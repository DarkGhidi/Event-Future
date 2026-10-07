/* Public market analysis; optional MEXC balance reads stay on the local server. No order endpoints. */
const API='/api/market/candles?source=spot';
const TIME_API='/api/market/time';
const MEXC_INDEX_STREAM='wss://contract.mexc.com/edge';
const MEXC_INDEX_API='/api/market/candles?source=index';
let eventMarkets=[];
let activeMarketSymbol=localStorage.getItem('eventlab-market-symbol')||'BTC_USDT';
const MAX_STREAM_LATENCY_MS = 10_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 1_000;
const MAX_CANDLE_AGE_MS = 90_000;
const maxTickAgeMs=15_000;
let serverClockOffset = 0;
let clockSyncedAt = 0;
let state = {
  candles: {}, indexCandles:{}, lastPrice:null, lastTradeAt:0, lastReceivedAt:0, lastTradeLatency:null,
  spotPrice:null, spotTradeAt:0, spotReceivedAt:0, spotLatency:null, socket:null, indexSocket:null,
  indexReconnectAttempt:0,indexHeartbeat:null,indexWatchdog:null,indexReconnectTimer:null,spotReconnectTimer:null,indexLastMessageAt:0,indexFallbackBusy:false,
  busySymbol:null,reloadRequested:false,lastCandleFetchAt:0,candleRetryTimer:null,indexFetchedAt:{}, marketGap:false, candleError:null,clockError:null,streamError:null,feedRetryBusy:false, installPrompt:null, analysis:null,
  journal:readJournal(),signalEvents:readSignalEvents(),prudence:Math.max(0,Math.min(100,Number(localStorage.getItem('eventlab-prudence')||70))),displayedAction:null,walletBusy:false,scanMode:'stopped',pendingSide:null,pendingSince:0,lastSpokenSide:null,lastAlertAt:{},soundEnabled:false,audio:null,preSignal:null,operationalSignal:null,lastPopupSignal:null,signalCooldownUntil:0,goValiditySeconds:Math.max(15,Math.min(45,Number(localStorage.getItem('eventlab-go-validity')||30)))
};
const timeframes = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240 };
const $ = id => document.getElementById(id);
const format = (n, digits = 0) => Number.isFinite(n) ? new Intl.NumberFormat('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n) : '—';
const price = n => format(n, 2);
const time = t => t ? new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const age = ms => !Number.isFinite(ms) || ms < 0 ? '—' : ms < 1_000 ? '<1 s' : Math.floor(ms / 1_000) + ' s';

function readJournal(){try{return JSON.parse(localStorage.getItem('eventlab-journal')||'[]').filter(r=>r&&['up','down'].includes(r.side));}catch{return[];}}
function readSignalEvents(){try{return JSON.parse(localStorage.getItem('eventlab-signal-events')||'[]').filter(r=>r&&r.id&&r.snapshot);}catch{return[];}}
function persistSignalEvents(){state.signalEvents=state.signalEvents.slice(-500);localStorage.setItem('eventlab-signal-events',JSON.stringify(state.signalEvents));renderReview();}
function signalSnapshot(){const a=state.analysis||{};return{symbol:activeMarketSymbol,capturedAt:Date.now(),horizon:'10m',index:{source:'MEXC index',price:state.lastPrice,exchangeAt:state.lastTradeAt,receivedAt:state.lastReceivedAt,ageMs:Math.max(0,Date.now()-state.lastReceivedAt)},spot:{source:'Binance spot',price:state.spotPrice,exchangeAt:state.spotTradeAt,receivedAt:state.spotReceivedAt,ageMs:state.spotReceivedAt?Math.max(0,Date.now()-state.spotReceivedAt):null},candlesFetchedAt:state.lastCandleFetchAt,features:a.ready?{trend:a.trend,momentum:a.momentum,volume:a.volume,volumeRatio:a.volumeRatio,location:a.location,volatility:a.volatility,anomaly:a.anomaly,rangeRatio:a.rangeRatio,wickRatio:a.wickRatio,spotGap:a.spotGap,score:a.score,requiredScore:a.requiredScore,contradictions:[...a.contradictions],entryLevel:a.entryLevel,invalidationLevel:a.invalidationLevel,entryBuffer:a.entryBuffer,forecastMovePct:a.forecastMovePct}:null};}
function logSignalEvent(type,side,snapshot=signalSnapshot()){const event={id:String(Date.now())+'-'+Math.random().toString(36).slice(2,7),type,side,symbol:activeMarketSymbol,createdAt:Date.now(),price:state.lastPrice,snapshot,noTrade:false,outcome:null};state.signalEvents.unshift(event);persistSignalEvents();return event;}
function closeSignalEvent(id,reason){const event=state.signalEvents.find(item=>item.id===id);if(event){event.closedAt=Date.now();event.closeReason=reason;event.noTrade=true;persistSignalEvents();}}
function settleSignalEvents(){let changed=false;for(const event of state.signalEvents){if((event.symbol||'BTC_USDT')!==activeMarketSymbol||event.type!=='go'||!event.confirmedAt||event.outcome||Date.now()<event.createdAt+600_000||!fresh()||state.lastReceivedAt<event.createdAt+600_000)continue;event.outcome=event.declaredOutcome||(state.lastPrice>event.price?'win':state.lastPrice<event.price?'loss':'draw');event.outcomeSource=event.declaredOutcome?'user-declared':'index-estimate';event.settledAt=state.lastReceivedAt;event.noTrade=!event.manualPositionId;changed=true;}if(changed)persistSignalEvents();}
function persistJournal() { localStorage.setItem('eventlab-journal', JSON.stringify(state.journal)); renderJournal(); updateCountdown(); }
function toast(message) { const node = $('toast'); node.textContent = message; node.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove('show'), 2_600); }

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}
function atrValue(candles, period = 14) {
  const closed=(candles||[]).filter(c=>Number.isFinite(Number(c.time))&&Number(c.time)+60_000<=Date.now());
  if(closed.length<period+1)return null;
  const ranges=[];
  for(let i=1;i<closed.length;i++){
    const current=closed[i],previous=closed[i-1];
    ranges.push(Math.max(Number(current.high)-Number(current.low),Math.abs(Number(current.high)-Number(previous.close)),Math.abs(Number(current.low)-Number(previous.close))));
  }
  const recent=ranges.slice(-period);
  return recent.length===period&&recent.every(Number.isFinite)?recent.reduce((sum,value)=>sum+value,0)/period:null;
}
function macd(values) {
  if (values.length < 35) return null;
  const fastK = 2 / 13, slowK = 2 / 27;
  let fast = values.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
  let slow = values.slice(0, 26).reduce((a, b) => a + b, 0) / 26;
  const series = [];
  for (let i = 26; i < values.length; i++) { fast = values[i] * fastK + fast * (1 - fastK); slow = values[i] * slowK + slow * (1 - slowK); series.push(fast - slow); }
  const signal = ema(series, 9), line = series.at(-1);
  return signal === null ? null : { line, signal, hist: line - signal };
}
function bands(values) {
  if (values.length < 20) return null;
  const recent = values.slice(-20), mid = recent.reduce((a, b) => a + b, 0) / 20;
  const sd = Math.sqrt(recent.reduce((a, b) => a + (b - mid) ** 2, 0) / 20);
  return { mid, upper: mid + 2 * sd, lower: mid - 2 * sd, width: mid ? 4 * sd / mid : 0 };
}
function summarize(tf) {
  const candles = state.indexCandles[tf] || [], closes = candles.map(c => c.close);
  if (closes.length < 55) return null;
  const e20 = ema(closes, 20), e50 = ema(closes, 50), last = closes.at(-1);
  const trend = e20 > e50 && last > e20 ? 'up' : e20 < e50 && last < e20 ? 'down' : 'mixed';
  const recent = candles.slice(-20), averageRange = recent.reduce((sum, c) => sum + c.high - c.low, 0) / recent.length;
  return { trend, last, macd: macd(closes), bands: bands(closes), averageRange, candles };
}
function fibLevels() {
  const candles = (state.indexCandles['4h'] || []).slice(-60);
  if (candles.length < 20 || !state.lastPrice) return null;
  const high = Math.max(...candles.map(c => c.high)), low = Math.min(...candles.map(c => c.low));
  if (!(high > low)) return null;
  const rising = candles.at(-1).close >= candles[0].close;
  const levels = rising ? { 382: high - (high - low) * .382, 500: high - (high - low) * .5, 618: high - (high - low) * .618 } : { 382: low + (high - low) * .382, 500: low + (high - low) * .5, 618: low + (high - low) * .618 };
  return { high, low, levels, near: Math.min(...Object.values(levels).map(v => Math.abs(state.lastPrice - v))) / (high - low) };
}
function supportResistance(candleSets, currentPrice) {
  const pivots=[];
  for(const [tf,candles] of candleSets){const minutes=timeframes[tf]||1,closed=(candles||[]).filter(c=>c.time+minutes*60_000<=Date.now());for(let i=2;i<closed.length-2;i++){const c=closed[i],near=closed.slice(i-2,i).concat(closed.slice(i+1,i+3));if(near.every(v=>c.high>v.high))pivots.push({price:c.high,tf,kind:'resistance'});if(near.every(v=>c.low<v.low))pivots.push({price:c.low,tf,kind:'support'});}}
  const makeZone=kind=>{const levels=pivots.filter(p=>p.kind===kind&&(kind==='support'?p.price<currentPrice:p.price>currentPrice)).sort((a,b)=>kind==='support'?b.price-a.price:a.price-b.price);if(!levels.length)return null;const anchor=levels[0].price,tolerance=currentPrice*.0015,cluster=levels.filter(p=>Math.abs(p.price-anchor)<=tolerance);const value=cluster.reduce((sum,p)=>sum+p.price,0)/cluster.length,distance=(value-currentPrice)/currentPrice*100;return{value,distance,tfs:[...new Set(cluster.map(p=>p.tf))],near:Math.abs(distance)<=.15};};
  return {support:makeZone('support'),resistance:makeZone('resistance')};
}
function analyze() {
  const horizons = Object.fromEntries(Object.keys(timeframes).map(tf => [tf, summarize(tf)]));
  const one = horizons['1m'], fib = fibLevels();
  if (!one || Object.values(horizons).some(x => !x)) return { ready: false };
  const upCount = Object.values(horizons).filter(x => x.trend === 'up').length;
  const downCount = Object.values(horizons).filter(x => x.trend === 'down').length;
  const trend = upCount >= 3 ? 'up' : downCount >= 3 ? 'down' : 'mixed';
  const momentum = one.macd?.hist > 0 ? 'up' : one.macd?.hist < 0 ? 'down' : 'mixed';
  const candles=state.indexCandles['1m'], current=candles.at(-1), spotCandles=state.candles['1m']||[];
  const spotFresh=!!state.spotReceivedAt&&Date.now()-state.spotReceivedAt<=maxTickAgeMs,spotGap=spotFresh&&state.spotPrice&&state.lastPrice?Math.abs(state.spotPrice-state.lastPrice)/state.lastPrice:null;
  const priorVolumes=spotFresh?spotCandles.slice(-21,-1).map(c=>c.volume):[];
  const priorRanges = candles.slice(-21, -1).map(c => c.high - c.low).sort((a, b) => a - b);
  const averageVolume = priorVolumes.reduce((a, b) => a + b, 0) / Math.max(1, priorVolumes.length);
  const volumeRatio=spotFresh&&averageVolume?spotCandles.at(-1).volume/averageVolume:1;
  const medianRange=priorRanges[Math.floor(priorRanges.length/2)]||0;
  const rangeRatio = medianRange ? (current.high - current.low) / medianRange : 0;
  const spotCurrent=spotFresh?(spotCandles.at(-1)||current):current,wickRatio=spotCurrent.high===spotCurrent.low?0:1-Math.abs(spotCurrent.close-spotCurrent.open)/(spotCurrent.high-spotCurrent.low);
  const possibleAnomaly = (rangeRatio >= 2.5 && volumeRatio >= 2) || (rangeRatio >= 1.8 && wickRatio >= .72) || volumeRatio >= 5;
  const volume=spotFresh&&volumeRatio>=1.15?spotCurrent.close>spotCurrent.open?'up':spotCurrent.close<spotCurrent.open?'down':'mixed':'mixed';
  const location = one.bands ? state.lastPrice > one.bands.upper ? 'above' : state.lastPrice < one.bands.lower ? 'below' : state.lastPrice > one.bands.mid ? 'upper-half' : 'lower-half' : 'unknown';
  const volatility=one.averageRange/one.last>.003?'high':one.averageRange/one.last<.0007?'low':'normal';
  const structure=candles.slice(-21,-1),localHigh=Math.max(...structure.map(c=>c.high)),localLow=Math.min(...structure.map(c=>c.low)),entryBuffer=Math.max(one.averageRange*.2,state.lastPrice*.00015);
  const closes=candles.slice(-11).map(c=>c.close),slope10=closes.length>1?(closes.at(-1)-closes[0])/(closes.length-1):0,forecast10=state.lastPrice+slope10*10,longProjection=forecast10-localHigh,shortProjection=forecast10-localLow;
  const contradictions = [];
  if (trend !== 'mixed' && momentum !== 'mixed' && trend !== momentum) contradictions.push('La tendance multi-horizons et le MACD 1 min divergent.');
  if (volume !== 'mixed' && momentum !== 'mixed' && volume !== momentum) contradictions.push('Le volume accompagne un mouvement opposé au momentum.');
  if (volatility === 'high') contradictions.push('Amplitude récente élevée : risque de retournement et d’écart avec l’indice MEXC.');
  if (fib && fib.near < .035) contradictions.push('Le prix approche un retracement Fibonacci; c’est un repère, pas une confirmation.');
  if(spotGap!=null&&spotGap>.005)contradictions.push('Écart notable entre index MEXC et spot Binance : divergence de sources possible.');
  if(possibleAnomaly)contradictions.push('Anomalie possible : pic de volume ou grande mèche détecté. Cela ne prouve pas une manipulation.');
  const score = (trend === 'up' ? 2 : trend === 'down' ? -2 : 0) + (momentum === 'up' ? 1 : momentum === 'down' ? -1 : 0) + (volume === 'up' ? 1 : volume === 'down' ? -1 : 0);
  const requiredScore = 2 + Math.round(state.prudence * 2 / 100);
  const decision=!possibleAnomaly&&(spotGap==null||spotGap<=.005)&&longProjection>entryBuffer*.25&&score>=requiredScore&&trend==='up'&&momentum==='up'?'up':!possibleAnomaly&&(spotGap==null||spotGap<=.005)&&shortProjection<-entryBuffer*.25&&score<=-requiredScore&&trend==='down'&&momentum==='down'?'down':'pass';
  return {ready:true,horizons,trend,momentum,volume,volumeRatio,location,volatility,fib,score,requiredScore,decision,contradictions,anomaly:possibleAnomaly,rangeRatio,wickRatio,entryLevel:decision==='up'?localHigh:decision==='down'?localLow:null,invalidationLevel:decision==='up'?localLow:decision==='down'?localHigh:null,entryBuffer,spotGap,forecast10,longProjection,shortProjection,forecastMovePct:(decision==='up'?longProjection:shortProjection)/state.lastPrice*100};
}

