import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const types = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.svg':'image/svg+xml' };
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';
let mexcCredentials = null;
function isLoopback(req) {
  const address = req.socket.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
function apiReply(res, status, data) {
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store, private', 'Pragma':'no-cache', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer' });
  res.end(JSON.stringify(data));
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  return !origin || origin === 'http://' + req.headers.host || origin === 'https://' + req.headers.host;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '', size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > 4096) { reject(new Error('too_large')); req.destroy(); } else raw += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('invalid_json')); } });
    req.on('error', reject);
  });
}
async function fetchMexcAssets(credentials) {
  const timestamp = String(Date.now());
  const signature = crypto.createHmac('sha256', credentials.secret).update(credentials.key + timestamp).digest('hex');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8_000), started = Date.now();
  try {
    const response = await fetch('https://api.mexc.com/api/v1/private/account/assets', {
      method: 'GET', signal: controller.signal, headers: { 'ApiKey':credentials.key, 'Request-Time':timestamp, 'Signature':signature, 'Recv-Window':'10000' }
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.success !== true) throw new Error('mexc_rejected');
    const assets = Array.isArray(body.data) ? body.data : [];
    return { assets, checkedAt:Date.now(), latencyMs:Date.now() - started };
  } finally { clearTimeout(timer); }
}
function printAccess() {
  console.log('Application locale (Windows) : http://localhost:' + port);
  if (host === '127.0.0.1' || host === '::1') return;
  for (const [name, entries] of Object.entries(os.networkInterfaces())) for (const entry of entries || []) if (entry.family === 'IPv4' && !entry.internal) console.log('Téléphone (même Wi-Fi) : http://' + entry.address + ':' + port + '  [' + name + ']');
}
export const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if(pathname==='/api/market/time'&&req.method==='GET'){
    try{const response=await fetch('https://data-api.binance.vision/api/v3/time',{signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error();const data=await response.json();return apiReply(res,200,data);}catch{return apiReply(res,502,{error:'Référence horaire indisponible.'});}
  }
  if(pathname==='/api/market/candles'&&req.method==='GET'){
    const requestUrl=new URL(req.url,'http://localhost'),source=requestUrl.searchParams.get('source'),tf=requestUrl.searchParams.get('tf');
    const allowed={ '1m':1,'5m':5,'15m':15,'1h':60,'4h':240 };
    if(!allowed[tf]||!['spot','index'].includes(source))return apiReply(res,400,{error:'Source ou horizon invalide.'});
    try{
      let upstream;
      if(source==='spot'){upstream='https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval='+tf+'&limit=120';}
      else{const mins=allowed[tf],interval=mins===1?'Min1':mins===5?'Min5':mins===15?'Min15':mins===60?'Min60':'Hour4',end=Math.floor(Date.now()/1000),start=end-mins*60*125;upstream='https://contract.mexc.com/api/v1/contract/kline/index_price/BTC_USDT?interval='+interval+'&start='+start+'&end='+end;}
      const response=await fetch(upstream,{signal:AbortSignal.timeout(10000),headers:{'Accept':'application/json'}});if(!response.ok)throw new Error('upstream');const data=await response.json();return apiReply(res,200,data);
    }catch{return apiReply(res,502,{error:'Chandelles publiques momentanément indisponibles.'});}
  }
  if (pathname.startsWith('/api/')) {
    if (!isLoopback(req)) return apiReply(res, 403, { error:'Cette fonction est réservée à localhost sur cet ordinateur.' });
    if (!sameOrigin(req)) return apiReply(res, 403, { error:'Origine refusée.' });
    if (pathname === '/api/mexc/connect' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (error) { return apiReply(res, 400, { error:error.message === 'too_large' ? 'Entrée trop volumineuse.' : 'Requête invalide.' }); }
      const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : '', secret = typeof body.apiSecret === 'string' ? body.apiSecret.trim() : '';
      if (!key || !secret || key.length > 256 || secret.length > 256) return apiReply(res, 400, { error:'Clé API et clé secrète requises.' });
      try {
        const result = await fetchMexcAssets({ key, secret });
        mexcCredentials = { key, secret };
        return apiReply(res, 200, { connected:true, ...result });
      } catch {
        mexcCredentials = null;
        return apiReply(res, 401, { error:'MEXC a refusé la lecture. Vérifiez la clé, sa permission de consultation et l’horloge de l’ordinateur.' });
      }
    }
    if (pathname === '/api/mexc/assets' && req.method === 'GET') {
      if (!mexcCredentials) return apiReply(res, 200, { connected:false });
      try { return apiReply(res, 200, { connected:true, ...await fetchMexcAssets(mexcCredentials) }); }
      catch { return apiReply(res, 502, { connected:true, error:'Lecture MEXC momentanément indisponible.' }); }
    }
    if (pathname === '/api/mexc/disconnect' && req.method === 'POST') {
      try { if (mexcCredentials) { mexcCredentials.key = ''; mexcCredentials.secret = ''; } } catch {}
      mexcCredentials = null;
      return apiReply(res, 200, { connected:false });
    }
    return apiReply(res, 404, { error:'Route API inconnue.' });
  }
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403); res.end('Accès refusé'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type':'text/plain; charset=utf-8' }); res.end(err.code === 'ENOENT' ? 'Page introuvable' : 'Erreur interne du serveur'); return; }
    res.writeHead(200, { 'Content-Type':types[path.extname(file)] || 'application/octet-stream', 'Cache-Control':'no-cache', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'strict-origin-when-cross-origin' }); res.end(data);
  });
});
server.on('close', () => { if (mexcCredentials) { mexcCredentials.key = ''; mexcCredentials.secret = ''; } mexcCredentials = null; });
server.on('error', error => { if (error.code === 'EADDRINUSE') { console.error('Le port ' + port + ' est déjà utilisé.'); process.exitCode = 1; return; } console.error(error); process.exitCode = 1; });
server.listen(port, host, () => { console.log('Event/Lab prêt.'); printAccess(); console.log('Gardez cette fenêtre ouverte pendant l’utilisation. Arrêt : Ctrl+C.'); });
