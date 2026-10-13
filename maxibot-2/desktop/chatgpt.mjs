import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const jwks = createRemoteJWKSet(new URL(ISSUER + '/.well-known/jwks.json'));
const random = () => randomBytes(32).toString('base64url');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const BAD_REQUEST_CODES = new Map([
  ['invalid_json_schema','CHATGPT_REQUEST_SCHEMA'], ['schema_not_supported','CHATGPT_REQUEST_SCHEMA'],
  ['unsupported_parameter','CHATGPT_REQUEST_PARAMETER'], ['unknown_parameter','CHATGPT_REQUEST_PARAMETER'],
  ['model_not_found','CHATGPT_REQUEST_MODEL'], ['unsupported_model','CHATGPT_REQUEST_MODEL'],
  ['context_length_exceeded','CHATGPT_REQUEST_TOO_LARGE'], ['input_too_long','CHATGPT_REQUEST_TOO_LARGE']
]);
async function responseError(r) {
  if (r.status === 401) return 'CHATGPT_RECONNECT';
  if (r.status === 429) return 'CHATGPT_USAGE_LIMIT';
  if (r.status === 400) {
    try { const d = await r.json(); const code = d?.error?.code; if (typeof code === 'string' && BAD_REQUEST_CODES.has(code)) return BAD_REQUEST_CODES.get(code); } catch {}
  }
  return 'CHATGPT_HTTP_' + r.status;
}
export async function verifyIdentity(token, clientId, nonce, selected = null, keys = jwks) {
  const { payload } = await jwtVerify(token, keys, { issuer: ISSUER, audience: clientId, algorithms: ['RS256', 'ES256'], requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5 });
  if (!same(payload.nonce, nonce)) throw new Error('CHATGPT_NONCE_INVALID');
  if (selected && (selected.subject !== payload.sub || selected.issuer !== payload.iss)) throw new Error('CHATGPT_IDENTITY_CHANGED');
  return { subject: payload.sub, issuer: payload.iss, email: typeof payload.email === 'string' ? payload.email : '' };
}
export async function loopback({ state, expectedClientId = null, timeoutMs = 600000 }) {
  let resolve, reject, used = false, timer;
  const result = new Promise((yes, no) => { resolve = yes; reject = no; }); result.catch(() => {});
  const close = () => { clearTimeout(timer); server.close(); };
  const server = createServer((req, res) => {
    const finish = (code, text) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(text); };
    const u = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET' || u.pathname !== '/auth/callback') return finish(404, 'Page absente.');
    if (used || !same(u.searchParams.get('state'), state)) return finish(400, 'Connexion invalide. Retournez dans Maxibot 2.0.');
    const supplied = u.searchParams.get('client_id');
    if (expectedClientId && supplied && supplied !== expectedClientId) return finish(400, 'Compte inattendu.');
    const clientId = expectedClientId || supplied;
    if (u.searchParams.get('error')) { used = true; finish(400, 'Connexion refusée. Retournez dans Maxibot 2.0.'); close(); reject(new Error('CHATGPT_SIGN_IN_CANCELLED')); return; }
    const code = u.searchParams.get('code');
    if (!code || !clientId || clientId === 'dynamic_agent_client' || clientId.length > 250) return finish(400, 'Connexion incomplète.');
    used = true; finish(200, 'Connexion reçue. Vous pouvez fermer cet onglet et revenir dans Maxibot 2.0.');
    close(); resolve({ code, clientId });
  });
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  const redirectUri = 'http://127.0.0.1:' + server.address().port + '/auth/callback';
  const cancel = () => { if (!used) { used = true; close(); reject(new Error('CHATGPT_SIGN_IN_CANCELLED')); } };
  timer = setTimeout(cancel, timeoutMs);
  return { result, redirectUri, cancel };
}
export async function consumeResponse(stream) {
  let buffer = '', completed = null; const decode = new TextDecoder();
  const consume = block => {
    const text = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!text || text === '[DONE]') return;
    let event; try { event = JSON.parse(text); } catch { throw new Error('CHATGPT_STREAM_INVALID'); }
    if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) {
      const code = event.response?.error?.code || event.error?.code || event.code;
      if (['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable'].includes(code)) throw new Error('CHATGPT_USAGE_LIMIT');
      throw new Error('CHATGPT_RESPONSE_FAILED');
    }
    if (event.type === 'response.completed') {
      if (event.response?.status !== 'completed') throw new Error('CHATGPT_RESPONSE_FAILED'); completed = event.response;
    }
  };
  for await (const chunk of stream) {
    buffer += decode.decode(chunk, { stream: true }); buffer = buffer.replace(/\r\n/g, '\n');
    if (buffer.length > 2_000_000) throw new Error('CHATGPT_STREAM_TOO_LARGE');
    let end; while ((end = buffer.indexOf('\n\n')) >= 0) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 2); }
  }
  buffer += decode.decode(); if (buffer.trim()) consume(buffer);
  if (!completed) throw new Error('CHATGPT_STREAM_INTERRUPTED'); return completed;
}
export class ChatGPT {
  constructor(vault, openBrowser, request = fetch) {
    this.vault = vault; this.openBrowser = openBrowser; this.request = request;
    this.refreshing = null; this.signing = false; this.generation = 0; this.cancelSignIn = null;
  }
  session() {
    const a = this.vault.get('chatgpt');
    return { connected: !!a?.accessToken, sharing: !!a?.accessToken && a.scopes?.includes('chatgpt.tokens.use.direct') === true, email: a?.email || '' };
  }
  async tokenRequest(params) {
    const r = await this.request(ISSUER + '/api/accounts/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(r.status === 400 || r.status === 401 ? 'CHATGPT_RECONNECT' : 'CHATGPT_NETWORK');
    const d = await r.json();
    if (typeof d.access_token !== 'string' || !d.access_token || !Number.isFinite(d.expires_in) || d.expires_in <= 0 || d.token_type?.toLowerCase() !== 'bearer') throw new Error('CHATGPT_TOKEN_INVALID');
    return d;
  }
  async signIn({ newProfile = false } = {}) {
    if (this.signing) throw new Error('CHATGPT_SIGN_IN_BUSY');
    this.signing = true; const generation = this.generation; let listener;
    try {
      const selected = newProfile ? null : this.vault.get('chatgpt');
      const pending = newProfile ? null : this.vault.get('chatgptRegistration');
      const clientId = selected?.clientId || pending?.clientId;
      const state = random(), nonce = random(), verifier = random();
      listener = await loopback({ state, expectedClientId: clientId }); this.cancelSignIn = listener.cancel;
      const url = new URL(ISSUER + '/api/accounts/authorize');
      const params = { client_id: clientId || 'dynamic_agent_client', ext_agent_host_id: this.vault.hostId(), response_type: 'code', redirect_uri: listener.redirectUri, scope: SCOPES, resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') };
      if (!clientId) params.agent_name_hint = 'Maxibot 2.0';
      if (selected?.idToken) params.id_token_hint = selected.idToken;
      if (selected?.email) params.login_hint = selected.email;
      url.search = new URLSearchParams(params).toString(); await this.openBrowser(url.toString());
      const callback = await listener.result;
      if (generation !== this.generation) throw new Error('CHATGPT_SIGN_IN_CANCELLED');
      this.vault.set('chatgptRegistration', { clientId: callback.clientId });
      const d = await this.tokenRequest({ grant_type: 'authorization_code', client_id: callback.clientId, code: callback.code, code_verifier: verifier, redirect_uri: listener.redirectUri, resource: RESOURCE });
      const identity = await verifyIdentity(d.id_token, callback.clientId, nonce, selected);
      if (generation !== this.generation) throw new Error('CHATGPT_SIGN_IN_CANCELLED');
      this.vault.set('chatgpt', { ...identity, clientId: callback.clientId, idToken: d.id_token, accessToken: d.access_token, refreshToken: d.refresh_token || null, scopes: (d.scope || '').split(' ').filter(Boolean), expiresAt: Date.now() + d.expires_in * 1000 });
      this.vault.set('chatgptRegistration', null); return this.session();
    } finally { listener?.cancel(); this.cancelSignIn = null; this.signing = false; }
  }
  async accessToken() {
    const a = this.vault.get('chatgpt');
    if (!a?.accessToken || !a.scopes?.includes('chatgpt.tokens.use.direct')) throw new Error('CHATGPT_PLAN_DISABLED');
    if (a.expiresAt > Date.now() + 90000) return a.accessToken;
    if (!a.refreshToken) throw new Error('CHATGPT_RECONNECT');
    if (!this.refreshing) {
      const generation = this.generation;
      this.refreshing = (async () => {
        const d = await this.tokenRequest({ grant_type: 'refresh_token', client_id: a.clientId, refresh_token: a.refreshToken, resource: RESOURCE });
        if (generation !== this.generation || this.vault.get('chatgpt')?.refreshToken !== a.refreshToken) throw new Error('CHATGPT_RECONNECT');
        const next = { ...a, accessToken: d.access_token, refreshToken: d.refresh_token || a.refreshToken, scopes: d.scope === undefined ? a.scopes : d.scope.split(' ').filter(Boolean), expiresAt: Date.now() + d.expires_in * 1000 };
        this.vault.set('chatgpt', next);
        if (!next.scopes.includes('chatgpt.tokens.use.direct')) throw new Error('CHATGPT_PLAN_DISABLED'); return next.accessToken;
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }
  async models() {
    const token = await this.accessToken();
    const r = await this.request(RESOURCE + '/models', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(r.status === 401 ? 'CHATGPT_RECONNECT' : 'CHATGPT_MODELS_UNAVAILABLE');
    const d = await r.json();
    return (d.models || []).filter(m => m.visibility === 'list' && typeof m.slug === 'string' && m.slug.startsWith('gpt-')).map(m => ({ id: m.slug, name: m.display_name || m.slug }));
  }
  async response(body) {
    const token = await this.accessToken();
    const r = await this.request(RESOURCE + '/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, store: false, stream: true }), signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(await responseError(r));
    return consumeResponse(r.body);
  }
  disconnectLocal() {
    this.generation++; this.cancelSignIn?.(); const a = this.vault.get('chatgpt');
    this.vault.set('chatgpt', a ? { clientId: a.clientId, subject: a.subject, issuer: a.issuer, email: a.email } : null);
    this.vault.set('chatgptRegistration', null);
  }
}
