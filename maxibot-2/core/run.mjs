import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { Store, loadConfig, sleep, acquireLock } from './io.mjs';
import { Mexc } from './mexc.mjs';
import { judge } from './gpt.mjs';
import { initialState, advance, applyDecision, buildReport, dayKey, equity } from './engine.mjs';
import { readSignals } from './signals.mjs';

const command=process.argv[2]??'help';
const dataDir=process.env.BOT_DATA_DIR??'data';
mkdirSync(dataDir,{recursive:true});
if (command==='account-check') {
  try { console.log(JSON.stringify(await new Mexc().accountCheck(),null,2)); } catch(e) { console.error(e.message); process.exitCode=1; }
} else if (command==='status' || command==='report') {
  const store=new Store(`${dataDir}/bot.sqlite`), state=store.load();
  if (!state) { console.log('Aucune simulation lancée.'); process.exitCode=1; }
  else { const report=buildReport(state); console.log(JSON.stringify(report,null,2)); if(command==='report') writeFileSync(`${dataDir}/report.json`,JSON.stringify(report,null,2)); }
  store.close();
} else if (command==='paper' || command==='once') {
  const config=loadConfig();
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL?.startsWith('gpt-')) throw new Error('Configurer les variables OpenAI dans .env avant le lancement');
  const release=acquireLock(`${dataDir}/run.lock`), store=new Store(`${dataDir}/bot.sqlite`), mexc=new Mexc();
  let state=store.load(), stopping=false;
  process.on('SIGINT',()=>{stopping=true;}); process.on('SIGTERM',()=>{stopping=true;});
  try {
    if (state && JSON.stringify(state.config)!==JSON.stringify(config)) throw new Error('Configuration changée pendant le test. Utiliser un autre BOT_DATA_DIR pour un nouvel essai.');
    while(!stopping) {
      if(state && state.status!=='running') { console.log('Test terminé. Utiliser la commande report.'); break; }
      const events=[], quotes={}, now=Date.now();
      // Vérifier le réseau AVANT de démarrer l'horloge des sept jours.
      for(const market of config.markets) for(const asset of config.symbols) {
        try { const q=await mexc.snapshot(asset,market); quotes[q.id]=q; events.push({kind:'snapshot',time:Date.now(),data:q}); }
        catch(e) { events.push({kind:'market_skip',time:Date.now(),data:{market,asset,reason:e.message}}); }
      }
      if(!state) {
        if(Object.keys(quotes).length!==config.markets.length*config.symbols.length) throw new Error('Données MEXC incomplètes : la semaine ne démarre pas');
        state=initialState(config,Date.now());
      }
      const tick=Date.now();
      if(Object.keys(quotes).length!==config.markets.length*config.symbols.length) state.dataGaps++;
      if(state.status!=='running') { console.log('Test terminé. Utiliser la commande report.'); break; }
      advance(state,quotes,config,tick,events);
      const candidates=[];
      const incoming=readSignals(`${dataDir}/signals.jsonl`,state,config,tick);
      for(const r of incoming.rejected) { if(r.id)state.processedSignals.push(r.id); events.push({kind:'signal_skip',time:tick,data:r}); }
      for(const signal of incoming.signals) {
        const q=quotes[`${signal.market}:${signal.asset}`];
        if(!q)continue; // Reconsidéré au prochain cycle seulement si toujours frais.
        state.processedSignals.push(signal.id);
        if(signal.action==='CLOSE') applyDecision(state,{id:`copy:${signal.id}`,snapshot:q,source:'copy',signal},{action:'CLOSE',confidence:1},config,tick,quotes,events);
        else candidates.push({id:`copy:${signal.id}`,snapshot:q,source:'copy',signal});
      }
      if(tick-state.lastDecisionAt>=config.decisionSeconds*1000) {
        for(const q of Object.values(quotes)) if(q.spreadBps<=config.maxSpreadBps) candidates.push({id:`auto:${q.id}`,snapshot:q,source:'autonomous',signal:null});
        state.lastDecisionAt=tick;
      }
      if(state.api.day!==dayKey(tick)) state.api={day:dayKey(tick),calls:0,tokens:0};
      if(candidates.length && state.status==='running' && !existsSync(`${dataDir}/STOP`)) {
        for(const candidate of candidates) candidate.activeDirections=Object.values(state.lanes).filter(l=>l.source===candidate.source && l.market===candidate.snapshot.market).flatMap(l=>l.positions.filter(p=>p.snapshotId===candidate.snapshot.id).map(p=>({profile:l.profile.name,action:p.side===1?'LONG':'SHORT',leader:p.leader})));
        if(state.api.calls>=config.maxCallsPerDay) events.push({kind:'gpt_budget_skip',time:tick,data:{candidates:candidates.map(c=>c.id)}});
        else {
          state.api.calls++;
          store.save(state,events.splice(0));
          try {
            const out=await judge(candidates,config);
            state.api.tokens+=Math.max(0,out.usage.total_tokens);
            events.push({kind:'gpt',time:Date.now(),data:{decisions:out.decisions,usage:out.usage,model:process.env.OPENAI_MODEL}});
            // Rafraîchir les cotations après la latence GPT : aucune exécution au prix d'avant l'appel.
            const affected=[...new Set(candidates.map(c=>c.snapshot.id))];
            for(const id of affected) {
              const old=quotes[id];
              try { quotes[id]=await mexc.snapshot(old.asset,old.market); }
              catch(e) { delete quotes[id]; state.dataGaps++; events.push({kind:'post_gpt_quote_skip',data:{id,reason:e.message}}); }
            }
            const executionTime=Date.now();
            // Gérer stops et changement de phase sur les prix nouveaux avant toute entrée.
            advance(state,quotes,config,executionTime,events);
            for(const d of out.decisions) {
              const candidate=candidates.find(c=>c.id===d.id);
              if(existsSync(`${dataDir}/STOP`) && ['LONG','SHORT'].includes(d.action)) events.push({kind:'stop_skip',data:{id:d.id}});
              else if(candidate.signal && executionTime-candidate.signal.time>config.maxSignalAgeSeconds*1000) events.push({kind:'signal_skip',data:{id:candidate.signal.id,reason:'expired_during_gpt'}});
              else applyDecision(state,candidate,d,config,executionTime,quotes,events);
            }
          } catch(e) { events.push({kind:'gpt_skip',time:Date.now(),data:{reason:e.message}}); }
        }
      }
      state.updatedAt=Date.now();
      for(const lane of Object.values(state.lanes)) events.push({kind:'portfolio',time:state.updatedAt,data:{lane:lane.id,equity:equity(lane,quotes)}});
      store.save(state,events);
      writeFileSync(`${dataDir}/report.json`,JSON.stringify(buildReport(state),null,2));
      console.log(JSON.stringify({time:new Date().toISOString(),status:state.status,cycles:state.cycles,apiCallsToday:state.api.calls,positions:Object.values(state.lanes).reduce((s,l)=>s+l.positions.length,0)}));
      if(command==='once' || state.status!=='running')break;
      await sleep(Math.max(1000,config.pollSeconds*1000-(Date.now()-now)));
    }
  } finally { store.close(); release(); }
} else {
  console.log('Node 24 — paper | once | account-check | status | report. Aucun ordre réel dans cette V1.');
}
