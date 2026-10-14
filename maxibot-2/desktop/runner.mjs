import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../core/io.mjs';
import { Mexc } from '../core/mexc.mjs';
import { decisionRequest, parseDecisionResult } from '../core/gpt.mjs';
import { initialState, advance, applyDecision, buildReport, dayKey, equity } from '../core/engine.mjs';
import { readSignals } from '../core/signals.mjs';
import { readDashboard } from '../web/data.mjs';

export class Runner {
  constructor(dir, config, chatgpt, mexc = new Mexc(), notify = () => {}) {
    this.dir = dir; mkdirSync(dir, { recursive: true });
    this.store = new Store(join(dir, 'bot.sqlite'));
    this.state = this.store.load(); this.config = this.state?.config || structuredClone(config);
    this.chatgpt = chatgpt; this.mexc = mexc; this.notify = notify;
    this.active = false; this.paused = false; this.busy = false; this.timer = null; this.lastError = null;
  }
  async start(model, capital = this.config.virtualCapitalUSDT, markets = this.config.markets) {
    if (this.active) return this.snapshot();
    if (!model?.startsWith('gpt-')) throw new Error('GPT_MODEL_REQUIRED');
    if (!Number.isFinite(capital) || capital < 50 || capital > 1e7 || !Array.isArray(markets) || !markets.length || markets.some(m => !['spot','futures'].includes(m)) || new Set(markets).size !== markets.length) throw new Error('CONFIG_INVALID');
    if (this.state?.status && this.state.status !== 'running') throw new Error('SIMULATION_FINISHED');
    if (this.state && this.state.config.chatGPTModel !== model) throw new Error('MODEL_FROZEN_FOR_WEEK');
    if (!this.state) this.config = { ...this.config, chatGPTModel: model, virtualCapitalUSDT: capital, ticketUSDT: Math.min(50, capital), markets };
    if (!this.chatgpt.session().sharing) throw new Error('CHATGPT_PLAN_DISABLED');
    this.active = true; this.paused = false; await this.cycle(); return this.snapshot();
  }
  stop() { this.active = false; clearTimeout(this.timer); this.timer = null; }
  pause(value) { this.paused = value === true; return this.snapshot(); }
  async cycle() {
    if (this.busy || !this.active) return;
    this.busy = true;
    try { this.lastError = null; await this.tick(); }
    catch (e) { this.lastError = e.message?.match(/^[A-Z0-9_]+$/) ? e.message : 'NETWORK_OR_DATA_ERROR'; }
    finally {
      this.busy = false; this.notify(this.snapshot());
      if (this.active && this.state?.status !== 'running' && this.state) this.active = false;
      if (this.active) this.timer = setTimeout(() => this.cycle(), this.config.pollSeconds * 1000);
    }
  }
  async tick() {
    const c = this.config, events = [], quotes = {};
    for (const market of c.markets) for (const asset of c.symbols) {
      if (!this.active) return;
      try { const q = await this.mexc.snapshot(asset, market); quotes[q.id] = q; events.push({ kind:'snapshot', time:Date.now(), data:q }); }
      catch { events.push({ kind:'market_skip', time:Date.now(), data:{market,asset,reason:'MEXC_DATA_UNAVAILABLE'} }); }
    }
    if (!this.active) return;
    if (!this.state) {
      if (Object.keys(quotes).length !== c.markets.length * c.symbols.length) throw new Error('MEXC_DATA_INCOMPLETE');
      this.state = initialState(c, Date.now());
    }
    const s = this.state, tick = Date.now();
    if (Object.keys(quotes).length !== c.markets.length * c.symbols.length) s.dataGaps++;
    advance(s, quotes, c, tick, events);
    const incoming = readSignals(join(this.dir,'signals.jsonl'), s, c, tick), candidates = [];
    for (const r of incoming.rejected) { if(r.id)s.processedSignals.push(r.id); events.push({kind:'signal_skip',time:tick,data:r}); }
    for (const signal of incoming.signals) {
      const q = quotes[signal.market + ':' + signal.asset]; if (!q) continue;
      s.processedSignals.push(signal.id);
      if (signal.action === 'CLOSE') applyDecision(s,{id:'copy:'+signal.id,snapshot:q,source:'copy',signal},{action:'CLOSE',confidence:1},c,tick,quotes,events);
      else candidates.push({id:'copy:'+signal.id,snapshot:q,source:'copy',signal});
    }
    if (tick-s.lastDecisionAt >= c.decisionSeconds*1000) {
      for (const q of Object.values(quotes)) if(q.spreadBps<=c.maxSpreadBps)candidates.push({id:'auto:'+q.id,snapshot:q,source:'autonomous',signal:null});
      s.lastDecisionAt = tick;
    }
    if (s.api.day !== dayKey(tick)) s.api = {day:dayKey(tick),calls:0,tokens:0};
    if (candidates.length && s.status === 'running' && !this.paused && this.active) {
      for (const item of candidates) item.activeDirections = Object.values(s.lanes).filter(l=>l.source===item.source&&l.market===item.snapshot.market).flatMap(l=>l.positions.filter(p=>p.snapshotId===item.snapshot.id).map(p=>({profile:l.profile.name,action:p.side===1?'LONG':'SHORT',leader:p.leader})));
      s.api.calls++;
      this.store.save(s,events.splice(0));
      try {
          const out = parseDecisionResult(await this.chatgpt.response(decisionRequest(candidates,c,c.chatGPTModel)), candidates);
          s.api.tokens+=Math.max(0,out.usage.total_tokens);
          events.push({kind:'gpt',time:Date.now(),data:{decisions:out.decisions,usage:out.usage,model:c.chatGPTModel}});
          for (const id of [...new Set(candidates.map(item=>item.snapshot.id))]) {
            const old=quotes[id];
            try {quotes[id]=await this.mexc.snapshot(old.asset,old.market);}
            catch {delete quotes[id];s.dataGaps++;events.push({kind:'post_gpt_quote_skip',data:{id,reason:'MEXC_DATA_UNAVAILABLE'}});}
          }
          const now=Date.now(); advance(s,quotes,c,now,events);
          for(const d of out.decisions) {
            const item=candidates.find(item=>item.id===d.id);
            if ((!this.active || this.paused) && ['LONG','SHORT'].includes(d.action)) events.push({kind:'stop_skip',data:{id:d.id}});
            else if(item.signal&&now-item.signal.time>c.maxSignalAgeSeconds*1000) events.push({kind:'signal_skip',data:{id:item.signal.id,reason:'expired_during_gpt'}});
            else applyDecision(s,item,d,c,now,quotes,events);
          }
      } catch(e) {
          const reason=e.message?.match(/^[A-Z0-9_]+$/)?e.message:'GPT_RESPONSE_INVALID';
          events.push({kind:'gpt_skip',time:Date.now(),data:{reason}});
          this.lastError=reason;
          if (['CHATGPT_USAGE_LIMIT','CHATGPT_RECONNECT','CHATGPT_PLAN_DISABLED'].includes(reason)) this.paused=true;
      }
    }
    s.updatedAt=Date.now();
    for(const lane of Object.values(s.lanes))events.push({kind:'portfolio',time:s.updatedAt,data:{lane:lane.id,equity:equity(lane,quotes)}});
    this.store.save(s,events);
    writeFileSync(join(this.dir,'report.json'),JSON.stringify(buildReport(s),null,2));
    if (events.some(e=>e.kind==='close')) this.notify({ notification:'Position fictive clôturée' });
  }
  snapshot(laneId) {
    const view=readDashboard(join(this.dir,'bot.sqlite'),laneId);
    const lane=this.state?.lanes[view.selected?.id];
    view.trades=(lane?.closed||[]).slice(-50).map(t=>({id:t.id,asset:t.snapshotId.split(':')[1],side:t.side===1?'LONG':'SHORT',net:t.net,exit:t.exit,entry:t.entry,exitedAt:t.exitedAt,reason:t.reason}));
    return {...view,active:this.active,busy:this.busy,paused:this.paused,lastError:this.lastError,model:this.config.chatGPTModel||null,markets:this.config.markets};
  }
  close() { this.stop(); this.store.close(); }
}
