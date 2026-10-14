import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { generateKeyPair, SignJWT } from 'jose';
import { Vault } from '../desktop/vault.mjs';
import { ChatGPT, loopback, consumeResponse, verifyIdentity, ISSUER } from '../desktop/chatgpt.mjs';
import { Runner } from '../desktop/runner.mjs';
import { loadConfig } from '../core/io.mjs';
function cryptoFixture(){
  const key=randomBytes(32);
  return {isEncryptionAvailable:()=>true,
    encryptString(s){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),text=Buffer.concat([c.update(s),c.final()]);return Buffer.concat([iv,c.getAuthTag(),text]);},
    decryptString(b){const c=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(12,28));return Buffer.concat([c.update(b.subarray(28)),c.final()]).toString();}
  };
}
const stream = blocks => new ReadableStream({start(c){for(const b of blocks)c.enqueue(new TextEncoder().encode(b));c.close();}});
const complete = response => 'data: '+JSON.stringify({type:'response.completed',response})+'\n\n';
test('Coffre: hôte stable, écriture chiffrée, aucune dégradation en clair',()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-vault-'));try{
    const path=join(dir,'credentials.bin'),crypto=cryptoFixture(),v=new Vault(path,crypto),id=v.hostId();
    v.set('mexc',{spotKey:'private-test-key',spotSecret:'private-test-secret'});
    assert.ok(!readFileSync(path).includes(Buffer.from('private-test-secret')));
    const second=new Vault(path,crypto);assert.equal(second.hostId(),id);assert.equal(second.get('mexc').spotSecret,'private-test-secret');
    assert.throws(()=>new Vault(path,{isEncryptionAvailable:()=>false}),/SECURE_STORAGE_UNAVAILABLE/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('Callback OAuth: refuse état forgé et client inattendu avant un retour valide',async()=>{
  const listener=await loopback({state:'fixture-state',expectedClientId:'issued-fixture-client',timeoutMs:1000});
  try{
    assert.equal((await fetch(listener.redirectUri+'?code=fixture&state=forged&client_id=issued-fixture-client')).status,400);
    assert.equal((await fetch(listener.redirectUri+'?code=fixture&state=fixture-state&client_id=other-client')).status,400);
    assert.equal((await fetch(listener.redirectUri+'?code=fixture&state=fixture-state')).status,200);
    assert.deepEqual(await listener.result,{code:'fixture',clientId:'issued-fixture-client'});
  }finally{listener.cancel();}
});
test('ID token: signature, audience, nonce et identité liés à la connexion',async()=>{
  const {privateKey,publicKey}=await generateKeyPair('RS256');
  const token=await new SignJWT({nonce:'expected',email:'fixture@example.invalid'}).setProtectedHeader({alg:'RS256'}).setIssuer(ISSUER).setAudience('client-fixture').setSubject('user-fixture').setIssuedAt().setExpirationTime('2m').sign(privateKey);
  const id=await verifyIdentity(token,'client-fixture','expected',null,publicKey);assert.equal(id.subject,'user-fixture');
  await assert.rejects(verifyIdentity(token,'wrong-client','expected',null,publicKey));
  await assert.rejects(verifyIdentity(token,'client-fixture','wrong',null,publicKey),/NONCE/);
  await assert.rejects(verifyIdentity(token,'client-fixture','expected',{subject:'other-user',issuer:ISSUER},publicKey),/IDENTITY_CHANGED/);
});
test('Streaming: ignore les deltas non terminés, refuse une limite tardive et une coupure',async()=>{
  const response={status:'completed',output:[],usage:{total_tokens:4}};
  const text=complete(response);assert.deepEqual(await consumeResponse(stream([text.slice(0,12),text.slice(12)])),response);
  const delta='{"decisions":[]}';const recovered=await consumeResponse(stream(['data: '+JSON.stringify({type:'response.output_text.delta',delta})+'\n\n',complete(response)]));assert.equal(recovered.output_text,delta);
  await assert.rejects(consumeResponse(stream(['data: {"type":"response.output_text.delta","delta":"not-final"}\n\n'])),/INTERRUPTED/);
  await assert.rejects(consumeResponse(stream(['data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n'])),/USAGE_LIMIT/);
  await assert.rejects(consumeResponse(stream([text,'data: {"type":"error","code":"failed"}\n\n'])),/FAILED/);
});
test('Refresh: un seul échange concurrent, rotation atomique et arrêt après déconnexion',async()=>{
  const values={chatgpt:{clientId:'fixture-client',accessToken:'old-access',refreshToken:'old-refresh',scopes:['chatgpt.tokens.use.direct'],expiresAt:0}};
  const vault={get:k=>structuredClone(values[k]),set:(k,v)=>{values[k]=structuredClone(v);}};
  let calls=0,finish;
  const request=async()=>{calls++;await new Promise(r=>finish=r);return new Response(JSON.stringify({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600,token_type:'Bearer'}));};
  const auth=new ChatGPT(vault,()=>{},request);
  const first=auth.accessToken(),second=auth.accessToken();finish();assert.deepEqual(await Promise.all([first,second]),['new-access','new-access']);assert.equal(calls,1);assert.equal(values.chatgpt.refreshToken,'new-refresh');
  values.chatgpt.expiresAt=0;const pending=auth.accessToken();auth.disconnectLocal();finish();await assert.rejects(pending,/RECONNECT/);assert.ok(!values.chatgpt.accessToken);
});
test('Une identité connectée sans permission de forfait ne permet aucun appel GPT',async()=>{
  const vault={get:()=>({accessToken:'fixture-token',scopes:['openid'],email:'fixture@example.invalid'})};
  const auth=new ChatGPT(vault,()=>{},()=>{throw new Error('must-not-call');});
  assert.equal(auth.session().connected,true);assert.equal(auth.session().sharing,false);await assert.rejects(auth.accessToken(),/PLAN_DISABLED/);
});
test('HTTP 400 GPT expose code, type et champ autorisés sans le message brut',async()=>{
  const vault={get:()=>({accessToken:'fixture-token',scopes:['chatgpt.tokens.use.direct'],expiresAt:Date.now()+3600000})};
  const make=error=>new ChatGPT(vault,()=>{},async()=>new Response(JSON.stringify({error:{...error,message:'private request payload'}}),{status:400}));
  await assert.rejects(make({code:'invalid_json_schema',type:'invalid_request_error',param:'text.format.schema'}).response({}),e=>e.message==='CHATGPT_REQUEST_SCHEMA_CODE_INVALID_JSON_SCHEMA_TYPE_INVALID_REQUEST_ERROR_PARAM_TEXT_FORMAT_SCHEMA'&&!e.message.includes('private'));
  await assert.rejects(make({code:'unsupported_parameter'}).response({}),/CHATGPT_REQUEST_PARAMETER_CODE_UNSUPPORTED_PARAMETER/);
  await assert.rejects(make({code:'unlisted-sensitive-detail',param:'private@example.com'}).response({}),e=>e.message==='CHATGPT_HTTP_400_CODE_UNLISTED_SENSITIVE_DETAIL'&&!e.message.includes('private'));
  const detailAuth=new ChatGPT(vault,()=>{},async()=>new Response(JSON.stringify({detail:'unsupported structured output for this request'}),{status:400,headers:{'x-request-id':'req_abc123'}}));
  await assert.rejects(detailAuth.response({}),e=>e.message==='CHATGPT_HTTP_400_DETAIL_SCHEMA_REQUEST_REQ_ABC123');
});
test('Compatibilité ChatGPT: retire le mode JSON seulement si text.format est explicitement refusé',async()=>{
  const vault={get:()=>({accessToken:'fixture-token',scopes:['chatgpt.tokens.use.direct'],expiresAt:Date.now()+3600000})};let calls=0,first,second;
  const auth=new ChatGPT(vault,()=>{},async(_url,options)=>{calls++;const body=JSON.parse(options.body);if(calls===1){first=body;return new Response(JSON.stringify({error:{code:'unsupported_parameter',param:'text.format'}}),{status:400});}second=body;return new Response('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[],usage:{total_tokens:1}}})+'\n\n');});
  const result=await auth.response({model:'gpt-fixture',input:[],text:{format:{type:'json_object'}}});assert.equal(result.status,'completed');assert.equal(calls,2);assert.equal(first.text.format.type,'json_object');assert.ok(!('text' in second));
});
test('Erreur de transport et flux GPT conservent un diagnostic sûr',async()=>{
  const vault={get:()=>({accessToken:'fixture-token',scopes:['chatgpt.tokens.use.direct'],expiresAt:Date.now()+3600000})};
  const network=new ChatGPT(vault,()=>{},async()=>{throw new TypeError('secret URL and token');});
  await assert.rejects(network.response({}),e=>e.message==='CHATGPT_NETWORK_ERROR');
  const broken=new ReadableStream({pull(c){c.error(new TypeError('private transport detail'));}});
  await assert.rejects(consumeResponse(broken),e=>e.message==='CHATGPT_STREAM_ERROR');
});
const quote = () => ({id:'spot:BTC',asset:'BTC',market:'spot',symbol:'BTCUSDT',bid:100,ask:100.05,spreadBps:5,observedAt:Date.now(),candles:[],features:{return5m:.01},fundingHistory:[]});
const decision = body => ({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({decisions:JSON.parse(body.input).map(c=>({id:c.id,action:'LONG',confidence:.9,reason:'Fixture vérifiée'}))})}]}],usage:{total_tokens:100}});
test('Desktop: simulation → décision OAuth → prix rafraîchis → journal SQLite → reprise',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-run-'));let runner;try{
    let samples=0;const cfg={...loadConfig(),symbols:['BTC'],markets:['spot']};
    const auth={session:()=>({sharing:true}),response:async body=>decision(body)};
    runner=new Runner(dir,cfg,auth,{snapshot:async()=>{samples++;return quote();}});
    await runner.start('gpt-fixture',1000,['spot']);runner.stop();
    assert.equal(samples,2);assert.equal(runner.snapshot().positions.length,1);assert.equal(runner.snapshot().liveEnabled,false);assert.equal(runner.state.api.calls,1);
    const started=runner.state.startedAt;runner.close();runner=new Runner(dir,cfg,auth,{snapshot:async()=>quote()});
    assert.equal(runner.state.startedAt,started);assert.equal(runner.snapshot().positions.length,1);
  }finally{runner?.close();rmSync(dir,{recursive:true,force:true});}
});
test('Desktop: une pause demandée pendant GPT empêche les nouvelles entrées',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-pause-'));let runner;try{
    const cfg={...loadConfig(),symbols:['BTC'],markets:['spot']};
    const auth={session:()=>({sharing:true}),response:async body=>{runner.pause(true);return decision(body);}};
    runner=new Runner(dir,cfg,auth,{snapshot:async()=>quote()});await runner.start('gpt-fixture');runner.stop();
    assert.equal(runner.snapshot().positions.length,0);assert.equal(runner.snapshot().paused,true);
  }finally{runner?.close();rmSync(dir,{recursive:true,force:true});}
});
test('Desktop: prix incomplets ne démarrent pas la semaine et quota GPT met en pause',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-coverage-'));let runner;try{
    const cfg={...loadConfig(),symbols:['BTC'],markets:['spot']},auth={session:()=>({sharing:true}),response:async()=>{throw new Error('CHATGPT_USAGE_LIMIT');}};
    runner=new Runner(dir,cfg,auth,{snapshot:async()=>{throw new Error('offline');}});await runner.start('gpt-fixture');runner.stop();
    assert.equal(runner.state,null);assert.equal(runner.snapshot().lastError,'MEXC_DATA_INCOMPLETE');runner.close();
    runner=new Runner(dir,cfg,auth,{snapshot:async()=>quote()});await runner.start('gpt-fixture');runner.stop();
    assert.equal(runner.snapshot().paused,true);assert.equal(runner.snapshot().lastError,'CHATGPT_USAGE_LIMIT');assert.equal(runner.snapshot().positions.length,0);
  }finally{runner?.close();rmSync(dir,{recursive:true,force:true});}
});
