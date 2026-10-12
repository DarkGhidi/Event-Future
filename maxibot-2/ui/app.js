const $=id=>document.getElementById(id), api=window.maxibot;
let market='spot', profile='balanced', snapshot=null, models=[], demo=false, initialized=false, updating=false, toastTimer;
const labels={exploration:'Exploration',balanced:'Équilibré',selective:'Sélectif'};
const money=(v,signed=false)=>Number.isFinite(v)?(signed&&v>=0?'+':'')+new Intl.NumberFormat('fr-FR',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(v):'—';
const errors={
  CHATGPT_USAGE_LIMIT:'Limite du forfait ChatGPT atteinte. Les nouvelles entrées sont en pause. Gérez l’utilisation dans les réglages ChatGPT.',
  CHATGPT_PLAN_DISABLED:'L’utilisation du forfait n’est pas autorisée pour cette connexion. Reconnectez un compte ChatGPT éligible et accordez cette permission.',
  CHATGPT_RECONNECT:'La connexion ChatGPT doit être renouvelée. Arrêtez la simulation puis reconnectez le compte.',
  CHATGPT_MODELS_UNAVAILABLE:'Impossible de charger les modèles de ce compte. Réessayez ou vérifiez son éligibilité.',
  CHATGPT_SIGN_IN_CANCELLED:'Connexion annulée ou délai écoulé. Vous pouvez recommencer.',
  CHATGPT_SIGN_IN_BUSY:'Une connexion est déjà ouverte dans votre navigateur.',
  MEXC_KEYS_INVALID:'Renseignez Access Key et Secret Key ensemble, sans espace. Les clés Futures sont facultatives.',
  MEXC_WITHDRAWAL_PERMISSION:'Cette clé autorise les retraits. Créez une clé dédiée en lecture, sans droit de retrait.',
  MEXC_DATA_INCOMPLETE:'Les données publiques MEXC sont incomplètes. La semaine n’a pas encore démarré. Maxibot 2.0 réessaie tant qu’il reste ouvert.',
  GPT_MODEL_REQUIRED:'Choisissez un modèle GPT proposé par votre compte.',
  MODEL_FROZEN_FOR_WEEK:'Le modèle est conservé pendant toute cette semaine. Archivez cet essai pour en lancer un avec un autre modèle.',
  CONFIG_INVALID:'Choisissez au moins un marché et un capital fictif entre 50 et 10 000 000 USDT.',
  STOP_BEFORE_ACCOUNT_CHANGE:'Arrêtez le moteur avant de modifier une connexion.',
  STOP_BEFORE_NEW_RUN:'Arrêtez le moteur et attendez la fin du cycle avant de créer un nouvel essai.',
  SIMULATION_FINISHED:'Cette semaine est terminée. Vous pouvez exporter le rapport ou créer un nouvel essai.',
  NO_SIMULATION:'Aucune simulation à exporter.',
  NETWORK_OR_DATA_ERROR:'Le réseau ou les données du marché sont indisponibles. Aucune entrée n’est forcée.',
  GPT_RESPONSE_INVALID:'La réponse GPT n’est pas exploitable. Ce cycle est ignoré.',
  ACTION_FAILED:'L’action n’a pas abouti. Vérifiez les connexions puis réessayez.'
};
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('toast').hidden=true;},12000);}
async function call(fn,...args){const result=await api[fn](...args);if(!result.ok)throw new Error(errors[result.error]||('Action indisponible : '+result.error));return result.value;}
const node=(tag,className,text)=>{const e=document.createElement(tag);if(className)e.className=className;if(text!==undefined)e.textContent=text;return e;};
function showSetup(){if(!$('setup').open)$('setup').showModal();}
function renderChart(data){
  const history=data.history||[];
  const line=$('chart-line'),area=$('chart-area'),last=$('chart-end');$('chart-empty').setAttribute('visibility',history.length?'hidden':'visible');
  if(!history.length){line.setAttribute('d','');area.setAttribute('d','');last.setAttribute('visibility','hidden');return;}
  let series=history;if(series.length>600){const step=Math.ceil(series.length/300),reduced=[series[0]];for(let i=0;i<series.length;i+=step){const part=series.slice(i,i+step),lo=part.reduce((a,b)=>a.value<b.value?a:b),hi=part.reduce((a,b)=>a.value>b.value?a:b);reduced.push(...[lo,hi].sort((a,b)=>a.time-b.time));}reduced.push(series.at(-1));series=reduced;}
  const values=series.map(x=>x.value),min=Math.min(...values),max=Math.max(...values),range=Math.max(max-min,max*.002,1),start=series[0].time,end=series.at(-1).time;
  const pts=series.map((p,i)=>[18+(end===start?(i/Math.max(series.length-1,1)):(p.time-start)/(end-start))*822,250-(p.value-min+range*.08)/(range*1.16)*220]);
  const d=pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(2)+' '+p[1].toFixed(2)).join(' ');
  line.setAttribute('d',d);area.setAttribute('d',d+' L840 270 L18 270 Z');last.setAttribute('visibility','visible');last.setAttribute('cx',pts.at(-1)[0]);last.setAttribute('cy',pts.at(-1)[1]);
  $('chart-first').textContent=new Date(start).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})+' · '+money(series[0].value);
  $('chart-last').textContent=new Date(end).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})+' · '+money(series.at(-1).value);
}
function render(data){
  const s=data.selected;const fresh=data.updatedAt&&Date.now()-data.updatedAt<180000;
  $('mode').textContent=demo?'MAQUETTE':'SIMULATION';
  $('status').textContent=demo?'DONNÉES FICTIVES':data.active?(data.busy?'ANALYSE EN COURS':data.paused?'ENTRÉES EN PAUSE':fresh?'DONNÉES REÇUES':'DONNÉES ATTENDUES'):data.status==='not_started'?'NON DÉMARRÉ':data.status==='running'?'MOTEUR ARRÊTÉ':'SEMAINE TERMINÉE';
  $('notice').textContent=demo?'DÉMONSTRATION — chiffres inventés pour présenter l’interface. Aucun bot n’est lancé.':data.lastError?(errors[data.lastError]||'Un cycle a été ignoré : '+data.lastError):data.active?'Prix MEXC et décisions GPT · positions et argent entièrement fictifs · aucun ordre réel.':'La simulation fonctionne lorsque Maxibot 2.0 est ouvert et que ce PC reste disponible.';
  $('equity').textContent=money(s?.equity);$('initial').textContent=s?'Départ fictif : '+money(s.initial):'Portefeuille non démarré';
  $('pnl').textContent=money(s?.pnl,true);$('pnl').classList.toggle('negative',(s?.pnl||0)<0);$('pnl-pct').textContent=s?(s.pnlPct>=0?'+':'')+s.pnlPct.toFixed(2)+'% · net simulé':'Frais et slippage inclus';
  $('drawdown').textContent=s?'-'+(s.drawdown*100).toFixed(2)+'%':'—';
  $('win-rate').textContent=s?.closed?Math.round(s.winRate*100)+'%':'—';$('wins').textContent=s?s.wins+' gains · '+s.losses+' pertes · '+s.closed+' clôtures':'Aucun trade clôturé';
  $('win-circle').setAttribute('stroke-dasharray',((s?.winRate||0)*245).toFixed(1)+' 245');
  $('phase').textContent=data.phase==='validation'?'VALIDATION · RÈGLES GELÉES':'EXPLORATION · TROIS PROFILS';$('coverage').textContent=(data.dataGaps||0)+' coupure(s) comptabilisée(s)';
  $('chart-date').textContent=data.startedAt?'Depuis le '+new Date(data.startedAt).toLocaleDateString('fr-FR'):'Votre portefeuille, votre journal';
  renderChart(data);$('log').replaceChildren();
  const events=data.events||[];$('event-count').textContent=events.length+' ÉVÉNEMENT(S)';
  if(!events.length)$('log').append(node('p','empty','Aucune décision enregistrée. Le bot peut attendre sans ouvrir de position.'));
  for(const e of events){const row=node('div','log-row');row.append(node('time','',new Date(e.time).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})),node('span','log-tag '+(e.kind.includes('skip')?'skip':''),e.kind==='open'?'[ENTRÉE]':e.kind==='close'?'[SORTIE]':e.kind==='decision'?'[GPT]':'[ATTENTE]'),node('p','',e.text+(Number.isFinite(e.net)?' · '+money(e.net,true):'')));$('log').append(row);}
  $('positions').replaceChildren();
  if(!data.positions?.length)$('positions').append(node('p','empty','En attente d’un signal validé. Le bot ne force pas d’entrée.'));
  for(const p of data.positions||[]){const card=node('article','position'),top=node('div','position-title'),meta=node('div','position-meta');top.append(node('span','',p.asset+' / USDT'),node('span','side '+(p.side==='SHORT'?'short':''),p.side+' · 1×'));meta.append(node('span','','ENTRÉE '+p.entry.toFixed(p.entry<10?4:2)),node('span','','PRIX '+p.mark.toFixed(p.mark<10?4:2)));card.append(top,meta,node('strong',p.pnl<0?'negative':'',money(p.pnl,true)),node('div','targets','STOP '+p.stop.toFixed(p.stop<10?4:2)+' · TP '+p.take.toFixed(p.take<10?4:2)));$('positions').append(card);}
  $('tape').replaceChildren();const trades=data.trades||[];$('trade-summary').textContent=trades.length+' DERNIÈRES CLÔTURES';
  if(!trades.length)$('tape').append(node('span','empty','Aucun trade clôturé dans ce portefeuille.'));
  for(const t of [...trades].reverse().slice(0,20)){const card=node('div','trade'+(t.net<0?' loss':''));card.append(node('div','asset',t.asset),node('small','',t.side),node('b','',money(t.net,true)));card.title=t.reason+' · '+new Date(t.exitedAt).toLocaleString('fr-FR');$('tape').append(card);}
  $('week-progress').value=data.progress||0;$('week-percent').textContent=Math.round((data.progress||0)*100)+'%';$('week-label').textContent=data.endsAt?'Fin prévue : '+new Date(data.endsAt).toLocaleString('fr-FR'):'5 jours d’exploration · 2 jours de validation';
  $('profiles').replaceChildren();
  for(const name of ['exploration','balanced','selective']){const lane=(data.lanes||[]).find(l=>l.market===market&&l.source==='autonomous'&&l.profile===name),button=node('button','profile'+(profile===name?' chosen':'')),title=node('span','name');title.append(node('span','',labels[name]),node('span','',profile===name?'SUIVI':'GPT'));button.append(title,node('div','hint',name==='exploration'?'Plus de signaux étudiés':name==='balanced'?'Compromis de confiance':'Signaux les plus sélectifs'),node('b',lane?.net<0?'negative':'',lane?money(lane.net,true):'—'),node('span','count',lane?(lane.closed+' clos · '+lane.open+' ouverts'):'À observer'));button.addEventListener('click',()=>{profile=name;refresh();});$('profiles').append(button);}
  $('pause').textContent=data.paused?'Reprendre les entrées':'Pause des entrées';$('pause').disabled=!data.active||demo;$('stop').disabled=!data.active||demo;$('export').disabled=!s||demo;$('new-run').disabled=data.active||data.busy||demo;$('start').disabled=data.active;$('start').textContent=data.startedAt?'Reprendre la simulation ↗':'Préparer la simulation ↗';
  $('limits').textContent=s?'GPT aujourd’hui : '+(data.api?.calls||0)+'/'+(data.api?.maxCalls||144)+' appels · '+(data.api?.reservedTokens||0)+' tokens réservés':'Aucun résultat garanti · capital entièrement fictif';
  if(data.startedAt){$('run-spot').checked=data.markets?.includes('spot')===true;$('run-futures').checked=data.markets?.includes('futures')===true;$('capital').value=s?.initial||1000;$('capital').disabled=true;$('run-spot').disabled=true;$('run-futures').disabled=true;}else{$('capital').disabled=false;$('run-spot').disabled=false;$('run-futures').disabled=false;}
}
function demoState(){
  const now=Date.now(),initial=1000,pnl=market==='futures'?286:147;
  return {status:'running',active:false,mode:'paper',startedAt:now-86400000,endsAt:now+6*86400000,updatedAt:now,progress:1/7,phase:'exploration',dataGaps:0,selected:{initial,equity:initial+pnl,pnl,pnlPct:pnl/10,drawdown:.032,closed:21,wins:15,losses:6,winRate:15/21},history:Array.from({length:80},(_,i)=>({time:now-86400000+i*86400000/79,value:initial+pnl*i/79+Math.sin(i*.8)*10})),lanes:['exploration','balanced','selective'].map((p,i)=>({market,source:'autonomous',profile:p,net:pnl-(i-1)*31,closed:21-i*3,open:2})),positions:[{asset:'BTC',side:'LONG',entry:60100,mark:60400,stop:59198.5,take:61903,pnl:2.49},{asset:'SOL',side:market==='futures'?'SHORT':'LONG',entry:145,mark:144.4,stop:147.17,take:140.65,pnl:market==='futures'?1.8:-1.8}],trades:[{asset:'BTC',side:'LONG',net:4.2,reason:'Exemple fictif',exitedAt:now},{asset:'SOL',side:'SHORT',net:-1.1,reason:'Exemple fictif',exitedAt:now}],events:[{time:now,kind:'decision',text:'BTC · LONG · Exemple de décision fictive'},{time:now-60000,kind:'skip',text:'SOL · WAIT · Exemple de signal écarté'},{time:now-120000,kind:'close',text:'ETH · clôture fictive',net:3.4}],api:{calls:18,maxCalls:144,reservedTokens:20000}};
}
async function refresh(){
  if(updating)return;updating=true;
  try{snapshot=await call('state',market+':autonomous:'+profile);$('version').textContent=snapshot.version;$('chatgpt-state').textContent=snapshot.chatgpt.connected?(snapshot.chatgpt.email+' · '+(snapshot.chatgpt.sharing?'Utilisation du forfait autorisée':'Forfait non autorisé')):'Compte non connecté';$('mexc-state').textContent=snapshot.mexc.connected?'Lecture Spot vérifiée'+(snapshot.mexc.futuresRead?' · Futures vérifiée':''):'Compte non connecté · prix publics disponibles';$('connection-summary').textContent=snapshot.chatgpt.connected?'CHATGPT CONNECTÉ · FORFAIT PERSONNEL':'CHATGPT NON CONNECTÉ';$('chatgpt-disconnect').disabled=!snapshot.chatgpt.connected;$('mexc-disconnect').disabled=!snapshot.mexc.connected;if(!demo&&snapshot.dashboard.selected?.id){[market,,profile]=snapshot.dashboard.selected.id.split(':');for(const b of document.querySelectorAll('[data-market]'))b.classList.toggle('selected',b.dataset.market===market);}render(demo?demoState():snapshot.dashboard);if(!initialized){initialized=true;if(!snapshot.chatgpt.connected)showSetup();else loadModels().catch(()=>{});}}
  catch(e){toast(e.message);}finally{updating=false;}
}
async function loadModels(){
  models=await call('models');$('model').replaceChildren();
  if(!models.length)$('model').append(new Option('Aucun modèle GPT disponible',''));
  for(const m of models)$('model').append(new Option(m.name,m.id));
  const saved=snapshot?.dashboard.model;if(saved&&models.some(m=>m.id===saved))$('model').value=saved;else{const cheap=models.find(m=>m.id.includes('luna'));if(cheap)$('model').value=cheap.id;}
}
async function action(fn){try{await fn();await refresh();}catch(e){toast(e.message);}}
for(const id of ['setup-open','settings-open','start'])$(id).addEventListener('click',()=>{demo=false;document.body.classList.remove('demo-mode');refresh();showSetup();});
$('setup-close').addEventListener('click',()=>$('setup').close());$('dashboard-nav').addEventListener('click',()=>{demo=false;document.body.classList.remove('demo-mode');refresh();});
$('tutorial-open').addEventListener('click',()=>$('guide').showModal());$('guide-close').addEventListener('click',()=>$('guide').close());
for(const b of document.querySelectorAll('[data-theme-choice]'))b.addEventListener('click',()=>{document.body.dataset.theme=b.dataset.themeChoice;localStorage.setItem('maxibot-theme',b.dataset.themeChoice);});
const theme=localStorage.getItem('maxibot-theme');if(['mint','night','berry','light'].includes(theme))document.body.dataset.theme=theme;
for(const b of document.querySelectorAll('[data-market]'))b.addEventListener('click',()=>{market=b.dataset.market;for(const other of document.querySelectorAll('[data-market]'))other.classList.toggle('selected',other===b);refresh();});
$('chatgpt-connect').addEventListener('click',()=>action(async()=>{$('chatgpt-connect').disabled=true;try{const result=await call('connectChatGPT',snapshot?.chatgpt.connected===true);if(result.sharing){toast('Vous utilisez votre forfait ChatGPT pour les requêtes éligibles. Gérez les limites dans les réglages ChatGPT.');await loadModels();}else toast(errors.CHATGPT_PLAN_DISABLED);}finally{$('chatgpt-connect').disabled=false;}}));
$('chatgpt-disconnect').addEventListener('click',()=>action(async()=>{await call('disconnectChatGPT');models=[];$('model').replaceChildren(new Option('Connectez ChatGPT pour choisir',''));toast('Connexion effacée de cet appareil. La révocation distante n’a pas été confirmée ; gérez l’autorisation dans les réglages ChatGPT.');}));
$('refresh-models').addEventListener('click',()=>action(loadModels));$('usage').addEventListener('click',()=>action(()=>call('openGuide','chatgpt')));
for(const id of ['mexc-guide','guide-mexc'])$(id).addEventListener('click',()=>action(()=>call('openGuide','mexc')));$('guide-chatgpt').addEventListener('click',()=>action(()=>call('openGuide','chatgpt')));
$('mexc-form').addEventListener('submit',e=>{e.preventDefault();action(async()=>{$('mexc-save').disabled=true;try{await call('connectMexc',{spotKey:$('spot-key').value.trim(),spotSecret:$('spot-secret').value.trim(),futuresKey:$('futures-key').value.trim(),futuresSecret:$('futures-secret').value.trim()});for(const id of ['spot-key','spot-secret','futures-key','futures-secret'])$(id).value='';toast('Connexion MEXC en lecture vérifiée. Clés enregistrées dans le stockage protégé de Windows.');}finally{$('mexc-save').disabled=false;}});});
$('mexc-disconnect').addEventListener('click',()=>action(()=>call('disconnectMexc')));
$('run-form').addEventListener('submit',e=>{e.preventDefault();action(async()=>{$('run-submit').disabled=true;try{demo=false;document.body.classList.remove('demo-mode');await call('start',{model:$('model').value,capital:Number($('capital').value),markets:[$('run-spot').checked?'spot':null,$('run-futures').checked?'futures':null].filter(Boolean)});$('setup').close();}finally{$('run-submit').disabled=false;}});});
$('pause').addEventListener('click',()=>action(()=>call('pause',!snapshot.dashboard.paused)));$('stop').addEventListener('click',()=>action(()=>call('stop')));
$('export').addEventListener('click',()=>action(()=>call('exportReport')));$('new-run').addEventListener('click',()=>action(async()=>{await call('newRun');toast('Ancien journal archivé sur ce PC. Un nouvel essai peut être préparé.');showSetup();}));
$('demo').addEventListener('click',()=>{demo=true;document.body.classList.add('demo-mode');$('setup').close();render(demoState());});
if(api){refresh();setInterval(refresh,3000);api.onUpdate(refresh);}else toast('Cette interface doit être ouverte depuis Maxibot 2.0.');