async function syncClock() {
  try {
    const symbol=encodeURIComponent(activeMarketSymbol);
    const samples=await Promise.allSettled([0,1,2].map(async()=>{
      const before=Date.now(),response=await fetch(TIME_API+'?symbol='+symbol,{cache:'no-store',signal:AbortSignal.timeout(8_000)});
      const body=await response.json().catch(()=>({}));
      if(!response.ok)throw Object.assign(new Error(body.error||'Référence horaire MEXC indisponible.'),{code:body.code||'HTTP_'+response.status});
      const after=Date.now(),serverTime=Number(body.serverTime),rtt=after-before;
      if(!Number.isFinite(serverTime)||serverTime<1_500_000_000_000||rtt>8_000)throw Object.assign(new Error('Horloge MEXC invalide.'),{code:'CLOCK_SAMPLE_INVALID'});
      return{offset:serverTime-(before+after)/2,rtt,receivedAt:after};
    }));
    const valid=samples.filter(item=>item.status==='fulfilled').map(item=>item.value).sort((a,b)=>a.rtt-b.rtt);
    if(!valid.length)throw Object.assign(new Error('Aucune mesure valide de l’horloge MEXC.'),{code:samples.find(item=>item.status==='rejected')?.reason?.code||'MEXC_CLOCK_UNAVAILABLE'});
    const best=valid[0];serverClockOffset=best.offset;clockSyncedAt=best.receivedAt;state.clockError=null;
  } catch(error) { state.clockError=error?.code||error?.cause?.code||error?.name||'NETWORK_ERROR'; }
  renderFeedDiagnostic();
  if(state.analysis?.ready)renderAnalysis();
}

async function loadCandles() {
 if(state.busy){if(state.busySymbol!==activeMarketSymbol)state.reloadRequested=true;return;}state.busy=true;state.busySymbol=activeMarketSymbol;
 const requestedSymbol=activeMarketSymbol;
 try{
  const tfs=Object.keys(timeframes),indexResults=await Promise.allSettled(tfs.map(async tf=>{
    const mins=timeframes[tf],response=await fetch(MEXC_INDEX_API+'&symbol='+encodeURIComponent(requestedSymbol)+'&tf='+tf,{cache:'no-store',signal:AbortSignal.timeout(8_000)}),body=await response.json().catch(()=>({}));
    if(!response.ok)throw Object.assign(new Error(tf+' chandelles HTTP '+response.status),{code:body.code||'HTTP_'+response.status});
    if(!body.success||!body.data?.time)throw Object.assign(new Error(tf+' chandelles indisponibles'),{code:body.code||'MEXC_RESPONSE_INVALID'});
    const d=body.data,rows=d.time.map((t,i)=>({time:Number(t)*1000,open:Number(d.open[i]),high:Number(d.high[i]),low:Number(d.low[i]),close:Number(d.close[i]),volume:0,closeTime:(Number(t)+mins*60-1)*1000}));
    if(!rows.length)throw Object.assign(new Error(tf+' sans chandelles'),{code:'EMPTY_CANDLES'});
    return[tf,rows];
  }));
  if(requestedSymbol!==activeMarketSymbol)return;
  const indexPairs=indexResults.filter(r=>r.status==='fulfilled').map(r=>r.value),failed=indexResults.map((r,i)=>r.status==='rejected'?{tf:tfs[i],error:r.reason}:null).filter(Boolean),failedTfs=failed.map(item=>item.tf);
  if(!indexPairs.length)throw Object.assign(new Error('Chandelles de l’indice MEXC indisponibles'),{code:failed[0]?.error?.code||failed[0]?.error?.cause?.code||'MEXC_CANDLES_UNAVAILABLE'});
  indexPairs.forEach(([tf,rows])=>{const live=state.indexCandles[tf]?.at(-1),freshLive=live&&Date.now()-live.time<timeframes[tf]*60_000&&live.time>=rows.at(-1)?.time;if(freshLive&&live.time===rows.at(-1)?.time)rows[rows.length-1]=live;else if(freshLive&&live.time>rows.at(-1)?.time)rows.push(live);state.indexCandles[tf]=rows;state.indexFetchedAt[tf]=Date.now();});
  state.candleError=failed.length?failed.map(item=>item.tf+': '+(item.error?.code||item.error?.message||'indisponible')).join(' · '):null;
  state.lastCandleFetchAt=Date.now();
  if(failedTfs.length){clearTimeout(state.candleRetryTimer);state.candleRetryTimer=setTimeout(()=>{if(requestedSymbol===activeMarketSymbol)loadCandles();},5000);}else clearTimeout(state.candleRetryTimer);
  try{
    const spotPairs=await Promise.all(tfs.map(async tf=>{const response=await fetch(API+'&symbol='+encodeURIComponent(requestedSymbol.replace('_',''))+'&tf='+tf,{cache:'no-store',signal:AbortSignal.timeout(8_000)});if(!response.ok)throw new Error('HTTP '+response.status);const rows=await response.json();return[tf,rows.map(c=>({time:+c[0],open:+c[1],high:+c[2],low:+c[3],close:+c[4],volume:+c[5],closeTime:+c[6]}))];}));
    if(requestedSymbol!==activeMarketSymbol)return;spotPairs.forEach(([tf,rows])=>state.candles[tf]=rows);state.spotCandleError=null;
  }catch(error){if(requestedSymbol===activeMarketSymbol)state.spotCandleError=error?.name||error?.message||'NETWORK_ERROR';}
  state.marketGap=false;state.analysis=analyze();renderAnalysis();renderFeedDiagnostic();
 }catch(error){if(requestedSymbol===activeMarketSymbol){state.candleError=error?.code||error?.cause?.code||error?.name||'NETWORK_ERROR';renderAnalysis();renderFeedDiagnostic();clearTimeout(state.candleRetryTimer);state.candleRetryTimer=setTimeout(()=>{if(requestedSymbol===activeMarketSymbol)loadCandles();},5000);}}
 finally{state.busy=false;state.busySymbol=null;if(state.reloadRequested){state.reloadRequested=false;queueMicrotask(loadCandles);}}
}

