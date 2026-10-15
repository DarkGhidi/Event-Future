import { join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { Store } from '../core/io.mjs';
import { freshPortfolio,available,reserved,log,reserveOrder,rejectOrder,settleOrder,settleFuturesHistory,markPortfolio } from './portfolio.mjs';
import { planRequest,parsePlan } from './planner.mjs';
import { finite,ApiError,floorStep } from './mexc.mjs';
import { matchMexcToken } from './fomoapi.mjs';
const DAY=86400000,TRAINING=7*DAY;
export class AutonomousRunner {
  constructor(dir,config,chatgpt,broker,notify=()=>{},options={}){
    this.config=config;this.chatgpt=chatgpt;this.broker=broker;this.notify=notify;this.clock=options.clock??Date.now;this.trainingRequired=options.trainingRequired??TRAINING;
    this.store=new Store(join(dir,'execution.sqlite'));this.state=this.store.load();this.busy=false;this.timer=null;this.shutdown=false;this.generation=0;this.lastError=null;this.universe=[];this.universeAt=0;this.sourceFile=null;this.fomo=options.fomo??null;this.copyEntrySince=Infinity;
    if(this.state){
      const wantedResume=this.state.resumeOnLaunch??(this.state.enabled===true);
      this.state.api??={day:new Date(this.clock()).toISOString().slice(0,10),calls:0,tokens:0};
      if(this.state.api.tokenAccountingVersion!==2){
        // Older builds kept the full per-call reserve after GPT returned HTTP errors.
        // If no plan was ever accepted, that estimate is not a real token-usage figure.
        if((this.state.training?.decisions??0)===0)this.state.api.tokens=0;
        this.state.api.tokenAccountingVersion=2;
      }
      this.state.resumeOnLaunch=this.state.portfolio.mode==='paper'&&wantedResume;
      this.state.enabled=this.state.resumeOnLaunch;
      if(!this.state.enabled)this.state.pauseReason??=null;
      this.save();if(this.active)this.timer=setTimeout(()=>this.cycle(),100);
    }
  }
  get hasExposure(){return !!this.state&&(this.state.portfolio.positions.length>0||this.state.portfolio.orders.some(o=>!o.settled));}
  get active(){return !!this.state?.enabled||this.hasExposure;}
  save(){if(this.state&&!this.closed)this.store.save(this.state);}
  async start(capital){
    if(this.starting||this.closed)throw new Error('CYCLE_BUSY');this.starting=true;this.shutdown=false;const generation=this.generation;
    try{return await this.activate(capital,generation);}finally{this.starting=false;}
  }
  async activate(capital,generation){
    if(this.busy)throw new Error('CYCLE_BUSY');if(!Number.isFinite(capital)||capital<=0||capital>1e7)throw new Error('CAPITAL_INVALID');
    if(!this.chatgpt.session().sharing)throw new Error('CHATGPT_PLAN_DISABLED');
    if(this.state?.portfolio.mode==='live')throw new Error('LIVE_TRADING_DISABLED');
    if(this.state&&capital!==this.state.portfolio.allocated&&(this.hasExposure||this.state.enabled))throw new Error('CAPITAL_STILL_ENGAGED');
    this.access=await this.broker.connectCheck();if(this.state?.uid&&this.state.uid!==this.access.uid)throw new Error('MEXC_ACCOUNT_CHANGED');
    const models=await this.chatgpt.models();if(!models.length)throw new Error('GPT_MODELS_UNAVAILABLE');
    if(!this.state)this.state={version:2,uid:this.access.uid,enabled:false,portfolio:freshPortfolio(capital),training:{coveredMs:0,decisions:0,lastHealthy:null},model:models[0].id,api:{day:new Date(this.clock()).toISOString().slice(0,10),calls:0,tokens:0},lastDecision:0,processed:[],trainingArchive:null};
    if(this.state.portfolio.reconcileFault)throw new Error(this.state.portfolio.reconcileFault);
    if(this.state.portfolio.mode==='live'){const a=await this.broker.accounts();if(available(this.state.portfolio)+capital-this.state.portfolio.allocated>a.spot+a.futures+.01)throw new Error('MEXC_FUNDS_INSUFFICIENT');}
    if(this.generation!==generation||this.shutdown)return this.snapshot();
    if(capital!==this.state.portfolio.allocated){this.state.portfolio.cash+=capital-this.state.portfolio.allocated;this.state.portfolio.allocated=capital;}
    this.state.model=models.find(m=>m.id===this.state.model)?.id??models[0].id;this.copyEntrySince=this.clock();this.state.enabled=true;this.state.resumeOnLaunch=this.state.portfolio.mode==='paper';this.state.pauseReason=null;this.shutdown=false;this.generation++;this.save();clearTimeout(this.timer);this.timer=setTimeout(()=>this.cycle(),0);return this.snapshot();
  }
  off(){this.generation++;if(this.state){this.state.enabled=false;this.state.resumeOnLaunch=false;this.state.pauseReason=null;this.save();}return this.snapshot();}
  stop({retainSimulation=false}={}){if(this.closed)return;this.generation++;if(this.state){this.state.enabled=false;if(!retainSimulation)this.state.resumeOnLaunch=false;this.save();}this.shutdown=true;clearTimeout(this.timer);this.timer=null;}
  close(){if(this.closed)return;this.stop({retainSimulation:true});this.store.close();this.closed=true;}
  async cycle(){
    if(this.busy||this.shutdown||!this.state)return;this.busy=true;
    try{this.lastError=null;await this.tick();}catch(e){this.lastError=/^[A-Z0-9_]+$/.test(e.message)?e.message:'NETWORK_OR_DATA_ERROR';log(this.state.portfolio,'skip',this.lastError);this.state.training.lastHealthy=null;if(this.state.enabled&&(this.lastError.startsWith('CHATGPT_')||this.lastError.startsWith('GPT_'))){this.state.enabled=false;this.state.resumeOnLaunch=false;this.state.pauseReason=this.lastError;}this.save();}
    finally{this.busy=false;this.notify(this.snapshot());if(!this.shutdown&&this.active)this.timer=setTimeout(()=>this.cycle(),15000);}
  }
  async reconcile(){
    const s=this.state.portfolio;
    for(const o of s.orders.filter(o=>!o.settled)){
      if(s.mode==='paper'){this.paperFill(o);continue;}
      try{
        const status=await this.broker.orderStatus(o);o.exchangeId=String(status.orderId);o.status='seen';
        const terminal=o.plan.market==='spot'?['FILLED','CANCELED','PARTIALLY_CANCELED','REJECTED','EXPIRED'].includes(status.status):[3,4,5].includes(Number(status.state));
        if(!terminal){if(this.clock()-o.sentAt>30000||!this.state.enabled&&o.kind==='open')await this.broker.cancel(o);continue;}
        const amount=o.plan.market==='spot'?finite(status.executedQty):finite(status.dealVol);if(amount===0){settleOrder(s,o,{quantity:0});this.save();continue;}
        const f=await this.broker.fills(o,status);settleOrder(s,o,f);this.save();
      }catch(e){o.status='unknown';this.lastError='ORDER_RESULT_UNKNOWN';log(s,'reconcile','Ordre '+o.id.slice(-8)+' en attente de vérification ; budget réservé.');this.save();}
    }
    if(s.mode==='live'&&s.positions.some(p=>p.plan.market==='futures')){
      const exchange=await this.broker.positions();
      for(const p of [...s.positions].filter(p=>p.plan.market==='futures')){
        const row=exchange.find(x=>String(x.positionId)===p.exchangePositionId&&finite(x.holdVol)>0);
        if(!row){const history=await this.broker.historicalPosition(p);if(history)settleFuturesHistory(s,p,history);else{s.reconcileFault='FUTURES_POSITION_UNRESOLVED';this.lastError=s.reconcileFault;}continue;}
        const waiting=s.orders.filter(o=>o.positionId===p.id&&!o.settled&&o.status==='await_history');const closedQty=s.orders.filter(o=>o.positionId===p.id&&o.fill).reduce((n,o)=>n+o.fill.quantity,0);if(waiting.length&&finite(row.holdVol)>(p.originalQuantity-closedQty)+1e-8){this.lastError='MEXC_POSITION_SYNC_PENDING';continue;}for(const o of waiting){o.settled=true;o.status='partial_close_confirmed';}
        if(row.openType!==1||finite(row.holdVol)>p.quantity+1e-8){s.reconcileFault='POSITION_CHANGED_OUTSIDE_BOT';this.state.enabled=false;continue;}
        if(row.autoAddIm===true){s.reconcileFault='POSITION_CHANGED_OUTSIDE_BOT';this.state.enabled=false;if(row.autoAddIm===true)await this.broker.disableAutoMargin(p.exchangePositionId);}
        // Actual remaining quantity handles native TP/SL and partial closes without repeating exits.
        p.quantity=finite(row.holdVol);if(!p.marginConfirmed){const delta=finite(row.im)-p.principal;s.cash-=delta;p.principal=finite(row.im);p.marginConfirmed=true;if(s.cash<0){s.reconcileFault='RESERVE_EXCEEDED';this.state.enabled=false;}}else if(finite(row.im)>p.principal+.01){s.reconcileFault='POSITION_CHANGED_OUTSIDE_BOT';this.state.enabled=false;}p.unrealized=finite(row.unRealizedPnl)+finite(row.holdFee)+finite(row.closeProfitLoss??0)-Math.max(0,Math.abs(finite(row.totalFee))-p.entryFee);
        const liquidation=finite(row.liquidatePrice);const protectedStop=p.plan.side==='LONG'?p.plan.stop>liquidation:p.plan.stop<liquidation;
        if(!protectedStop){this.state.enabled=false;log(s,'reconcile','Stop trop proche de la liquidation réelle : sortie de protection.');await this.closePosition(p,'protection_liquidation');}
        if(!p.autoMarginConfirmed){await this.broker.disableAutoMargin(p.exchangePositionId);p.autoMarginConfirmed=true;}
        if(p.protected!==true){this.state.enabled=false;log(s,'reconcile','Protection Futures non confirmée : sortie de protection.');await this.closePosition(p,'native_protection_missing');}
      }
    }
    if(s.reconcileFault==='FUTURES_POSITION_UNRESOLVED'&&!s.positions.some(p=>p.plan.market==='futures'))delete s.reconcileFault;
    this.save();
  }
  paperFill(o){const s=this.state.portfolio,p=o.plan;if(o.kind==='open'){const price=p.referencePrice;const qty=p.market==='spot'?p.notional/price:p.quantity;settleOrder(s,o,{quantity:qty,price,quote:p.notional,fee:p.notional*p.fee,baseFee:0,positionId:'paper-'+o.id});}else{const position=s.positions.find(p=>p.id===o.positionId);if(!position)return;const price=position.mark,quote=position.quantity*price;if(p.market==='spot')settleOrder(s,o,{quantity:position.quantity,price,quote,fee:quote*p.fee,baseFee:0});else{const gross=(p.side==='LONG'?1:-1)*position.quantity*p.meta.contractSize*(price-position.entry);settleFuturesHistory(s,position,{state:3,holdVol:0,closeProfitLoss:gross,holdFee:position.paperFunding??0,totalFee:position.entryFee+position.quantity*p.meta.contractSize*price*p.fee});o.settled=true;o.status='settled';}}this.save();}
  async submit(o,generation){
    const s=this.state.portfolio;this.save(); // Durable reservation BEFORE any exchange write.
    if(s.mode==='paper'){if(o.kind==='open'&&(!this.state.enabled||this.generation!==generation)){rejectOrder(s,o,'OFF_CANCELLED');this.save();return;}this.paperFill(o);return;}
    if(o.kind==='open'){this.state.enabled=false;rejectOrder(s,o,'LIVE_TRADING_DISABLED');this.save();return;}
    try{const r=await this.broker.submit(o,o.kind==='open'?()=>this.state.enabled&&this.generation===generation&&!this.shutdown:null);o.exchangeId=String(r.orderId??r.data?.orderId??'');o.status='sent';this.save();}
    catch(e){if(e instanceof ApiError&&e.definite){rejectOrder(s,o,e.message);}else{o.status='unknown';this.lastError='ORDER_RESULT_UNKNOWN';log(s,'reconcile','Envoi incertain : aucun renvoi automatique.');}this.save();}
  }
  async closePosition(p,reason){const s=this.state.portfolio;if(s.orders.some(o=>!o.settled&&o.positionId===p.id))return;
    if(s.mode==='live'&&p.plan.market==='spot'){const quantity=floorStep(p.quantity,10**-p.plan.meta.baseAssetPrecision);if(quantity<=0||quantity<finite(p.plan.meta.baseSizePrecision??0)||quantity*p.mark<finite(p.plan.meta.quoteAmountPrecisionMarket??p.plan.meta.quoteAmountPrecision??0)){p.dust=true;log(s,'skip',p.plan.asset+' · reste sous le minimum MEXC, aucun ordre nul envoyé.');this.save();return;}const balances=await this.broker.spotBalances(),free=finite(balances.find(b=>b.asset===p.plan.asset)?.free??0);if(free+1e-12<p.quantity){s.reconcileFault='SPOT_BALANCE_CHANGED_OUTSIDE_BOT';this.state.enabled=false;this.save();return;}}
    const o=reserveOrder(s,p.plan,'close',p);o.reason=reason;await this.submit(o,this.generation);
  }
  async tick(){
    try{await this.reconcile();}catch{this.lastError='RECONCILIATION_FAILED';this.state.enabled=false;log(this.state.portfolio,'reconcile','Réconciliation indisponible : entrées OFF, sorties toujours suivies.');this.save();}const s=this.state.portfolio;
    if(!this.access){this.access=await this.broker.connectCheck();if(this.state.uid!==this.access.uid)throw new Error('MEXC_ACCOUNT_CHANGED');}
    const quotes={};
    // Existing positions and their exits are processed before discovery or GPT.
    for(const p of [...s.positions]){
      let q;try{q=await this.broker.quote({asset:p.plan.asset,market:p.plan.market,meta:p.plan.meta});}catch{this.lastError='POSITION_QUOTE_UNAVAILABLE';this.state.training.lastHealthy=null;log(s,'skip',p.plan.asset+' · cotation indisponible ; les autres sorties continuent.');continue;}quotes[q.id]=q;
      p.mark=p.plan.side==='LONG'?q.bid:q.ask;
      if(s.mode==='paper'&&p.plan.market==='futures'){p.fundingSeen??=[];for(const f of q.fundingHistory??[])if(f.time>p.openedAt&&!p.fundingSeen.includes(f.time)){p.paperFunding=(p.paperFunding??0)-(p.plan.side==='LONG'?1:-1)*p.quantity*p.plan.meta.contractSize*p.mark*f.rate;p.fundingSeen.push(f.time);}}
      if(p.plan.side==='LONG'?(p.mark<=p.plan.stop||p.mark>=p.plan.take):(p.mark>=p.plan.stop||p.mark<=p.plan.take))await this.closePosition(p,'stop_or_take');
    }
    markPortfolio(s,quotes);this.save();
    if(s.drawdown>=this.config.maxDrawdownPct){this.state.enabled=false;this.state.resumeOnLaunch=false;this.state.pauseReason='DRAWDOWN_LIMIT';for(const p of [...s.positions])await this.closePosition(p,'drawdown');this.save();}
    const signals=this.readCopySignals();for(const signal of signals.filter(x=>x.action==='CLOSE')){for(const p of [...s.positions].filter(p=>p.plan.leader===signal.leader&&p.plan.symbol===signal.symbol&&p.plan.market===signal.market))await this.closePosition(p,'leader_exit');}
    const fomoSignals=await this.readFomoSignals();
    if(!this.state.enabled||s.reconcileFault||s.orders.some(o=>!o.settled))return;
    if(!this.universe.length||this.clock()-this.universeAt>300000){this.universe=await this.broker.discovery(this.access);this.universeAt=this.clock();}
    const candidates=[];
    // Give Spot and Futures their own discovery slots so a high-volume futures
    // market cannot crowd every Spot market out of the GPT decision batch.
    const choices=['spot','futures'].flatMap(market=>this.universe.filter(x=>x.market===market).slice(0,8));
    for(const item of choices){try{const q=await this.broker.quote(item);quotes[q.id]=q;if(!s.positions.some(p=>p.plan.symbol===q.symbol&&p.plan.market===q.market))candidates.push({id:'auto:'+q.id,q,source:q.features.volumeRatio>=2?'momentum':'autonomous'});}catch{log(s,'skip',item.asset+' · données indisponibles');}}
    for(const signal of [...signals.filter(x=>x.action!=='CLOSE'),...fomoSignals]){const item=this.universe.find(i=>i.market===signal.market&&i.symbol===signal.symbol);if(!item)continue;try{const q=await this.broker.quote(item);quotes[q.id]=q;if(!s.positions.some(p=>p.plan.symbol===q.symbol&&p.plan.market===q.market))candidates.push({id:'copy:'+signal.id,q,source:signal.fomo?'fomoapi':'copy',fomoEvent:signal.fomo?signal:null,signal:{leader:signal.leader,action:signal.action,...(signal.fomo?{trader:signal.trader,chainId:signal.chainId,contract:signal.contract,observedAt:signal.time,sizeUsd:signal.usdValue,leaderStats:this.fomo.stats(signal.leader),statsUpdatedAt:this.fomo.refreshAt}: {})}});}catch{log(s,'skip','Signal de copie sans cotation exploitable');}}
    for(const p of s.positions){const q=quotes[p.plan.market+':'+p.plan.asset];if(q)candidates.push({id:'position:'+p.id,q,source:p.plan.source,position:p});}
    if(!choices.length||!Object.keys(quotes).length){this.state.training.lastHealthy=null;this.save();return;}
    if(s.mode==='paper'){const now=this.clock(),last=this.state.training.lastHealthy;if(last&&now-last<=120000)this.state.training.coveredMs+=Math.max(0,now-last);this.state.training.lastHealthy=now;
      if(this.state.training.coveredMs>=this.trainingRequired&&!this.state.training.completedAt){this.state.training.completedAt=now;log(s,'mode','Sept jours de simulation couverts. La simulation en données MEXC en direct continue ; aucun ordre réel ne sera envoyé automatiquement.');this.save();}}
    const generation=this.generation;if(this.clock()-this.state.lastDecision<this.config.decisionSeconds*1000&&!candidates.some(c=>c.signal&&!c.position))return;
    this.state.lastDecision=this.clock();const day=new Date(this.clock()).toISOString().slice(0,10);if(this.state.api.day!==day)this.state.api={day,calls:0,tokens:0};
    const a=s.mode==='paper'?{spot:available(s),futures:available(s)}:await this.broker.accounts();
    this.state.api.calls++;this.save();
    let result;try{
      const response=await this.chatgpt.response(planRequest(this.state.model,candidates,{mode:s.mode,available:available(s),closed:s.closed,events:s.events.slice(0,30)},{spot:a.spot,futures:a.futures}));
      if(Number.isFinite(response?.usage?.total_tokens)){this.state.api.tokens+=response.usage.total_tokens;this.save();}
      result=parsePlan(response,candidates);
    }catch(e){
      const code=String(e?.message??'');
      if(code.startsWith('CHATGPT_')||code.startsWith('GPT_')){this.state.enabled=false;this.state.resumeOnLaunch=false;this.state.pauseReason=/^[A-Z0-9_]+$/.test(code)?code:'GPT_ERROR';}
      throw e;
    }
    this.state.training.decisions++;this.save();
    for(const d of result.decisions){const c=candidates.find(c=>c.id===d.id);log(s,'decision',c.q.asset+' · '+c.q.market.toUpperCase()+' · '+c.source.toUpperCase()+' · '+d.action+' · '+d.reason);if(d.action==='CLOSE'&&c.position){await this.closePosition(c.position,'GPT');continue;}if(!['LONG','SHORT'].includes(d.action))continue;
      if(!this.state.enabled||this.generation!==generation||s.orders.some(o=>!o.settled)||s.reconcileFault)break;
      try{
        if(c.fomoEvent&&!this.fomo?.validEntry(c.fomoEvent))throw new Error('FOMO_SIGNAL_EXPIRED');
        const q=await this.broker.quote({asset:c.q.asset,market:c.q.market,meta:c.q.meta});quotes[q.id]=q;const account=s.mode==='paper'?a:await this.broker.accounts();
        if(d.amountUSDT>available(s)||d.amountUSDT>account[q.market])throw new Error('CAPITAL_RESERVED');
        // Direction and absolute exits must remain coherent after GPT latency.
        const entry=d.action==='LONG'?q.ask:q.bid;if(d.action==='LONG'?!(d.stop<entry&&d.take>entry):!(d.stop>entry&&d.take<entry))throw new Error('QUOTE_CHANGED');
        const plan=await this.broker.prepare(q,{...d,source:c.source},d.amountUSDT);plan.referencePrice=entry;if(c.signal)plan.leader=c.signal.leader;
        if(c.fomoEvent){if(!this.fomo?.validEntry(c.fomoEvent))throw new Error('FOMO_SIGNAL_EXPIRED');plan.fomoIdentity=c.fomoEvent.identity;plan.copyEventTime=c.fomoEvent.time;plan.copyTradeId=c.fomoEvent.tradeId;}
        if(!this.state.enabled||this.generation!==generation)break;
        const o=reserveOrder(s,plan);await this.submit(o,generation);await this.reconcile();
      }catch(e){log(s,'skip',c.q.symbol+' · '+(/^[A-Z0-9_]+$/.test(e.message)?e.message:'ORDER_PREPARATION_FAILED'));}
    }
    markPortfolio(s,quotes);this.save();
  }
  readCopySignals(){
    if(!this.sourceFile)return [];
    try{
      if(statSync(this.sourceFile).size>5_000_000)throw new Error('COPY_FEED_TOO_LARGE');
      const out=[];for(const line of readFileSync(this.sourceFile,'utf8').split(/\r?\n/).filter(Boolean)){
        let x;try{x=JSON.parse(line);}catch{continue;}
        if(typeof x.id!=='string'||x.id.length>150||this.state.processed.includes(x.id)||x.venue!=='mexc'||!['spot','futures'].includes(x.market)||typeof x.symbol!=='string'||!/^([A-Z0-9]+USDT|[A-Z0-9]+_USDT)$/.test(x.symbol)||typeof x.leader!=='string'||x.leader.length>100||!['LONG','SHORT','CLOSE'].includes(x.action)||!Number.isFinite(x.time)||x.time>this.clock()+5000||this.clock()-x.time>120000)continue;
        this.state.processed.push(x.id);out.push(x);
      }
      this.state.processed=this.state.processed.slice(-10000);this.save();return out;
    }catch{this.lastError='COPY_FEED_UNAVAILABLE';return [];}
  }
  async readFomoSignals(){
    if(!this.fomo)return [];
    const s=this.state.portfolio,signals=this.fomo.take().filter(x=>!this.state.processed.includes(x.id));
    for(const x of signals)this.state.processed.push(x.id);this.state.processed=this.state.processed.slice(-10000);this.save();
    // A leader exit remains usable while OFF and without metadata/GPT access.
    for(const x of signals.filter(x=>x.action==='CLOSE'))for(const p of [...s.positions].filter(p=>p.plan.source==='fomoapi'&&p.plan.leader===x.leader&&p.plan.fomoIdentity===x.identity&&x.time>=p.plan.copyEventTime))await this.closePosition(p,'FOMOAPI leader_exit');
    if(!this.state.enabled)return [];
    this.fomo.refreshStats().catch(()=>{});
    const buys=signals.filter(x=>x.action==='LONG'&&x.time>=this.copyEntrySince&&this.fomo.validEntry(x));if(!buys.length)return [];
    try{
      if(!this.universe.length||this.clock()-this.universeAt>300000){this.universe=await this.broker.discovery(this.access);this.universeAt=this.clock();}
      const currencies=await this.broker.currencyInfo(),out=[];this.fomo.mappingError=null;
      for(const x of buys){const matches=matchMexcToken(x,currencies,this.universe);if(!matches.length){this.fomo.unlisted++;log(s,'skip','FOMOAPI · token sans correspondance MEXC vérifiable');continue;}this.fomo.matched++;
        for(const item of matches)out.push({...x,id:x.id+':'+item.market,market:item.market,symbol:item.symbol,fomo:true});
      }return out;
    }catch(e){this.fomo.mappingError=/^[A-Z0-9_]+$/.test(e.message)?e.message:'FOMO_MAPPING_UNAVAILABLE';log(s,'skip',this.fomo.mappingError);return [];}
  }
  snapshot(){
    const fomo=this.fomo?.snapshot()??{configured:false,connected:false,status:'disconnected'};
    const s=this.state?.portfolio;if(!s)return {status:'not_started',mode:'paper',active:false,enabled:false,starting:this.starting===true,positions:[],events:[],history:[],trades:[],selected:null,lanes:[],copyConnected:fomo.connected,externalCopyConfigured:!!this.sourceFile,fomo,progress:0};
    const eq=s.cash+s.positions.reduce((n,p)=>n+(p.plan.market==='spot'?p.quantity*p.mark:p.principal+p.unrealized),0),wins=s.closed.filter(t=>t.net>0).length;
    return {status:this.state.enabled?'running':'off',active:this.active,enabled:this.state.enabled,starting:this.starting===true,busy:this.busy,paused:!this.state.enabled,mode:s.mode,liveEnabled:s.mode==='live',startedAt:s.startedAt,updatedAt:s.updatedAt,phase:s.mode==='paper'?'observation':'live',progress:Math.min(1,this.state.training.coveredMs/this.trainingRequired),lastError:this.lastError||this.state.pauseReason||s.reconcileFault,model:this.state.model,allocated:s.allocated,free:available(s),reserved:reserved(s),pending:s.orders.filter(o=>!o.settled).length,copyConnected:fomo.connected||!!this.sourceFile,externalCopyConfigured:!!this.sourceFile,fomo:{...fomo,executed:(s.closed.filter(t=>t.source==='fomoapi').length+s.positions.filter(p=>p.plan.source==='fomoapi').length)},
      selected:{id:'bot',initial:s.allocated,equity:eq,pnl:eq-s.allocated,pnlPct:(eq/s.allocated-1)*100,drawdown:s.drawdown,closed:s.closed.length,wins,losses:s.closed.length-wins,winRate:s.closed.length?wins/s.closed.length:0},
      positions:s.positions.map(p=>{const contractSize=p.plan.market==='futures'?finite(p.plan.meta?.contractSize??1):1,notional=p.quantity*contractSize*p.mark,margin=p.principal,stopLossEstimate=p.plan.market==='spot'?p.quantity*p.plan.stop-p.cost:(p.plan.side==='LONG'?1:-1)*p.quantity*contractSize*(p.plan.stop-p.entry);return {id:p.id,asset:p.plan.asset,market:p.plan.market,side:p.plan.side,entry:p.entry,mark:p.mark,pnl:p.unrealized,pnlPct:margin?100*p.unrealized/margin:0,stop:p.plan.stop,take:p.plan.take,leverage:p.plan.leverage,source:p.plan.source,margin,notional,quantity:p.quantity,stopLossEstimate,stopDistancePct:p.mark?100*Math.abs(p.mark-p.plan.stop)/p.mark:0,takeDistancePct:p.mark?100*Math.abs(p.plan.take-p.mark)/p.mark:0,protection:s.mode==='paper'?'Simulation · sorties fictives':p.dust?'Reste sous le minimum MEXC':p.plan.market==='spot'?'PC allumé nécessaire':p.protected?'MEXC · isolée':'Vérification MEXC'};}),trades:s.closed.slice(-50),history:s.history,events:s.events.slice(0,60),lanes:[],api:{calls:this.state.api.calls,tokens:this.state.api.tokens},monitoring:this.hasExposure,trainingDecisions:this.state.training.decisions};
  }
}
