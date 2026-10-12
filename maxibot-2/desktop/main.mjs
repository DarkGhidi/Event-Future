import { app, BrowserWindow, ipcMain, protocol, shell, session, dialog, Notification, powerSaveBlocker, powerMonitor, safeStorage } from 'electron';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Vault } from './vault.mjs';
import { ChatGPT } from './chatgpt.mjs';
import { Runner } from './runner.mjs';
import { Mexc } from '../core/mexc.mjs';
import { loadConfig } from '../core/io.mjs';
import { buildReport } from '../core/engine.mjs';
const base=dirname(dirname(fileURLToPath(import.meta.url))), smoke=process.argv.includes('--smoke-test');
const stage=name=>{if(smoke)writeFileSync(join(process.cwd(),'smoke-stage.txt'),name);};
stage('module-loaded');
if(smoke)app.setPath('userData',mkdtempSync(join(tmpdir(),'maxibot-smoke-')));
app.setAppUserModelId('com.maxibot.desktop2');
if(!app.requestSingleInstanceLock())app.quit();
let win, vault, chatgpt, runner, modelList=[], blocker=null, quitting=false, waitingForQuit=false;
const notify = message => {
  if(message.notification&&Notification.isSupported())new Notification({title:'Maxibot 2.0 · SIMULATION',body:message.notification}).show();
  if(win&&!win.isDestroyed())win.webContents.send('maxibot:update');
};
const startRunner = () => {
  let runId=vault.get('activeRun');
  if(!runId){runId=randomUUID();vault.set('activeRun',runId);}
  runner=new Runner(join(app.getPath('userData'),'runs',runId),loadConfig(join(base,'config.json')),chatgpt,new Mexc(),notify);
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
  handle('state',lane=>({chatgpt:chatgpt.session(),mexc:{connected:!!vault.get('mexc')?.verified,spotRead:vault.get('mexc')?.spotRead||false,futuresRead:vault.get('mexc')?.futuresRead===true},dashboard:runner.snapshot(typeof lane==='string'&&lane.length<150?lane:undefined),version:app.getVersion()}));
  handle('chatgpt-connect',async arg=>{
    if(runner.active)throw new Error('STOP_BEFORE_ACCOUNT_CHANGE');
    const state=await chatgpt.signIn({newProfile:arg?.newProfile===true});modelList=[];
    if(state.sharing)modelList=await chatgpt.models();return {...state,models:modelList};
  });
  handle('chatgpt-disconnect',()=>{runner.stop();stopBlocker();chatgpt.disconnectLocal();modelList=[];return {remoteRevocationConfirmed:false};});
  handle('models',async()=>{modelList=await chatgpt.models();return modelList;});
  handle('mexc-connect',async keys=>{
    if(runner.active)throw new Error('STOP_BEFORE_ACCOUNT_CHANGE');
    if(!keyValue(keys?.spotKey)||!keyValue(keys?.spotSecret))throw new Error('MEXC_KEYS_INVALID');
    if((keys.futuresKey||keys.futuresSecret)&&(!keyValue(keys.futuresKey)||!keyValue(keys.futuresSecret)))throw new Error('MEXC_KEYS_INVALID');
    const clean={spotKey:keys.spotKey,spotSecret:keys.spotSecret,futuresKey:keys.futuresKey||'',futuresSecret:keys.futuresSecret||''};
    const result=await new Mexc().accountCheck(clean);
    if(result.withdrawalPermission)throw new Error('MEXC_WITHDRAWAL_PERMISSION');
    vault.set('mexc',{...clean,...result,verified:true});return result;
  });
  handle('mexc-disconnect',()=>{if(runner.active)throw new Error('STOP_BEFORE_ACCOUNT_CHANGE');vault.set('mexc',null);return true;});
  handle('start',async settings=>{
    if(!modelList.length)modelList=await chatgpt.models();
    if(!modelList.some(m=>m.id===settings?.model))throw new Error('GPT_MODEL_REQUIRED');
    const value=await runner.start(settings.model,Number(settings.capital),settings.markets);
    if(blocker===null)blocker=powerSaveBlocker.start('prevent-app-suspension');return value;
  });
  handle('pause',value=>runner.pause(value));
  handle('stop',()=>{runner.stop();stopBlocker();return runner.snapshot();});
  handle('new-run',()=>{if(runner.active||runner.busy)throw new Error('STOP_BEFORE_NEW_RUN');runner.close();vault.set('activeRun',randomUUID());startRunner();return runner.snapshot();});
  const guides={mexc:'https://www.mexc.com/user/openapi',chatgpt:'https://chatgpt.com',github:'https://github.com/DarkGhidi/Event-Future/releases'};
  handle('open-guide',name=>{if(!Object.hasOwn(guides,name))throw new Error('GUIDE_INVALID');return shell.openExternal(guides[name]);});
  handle('export',async()=>{
    if(!runner.state)throw new Error('NO_SIMULATION');
    const out=await dialog.showSaveDialog(win,{defaultPath:'Maxibot 2.0-Rapport.json',filters:[{name:'Rapport JSON',extensions:['json']}]});
    if(!out.canceled&&out.filePath)writeFileSync(out.filePath,JSON.stringify(buildReport(runner.state),null,2));return !out.canceled;
  });
  win=new BrowserWindow({width:1440,height:960,minWidth:1000,minHeight:720,show:!smoke,backgroundColor:'#07100f',title:'Maxibot 2.0',webPreferences:{preload:join(base,'desktop','preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  win.removeMenu();
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(e,url)=>{if(url!=='maxibot://app/index.html')e.preventDefault();});
  win.on('close',async e=>{
    if(!smoke&&!quitting&&runner.active){e.preventDefault();const answer=await dialog.showMessageBox(win,{type:'question',buttons:['Continuer la simulation','Arrêter et quitter'],defaultId:0,cancelId:0,message:'La simulation s’arrête si Maxibot 2.0 est fermé.',detail:'Le journal reste enregistré et peut être repris à la prochaine ouverture.'});if(answer.response===1){quitting=true;runner.stop();app.quit();}}
  });
  powerMonitor.on('resume',()=>{if(runner.active&&!runner.busy){clearTimeout(runner.timer);runner.cycle();}});
  stage('window-created');await win.loadURL('maxibot://app/index.html');stage('window-loaded');
  if(smoke){
    const result=await win.webContents.executeJavaScript("(async()=>{const r=await window.maxibot.state();return {bridge:!!window.maxibot,ok:r.ok,status:r.value?.dashboard.status,heading:document.querySelector('h1')?.textContent,forms:document.querySelectorAll('form').length}})()");
    if(!result.bridge||!result.ok||result.status!=='not_started'||result.heading!=='Maxibot 2.0'||result.forms<2)throw new Error('SMOKE_FAILED');
    // Exercise packaged native SQLite and Windows DPAPI without accounts or Internet.
    vault.set('smokeFixture',{test:'non-secret'});if(vault.get('smokeFixture').test!=='non-secret')throw new Error('SMOKE_STORAGE_FAILED');
    writeFileSync(join(process.cwd(),'smoke-result.json'),JSON.stringify({...result,node:process.versions.node,electron:process.versions.electron,storage:true}));
    await win.webContents.executeJavaScript("document.getElementById('demo').click()");
    const screenshot=await win.webContents.capturePage();writeFileSync(join(process.cwd(),'smoke-preview.png'),screenshot.toPNG());
    runner.close();app.exit(0);
  }
} catch(e) {
  if(smoke){writeFileSync(join(process.cwd(),'smoke-result.json'),JSON.stringify({error:e.message}));app.exit(1);}
  else {dialog.showErrorBox('Maxibot 2.0','Le stockage protégé ou le démarrage est indisponible. Aucun secret ne sera enregistré en clair. Code : '+(/^[A-Z0-9_]+$/.test(e.message)?e.message:'STARTUP_FAILED'));app.quit();}
}
app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',e=>{
  quitting=true;runner?.stop();chatgpt?.cancelSignIn?.();stopBlocker();
  if(runner?.busy){e.preventDefault();if(!waitingForQuit){waitingForQuit=true;const t=setInterval(()=>{if(!runner.busy){clearInterval(t);app.quit();}},100);}return;}
  runner?.close();
});