function updateLiveMinuteCandle(tradeTime, tradePrice, quantity) {
  const candles = state.candles['1m']; if (!candles?.length) return;
  const start = Math.floor(tradeTime / 60_000) * 60_000, last = candles.at(-1);
  if (last.time === start) {
    last.high = Math.max(last.high, tradePrice); last.low = Math.min(last.low, tradePrice); last.close = tradePrice;
    if (Date.now() >= state.lastCandleFetchAt) last.volume += quantity;
  } else if (last.time < start) {
    candles.push({ time: start, open: tradePrice, high: tradePrice, low: tradePrice, close: tradePrice, volume: quantity, closeTime: start + 59_999 });
    if (candles.length > 120) candles.shift();
  }
}
function updateMexcIndexCandles(tradeTime, tradePrice) {
  for (const [tf, minutes] of Object.entries(timeframes)) {
    const candles=state.indexCandles[tf];if(!candles?.length)continue;
    const duration=minutes*60_000,start=Math.floor(tradeTime/duration)*duration,last=candles.at(-1);
    if(last.time===start){last.high=Math.max(last.high,tradePrice);last.low=Math.min(last.low,tradePrice);last.close=tradePrice;}
    else if(last.time<start){candles.push({time:start,open:tradePrice,high:tradePrice,low:tradePrice,close:tradePrice,volume:0,closeTime:start+duration-1});if(candles.length>130)candles.shift();}
  }
}
function connectStream() {
  try {
    const stream=activeMarketSymbol.replace('_','').toLowerCase(),socket=new WebSocket('wss://stream.binance.com:9443/ws/'+stream+'@trade');state.socket=socket;
    socket.onopen=()=>setConnection('ok','Marchés connectés');
    socket.onmessage=event=>{try{if(state.socket!==socket)return;const tick=JSON.parse(event.data),received=Date.now(),exchangeTime=Number(tick.T||tick.E);state.spotPrice=Number(tick.p);state.spotTradeAt=exchangeTime;state.spotReceivedAt=received;state.spotLatency=Math.max(0,received-(exchangeTime+serverClockOffset));updateLiveMinuteCandle(exchangeTime,state.spotPrice,Number(tick.q||0));renderPriceStatus();drawChart();}catch{}};
    socket.onerror=()=>setConnection('bad','Marché au comptant Binance indisponible');socket.onclose=()=>{if(state.socket!==socket)return;if(document.visibilityState!=='hidden')setConnection('bad','Reconnexion…');clearTimeout(state.spotReconnectTimer);state.spotReconnectTimer=setTimeout(connectStream,2500);};
  }catch{setConnection('bad','Marché au comptant Binance indisponible');setTimeout(connectStream,5000);}
}
async function pollMexcIndexFallback() {
  if(state.indexFallbackBusy||!activeMarketSymbol||Date.now()-state.lastReceivedAt<=5_000)return;
  const symbol=activeMarketSymbol;state.indexFallbackBusy=true;
  try{
    const response=await fetch('/api/market/index-price?symbol='+encodeURIComponent(symbol),{cache:'no-store',signal:AbortSignal.timeout(4_000)});
    if(!response.ok)throw new Error('index_http_'+response.status);
    const body=await response.json(),data=body?.data,priceValue=Number(data?.price),exchangeTime=Number(data?.timestamp);
    if(!body?.success||data?.symbol!==symbol||!Number.isFinite(priceValue)||priceValue<=0||!Number.isFinite(exchangeTime))throw new Error('index_response_invalid');
    const normalizedTime=exchangeTime<100_000_000_000?exchangeTime*1000:exchangeTime,received=Date.now();
    if(symbol!==activeMarketSymbol||normalizedTime<=state.lastTradeAt)return;
    state.streamError=null;state.lastPrice=priceValue;state.lastTradeAt=normalizedTime;state.lastReceivedAt=received;
    state.lastTradeLatency=Math.max(0,received-(normalizedTime+serverClockOffset));
    updateMexcIndexCandles(normalizedTime,priceValue);state.analysis=analyze();settleSignalEvents();renderAnalysis();
  }catch(error){state.streamError=error?.code||error?.message||error?.cause?.code||error?.name||'NETWORK_ERROR';renderFeedDiagnostic();}finally{state.indexFallbackBusy=false;}
}
function connectMexcIndex() {
  try {
    const socket=new WebSocket(MEXC_INDEX_STREAM);state.indexSocket=socket;
    socket.onopen=()=>{state.indexReconnectAttempt=0;state.indexLastMessageAt=Date.now();socket.send(JSON.stringify({method:'sub.index.price',param:{symbol:activeMarketSymbol}}));clearInterval(state.indexHeartbeat);clearInterval(state.indexWatchdog);state.indexHeartbeat=setInterval(()=>{if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({method:'ping'}));},15_000);state.indexWatchdog=setInterval(()=>{if(socket.readyState===WebSocket.OPEN&&Date.now()-state.indexLastMessageAt>45_000)socket.close();},5_000);};
    socket.onmessage=event=>{try{if(state.indexSocket!==socket)return;const msg=JSON.parse(event.data);state.indexLastMessageAt=Date.now();if(msg.channel==='push.index.price'&&msg.data?.symbol===activeMarketSymbol){const received=Date.now(),exchangeTime=Number(msg.ts||Date.now()),val=Number(msg.data.price);if(!Number.isFinite(val)||val<=0)return;state.streamError=null;state.lastPrice=val;state.lastTradeAt=exchangeTime;state.lastReceivedAt=received;state.lastTradeLatency=Math.max(0,received-(exchangeTime+serverClockOffset));updateMexcIndexCandles(exchangeTime,val);state.analysis=analyze();settleSignalEvents();renderAnalysis();}}catch{}};
    socket.onerror=()=>{state.streamError='WEBSOCKET_ERROR';renderFeedDiagnostic();setConnection('bad','Index MEXC indisponible');};socket.onclose=()=>{clearInterval(state.indexHeartbeat);clearInterval(state.indexWatchdog);if(state.indexSocket!==socket)return;if(document.visibilityState!=='hidden'){state.streamError=state.streamError||'WEBSOCKET_CLOSED';renderFeedDiagnostic();setConnection('bad','Index MEXC · reconnexion…');}const delay=Math.min(30_000,1_000*2**Math.min(state.indexReconnectAttempt++,5));clearTimeout(state.indexReconnectTimer);state.indexReconnectTimer=setTimeout(connectMexcIndex,delay);};
  }catch{setConnection('bad','Index MEXC indisponible');const delay=Math.min(30_000,1_000*2**Math.min(state.indexReconnectAttempt++,5));clearTimeout(state.indexReconnectTimer);state.indexReconnectTimer=setTimeout(connectMexcIndex,delay);}
}
function setConnection(mode, label) { const c = $('connectionState'); c.className = 'connection ' + mode; c.innerHTML = '<i></i> ' + label; }
// Tolerate at most 1 s of clock skew; the maximum accepted tick age remains 15 s.
function freshnessIssue(){const now=Date.now(),marketAge=now+serverClockOffset-state.lastTradeAt;if(state.clockError)return'horloge MEXC indisponible ('+state.clockError+')';if(state.candleError)return'chandelles MEXC incomplètes ('+state.candleError+')';if(!clockSyncedAt||now-clockSyncedAt>=300_000)return'horloge MEXC non synchronisée';if(!state.lastTradeAt||now-state.lastReceivedAt>maxTickAgeMs||marketAge < -MAX_FUTURE_CLOCK_SKEW_MS||marketAge>maxTickAgeMs||state.lastTradeLatency>MAX_STREAM_LATENCY_MS)return'tick de l’index MEXC périmé';if(!state.lastCandleFetchAt||now-state.lastCandleFetchAt>MAX_CANDLE_AGE_MS)return'chandelles de l’index périmées';for(const tf of Object.keys(timeframes))if(!state.indexFetchedAt[tf]||now-state.indexFetchedAt[tf]>MAX_CANDLE_AGE_MS)return'chandelles '+tf+' manquantes ou périmées';if(!state.analysis?.ready)return'analyse MEXC incomplète';return null;}
function fresh() {return !freshnessIssue();}
function feedErrorLabel(code){
  const labels={ENOTFOUND:'le serveur MEXC ne se résout pas (DNS)',EAI_AGAIN:'le DNS MEXC ne répond pas',ECONNREFUSED:'la connexion à MEXC est refusée',ECONNRESET:'la connexion à MEXC a été interrompue',ETIMEDOUT:'la connexion à MEXC a expiré',UND_ERR_CONNECT_TIMEOUT:'la connexion à MEXC a expiré',UND_ERR_HEADERS_TIMEOUT:'MEXC ne répond pas à temps',MEXC_RESPONSE_INVALID:'MEXC a répondu sans données de marché valides',NETWORK_ERROR:'aucune connexion réseau n’a abouti',CLOCK_SAMPLE_INVALID:'l’horloge MEXC est incohérente'};
  return labels[code]||String(code||'erreur réseau inconnue').replace(/_/g,' ');
}
function renderFeedDiagnostic(){
  const box=$('feedDiagnostic');if(!box)return;
  const streamStale=!state.lastReceivedAt||Date.now()-state.lastReceivedAt>maxTickAgeMs;
  const failed=!!state.clockError||!!state.candleError||!!state.streamError||!clockSyncedAt||streamStale;
  box.hidden=!failed&&!state.feedRetryBusy;
  box.classList.toggle('is-loading',state.feedRetryBusy);
  $('feedDiagnosticTitle').textContent=state.feedRetryBusy?'Vérification du flux MEXC…':'Données MEXC indisponibles';
  const problems=[];
  if(state.clockError)problems.push('Horloge : '+feedErrorLabel(state.clockError));
  if(state.candleError)problems.push('Chandelles : '+feedErrorLabel(state.candleError));
  if(state.streamError)problems.push('Flux prix : '+feedErrorLabel(state.streamError));
  else if(streamStale)problems.push('Flux prix : aucun tick MEXC reçu depuis moins de 15 s.');
  if(!problems.length&&failed)problems.push('Attente de la confirmation de l’horloge MEXC.');
  $('feedDiagnosticDetails').textContent=state.feedRetryBusy?'Nouvelle tentative sur les deux passerelles publiques MEXC en cours.':problems.join(' · ');
  $('retryFeedButton').disabled=state.feedRetryBusy;
}
async function retryMarketFeed(){
  if(state.feedRetryBusy)return;
  state.feedRetryBusy=true;renderFeedDiagnostic();state.indexReconnectAttempt=0;
  const socket=state.indexSocket;state.indexSocket=null;clearTimeout(state.indexReconnectTimer);if(socket&&socket.readyState<2)socket.close();
  await Promise.allSettled([syncClock(),loadCandles()]);
  if(!state.indexSocket)connectMexcIndex();
  state.feedRetryBusy=false;renderFeedDiagnostic();
}
function renderPriceStatus() {
  $('lastPrice').textContent=state.lastPrice?price(state.lastPrice):'—';$('sourceLabel').textContent='Indice MEXC · '+(state.spotPrice?'spot Binance facultatif '+price(state.spotPrice):'confirmation spot facultative indisponible');
  if (state.lastTradeAt) {
    $('updatedAt').textContent='Index MEXC '+time(state.lastTradeAt)+' · reçu il y a '+age(Date.now()-state.lastReceivedAt)+' · latence observée '+age(state.lastTradeLatency);
  }
  if(state.candleError&&!state.lastCandleFetchAt)$('sourceLabel').textContent='Index MEXC · chandelles indisponibles';
  if (state.lastCandleFetchAt && Date.now() - state.lastCandleFetchAt > MAX_CANDLE_AGE_MS) $('sourceLabel').textContent = 'Chandelles périmées · rechargement en cours';
  const issue=freshnessIssue();setConnection(issue ? 'bad' : 'ok', issue ? state.lastTradeAt ? 'Données périmées' : 'En attente' : 'Flux à jour');$('connectionState').title=issue||'Index et chandelles MEXC à jour';$('freshnessNote').textContent=issue?'Blocage : '+issue+' · seuils actifs : tick 15 s, chandelles 90 s':'Index MEXC ≤ 15 s · chandelles de l’index ≤ 90 s · prix au comptant facultatif';renderFeedDiagnostic();
}
function disableActions(){const signal=state.operationalSignal,blocked=!!state.preSignal||!!signal&&(signal.phase!=='go'||signal.reconfirming),canLog=!!state.lastPrice&&!activePosition()&&!blocked;$('positionUpButton').disabled=!canLog||!!signal&&signal.side!=='up';$('positionDownButton').disabled=!canLog||!!signal&&signal.side!=='down';}
function decisionFreshness() {
  if (fresh()) return;
  state.displayedAction = null; $('signalCard').classList.remove('action-long','action-short','flash-long','flash-short');
  $('decisionGlyph').textContent = '!'; $('decisionGlyph').className = 'decision-glyph neutral';
  $('decisionLabel').textContent = 'DONNÉES PÉRIMÉES · PAS D’ENTRÉE';
  $('decisionReason').textContent = 'Le flux ou les chandelles dépassent le seuil de fraîcheur. La recommandation est bloquée.';
  disableActions();
}
function drawChart() {
  const canvas = $('priceChart'),indexCandles=state.indexCandles['1m']||[],useIndex=indexCandles.length>0,candles=(useIndex?indexCandles:(state.candles['1m']||[])).slice(-60);$('eventChartSource').textContent=useIndex?'Indice MEXC · chandelles et bandes':'Binance au comptant · aperçu uniquement · signaux bloqués';
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1, width = Math.max(300, rect.width), height = rect.height || 220;
  canvas.width = width * ratio; canvas.height = height * ratio;
  const ctx = canvas.getContext('2d'); if(!ctx){$('eventChartSource').textContent='Graphique indisponible · moteur graphique non initialisé';return;} ctx.scale(ratio, ratio); ctx.clearRect(0, 0, width, height);
  if(!candles.length){ctx.fillStyle='#728294';ctx.font='12px sans-serif';ctx.fillText(state.candleError?'Chandelles de l’indice MEXC indisponibles · nouvelle tentative en cours':'Chargement des chandelles historiques de l’indice MEXC…',16,height/2);return;}
  const pad = { left: 4, right: 60, top: 8, bottom: 22 }, plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;
  const extrema = candles.flatMap(c => [c.high, c.low]), spread = Math.max(...extrema) - Math.min(...extrema) || 1;
  const min = Math.min(...extrema) - spread * .12, max = Math.max(...extrema) + spread * .12;
  const y = v => pad.top + (max - v) / (max - min) * plotH, x = i => pad.left + (i + .5) * plotW / candles.length;
  ctx.font = '9px monospace'; ctx.fillStyle = '#728294'; ctx.strokeStyle = '#1b2b3d';
  for (let g = 0; g < 4; g++) { const yy = pad.top + plotH * g / 3; ctx.beginPath(); ctx.moveTo(pad.left, yy); ctx.lineTo(width - pad.right, yy); ctx.stroke(); ctx.fillText(price(max - (max - min) * g / 3), width - pad.right + 6, yy + 3); }
  const upper = [], lower = [];
  candles.forEach((c, i) => { const subset = candles.slice(Math.max(0, i - 19), i + 1), mid = subset.reduce((a, v) => a + v.close, 0) / subset.length, sd = Math.sqrt(subset.reduce((a, v) => a + (v.close - mid) ** 2, 0) / subset.length); upper.push(mid + 2 * sd); lower.push(mid - 2 * sd); });
  ctx.setLineDash([3, 4]); ctx.strokeStyle = '#516277';
  [upper, lower].forEach(line => { ctx.beginPath(); line.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))); ctx.stroke(); }); ctx.setLineDash([]);
  const bodyW = Math.max(2, plotW / candles.length * .52);
  candles.forEach((c, i) => { const rising = c.close >= c.open, color = rising ? '#65d8a3' : '#ff7881', cx = x(i), top = y(Math.max(c.open, c.close)), bottom = y(Math.min(c.open, c.close)); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(cx, y(c.high)); ctx.lineTo(cx, y(c.low)); ctx.stroke(); ctx.fillRect(cx - bodyW / 2, top, bodyW, Math.max(1, bottom - top)); });
  ctx.fillStyle = '#647487'; ctx.fillText(time(candles[0].time).slice(0, 5), pad.left, height - 5); ctx.fillText(time(candles.at(-1).time).slice(0, 5), width - pad.right - 32, height - 5);
}
function renderAnalysis() {
  renderPriceStatus();
  if (!state.analysis?.ready) { decisionFreshness(); drawChart(); return; }
  const a = state.analysis, live = fresh(), side = a.decision;
  const one = state.indexCandles['1m'] || [];
  if (one.length > 1 && state.lastPrice) { const change = (state.lastPrice - one.at(-2).close) / one.at(-2).close * 100; $('priceChange').textContent = (change >= 0 ? '+' : '') + change.toFixed(2) + '%'; $('priceChange').className = 'change ' + (change < 0 ? 'down' : ''); }
  $('decisionGlyph').textContent = side === 'up' ? '↑' : side === 'down' ? '↓' : '·';
  $('decisionGlyph').className = 'decision-glyph ' + (!live || side === 'pass' ? 'neutral' : side);
  $('decisionLabel').textContent = !live ? 'DONNÉES PÉRIMÉES' : side === 'up' ? 'ACHAT · POSITION LONGUE' : side === 'down' ? 'VENTE · POSITION COURTE' : 'PAS D’ENTRÉE';
  $('decisionReason').textContent = !live ? 'Flux de l’index ou chandelles MEXC périmés : suivi suspendu.' : side === 'pass' ? 'Pas d’accord suffisant entre les familles de signaux.' : side === 'up' ? 'Index MEXC à T+10 min · prix d’entrée réel fixé par MEXC.' : 'Index MEXC à T+10 min · prix d’entrée réel fixé par MEXC.';
  $('entryHint').textContent=live&&a.entryLevel?(side==='up'?'Zone d’achat vers/au-dessus de ':'Zone de vente vers/sous ')+price(a.entryLevel)+' · index MEXC':'Seuil d’entrée indicatif indisponible'; $('invalidationHint').textContent=live&&a.invalidationLevel?(side==='up'?'Annuler si la lecture change ou si l’index < ':'Annuler si la lecture change ou si l’index > ')+price(a.invalidationLevel):'Signal annulé si les conditions changent ou si les données périment';
  $('positionUpButton').disabled=!state.lastPrice||!!activePosition();$('positionDownButton').disabled=!state.lastPrice||!!activePosition();

  const delay = 60_000 - Date.now() % 60_000;
  $('nextAnalysis').textContent = 'Analyse sur les mises à jour de l’index · chandelles relues toutes les 10 s · validation sur bougie 1 min';
  $('trendSummary').textContent = Object.entries(a.horizons).map(([tf, v]) => tf + ' ' + ({ up: '↑', down: '↓', mixed: '·' })[v.trend]).join('   ');
  $('macdSummary').textContent = a.momentum === 'up' ? 'Positif · histogramme en hausse' : a.momentum === 'down' ? 'Négatif · histogramme en baisse' : 'Neutre ou incomplet';
  $('volSummary').textContent = a.location === 'above' ? 'Au-dessus de la bande haute' : a.location === 'below' ? 'Sous la bande basse' : a.location === 'upper-half' ? 'Moitié haute des bandes' : a.location === 'lower-half' ? 'Moitié basse des bandes' : '—';
  $('volumeSummary').textContent = format(a.volumeRatio, 2) + '× la moyenne récente';
  renderFactors(a); renderLevels(a); drawChart();
  renderEventStructure();
  const contradictions = $('contradictions');
  if (a.contradictions.length) { contradictions.textContent = 'À garder en tête · ' + a.contradictions.join(' '); contradictions.classList.remove('hidden'); }
  else contradictions.classList.add('hidden');
  if (!live) decisionFreshness(); else updateCountdown();
  updateOperationalSignal();
}
function renderEventStructure(){const levels=supportResistance(Object.entries(state.indexCandles),state.lastPrice||NaN);for(const [kind,node] of [['support',levels.support],['resistance',levels.resistance]]){const value=$('event-'+kind);if(!value)continue;value.textContent=node?price(node.value)+' · '+(node.distance>0?'+':'')+format(node.distance,2)+' % · '+node.tfs.join(' / ')+(node.near?' · proche':''):'Pas de pivot confirmé disponible';}}
function renderFactors(a) {
  const cards = $('factors').children, ups = Object.values(a.horizons).filter(v => v.trend === 'up').length, downs = Object.values(a.horizons).filter(v => v.trend === 'down').length;
  const t = ups >= 3 ? 'up' : downs >= 3 ? 'down' : 'mixed';
  const states = [[t === 'up' ? 'Haussier' : t === 'down' ? 'Baissier' : 'Mixte', t], [a.momentum === 'up' ? 'Positif' : a.momentum === 'down' ? 'Négatif' : 'Mixte', a.momentum], [a.location === 'above' || a.location === 'below' ? 'Bande dépassée' : 'Dans les bandes', 'mixed'], [a.volume === 'mixed' ? 'Volume neutre' : a.volume === 'up' ? 'Volume acheteur' : 'Volume vendeur', a.volume], [a.anomaly ? 'Anomalie possible' : 'Structure observée', a.anomaly ? 'down' : 'mixed']];
  const descriptions = [
    'EMA 20/50 sur index MEXC en 1 min, 5 min, 15 min, 1 h et 4 h : ' + ups + ' horizon(s) haussier(s), ' + downs + ' baissier(s).',
    'MACD 1 min (12/26/9), une seule famille de momentum pour limiter le double comptage.',
    'Bandes de Bollinger 20 périodes / 2 écarts types sur index MEXC. Fibonacci sert de contexte.',
    'Volume au comptant Binance directionnel au-dessus de 1,15× la moyenne des 20 dernières minutes.',
    'Structure du mouvement sur 4 h et niveaux récents. ' + (a.anomaly ? 'Anomalie possible de volume ou de mèche; cela ne prouve pas une manipulation.' : 'Aucune anomalie simple repérée.') + ' Un écart entre l’index MEXC et Binance au comptant est signalé si le flux est à jour.'
  ];
  [...cards].forEach((card, i) => { card.querySelector('p').textContent = descriptions[i]; const label = card.querySelector('.factor-state'); label.textContent = states[i][0]; label.className = 'factor-state ' + (states[i][1] === 'mixed' ? 'mixed' : states[i][1]); });
}
function renderLevels(a) {
  if (!a.fib) return;
  $('levelHigh').textContent = price(a.fib.high); $('levelCurrent').textContent = price(state.lastPrice); $('levelLow').textContent = price(a.fib.low);
  $('fib382').textContent = price(a.fib.levels[382]); $('fib500').textContent = price(a.fib.levels[500]); $('fib618').textContent = price(a.fib.levels[618]);
}
function activePosition() { return state.journal.filter(r => (r.symbol||'BTC_USDT')===activeMarketSymbol&&r.status === 'open' && r.expiresAt > Date.now()).sort((a, b) => a.expiresAt - b.expiresAt)[0]; }
function updateCountdown() {
  const active=activePosition();if(!active){$('countdown').textContent='—';return;}const left=Math.max(0,active.expiresAt-Date.now()),value=String(Math.floor(left/60_000)).padStart(2,'0')+':'+String(Math.floor(left%60_000/1_000)).padStart(2,'0');$('countdown').textContent='Suivi · '+value;
}
function makeRecord(side) {
  const now=Date.now(),a=state.analysis;
  return {id:String(now)+'-'+Math.random().toString(36).slice(2,7),symbol:activeMarketSymbol,created:now,entryObservedAt:state.lastReceivedAt,entryExchangeAt:state.lastTradeAt,side,price:state.lastPrice,entryIndexPrice:state.lastPrice,indexSource:'MEXC',expiresAt:now+600_000,status:'open',result:null,signalEventId:state.operationalSignal?.side===side?state.operationalSignal.eventId:null,signalSnapshot:signalSnapshot(),manualEntryDelayMs:state.operationalSignal?.side===side?now-state.operationalSignal.issuedAt:null,
    factors:a?.ready?{trend:a.trend,momentum:a.momentum,volume:a.volume,location:a.location,volatility:a.volatility,anomaly:a.anomaly,score:a.score,requiredScore:a.requiredScore,spotGap:a.spotGap,volumeRatio:a.volumeRatio}:null,
    tickAgeAtStart:Math.max(0,Date.now()-state.lastReceivedAt),entryMarkedManually:true,entryReferenceFresh:fresh()};
}
function addPosition(side) {
  if(!state.lastPrice||!fresh()){toast('Index MEXC non frais : position non consignée.');return;}if(activePosition()){toast('Une position est déjà suivie jusqu’à son échéance.');return;}
  const record=makeRecord(side);if(record.signalEventId){const event=state.signalEvents.find(item=>item.id===record.signalEventId);if(event){event.manualPositionId=record.id;event.manualEntryAt=Date.now();event.noTrade=false;persistSignalEvents();}}state.journal.unshift(record);state.journal=state.journal.slice(0,100);persistJournal();
  state.operationalSignal=null;state.signalCooldownUntil=state.journal[0].expiresAt;renderAnalysis();toast((side==='up'?'Achat (position longue)':'Vente (position courte)')+' enregistré · suivi de 10 minutes lancé.'+(state.journal[0].entryReferenceFresh?'':' Référence d’index potentiellement périmée.'));
}
function speakCue(text) { if(!state.soundEnabled||!window.speechSynthesis||typeof window.SpeechSynthesisUtterance!=='function')return; try { const voices=speechSynthesis.getVoices(),voice=voices.find(v=>/^fr-FR$/i.test(v.lang))||voices.find(v=>/^fr([-_]|$)/i.test(v.lang));if(!voice)return;const utterance=new SpeechSynthesisUtterance(text);utterance.voice=voice;utterance.lang=voice.lang;utterance.rate=1.35;speechSynthesis.cancel();speechSynthesis.speak(utterance); } catch {} }
function speakCancelled(){if(!state.soundEnabled)return;for(const timer of state.cancelSpeechTimers||[])clearTimeout(timer);state.cancelSpeechTimers=[];for(let i=0;i<3;i++)state.cancelSpeechTimers.push(setTimeout(()=>speakCue('Annulé'),i*700));}
function startSignalCountdown(signal){
  signal.phase='countdown';signal.countdownRemaining=10;signal.calledAt=signal.issuedAt;signal.callPrice=state.lastPrice;signal.callSnapshot=signalSnapshot();signal.expiresAt=Date.now()+11_000+state.goValiditySeconds*1000;
  $('positionUpButton').disabled=true;$('positionDownButton').disabled=true;setSignalVisual(signal.side,'pre');$('decisionLabel').textContent=signal.side==='up'?'POSITION LONG · AVANT GO':'POSITION SHORT · AVANT GO';$('scanCountdown').textContent='GO dans 10 s';
  if(state.soundEnabled)speakCue(signal.side==='up'?'Position Long':'Position Short');
  let count=10;
  signal.countdownTimer=setInterval(()=>{
    if(state.operationalSignal!==signal){clearInterval(signal.countdownTimer);return;}
    if(signal.reconfirming)return;
    if(count>0){signal.countdownRemaining=count;speakCue(String(count));count-=1;return;}
    clearInterval(signal.countdownTimer);signal.countdownTimer=null;signal.phase='go';signal.goAt=Date.now();signal.issuedAt=signal.goAt;signal.expiresAt=signal.goAt+state.goValiditySeconds*1000;signal.countdownRemaining=0;
    const event=state.signalEvents.find(item=>item.id===signal.eventId);
    if(event){event.callAt=signal.calledAt;event.callPrice=signal.callPrice;event.callSnapshot=signal.callSnapshot;event.createdAt=signal.goAt;event.confirmedAt=signal.goAt;event.price=state.lastPrice;event.snapshot=signalSnapshot();event.countdownSeconds=10;event.noTrade=false;persistSignalEvents();}
    $('positionUpButton').disabled=signal.side!=='up'||signal.reconfirming;$('positionDownButton').disabled=signal.side!=='down'||signal.reconfirming;setSignalVisual(signal.side);beep('go');speakCue('GO');
  },1_000);
}
function beep(kind='tick') { if(!state.soundEnabled)return; try { const AudioContextType=window.AudioContext||window.webkitAudioContext;if(!AudioContextType)return;const context=state.audio||new AudioContextType();state.audio=context;const tones=kind==='go'?[880,1320]:[660];tones.forEach((frequency,index)=>{const osc=context.createOscillator(),gain=context.createGain(),start=context.currentTime+index*.13;osc.frequency.value=frequency;gain.gain.value=kind==='go'?.11:.055;osc.connect(gain);gain.connect(context.destination);osc.start(start);osc.stop(start+(kind==='go'?.16:.075));}); } catch {} }
function stopScan(mode='stopped'){state.scanMode=mode;state.pendingSide=null;state.pendingSince=0;if(state.preSignal)closeSignalEvent(state.preSignal.eventId,mode==='paused'?'monitor-paused':'monitor-stopped');if(state.operationalSignal?.countdownTimer)clearInterval(state.operationalSignal.countdownTimer);if(state.operationalSignal){const event=state.signalEvents.find(item=>item.id===state.operationalSignal.eventId);if(event){event.noTrade=!event.manualPositionId;event.closedAt=Date.now();event.closeReason=mode==='paused'?'monitor-paused':'monitor-stopped';persistSignalEvents();}}state.preSignal=null;state.operationalSignal=null;setSignalVisual(null);$('scanCountdown').textContent=mode==='paused'?'Surveillance en pause':'Surveillance arrêtée';renderScanControls();}
function renderScanControls() { $('scanStartButton').disabled=state.scanMode==='running';$('scanPauseButton').disabled=state.scanMode!=='running';$('scanStopButton').disabled=state.scanMode==='stopped';$('scanStatus').textContent=state.scanMode==='running'?'Surveillance active · gardez cet onglet ouvert':state.scanMode==='paused'?'Surveillance en pause':'Surveillance arrêtée'; }
function notifyDesktop(title,body,tag){try{if('Notification'in window&&Notification.permission==='granted')new Notification(title,{body,tag,silent:true});}catch{}}
function startScan(){if('Notification'in window&&Notification.permission==='default')Notification.requestPermission().catch(()=>{});state.scanMode='running';state.pendingSide=null;state.pendingSince=0;state.preSignal=null;state.operationalSignal=null;state.lastSpokenSide=null;renderScanControls();processScan();}
function setSignalVisual(side,stage='go') {
  const card=$('signalCard'),visualKey=side?stage+'-'+side:null,changed=visualKey!==state.displayedAction;
  if(changed){card.classList.remove('action-long','action-short','flash-long','flash-short','pre-signal-long','pre-signal-short');if(side){if(stage==='pre'){card.classList.add(side==='up'?'pre-signal-long':'pre-signal-short');}else{const stable=side==='up'?'action-long':'action-short',flash=side==='up'?'flash-long':'flash-short';card.classList.add(stable);if(!window.matchMedia('(prefers-reduced-motion: reduce)').matches){void card.offsetWidth;card.classList.add(flash);card.addEventListener('animationend',()=>card.classList.remove(flash),{once:true});}}}state.displayedAction=visualKey;}
  $('decisionGlyph').textContent=side==='up'?'↑':side==='down'?'↓':'·';$('decisionGlyph').className='decision-glyph '+(stage==='pre'?'neutral':side||'neutral');
}
function signalBounds(side,a,entryLevel=a?.entryLevel){const chase=Math.max((a?.entryBuffer||0)*2,state.lastPrice*.0003),preLead=Math.max((a?.entryBuffer||0)*4,state.lastPrice*.0005);const distance=side==='up'?entryLevel-state.lastPrice:state.lastPrice-entryLevel;const near=side==='up'?state.lastPrice>=entryLevel-(a?.entryBuffer||0)&&state.lastPrice<=entryLevel+chase:state.lastPrice<=entryLevel+(a?.entryBuffer||0)&&state.lastPrice>=entryLevel-chase;return{near,invalid:side==='up'?state.lastPrice<=(a?.invalidationLevel??state.operationalSignal?.invalidationLevel??state.preSignal?.invalidationLevel):state.lastPrice>=(a?.invalidationLevel??state.operationalSignal?.invalidationLevel??state.preSignal?.invalidationLevel),distance,preLead,chase};}
function cancelSignal(){$('positionUpButton').disabled=true;$('positionDownButton').disabled=true;if(state.operationalSignal?.countdownTimer)clearInterval(state.operationalSignal.countdownTimer);if(state.operationalSignal){const event=state.signalEvents.find(item=>item.id===state.operationalSignal.eventId);if(event){event.noTrade=!event.manualPositionId;event.closeReason='go-cancelled';event.closedAt=Date.now();persistSignalEvents();}}if(state.preSignal)closeSignalEvent(state.preSignal.eventId,'pre-alert-cancelled');state.operationalSignal=null;state.preSignal=null;state.pendingSide=null;state.pendingSince=0;state.signalCooldownUntil=Date.now()+10_000;setSignalVisual(null);$('decisionLabel').textContent='PAS D’ENTRÉE · SIGNAL ANNULÉ';$('scanCountdown').textContent='Signal annulé · aucune action à prendre';speakCancelled();}
function updateOperationalSignal() {
 const a=state.analysis,active=activePosition(),live=fresh(),now=Date.now();
 if(!live){const wasActive=!!state.operationalSignal||!!state.preSignal;if(state.operationalSignal?.countdownTimer)clearInterval(state.operationalSignal.countdownTimer);if(state.operationalSignal){const event=state.signalEvents.find(item=>item.id===state.operationalSignal.eventId);if(event){event.noTrade=true;event.closeReason='stale-data';persistSignalEvents();}}if(state.preSignal)closeSignalEvent(state.preSignal.eventId,'stale-data');state.operationalSignal=null;state.preSignal=null;state.pendingSide=null;state.pendingSince=0;$('positionUpButton').disabled=true;$('positionDownButton').disabled=true;setSignalVisual(null);$('decisionLabel').textContent='DONNÉES PÉRIMÉES · PAS D’ENTRÉE';$('scanCountdown').textContent='Données périmées · alerte suspendue';if(wasActive)speakCancelled();return;}
 if(active){state.operationalSignal=null;state.preSignal=null;state.pendingSide=null;state.pendingSince=0;$('positionUpButton').disabled=true;$('positionDownButton').disabled=true;setSignalVisual(null);$('decisionLabel').textContent='POSITION SUIVIE';$('decisionReason').textContent='Le suivi en cours bloque tout nouveau signal jusqu’à son échéance.';$('entryHint').textContent=(active.side==='up'?'Achat (position longue)':'Vente (position courte)')+' · index MEXC au suivi '+price(active.price);$('invalidationHint').textContent='Échéance du suivi '+time(active.expiresAt);$('scanCountdown').textContent='Position suivie · prochaine lecture à l’échéance';return;}
 if(state.scanMode!=='running'){state.operationalSignal=null;state.preSignal=null;state.pendingSide=null;state.pendingSince=0;setSignalVisual(null);$('scanCountdown').textContent=state.scanMode==='paused'?'Surveillance en pause':'Surveillance arrêtée';$('decisionLabel').textContent=a?.decision==='up'?'ACHAT · SURVEILLANCE ARRÊTÉE':a?.decision==='down'?'VENTE · SURVEILLANCE ARRÊTÉE':'PAS D’ENTRÉE';$('positionUpButton').disabled=!state.lastPrice;$('positionDownButton').disabled=!state.lastPrice;return;}
 const side=a?.decision&&a.decision!=='pass'?a.decision:null,signal=state.operationalSignal;
 if(signal){
   const bounds=signalBounds(signal.side,a,signal.entryLevel),hardInvalid=bounds.invalid||bounds.distance < -bounds.chase;
   if(hardInvalid){cancelSignal('Signal annulé. Le prix a quitté sa zone valide.');return;}
   if(now>=signal.expiresAt){if(signal.countdownTimer)clearInterval(signal.countdownTimer);const event=state.signalEvents.find(item=>item.id===signal.eventId);if(event){event.noTrade=!event.manualPositionId;event.closeReason=event.manualPositionId?'manual-position':'go-expired';event.closedAt=now;persistSignalEvents();}state.operationalSignal=null;state.signalCooldownUntil=now+10_000;setSignalVisual(null);$('positionUpButton').disabled=true;$('positionDownButton').disabled=true;$('decisionLabel').textContent='SIGNAL EXPIRÉ · PAS D’ENTRÉE';$('scanCountdown').textContent='Signal expiré · attendez une nouvelle configuration';speakCancelled();return;}
   const stable=side===signal.side&&bounds.near&&!bounds.invalid;
   if(!stable){signal.weakSince??=now;if(now-signal.weakSince>=3_000){cancelSignal('Signal annulé après une détérioration persistante.');return;}signal.reconfirming=true;}else{signal.weakSince=0;signal.reconfirming=false;}
   const seconds=Math.max(0,Math.ceil((signal.expiresAt-now)/1000));if(signal.phase==='countdown'){$('positionUpButton').disabled=true;$('positionDownButton').disabled=true;setSignalVisual(signal.side,'pre');$('decisionLabel').textContent=signal.reconfirming?'DÉCOMPTE SUSPENDU · REVALIDATION':signal.side==='up'?'POSITION LONG · AVANT GO':'POSITION SHORT · AVANT GO';$('decisionReason').textContent='Attendez le GO parlé; les boutons restent suspendus pendant le décompte.';$('entryHint').textContent='Zone de déclenchement · index MEXC '+price(signal.entryLevel);$('invalidationHint').textContent='Le signal peut encore être annulé avant GO.';$('scanCountdown').textContent=signal.reconfirming?'Revalidation · '+signal.countdownRemaining+' s':'GO dans '+signal.countdownRemaining+' s';return;}$('positionUpButton').disabled=signal.side!=='up'||signal.reconfirming;$('positionDownButton').disabled=signal.side!=='down'||signal.reconfirming;setSignalVisual(signal.side);
   $('decisionLabel').textContent=signal.reconfirming?'GO EN PAUSE · REVALIDATION':signal.side==='up'?'GO CONFIRMÉ · ACHAT':'GO CONFIRMÉ · VENTE';$('decisionReason').textContent=signal.reconfirming?'Le signal vérifie un bref changement de conditions; les boutons sont suspendus.':'Conditions confirmées à l’index MEXC. Vérifiez le contrat et le paiement sur MEXC; aucun ordre n’est passé par l’app.';$('entryHint').textContent='Zone de déclenchement · index MEXC '+price(signal.entryLevel);$('invalidationHint').textContent='Signal valable si les données restent fraîches et si le prix reste dans la zone.';$('scanCountdown').textContent=signal.reconfirming?'Revalidation · '+seconds+' s restantes':'GO · valable encore '+seconds+' s · exécution manuelle';return;
 }
 if(side&&now>=state.signalCooldownUntil){
   const bounds=signalBounds(side,a),preEligible=!bounds.near&&!bounds.invalid&&bounds.distance>0&&bounds.distance<=bounds.preLead;
   if(preEligible){state.pendingSide=null;state.pendingSince=0;if(state.preSignal&&state.preSignal.side!==side)closeSignalEvent(state.preSignal.eventId,'direction-changed');if(!state.preSignal||state.preSignal.side!==side){state.preSignal={side,issuedAt:now,entryLevel:a.entryLevel,invalidationLevel:a.invalidationLevel,entryBuffer:a.entryBuffer,weakSince:0,eventId:logSignalEvent('pre-alert',side).id};setSignalVisual(side,'pre');toast((eventMarkets.find(m=>m.symbol===activeMarketSymbol)?.label||activeMarketSymbol)+' · '+(side==='up'?'Pré-signal haussier':'Pré-signal baissier')+' · approche de '+price(a.entryLevel));notifyDesktop((eventMarkets.find(m=>m.symbol===activeMarketSymbol)?.label||activeMarketSymbol)+' · Pré-signal '+(side==='up'?'Long':'Short'),'Approche de la zone '+price(a.entryLevel)+' · aucun ordre n’est passé.','event-pre-'+activeMarketSymbol);}else state.preSignal.weakSince=0;$('positionUpButton').disabled=true;$('positionDownButton').disabled=true;$('decisionLabel').textContent=state.preSignal.side==='up'?'PRÉ-SIGNAL HAUSSIER · APPROCHE':'PRÉ-SIGNAL BAISSIER · APPROCHE';$('decisionReason').textContent='Configuration en approche. Préparez MEXC; attendez le GO confirmé avant toute action.';$('entryHint').textContent='Seuil surveillé · index MEXC '+price(a.entryLevel);$('invalidationHint').textContent='Aucune entrée confirmée · la configuration peut disparaître.';$('scanCountdown').textContent='PRÉ-SIGNAL · surveillez la zone, ne prenez pas de position';return;}
   if(bounds.near&&!bounds.invalid){const preAlertId=state.preSignal?.eventId||null;if(state.preSignal)state.preSignal=null;if(state.pendingSide!==side){state.pendingSide=side;state.pendingSince=now;}if(now-state.pendingSince>=1_500){const goEvent=logSignalEvent('go',side);const preEvent=state.signalEvents.find(item=>item.id===preAlertId);if(preEvent){preEvent.goEventId=goEvent.id;preEvent.closedAt=now;preEvent.closeReason='go-confirmed';persistSignalEvents();}state.operationalSignal={side,issuedAt:now,expiresAt:now+state.goValiditySeconds*1000,entryLevel:a.entryLevel,invalidationLevel:a.invalidationLevel,entryBuffer:a.entryBuffer,phase:'go',weakSince:0,reconfirming:false,eventId:goEvent.id,preAlertId};state.pendingSide=null;state.pendingSince=0;setSignalVisual(side);toast((eventMarkets.find(m=>m.symbol===activeMarketSymbol)?.label||activeMarketSymbol)+' · '+(side==='up'?'GO haussier':'GO baissier')+' confirmé · exécution manuelle');notifyDesktop((eventMarkets.find(m=>m.symbol===activeMarketSymbol)?.label||activeMarketSymbol)+' · GO '+(side==='up'?'Long':'Short'),'Signal confirmé · fenêtre de '+state.goValiditySeconds+' s · exécution manuelle.','event-go-'+activeMarketSymbol);$('positionUpButton').disabled=side!=='up';$('positionDownButton').disabled=side!=='down';startSignalCountdown(state.operationalSignal);return;}}
 }
 if(state.preSignal){const heldSide=state.preSignal.side,bounds=signalBounds(heldSide,a,state.preSignal.entryLevel),stillSetup=side===heldSide&&!bounds.invalid&&bounds.distance<=bounds.preLead&&bounds.distance>=-bounds.chase;if(stillSetup)state.preSignal.weakSince=0;else{state.preSignal.weakSince??=now;if(now-state.preSignal.weakSince>=3_000){closeSignalEvent(state.preSignal.eventId,'configuration-disappeared');state.preSignal=null;setSignalVisual(null);}}}
 $('positionUpButton').disabled=!state.lastPrice;$('positionDownButton').disabled=!state.lastPrice;
 if(state.preSignal){setSignalVisual(state.preSignal.side,'pre');$('decisionLabel').textContent=state.preSignal.side==='up'?'PRÉ-SIGNAL HAUSSIER · APPROCHE':'PRÉ-SIGNAL BAISSIER · APPROCHE';$('scanCountdown').textContent='Configuration à surveiller · aucun GO';}
 else{setSignalVisual(null);$('decisionLabel').textContent=Date.now()<state.signalCooldownUntil?'PAS D’ENTRÉE · RÉARMEMENT':'PAS D’ENTRÉE';$('scanCountdown').textContent=side?'Signal en confirmation · préparez-vous, sans agir':'Aucune configuration exploitable';}
}
function processScan() { if(state.scanMode==='running')updateOperationalSignal(); }
function settleJournal() {
  let changed = false;
  for(const record of state.journal){
    if((record.symbol||'BTC_USDT')!==activeMarketSymbol)continue;
    if(record.status!=='open'||record.expiresAt>Date.now()||record.result)continue;
    let expiryIndex=Number.isFinite(record.expiryIndexPrice)?record.expiryIndexPrice:Number.isFinite(record.expirySpotPrice)?record.expirySpotPrice:null;
    if(expiryIndex==null&&state.lastPrice&&fresh()&&state.lastReceivedAt>=record.expiresAt){
      const delay=state.lastReceivedAt-record.expiresAt;
      if(delay<=30_000){
        record.expiryIndexPrice=state.lastPrice;record.expirySpotPrice=state.lastPrice;record.expiryObservedAt=state.lastReceivedAt;record.expiryExchangeAt=state.lastTradeAt;record.expiryTimingDelayMs=delay;record.expiryReferenceFresh=true;expiryIndex=state.lastPrice;changed=true;
      }else{record.status='expired';record.expiryReviewRequired=true;changed=true;continue;}
    }
    const expiryFresh=record.expiryReferenceFresh!==false&&expiryIndex!=null;
    if(expiryFresh){
      record.result=expiryIndex===record.price?'draw':record.side==='up'?(expiryIndex>record.price?'win':'loss'):(expiryIndex<record.price?'win':'loss');
      record.resultSource='index-estimate';record.settledAt=Date.now();record.status='closed';record.expiryIndexPrice=expiryIndex;changed=true;
    }else if(Date.now()-record.expiresAt>30_000&&!record.expiryReviewRequired){record.status='expired';record.expiryReviewRequired=true;changed=true;}
  }
  if(changed)persistJournal();else renderJournal();
}
function markResult(id, result, source='manual') {
  const record = state.journal.find(r => r.id === id); if (!record || record.status === 'pass') return;
  const correction=record.resultSource==='index-estimate'||record.resultSource==='manual-correction';
  record.result = result; record.status = 'closed'; record.markedAt = Date.now();record.resultSource=source==='correction'?'manual-correction':'manual-declared';if(record.signalEventId){const event=state.signalEvents.find(item=>item.id===record.signalEventId);if(event){event.declaredOutcome=result;event.declaredAt=record.markedAt;event.outcomeSource='user-declared';persistSignalEvents();}}persistJournal();toast((correction?'Correction ':'Résultat déclaré ')+result.toUpperCase()+' enregistré.');
}
function wilsonInterval(successes, total) {
  if (!total) return null;
  const z = 1.96, p = successes / total, denom = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denom;
  const radius = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denom;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}
