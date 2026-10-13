import { app, BrowserWindow, ipcMain, protocol, shell, session, dialog, Notification, powerSaveBlocker, powerMonitor, safeStorage } from 'electron';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Vault } from './vault.mjs';
import { ChatGPT } from './chatgpt.mjs';
import { AutonomousRunner } from '../live/runner.mjs';
import { LiveMexc } from '../live/mexc.mjs';
import { FomoApi,validFomoKey } from '../live/fomoapi.mjs';
import { loadConfig } from '../core/io.mjs';

const base=dirname(dirname(fileURLToPath(import.meta.url))), smoke=process.argv.includes('--smoke-test');
const stage=name=>{if(smoke)writeFileSync(join(process.cwd(),'smoke-stage.txt'),name);};
stage('module-loaded');
if(smoke)app.setPath('userData',mkdtempSync(join(tmpdir(),'maxibot-smoke-')));
app.setAppUserModelId('com.maxibot.desktop2');
if(!app.requestSingleInstanceLock())app.quit();
let win, vault, chatgpt, runner, fomo=null, fomoConnecting=false, modelList=[], blocker=null, quitting=false, waitingForQuit=false;
const notify = message => {
  if(message.notification&&Notification.isSupported())new Notification({title:'Maxibot 2.0',body:message.notification}).show();
  if(message&&!message.active)stopBlocker();else if(blocker===null)blocker=powerSaveBlocker.start('prevent-app-suspension');
  if(win&&!win.isDestroyed())win.webContents.send('maxibot:update');
};
const startRunner = () => {
  let runId=vault.get('executionRunId');
  if(!runId){runId=randomUUID();vault.set('executionRunId',runId);}
  runner=new AutonomousRunner(join(app.getPath('userData'),'execution',runId),loadConfig(join(base,'config.json')),chatgpt,new LiveMexc(()=>vault.get('mexc')),notify,{fomo});runner.sourceFile=vault.get('copySource');
};
function validSender(e) {
  return !!win && e.sender===win.webContents && e.senderFrame===win.webContents.mainFrame &&
    e.senderFrame?.url==='maxibot://app/index.html' && e.senderFrame?.origin==='maxibot://app';
}
function handle(name, fn) {
  ipcMain.handle('maxibot:'+name,async(e,arg)=>{
    if(!validSender(e))return {ok:false,error:'IPC_FORBIDDEN'};
    try{return {ok:true,value:await fn(arg)};}
    catch(error){return {ok:false,error:/^[A-Z0-9_]+$/.test(error.message)?error.message:'ACTION_FAILED'};}
  });
}
function stopBlocker(){if(blocker!==null&&powerSaveBlocker.isStarted(blocker))powerSaveBlocker.stop(blocker);blocker=null;}
const keyValue = v => typeof v==='string'&&v.length>=8&&v.length<=512&&!/[\s\u0000]/.test(v);
await app.whenReady();stage('app-ready');
try {
  const assets={'/index.html':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
  protocol.handle('maxibot',request=>{
    const u=new URL(request.url),entry=assets[u.pathname];
    if(u.hostname!=='app'||!entry)return new Response('Not found',{status:404});
    return new Response(readFileSync(join(base,'ui',entry[0])),{headers:{'Content-Type':entry[1],'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}});
  });
  session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  if(process.platform==='linux'&&safeStorage.getSelectedStorageBackend()==='basic_text')throw new Error('SECURE_STORAGE_UNAVAILABLE');
  vault=new Vault(join(app.getPath('userData'),'credentials.bin'),safeStorage);
  chatgpt=new ChatGPT(vault,url=>{
    const u=new URL(url);
    if(u.origin!=='https://auth.openai.com'||u.pathname!=='/api/accounts/authorize')throw new Error('AUTH_URL_INVALID');
    return shell.openExternal(url);
  });
  startRunner();stage('storage-and-runner-ready');
  handle('state',lane=>({chatgpt:chatgpt.session(),mexc:{connected:!!vault.get('mexc')?.verified,spotRead:vault.get('mexc')?.spotRead||false,futuresRead:vault.get('mexc')?.futuresRead===true,spotCanTrade:vault.get('mexc')?.spotCanTrade===true,futuresCanTrade:vault.get('mexc')?.futuresCanTrade===true},dashboard:runner.snapshot(typeof lane==='string'&&lane.length<150?lane:undefined),version:app.getVersion()}));
  handle('chatgpt-connect',async arg=>{
    if(runner.starting||runner.state?.enabled||runner.busy)throw new Error('STOP_BEFORE_ACCOUNT_CHANGE');
    const state=await chatgpt.signIn({newProfile:arg?.newProfile===true});modelList=[];
    if(state.sharing)modelList=await chatgpt.models();return {...state,models:modelList};
  });
  handle('chatgpt-disconnect',()=>{if(runner.starting||runner.active)throw new Error('STOP_BEFORE_ACCOUNT_CHANGE');runner.stop();stopBlocker();chatgpt.disconnectLocal();modelList=[];return {remoteRevocationConfirmed:false};});
  handle('models',async()=>{modelList=await chatgpt.models();return modelList;});
  handle('mexc-connect',async keys=>{
    if(runner.starting||runner.state?.enabled||runner.busy)throw new Error('STOP_BEFORE_ACCOUNT_CHANGE');
    if(!keyValue(keys?.spotKey)||!keyValue(keys?.spotSecret))throw new Error('MEXC_KEYS_INVALID');
    if((keys.futuresKey||keys.futuresSecret)&&(!keyValue(keys.futuresKey)||!keyValue(keys.futuresSecret)))throw new Error('MEXC_KEYS_INVALID');
    const clean={spotKey:keys.spotKey,spotSecret:keys.spotSecret,futuresKey:keys.futuresKey||'',futuresSecret:keys.futuresSecret||''};
    const result=await new LiveMexc(()=>clean).connectCheck();
    if(runner.state?.uid&&runner.state.uid!==result.uid){if(runner.hasExposure)throw new Error('MEXC_ACCOUNT_CHANGED');runner.close();vault.set('executionRunId',randomUUID());vault.set('mexc',{...clean,...result});startRunner();}else{vault.set('mexc',{...clean,...result});runner.access=result;runner.broker.currencyCache=null;}if(fomo)fomo.mappingError=result.currencyRead?null:'MEXC_CURRENCY_READ_PERMISSION';return result;
  });
  handle('mexc-disconnect',()=>{if(runner.starting||runner.active)throw new Error('STOP_BEFORE_ACCOUNT_CHANGE');vault.set('mexc',null);return true;});
  handle('start',async settings=>{
    if(fomoConnecting)throw new Error('FOMO_CONNECTING');
    if(!vault.get('mexc')?.verified)throw new Error('MEXC_KEYS_REQUIRED');
    const value=await runner.start(Number(settings.capital));
    if(blocker===null)blocker=powerSaveBlocker.start('prevent-app-suspension');return value;
  });
  handle('stop',()=>{const value=runner.off();if(!runner.hasExposure)stopBlocker();return value;});
  handle('copy-source',async()=>{
    const result=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'Flux MEXC JSONL',extensions:['jsonl']}]});
    if(!result.canceled){vault.set('copySource',result.filePaths[0]);runner.sourceFile=result.filePaths[0];}return !result.canceled;
  });
  handle('fomo-connect',async key=>{
    if(fomoConnecting||runner.starting||runner.state?.enabled||runner.busy)throw new Error('STOP_BEFORE_ACCOUNT_CHANGE');
    if(!validFomoKey(key))throw new Error('FOMO_KEY_INVALID');
    fomoConnecting=true;const next=new FomoApi(key,{onState:()=>{if(win&&!win.isDestroyed())win.webContents.send('maxibot:update');}});
    try{await next.connect();if(quitting)throw new Error('FOMO_DISCONNECTED');next.mappingError=vault.get('mexc')?.verified&&vault.get('mexc')?.currencyRead!==true?'MEXC_CURRENCY_READ_PERMISSION':null;vault.set('fomoapi',{key});fomo?.close();fomo=next;runner.fomo=fomo;return fomo.snapshot();}
    catch(e){next.close();throw e;}finally{fomoConnecting=false;}
  });
  handle('fomo-disconnect',()=>{
    if(fomoConnecting||runner.starting||runner.state?.enabled||runner.busy)throw new Error('STOP_BEFORE_ACCOUNT_CHANGE');
    if(runner.state?.portfolio.positions.some(p=>p.plan.source==='fomoapi')||runner.state?.portfolio.orders.some(o=>!o.settled&&o.plan.source==='fomoapi'))throw new Error('FOMO_POSITIONS_ACTIVE');
    vault.set('fomoapi',null);fomo?.close();fomo=null;runner.fomo=null;return true;
  });
  if(!smoke&&vault.get('fomoapi')?.key){
    fomo=new FomoApi(vault.get('fomoapi').key,{onState:()=>{if(win&&!win.isDestroyed())win.webContents.send('maxibot:update');}});runner.fomo=fomo;
    const saved=fomo;saved.connect().catch(()=>{});
  }
  const guides={mexc:'https://www.mexc.com/user/openapi',chatgpt:'https://chatgpt.com',fomo:'https://fomoapi.io/dashboard',github:'https://github.com/DarkGhidi/Event-Future/releases'};
  handle('open-guide',name=>{if(!Object.hasOwn(guides,name))throw new Error('GUIDE_INVALID');return shell.openExternal(guides[name]);});
  handle('export',async()=>{
    if(!runner.state)throw new Error('NO_SIMULATION');
    const out=await dialog.showSaveDialog(win,{defaultPath:'Maxibot 2.0-Rapport.json',filters:[{name:'Rapport JSON',extensions:['json']}]});
    if(!out.canceled&&out.filePath)writeFileSync(out.filePath,JSON.stringify({appVersion:app.getVersion(),...runner.state},null,2));return !out.canceled;
  });
  win=new BrowserWindow({width:1440,height:960,minWidth:1000,minHeight:720,show:!smoke,backgroundColor:'#07100f',title:'Maxibot 2.0',webPreferences:{preload:join(base,'desktop','preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  win.removeMenu();
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(e,url)=>{if(url!=='maxibot://app/index.html')e.preventDefault();});
  win.on('close',async e=>{
    if(!smoke&&!quitting&&runner.active){e.preventDefault();const answer=await dialog.showMessageBox(win,{type:'question',buttons:['Continuer le suivi','Arrêter et quitter'],defaultId:0,cancelId:0,message:'Des positions ou des ordres peuvent encore être actifs.',detail:'Fermer le programme arrête le suivi et les sorties locales Spot. Les protections Futures confirmées sur MEXC restent sur l’exchange. Revenez au tableau de bord pour suivre ou clôturer vos positions.'});if(answer.response===1){quitting=true;runner.stop();app.quit();}}
  });
  powerMonitor.on('resume',()=>{if(runner.active&&!runner.busy){clearTimeout(runner.timer);runner.cycle();}});
  stage('window-created');await win.loadURL('maxibot://app/index.html');stage('window-loaded');
  if(smoke){
    const result=await win.webContents.executeJavaScript("(async()=>{const r=await window.maxibot.state();return {bridge:!!window.maxibot,ok:r.ok,status:r.value?.dashboard.status,heading:document.querySelector('h1')?.textContent,forms:document.querySelectorAll('form').length,fomoForm:document.getElementById('fomo-form')?.tagName==='FORM',fomoBridge:typeof window.maxibot.connectFomo==='function',fomoConfigured:r.value?.dashboard.fomo?.configured}})()");
    if(typeof WebSocket!=='function')throw new Error('SMOKE_WEBSOCKET_UNAVAILABLE');
    if(!result.bridge||!result.ok||result.status!=='not_started'||result.heading!=='Maxibot 2.0'||result.forms<3||!result.fomoForm||!result.fomoBridge||result.fomoConfigured!==false)throw new Error('SMOKE_FAILED');
    // Exercise packaged native SQLite and Windows DPAPI without accounts or Internet.
    vault.set('smokeFixture',{test:'non-secret'});if(vault.get('smokeFixture').test!=='non-secret')throw new Error('SMOKE_STORAGE_FAILED');
    writeFileSync(join(process.cwd(),'smoke-result.json'),JSON.stringify({...result,node:process.versions.node,electron:process.versions.electron,storage:true}));
    await new Promise(r=>setTimeout(r,250));await win.webContents.executeJavaScript("document.getElementById('demo').click()");await new Promise(r=>setTimeout(r,250));
    const screenshot=await win.webContents.capturePage();writeFileSync(join(process.cwd(),'smoke-preview.png'),screenshot.toPNG());
    const rejected=await win.webContents.executeJavaScript("window.maxibot.connectFomo('bad')");if(rejected.ok||rejected.error!=='FOMO_KEY_INVALID')throw new Error('SMOKE_FOMO_VALIDATION_FAILED');
    await win.webContents.executeJavaScript("document.getElementById('setup-open').click();document.getElementById('fomo-form').scrollIntoView()");await new Promise(r=>setTimeout(r,250));const setupImage=await win.webContents.capturePage();writeFileSync(join(process.cwd(),'smoke-fomo-setup.png'),setupImage.toPNG());
    runner.close();app.exit(0);
  }
} catch(e) {
  if(smoke){writeFileSync(join(process.cwd(),'smoke-result.json'),JSON.stringify({error:e.message}));app.exit(1);}
  else {dialog.showErrorBox('Maxibot 2.0','Le stockage protégé ou le démarrage est indisponible. Aucun secret ne sera enregistré en clair. Code : '+(/^[A-Z0-9_]+$/.test(e.message)?e.message:'STARTUP_FAILED'));app.quit();}
}
app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',e=>{
  quitting=true;runner?.stop();fomo?.close();chatgpt?.cancelSignIn?.();stopBlocker();
  if(runner?.busy){e.preventDefault();if(!waitingForQuit){waitingForQuit=true;const t=setInterval(()=>{if(!runner.busy){clearInterval(t);app.quit();}},100);}return;}
  runner?.close();
});