function renderReview() {
  const labeled = state.journal.filter(r => ['win', 'loss'].includes(r.result) && ['manual-declared','manual-correction','manual'].includes(r.resultSource));
  const wins = labeled.filter(r => r.result === 'win'), losses = labeled.filter(r => r.result === 'loss'), scored = wins.length + losses.length;
  const winRate = scored ? wins.length / scored : null;
  const ci = wilsonInterval(wins.length, scored);
  $('reviewMetrics').innerHTML = '<div><span>Taux des résultats déclarés</span><strong>' + (winRate == null ? '—' : format(winRate * 100, 1) + '%') + '</strong><small>n = ' + scored + ' · IC 95 % Wilson ' + (ci ? format(ci[0] * 100, 1) + '–' + format(ci[1] * 100, 1) + '%' : '—') + '</small></div>';
  const dimensions = ['trend', 'momentum', 'volume', 'volatility', 'location'], titles = { trend: 'tendance', momentum: 'momentum', volume: 'volume', volatility: 'volatilité', location: 'position dans les bandes' };
  const groups = [];
  for (const dimension of dimensions) for (const value of [...new Set(labeled.map(r => r.factors?.[dimension]).filter(Boolean))]) {
    const sample = labeled.filter(r => r.factors?.[dimension] === value && (r.result === 'win' || r.result === 'loss'));
    if (sample.length >= 10) groups.push({ dimension, value, n: sample.length, rate: sample.filter(r => r.result === 'win').length / sample.length });
  }
  let text = 'Analyse descriptive des résultats déclarés par vous; Event Futures ne lit pas le règlement de l’ordre MEXC. Les résultats estimés par l’index sont suivis séparément et ne sont pas traités comme des résultats vérifiés. Les associations observées ne prouvent pas une cause et quelques positions ne suffisent pas à établir une règle.';
  if (scored < 30) text += ' Échantillon trop petit pour suggérer un ajustement (' + scored + '/30 résultats); aucune règle ne sera modifiée.';
  else if (!groups.length || groups.length < 2) text += ' Aucune comparaison de contexte assez fournie; les signaux en direct restent inchangés.';
  else {
    groups.sort((a, b) => b.rate - a.rate); const best = groups[0], worst = groups.at(-1), gap = best.rate - worst.rate;
    text += gap >= .15 ? ' Piste descriptive à valider hors échantillon : comparer la famille « ' + titles[best.dimension] + ' = ' + best.value + ' » (' + format(best.rate * 100, 0) + '%, n=' + best.n + ') à « ' + titles[worst.dimension] + ' = ' + worst.value + ' » (' + format(worst.rate * 100, 0) + '%, n=' + worst.n + '). Échantillon rétrospectif, incertitude élevée; aucun changement automatique.' : ' Les contextes observés ne montrent pas d’écart suffisant pour formuler une piste. Aucune règle en direct n’est modifiée.';
  }
  const completed=state.signalEvents.filter(e=>e.type==='go'&&['win','loss','draw'].includes(e.outcome)&&e.outcomeSource==='index-estimate').sort((a,b)=>a.createdAt-b.createdAt),holdoutStart=Math.floor(completed.length*.8),holdout=completed.slice(holdoutStart),eligible=holdout.filter(e=>{const f=e.snapshot?.features;return f&&Number.isFinite(f.score)&&Number.isFinite(f.requiredScore)&&Math.abs(f.score)>=f.requiredScore+1;}),scoredHoldout=holdout.filter(e=>e.outcome==='win'||e.outcome==='loss'),scoredEligible=eligible.filter(e=>e.outcome==='win'||e.outcome==='loss'),baseRate=scoredHoldout.length?scoredHoldout.filter(e=>e.outcome==='win').length/scoredHoldout.length:null,shadowRate=scoredEligible.length?scoredEligible.filter(e=>e.outcome==='win').length/scoredEligible.length:null,untraded=state.signalEvents.filter(e=>e.type==='go'&&e.confirmedAt&&e.noTrade).length,preAlerts=state.signalEvents.filter(e=>e.type==='pre-alert').length;
  text+=' Alertes: '+preAlerts+' pré-alertes enregistrées; '+untraded+' GO sans position saisie. Évaluation en ombre fixe (seuil de score renforcé d’un point), sur les 20 % les plus récents des GO évaluables: '+scoredEligible.length+'/30 cas admissibles; référence '+(baseRate==null?'—':format(baseRate*100,1)+'%')+', règle d’ombre '+(shadowRate==null?'—':format(shadowRate*100,1)+'%')+'. Uniquement descriptif, sans remplacement automatique; aucune conclusion tant que le lot hors échantillon est trop petit.';
  const shadowVerdict=scoredEligible.length<30?'lot trop petit; test poursuivi sans action':shadowRate<baseRate?'dégradation observée; candidate rejetée et règle active conservée':shadowRate>baseRate?'gain descriptif observé; à confirmer sur un nouveau lot avant toute décision':'aucun gain mesuré; candidate non retenue';text+=' Verdict ombre: '+shadowVerdict+'.';
  $('reviewText').textContent = text;
}
function renderJournal() {
  const box = $('journalList'), wins = state.journal.filter(r => r.result === 'win').length, losses = state.journal.filter(r => r.result === 'loss').length;
  const draws=state.journal.filter(r=>r.result==='draw').length;$('journalSummary').children[0].textContent = state.journal.length + ' positions · ' + wins + ' gagnée(s) · ' + losses + ' perdue(s) · ' + draws + ' égalité(s)';
  if (!state.journal.length) { box.innerHTML = '<div class="empty-journal">Les positions réelles suivies apparaîtront ici. Le résultat manuel de MEXC reste distinct du prix spot public.</div>'; renderReview(); return; }
  box.innerHTML = state.journal.map(record => {
    const label = record.side === 'up' ? 'Achat (position longue)' : 'Vente (position courte)';
    const left = Math.max(0, record.expiresAt - Date.now()), clock = String(Math.floor(left / 60_000)).padStart(2, '0') + ':' + String(Math.floor(left % 60_000 / 1_000)).padStart(2, '0');
  const result = record.result ? (record.result==='win'?'GAGNÉ':record.result==='loss'?'PERDU':'ÉGALITÉ')+(record.resultSource==='index-estimate'?' · index estimé':record.resultSource==='manual-correction'?' · déclaré, corrigé':' · déclaré') : left ? 'Suivi · ' + clock : record.expiryReviewRequired ? 'À vérifier · index indisponible à l’échéance' : 'Échéance · attente d’un index à jour';
    const cls = record.result === 'win' ? 'win' : record.result === 'loss' ? 'loss' : record.status === 'open' ? 'open' : 'draw';
    const entryIndex=Number.isFinite(record.entryIndexPrice)?record.entryIndexPrice:record.price,expiryIndex=Number.isFinite(record.expiryIndexPrice)?record.expiryIndexPrice:record.expirySpotPrice;
    const detail=(record.symbol||'BTC_USDT').replace('_',' / ')+' · référence index MEXC '+price(entryIndex)+(record.signalEventId?' · signal '+record.signalEventId:'')+(record.entryReferenceFresh===false?' · lecture initiale périmée':'')+(Number.isFinite(expiryIndex)?' · index à échéance '+price(expiryIndex):'')+(record.resultSource==='manual-correction'?' · corrigé selon résultat réel':'');
    const resultButtons = !record.result && !left ? '<span class="result-buttons"><button data-result="win" data-id="' + record.id + '" class="result-button win">Gagné</button><button data-result="loss" data-id="' + record.id + '" class="result-button loss">Perdu</button><button data-result="draw" data-id="' + record.id + '" class="result-button draw">Égalité / remboursé</button></span>' : record.resultSource==='index-estimate'||record.resultSource==='manual-correction'||record.resultSource==='manual-declared' ? '<span class="result-buttons"><button data-result="win" data-source="correction" data-id="' + record.id + '" class="result-button win" aria-label="Corriger en résultat gagné">Gagné</button><button data-result="loss" data-source="correction" data-id="' + record.id + '" class="result-button loss" aria-label="Corriger en résultat perdu">Perdu</button><button data-result="draw" data-source="correction" data-id="' + record.id + '" class="result-button draw" aria-label="Corriger en égalité remboursée">Égalité / remboursé</button></span>' : '';
    return '<div class="journal-row"><span class="date">' + time(record.created) + '</span><strong class="side ' + record.side + '">' + label + '</strong><span class="detail">' + detail + '</span><span class="result ' + cls + '">' + result + '</span>' + resultButtons + '</div>';
  }).join('');
  renderReview();
}
async function walletRequest(path,options={}) { let response;try{response=await fetch(path,{cache:'no-store',...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});}catch{throw new Error('Connexion au serveur local indisponible. Vérifiez que l’application est toujours ouverte.');}let data={};try{data=await response.json();}catch{}if(!response.ok)throw new Error(data.error||'Lecture indisponible.');return data; }
function renderWallet(data) {
  const status=$('walletStatus'),details=$('walletDetails'),balances=$('walletBalances');
  if(!data.connected){status.textContent='Solde non connecté';details.textContent='Connectez une clé MEXC limitée à « View Account Details » (« Consulter les détails du compte »). Dans l’app bureau, elle peut être conservée chiffrée par le système; sur le web, elle reste limitée à la session.';balances.classList.add('hidden');$('walletConnectButton').classList.remove('hidden');$('walletDisconnectButton').classList.add('hidden');return;}
  status.textContent='Portefeuille connecté · lecture seule';details.textContent='Actualisé '+time(data.checkedAt)+' · réponse en '+format(data.latencyMs,0)+' ms.';
  balances.innerHTML=(data.assets||[]).filter(x=>Number(x.equity||x.availableBalance||x.cashBalance)>0).slice(0,8).map(x=>'<div><span>'+String(x.currency||'').replace(/[<>]/g,'')+'</span><strong>'+format(Number(x.equity??x.availableBalance??x.cashBalance),4)+'</strong></div>').join('')||'<div><span>Aucun actif non nul</span></div>';
  balances.classList.remove('hidden');$('walletConnectButton').classList.add('hidden');$('walletDisconnectButton').classList.remove('hidden');
}
async function refreshWallet() { if(state.walletBusy)return;state.walletBusy=true;try{const data=await walletRequest('/api/mexc/assets');renderWallet(data);if(data.connected&&window.eventFuturesNative?.getCredentialStorageStatus){const storage=await window.eventFuturesNative.getCredentialStorageStatus();$('walletDetails').textContent+=' '+(storage.saved?'Clés restaurées depuis le stockage chiffré du système.':'Identifiants limités à cette session.');}}catch(error){$('walletStatus').textContent='Lecture MEXC indisponible';$('walletDetails').textContent=error.message;}finally{state.walletBusy=false;} }
async function saveWalletCredentials(key,secret) {
  if(!window.eventFuturesNative?.saveMexcCredentials)return false;
  try { const result=await window.eventFuturesNative.saveMexcCredentials(key,secret);return result?.saved===true; } catch { return false; }
}
function setupWallet() {
  if(location.hostname!=='localhost'&&location.hostname!=='127.0.0.1'){$('walletConnectButton').disabled=true;$('walletDetails').textContent='Pour protéger la clé, la connexion portefeuille est réservée à cet ordinateur via http://localhost:4173.';}
  $('walletConnectButton').addEventListener('click',()=>{$('walletDialog').classList.remove('hidden');$('apiKeyInput').focus();});
  $('walletDialogClose').addEventListener('click',()=>{$('walletDialog').classList.add('hidden');$('walletFormError').textContent='';});
  $('walletForm').addEventListener('submit',async event=>{event.preventDefault();if(location.hostname!=='localhost'&&location.hostname!=='127.0.0.1')return;let key=$('apiKeyInput').value,secret=$('apiSecretInput').value;$('walletSubmit').disabled=true;$('walletFormError').textContent='Vérification en cours…';try{const data=await walletRequest('/api/mexc/connect',{method:'POST',body:JSON.stringify({apiKey:key,apiSecret:secret})});const saved=await saveWalletCredentials(key,secret);renderWallet(data);$('walletDetails').textContent+=' '+(saved?'Clés enregistrées chiffrées par le système.':'Clés conservées pour cette session uniquement; le stockage sécurisé du système est indisponible.');$('walletDialog').classList.add('hidden');}catch(error){$('walletFormError').textContent=error.message;}finally{key='';secret='';$('apiKeyInput').value='';$('apiSecretInput').value='';$('walletSubmit').disabled=false;}});
  $('walletDisconnectButton').addEventListener('click',async()=>{try{renderWallet(await walletRequest('/api/mexc/disconnect',{method:'POST',body:'{}'}));if(window.eventFuturesNative?.clearMexcCredentials){const result=await window.eventFuturesNative.clearMexcCredentials();if(!result?.cleared)toast('Portefeuille déconnecté, mais la suppression du stockage chiffré a échoué.');}}catch(error){toast(error.message);}});
  refreshWallet();
}
const botState = { symbol:'BTC_USDT', market:null, marketBusy:false, accountConnected:false, emergencyLatched:false, storageAvailable:false, botActive:false, botBusy:false, availableUsdt:null };
async function botRequest(path, options={}) {
  let response;
  try { response=await fetch(path,{cache:'no-store',...options,headers:{'Content-Type':'application/json',...(options.headers||{})}}); }
  catch { throw new Error('Serveur local indisponible.'); }
  let data={}; try { data=await response.json(); } catch {}
  if(!response.ok) throw new Error(data.error||'Lecture indisponible.');
  return data;
}
function botSymbol() { return $('botPairSelect').value === 'RIVER_USDT' ? 'RIVER_USDT' : 'BTC_USDT'; }
function botUsdt(n, digits=2) { return format(n,digits)+' USDT'; }
function botRiskSizing(allocated,share,leverage,riskPercent,market=botState.market){
  const requested=allocated*share/100*leverage,ticker=market?.ticker,contract=market?.contract,price=Number(ticker?.lastPrice),atr=atrValue(market?.candles||[]),bid=Number(ticker?.bid1),ask=Number(ticker?.ask1);
  if(!price||!atr||!bid||!ask||ask<bid||!contract)return{notional:requested,margin:requested/(leverage||1),riskBudget:allocated*riskPercent/100};
  const lossFraction=1.5*atr/price+2*Math.max(Number(contract.takerFeeRate)||0,.0006)+(ask-bid)/((ask+bid)/2)+.0005;
  const riskBudget=allocated*riskPercent/100,notional=Math.min(requested,lossFraction>0?riskBudget/lossFraction:0);
  return{notional,margin:notional/(leverage||1),riskBudget};
}
function renderBotExposure() {
  const allocated=Math.max(0,Number($('botAllocatedBudget').value)||0), share=Number($('botMarginShare').value)||0, leverage=Number($('botLeverage').value)||0,riskPercent=Number($('botRiskPercent').value)||.5;
  const exposure=botRiskSizing(allocated,share,leverage,riskPercent),margin=exposure.margin,notional=exposure.notional;
  $('botMarginShareValue').textContent=share+' %'; $('botLeverageValue').textContent=leverage+'×'; $('botRiskPercentValue').textContent=format(riskPercent,1).replace('.',',')+' %'; $('botRiskCapValue').textContent=format(riskPercent,1).replace('.',',')+' %';
  $('botMarginResult').textContent=botUsdt(margin)+' de marge / trade'; $('botNotionalResult').textContent=botUsdt(notional)+' de notionnel estimé';
  const market=botState.market, contract=market?.contract;
  if(!contract) { $('botLimitResult').textContent='Limites MEXC non vérifiées; aucun démarrage possible.';updateBotStartAvailability();return; }
  const baseMaxLev=Number(contract.countryConfigContractMaxLeverage)>0?Number(contract.countryConfigContractMaxLeverage):Number(contract.maxLeverage), minVol=Number(contract.minVol), maxVol=Number(contract.maxVol);
  const allowed=contract.apiAllowed===true||contract.apiAllowed===1||contract.apiAllowed==='1'||contract.apiAllowed==='true';
  const status=Number(contract.state)===0?'contrat actif':'contrat non confirmé actif';
  let volume=Number(market.ticker?.lastPrice)>0&&Number(contract.contractSize)>0?notional/(Number(market.ticker.lastPrice)*Number(contract.contractSize)):NaN;
  const volUnit=Number(contract.volUnit)||1; if(Number.isFinite(volume))volume=Math.floor(volume/volUnit)*volUnit;
  const tiers=Array.isArray(contract.riskLimitCustom)?contract.riskLimitCustom.slice().sort((a,b)=>Number(a.maxVol)-Number(b.maxVol)):[];
  const tier=tiers.find(item=>Number.isFinite(volume)&&volume<=Number(item.maxVol));
  const tierMaxLev=Number(tier?.maxLeverage), maxLev=Number.isFinite(tierMaxLev)&&tierMaxLev>0?Math.min(baseMaxLev,tierMaxLev):baseMaxLev;
  const volumeOk=Number.isFinite(volume)&&volume>=minVol&&volume<=maxVol;
  $('botLimitResult').textContent=status+' · levier max '+(Number.isFinite(maxLev)?maxLev+'×':'inconnu')+' · '+(allowed?'API autorisée':'API non autorisée ou non confirmée')+(Number.isFinite(volume)?' · volume estimé '+format(volume,4)+' contrats':'')+(volumeOk?'':' · volume hors limites');
  if(Number.isFinite(maxLev)&&maxLev>0){$('botLeverage').max=String(maxLev);if(Number($('botLeverage').value)>maxLev){$('botLeverage').value=String(maxLev);renderBotExposure();return;}}
  $('botLeverageValue').textContent=$('botLeverage').value+'×';
  const latestCandleAt=market.candles?.at(-1)?.time||0;
  const fresh=Date.now()-market.checkedAt<30_000&&latestCandleAt>0&&Date.now()-(latestCandleAt+60_000)<90_000;
  if(!fresh||Number(contract.state)!==0||!allowed||!volumeOk||!Number.isFinite(maxLev)||leverage>maxLev) $('botLimitResult').dataset.state='blocked';
  else $('botLimitResult').dataset.state='verified';
  updateBotStartAvailability();
}
function updateBotStartAvailability(){
  const contract=botState.market?.contract,market=botState.market,allocated=Math.max(0,Number($('botAllocatedBudget')?.value)||0),share=Number($('botMarginShare')?.value)||0,leverage=Number($('botLeverage')?.value)||0,riskPercent=Number($('botRiskPercent')?.value)||.5,margin=botRiskSizing(allocated,share,leverage,riskPercent,market).margin,wallet=Number($('botWalletBudget')?.value)||0;
  const latest=market?.candles?.at(-1)?.time||0,marketFresh=!!market&&Date.now()-market.checkedAt<30_000&&latest>0&&Date.now()-(latest+60_000)<90_000;
  const available=botState.availableUsdt;
  const eligible=botState.storageAvailable&&botState.accountConnected&&!!contract&&$('botLimitResult')?.dataset.state==='verified'&&(contract.apiAllowed===true||contract.apiAllowed===1||contract.apiAllowed==='1'||contract.apiAllowed==='true')&&Number(contract.state)===0&&marketFresh&&margin>0&&Number($('botAllocatedBudget')?.value)<=wallet&&Number.isFinite(available)&&available>=margin*1.03&&$('botLiveConsent')?.checked&&!botState.botActive&&!botState.botBusy&&!botState.emergencyLatched;
  $('botStartButton').disabled=!eligible;$('botStartButton').textContent=botState.botBusy?'Vérification…':'Démarrer le bot';$('botStopButton').classList.toggle('hidden',!botState.botActive);
}
function drawBotChart() {
  const canvas=$('botPriceChart'), candles=botState.market?.candles||[]; if(!canvas||!candles.length)return;
  const rect=canvas.getBoundingClientRect(),ratio=window.devicePixelRatio||1,width=Math.max(300,rect.width),height=rect.height||145;
  canvas.width=width*ratio;canvas.height=height*ratio;const ctx=canvas.getContext('2d');if(!ctx)return;ctx.scale(ratio,ratio);ctx.clearRect(0,0,width,height);
  const recent=candles.slice(-60),pad={left:5,right:62,top:8,bottom:20},plotW=width-pad.left-pad.right,plotH=height-pad.top-pad.bottom;
  const highs=recent.flatMap(c=>[c.high,c.low]),spread=Math.max(...highs)-Math.min(...highs)||1,min=Math.min(...highs)-spread*.1,max=Math.max(...highs)+spread*.1,y=v=>pad.top+(max-v)/(max-min)*plotH,x=i=>pad.left+(i+.5)*plotW/recent.length;
  ctx.font='9px monospace';ctx.fillStyle='#728294';ctx.strokeStyle='#1b2b3d';
  for(let g=0;g<3;g++){const yy=pad.top+plotH*g/2;ctx.beginPath();ctx.moveTo(pad.left,yy);ctx.lineTo(width-pad.right,yy);ctx.stroke();ctx.fillText(price(max-(max-min)*g/2),width-pad.right+5,yy+3);}
  const bodyW=Math.max(2,plotW/recent.length*.55);recent.forEach((c,i)=>{const color=c.close>=c.open?'#65d8a3':'#ff7881',cx=x(i),top=y(Math.max(c.open,c.close)),bottom=y(Math.min(c.open,c.close));ctx.strokeStyle=color;ctx.fillStyle=color;ctx.beginPath();ctx.moveTo(cx,y(c.high));ctx.lineTo(cx,y(c.low));ctx.stroke();ctx.fillRect(cx-bodyW/2,top,bodyW,Math.max(1,bottom-top));});
  ctx.fillStyle='#647487';ctx.fillText(time(recent[0].time).slice(0,5),pad.left,height-4);ctx.fillText(time(recent.at(-1).time).slice(0,5),width-pad.right-30,height-4);
}
function renderBotMarket(data) {
  botState.market=data;const symbol=data.symbol, ticker=Array.isArray(data.ticker)?data.ticker[0]:data.ticker,contract=data.contract,closes=(data.candles||[]).map(c=>c.close).filter(Number.isFinite);
  data.ticker=ticker; $('botChartTitle').textContent=symbol+' · MEXC Perpétuel';$('botPriceValue').textContent=price(Number(ticker?.lastPrice));
  $('botContractState').textContent=Number(contract.state)===0?'Contrat actif · limites relues sur MEXC':'Contrat inactif ou statut non confirmé';
  const facts=[['Prix MEXC',price(Number(ticker?.lastPrice))],['Levier maximum',(contract.maxLeverage??contract.countryConfigContractMaxLeverage??'—')+'×'],['Pas de prix',contract.priceUnit??'—'],['Taille du contrat',contract.contractSize??'—']];
  $('botContractFacts').innerHTML=facts.map(([label,value])=>'<div><span>'+label+'</span><strong>'+String(value).replace(/[<>]/g,'')+'</strong></div>').join('');
  $('botContractFreshness').textContent='Lecture '+time(data.checkedAt)+' · public MEXC';
  const m=macd(closes);$('botMacdValue').textContent=m?format(m.line,6)+' · signal '+format(m.signal,6):'En attente de 35 chandelles';
  const zones=supportResistance([['1m',data.candles],['5m',data.candles5m],['15m',data.candles15m]],Number(ticker?.lastPrice));$('botSupport').textContent=zones.support?price(zones.support.value)+' · '+format(zones.support.distance,2)+' % · '+zones.support.tfs.join('/'):'Non disponible';$('botResistance').textContent=zones.resistance?price(zones.resistance.value)+' · +'+format(zones.resistance.distance,2)+' % · '+zones.resistance.tfs.join('/'):'Non disponible';
  const atr=atrValue(data.candles),last=Number(ticker?.lastPrice);$('botAtr').textContent=atr&&last?price(atr)+' · '+format(atr/last*100,3)+' % du prix':'Non disponible';
  const metric=(id,value,digits=0)=>{const node=$(id),n=Number(value);node.textContent=value!==null&&value!==undefined&&Number.isFinite(n)?format(n,digits):'Non fourni par MEXC';};metric('botVolume24',ticker?.volume24,2);metric('botAmount24',ticker?.amount24,2);metric('botOpenInterest',ticker?.holdVol,2);metric('botFunding',ticker?.fundingRate*100,4);if(Number.isFinite(Number(ticker?.fundingRate)))$('botFunding').textContent=format(Number(ticker.fundingRate)*100,4)+' %';
  if(closes.length){const high=Math.max(...closes.slice(-60)),low=Math.min(...closes.slice(-60)),range=high-low;$('botFib382').textContent=price(high-range*.382);$('botFib500').textContent=price(high-range*.5);$('botFib618').textContent=price(high-range*.618);}
  renderBotExposure();drawBotChart();
}
async function refreshBotMarket() {
  if(botState.marketBusy)return;botState.marketBusy=true;
  const symbol=botSymbol();botState.symbol=symbol;
  try{const data=await botRequest('/api/bot/market?symbol='+encodeURIComponent(symbol));if(botSymbol()===symbol)renderBotMarket(data);}
  catch(error){$('botContractState').textContent='Données MEXC indisponibles';$('botContractFreshness').textContent=error.message;$('botLimitResult').textContent='Limites non vérifiées; démarrage interdit.';$('botStartButton').disabled=true;}
  finally{botState.marketBusy=false;}
}
function renderBotAccount(data) {
  botState.accountConnected=!!data.connected;
  const usdt=(data.assets||[]).find(x=>String(x.currency||'').toUpperCase()==='USDT');botState.availableUsdt=Number(usdt?.availableBalance??usdt?.available??usdt?.equity);
  $('botConnectionLabel').textContent=data.connected?'Compte connecté · lecture':'Hors connexion';
  $('botAccountStatus').textContent=data.connected?'Compte vérifié · lecture seule':'Aucune clé de trading configurée';
  $('botAccountDetails').textContent=data.connected?'Lecture MEXC '+time(data.checkedAt)+' · '+format(data.latencyMs,0)+' ms. Aucun ordre n’est envoyé.':'La clé est testée avec des requêtes de lecture puis chiffrée localement.';
  $('botConnectButton').classList.toggle('hidden',!!data.connected);$('botDisconnectButton').classList.toggle('hidden',!data.connected);
  if(data.connected){const positions=data.positions||[];$('botAccountSummary').innerHTML=[['USDT disponible',format(botState.availableUsdt,2)],['Positions ouvertes',String(positions.length)],['Vérifié',time(data.checkedAt)]].map(([a,b])=>'<div><span>'+a+'</span><strong>'+b+'</strong></div>').join('');$('botAccountSummary').classList.remove('hidden');}
  else $('botAccountSummary').classList.add('hidden');
  updateBotStartAvailability();
}
async function refreshBotAccount(){try{const data=await botRequest('/api/bot/account');renderBotAccount(data);}catch(error){botState.accountConnected=false;botState.availableUsdt=null;$('botAccountStatus').textContent='Lecture MEXC indisponible';$('botAccountDetails').textContent=error.message;updateBotStartAvailability();}}
function renderBotActivity(data){const search=data.search;$('botSearchPhase').textContent=search?.label||(data.active?'En attente de données MEXC':'Bot arrêté');$('botSearchTime').textContent=search?.checkedAt?time(search.checkedAt):'—';$('botSearchPrice').textContent=Number.isFinite(Number(search?.price))?price(Number(search.price)):'—';$('botSearchMacd').textContent=search?.macd?search.macd.toUpperCase():'Aucun croisement';$('botSearchTrend').textContent=(search?.trend5||'—').toUpperCase()+' / '+(search?.trend15||'—').toUpperCase();const list=$('botActivityList'),events=Array.isArray(data.events)?data.events.slice(0,30):[];if(!events.length){list.innerHTML='<li class="bot-activity-empty">Les recherches, entrées et ajustements confirmés apparaîtront ici.</li>';return;}list.innerHTML=events.map(event=>{const label=String(event.label||'Événement').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),detail=String(event.detail||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),levels=[Number.isFinite(Number(event.stopLoss))&&event.stopLoss!==null?'SL '+price(Number(event.stopLoss)):null,Number.isFinite(Number(event.takeProfit))&&event.takeProfit!==null?'TP '+price(Number(event.takeProfit)):null].filter(Boolean).join(' · ');return'<li class="bot-activity-item type-'+String(event.type||'event').replace(/[^a-z-]/g,'')+'"><time>'+time(Number(event.at))+'</time><div><strong>'+label+'</strong>'+(detail?'<span>'+detail+'</span>':'')+(levels?'<small>'+levels+'</small>':'')+'</div>'+(Number.isFinite(Number(event.price))&&event.price!==null?'<b>'+price(Number(event.price))+'</b>':'')+'</li>';}).join('');}
async function refreshBotStatus(){try{const data=await botRequest('/api/bot/status');botState.botActive=!!data.active;const native=window.eventFuturesNative;if(data.active&&native?.keepAwakeForBot)native.keepAwakeForBot().then(result=>{$('botPowerStatus').textContent=result?.active?'Ordinateur maintenu éveillé pendant le suivi du bot':'Maintien de l’ordinateur actif indisponible';}).catch(()=>$('botPowerStatus').textContent='Maintien de l’ordinateur actif indisponible');else if(!data.active&&native?.allowSleepAfterBot){native.allowSleepAfterBot().catch(()=>{});$('botPowerStatus').textContent='Veille autorisée · bot arrêté';}else $('botPowerStatus').textContent='Application web · le bot ne tourne pas en arrière-plan';$('botStatusText').textContent=data.status||'Bot arrêté';$('botOrderState').textContent=data.managedPosition?'Position MEXC suivie':'Aucun ordre en cours';if(data.active)$('botExitState').textContent='SL / TP MEXC · trailing en suivi';else if(data.status?.includes('Intervention manuelle'))$('botExitState').textContent='Vérification MEXC requise';renderBotActivity(data);updateBotStartAvailability();}catch{}}
async function setupBot() {
  const native=window.eventFuturesNative, local=['localhost','127.0.0.1'].includes(location.hostname), storage=native?.getBotCredentialStorageStatus?await native.getBotCredentialStorageStatus():{available:false,saved:false};
  botState.storageAvailable=!!(local&&storage.available);
  if(!local||!storage.available){$('botConnectButton').disabled=true;$('botAccountDetails').textContent='La configuration exige l’application bureau et le chiffrement sécurisé du système.';}
  else if(storage.saved){$('botAccountStatus').textContent='Clé chiffrée restaurée · vérification en cours';await refreshBotAccount();}
  $('botPairSelect').addEventListener('change',()=>{botState.market=null;$('botChartTitle').textContent=botSymbol()+' · MEXC Perpétuel';$('botPriceValue').textContent='—';$('botContractState').textContent='Vérification des règles publiques…';updateBotStartAvailability();refreshBotMarket();});
  $('botAllocatedBudget').addEventListener('input',renderBotExposure);$('botMarginShare').addEventListener('input',renderBotExposure);$('botLeverage').addEventListener('input',renderBotExposure);$('botRiskPercent').addEventListener('input',renderBotExposure);
  $('botWalletBudget').addEventListener('input',updateBotStartAvailability);$('botLiveConsent').addEventListener('change',updateBotStartAvailability);
  $('botConnectButton').addEventListener('click',()=>{$('botKeyDialog').classList.remove('hidden');$('botApiKeyInput').focus();});
  $('botKeyDialogClose').addEventListener('click',()=>{$('botKeyDialog').classList.add('hidden');$('botKeyFormError').textContent='';});
  $('botKeyForm').addEventListener('submit',async event=>{event.preventDefault();if(!local||!storage.available)return;let key=$('botApiKeyInput').value,secret=$('botApiSecretInput').value;$('botKeySubmit').disabled=true;$('botKeyFormError').textContent='Vérification de lecture en cours…';try{const data=await botRequest('/api/bot/connect',{method:'POST',body:JSON.stringify({apiKey:key,apiSecret:secret})});const saved=await native.saveBotCredentials(key,secret);if(!saved)throw new Error('Le coffre sécurisé du système n’a pas enregistré la clé; la connexion a été annulée.');renderBotAccount(data);$('botKeyDialog').classList.add('hidden');toast('Clé vérifiée et chiffrée sur cet appareil.');}catch(error){$('botKeyFormError').textContent=error.message;try{await botRequest('/api/bot/disconnect',{method:'POST',body:'{}'});}catch{}}finally{key='';secret='';$('botApiKeyInput').value='';$('botApiSecretInput').value='';$('botKeySubmit').disabled=false;}});
  $('botDisconnectButton').addEventListener('click',async()=>{try{renderBotAccount(await botRequest('/api/bot/disconnect',{method:'POST',body:'{}'}));const result=await native.clearBotCredentials();if(!result?.cleared)toast('Session coupée, mais le fichier chiffré n’a pas pu être supprimé.');}catch(error){toast(error.message);}});
  $('botStartButton').addEventListener('click',async()=>{if($('botStartButton').disabled||botState.botBusy)return;const allocated=Number($('botAllocatedBudget').value),marginPercent=Number($('botMarginShare').value),riskPercent=Number($('botRiskPercent').value)||.5,leverage=Number($('botLeverage').value),exposure=botRiskSizing(allocated,marginPercent,leverage,riskPercent),margin=exposure.margin,notional=exposure.notional;const ok=window.confirm('Démarrer le bot sur '+botSymbol()+' ?\n\nOrdres réels MEXC · MACD 1 min + tendance 5/15 min.\nCible de marge : '+botUsdt(margin)+' · plafond de notionnel : '+botUsdt(notional)+' · levier : '+leverage+'×.\nLe risque estimé est plafonné à '+format(riskPercent,1).replace('.',',')+' % du budget affecté; volume réduit selon le stop, les frais et la profondeur.\nSL 1,5 ATR · TP 3 ATR · trailing après +1,5 ATR.\n\nConfirmez uniquement si vous acceptez le risque de perte.');if(!ok)return;botState.botBusy=true;updateBotStartAvailability();try{const data=await botRequest('/api/bot/start',{method:'POST',body:JSON.stringify({symbol:botSymbol(),allocated,walletBudget:Number($('botWalletBudget').value),marginPercent,riskPercent,leverage,consent:$('botLiveConsent').checked})});botState.botActive=!!data.active;$('botStatusText').textContent=data.status;$('botOrderState').textContent='Surveillance · aucune entrée ouverte';toast('Bot démarré; attente d’un signal MACD confirmé.');}catch(error){toast(error.message);}finally{botState.botBusy=false;updateBotStartAvailability();refreshBotStatus();}});
  $('botStopButton').addEventListener('click',async()=>{try{const data=await botRequest('/api/bot/stop',{method:'POST',body:'{}'});botState.botActive=!!data.active;$('botStatusText').textContent=data.status;toast('Bot arrêté; les protections MEXC en place restent actives.');refreshBotStatus();}catch(error){toast(error.message);}});
  $('botEmergencyStop').addEventListener('click',async()=>{if(!window.confirm('Arrêt d’urgence : arrêter les nouvelles entrées et tenter de clôturer immédiatement la position du bot ? Les protections MEXC existantes ne garantissent pas le prix d’exécution.'))return;botState.botBusy=true;updateBotStartAvailability();try{const data=await botRequest('/api/bot/emergency',{method:'POST',body:'{}'});botState.botActive=false;botState.emergencyLatched=true;$('botStatusText').textContent=data.status;$('botOrderState').textContent=data.managedPosition?'Clôture non confirmée':'Bot arrêté';$('botStartButton').disabled=true;toast(data.status);}catch(error){toast('Arrêt d’urgence non confirmé : '+error.message);}finally{botState.botBusy=false;updateBotStartAvailability();}});
  await refreshBotStatus();renderBotExposure();await refreshBotMarket();
}
function setupMainTabs(){
  const eventTab=$('eventFuturesTab'),botTab=$('perpetualBotTab'),eventPanel=$('top'),botPanel=$('perpBotView');
  const showBot=enabled=>{eventTab.classList.toggle('active',!enabled);botTab.classList.toggle('active',enabled);eventTab.setAttribute('aria-selected',String(!enabled));botTab.setAttribute('aria-selected',String(enabled));eventTab.tabIndex=enabled?-1:0;botTab.tabIndex=enabled?0:-1;eventPanel.hidden=enabled;eventPanel.classList.toggle('hidden',enabled);botPanel.hidden=!enabled;botPanel.classList.toggle('hidden',!enabled);$('headerMarketPill').innerHTML=enabled?'<i></i> '+botSymbol().replace('_',' / '):'<i></i> '+eventMarkets.find(m=>m.symbol===activeMarketSymbol)?.label;$('mainFooterText').textContent=enabled?botSymbol()+' · Perpétuel USDT':(eventMarkets.find(m=>m.symbol===activeMarketSymbol)?.label||activeMarketSymbol.replace('_',' / '))+' · Event Futures 10 min';if(enabled)drawBotChart();};
  eventTab.addEventListener('click',()=>showBot(false));botTab.addEventListener('click',()=>showBot(true));
  $('eventMarketTabs').addEventListener('click',event=>{const button=event.target.closest('[data-event-market]');if(button)activateEventMarket(button.dataset.eventMarket);});$('eventMarketTabs').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;const tabs=[...$('eventMarketTabs').querySelectorAll('[role="tab"]')],index=tabs.indexOf(document.activeElement),next=(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;event.preventDefault();tabs[next]?.focus();tabs[next]?.click();});
  $('refreshButton').addEventListener('click',()=>{if(!botPanel.hidden){refreshBotMarket();refreshBotAccount();}});
}
function renderEventMarketTabs(){const nav=$('eventMarketTabs');nav.replaceChildren(...eventMarkets.map((market,index)=>{const button=document.createElement('button');button.type='button';button.className='event-market-tab'+(market.symbol===activeMarketSymbol?' active':'');button.role='tab';button.setAttribute('aria-selected',String(market.symbol===activeMarketSymbol));button.tabIndex=market.symbol===activeMarketSymbol?0:-1;button.dataset.eventMarket=market.symbol;button.textContent=market.label;button.setAttribute('aria-controls','top');return button;}));}
function applyEventMarketLabels(){const market=eventMarkets.find(m=>m.symbol===activeMarketSymbol);if(!market)return;const label=market.label,pair=activeMarketSymbol.replace('_','/');document.title='Event Futures · '+label;$('eventMarketHeading').textContent=label;$('eventMarketMicro').textContent=label;$('eventChartPair').textContent=pair+' · 1 MINUTE';$('eventChartCard').setAttribute('aria-label','Graphique '+label+' 1 minute');$('headerMarketPill').innerHTML='<i></i> '+label;$('mainFooterText').textContent=label+' · Event Futures 10 min';}
async function activateEventMarket(symbol,initial=false){if(!eventMarkets.some(m=>m.symbol===symbol))return;if(!initial&&symbol===activeMarketSymbol)return;if(!initial)stopScan('stopped');for(const timer of [state.indexHeartbeat,state.indexWatchdog])clearInterval(timer);clearTimeout(state.indexReconnectTimer);clearTimeout(state.spotReconnectTimer);clearTimeout(state.candleRetryTimer);const oldIndex=state.indexSocket,oldSpot=state.socket;state.indexSocket=null;state.socket=null;oldIndex?.close();oldSpot?.close();activeMarketSymbol=symbol;localStorage.setItem('eventlab-market-symbol',symbol);state.candles={};state.indexCandles={};state.indexFetchedAt={};state.lastPrice=null;state.lastTradeAt=0;state.lastReceivedAt=0;state.lastTradeLatency=null;state.spotPrice=null;state.spotTradeAt=0;state.spotReceivedAt=0;state.spotLatency=null;state.lastCandleFetchAt=0;state.candleError=null;state.clockError=null;state.streamError=null;state.analysis=null;state.preSignal=null;state.operationalSignal=null;state.pendingSide=null;state.pendingSince=0;state.signalCooldownUntil=0;state.indexReconnectAttempt=0;clockSyncedAt=0;serverClockOffset=0;renderEventMarketTabs();applyEventMarketLabels();renderPriceStatus();drawChart();decisionFreshness();syncClock();loadCandles();connectStream();connectMexcIndex();}
async function loadEventMarkets(){try{const response=await fetch('./event-markets.json',{cache:'no-store'});if(!response.ok)throw new Error('market_config_unavailable');const config=await response.json();eventMarkets=(Array.isArray(config.markets)?config.markets:[]).filter(m=>m&&['BTC_USDT','ETH_USDT'].includes(m.symbol)&&typeof m.label==='string');if(!eventMarkets.length)throw new Error('market_config_empty');if(!eventMarkets.some(m=>m.symbol===activeMarketSymbol))activeMarketSymbol=eventMarkets[0].symbol;$('marketConfigNote').textContent='Catalogue MEXC vérifié manuellement le '+config.verifiedOn+' · mise à jour contrôlée dans event-markets.json';renderEventMarketTabs();await activateEventMarket(activeMarketSymbol,true);}catch{$('marketConfigNote').textContent='Catalogue local indisponible · marchés Event Futures non chargés';setConnection('bad','Catalogue des marchés indisponible');}}
function installHandlers() {
  $('refreshButton').addEventListener('click', () => { if($('perpBotView').hidden){retryMarketFeed();toast('Reconnexion aux données MEXC demandée.');} });$('retryFeedButton').addEventListener('click',retryMarketFeed);
  $('signalWindowInput').value=String(state.goValiditySeconds);$('signalWindowValue').textContent=state.goValiditySeconds+' s';$('signalWindowInput').addEventListener('input',()=>{state.goValiditySeconds=Number($('signalWindowInput').value);$('signalWindowValue').textContent=state.goValiditySeconds+' s';localStorage.setItem('eventlab-go-validity',String(state.goValiditySeconds));});
  $('positionUpButton').addEventListener('click',()=>addPosition('up')); $('positionDownButton').addEventListener('click',()=>addPosition('down'));
  $('prudenceInput').value=String(state.prudence); $('prudenceValue').textContent=state.prudence+' / 100'; $('prudenceInput').addEventListener('input',()=>{state.prudence=Number($('prudenceInput').value);$('prudenceValue').textContent=state.prudence+' / 100';localStorage.setItem('eventlab-prudence',String(state.prudence));if(state.candles['1m']){state.analysis=analyze();renderAnalysis();}});
  $('scanStartButton').addEventListener('click',startScan); $('scanPauseButton').addEventListener('click',()=>{stopScan('paused');}); $('scanStopButton').addEventListener('click',()=>{stopScan('stopped');}); $('soundEnableButton').addEventListener('click',async()=>{try{const voices=window.speechSynthesis?.getVoices?.()||[],hasFrenchVoice=voices.some(v=>/^fr([-_]|$)/i.test(v.lang));if(!hasFrenchVoice){state.soundEnabled=false;$('soundEnableButton').textContent='Voix française indisponible · décompte visuel actif';return;}const AudioContextType=window.AudioContext||window.webkitAudioContext;if(AudioContextType){state.audio=new AudioContextType();await state.audio.resume();}state.soundEnabled=true;$('soundEnableButton').textContent='Voix française activée';$('soundEnableButton').disabled=true;renderScanControls();}catch{$('scanStatus').textContent='Voix française indisponible · décompte visuel actif.';}}); renderScanControls();
  setupWallet();
  setupMainTabs();setupBot();

  $('clearJournal').addEventListener('click', () => { state.journal = []; persistJournal(); toast('Journal effacé sur cet appareil.'); });
  $('journalList').addEventListener('click', event => { const button = event.target.closest('[data-result]'); if (button) markResult(button.dataset.id, button.dataset.result,button.dataset.source||'manual'); });
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); state.installPrompt = event; $('installButton').classList.remove('hidden'); });
  $('installButton').addEventListener('click', async () => { if (!state.installPrompt) return; state.installPrompt.prompt(); await state.installPrompt.userChoice; state.installPrompt = null; $('installButton').classList.add('hidden'); });
  window.addEventListener('appinstalled', () => { $('installButton').classList.add('hidden'); toast('Application installée.'); });
  document.addEventListener('visibilitychange', () => { if(document.visibilityState==='visible'&&$('perpBotView').hidden){loadCandles();syncClock();if(!state.socket||state.socket.readyState>1)connectStream();if(!state.indexSocket||state.indexSocket.readyState>1)connectMexcIndex();} });
  window.addEventListener('resize', drawChart);
}

installHandlers(); renderJournal();
window.__eventFuturesSmokeReady=loadEventMarkets();
window.__eventFuturesSmoke=async()=>{await window.__eventFuturesSmokeReady;if(eventMarkets.length!==2||!eventMarkets.some(m=>m.symbol==='BTC_USDT')||!eventMarkets.some(m=>m.symbol==='ETH_USDT'))throw new Error('Catalogue crypto BTC/ETH incomplet.');const results=[];for(const market of eventMarkets){await activateEventMarket(market.symbol);const deadline=Date.now()+45_000;while(Date.now()<deadline&&(!fresh()||!state.analysis?.ready)){await new Promise(resolve=>setTimeout(resolve,500));}if(!fresh()||!state.analysis?.ready||!state.lastPrice||!state.indexCandles['1m']?.length)throw new Error(market.symbol+' : '+(freshnessIssue()||'analyse ou chandelles absentes'));results.push({symbol:market.symbol,price:state.lastPrice,candles1m:state.indexCandles['1m'].length,fresh:true});}return{ok:true,results};};
setInterval(()=>{if($('perpBotView').hidden)loadCandles();}, 10_000); setInterval(()=>{if($('perpBotView').hidden&&(!clockSyncedAt||Date.now()-clockSyncedAt>60_000))syncClock();}, 15_000); setInterval(refreshWallet, 30_000); setInterval(()=>{if(!$('perpBotView').hidden){refreshBotMarket();refreshBotAccount();}},30_000);setInterval(pollMexcIndexFallback,2_500);setInterval(()=>{if(!$('perpBotView').hidden)refreshBotStatus();},2_000);setInterval(processScan, 250);
setInterval(() => { renderPriceStatus(); decisionFreshness(); updateCountdown(); settleJournal(); }, 1_000);
if ('serviceWorker' in navigator) window.addEventListener('load', () => {navigator.serviceWorker.addEventListener('controllerchange',()=>{const build='eventlab-worker-v6';if(sessionStorage.getItem('eventlab-worker-build')!==build){sessionStorage.setItem('eventlab-worker-build',build);location.reload();}});navigator.serviceWorker.register('./sw.js').then(registration=>registration.update()).catch(() => {});});


