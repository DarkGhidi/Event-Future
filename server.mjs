import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const eventMarkets = JSON.parse(fs.readFileSync(path.join(root, 'event-markets.json'), 'utf8')).markets.map(m => m.symbol);
const botEventFile = process.env.EVENT_FUTURES_DATA_DIR ? path.join(process.env.EVENT_FUTURES_DATA_DIR, 'bot-activity.json') : null;
function readBotEvents(){try{return botEventFile?JSON.parse(fs.readFileSync(botEventFile,'utf8')).filter(e=>e&&e.id&&e.at).slice(0,100):[];}catch{return[];}}
const types = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.svg':'image/svg+xml' };
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';
let mexcCredentials = null;
let botCredentials = null;
let botRun = { active:false, emergency:false, status:'Arrêté', config:null, lastSignalBar:0, lastObservedBar:0, lastSearchPhase:null, search:null, events:readBotEvents(), managedPosition:null, lastError:null, loopBusy:false, loopTimer:null };
function addBotEvent(type,label,details={}){const event={id:crypto.randomUUID(),at:Date.now(),type,label,symbol:botRun.config?.symbol||null,price:Number.isFinite(Number(details.price))?Number(details.price):null,stopLoss:Number.isFinite(Number(details.stopLoss))?Number(details.stopLoss):null,takeProfit:Number.isFinite(Number(details.takeProfit))?Number(details.takeProfit):null,detail:details.detail||''};botRun.events.unshift(event);botRun.events=botRun.events.slice(0,100);if(botEventFile){try{fs.mkdirSync(path.dirname(botEventFile),{recursive:true});const tmp=botEventFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify(botRun.events),{mode:0o600});fs.renameSync(tmp,botEventFile);}catch(error){console.warn('Unable to persist local bot activity:',error.code||error.name||'unknown');}}return event;}
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
function allowedBotSymbol(value) { return value === 'BTC_USDT' || value === 'RIVER_USDT'; }
function allowedEventSymbol(value) { return eventMarkets.includes(value); }
async function fetchMexcPublic(url) {
  const parsed = new URL(url);
  const bases = parsed.hostname === 'api.mexc.com' ? ['https://api.mexc.com', 'https://contract.mexc.com'] : [parsed.origin];
  let response, lastError;
  for (let index = 0; index < bases.length; index += 1) {
    try {
      response = await fetch(bases[index] + parsed.pathname + parsed.search, { signal:AbortSignal.timeout(6_000), headers:{ Accept:'application/json' } });
      if (response.ok) break;
      if (index + 1 >= bases.length || ![404, 500, 502, 503, 504].includes(response.status)) throw new Error('mexc_http_' + response.status);
      await response.body?.cancel();
    } catch (error) {
      lastError = error;
      if (index + 1 >= bases.length) throw error;
    }
  }
  if (!response?.ok) throw lastError || new Error('mexc_unavailable');
  const body = await response.json();
  if (!body || body.success !== true) throw new Error('mexc_unavailable');
  return body.data;
}
async function fetchBotMarket(symbol) {
  if (!allowedBotSymbol(symbol)) throw new Error('symbol_invalid');
  const [tickerData, detailData, oneData, fiveData, fifteenData] = await Promise.all([
    fetchMexcPublic('https://api.mexc.com/api/v1/contract/ticker?symbol=' + symbol),
    fetchMexcPublic('https://api.mexc.com/api/v1/contract/detail/country?symbol=' + symbol),
    fetchMexcPublic('https://api.mexc.com/api/v1/contract/kline/' + symbol + '?interval=Min1'),
    fetchMexcPublic('https://api.mexc.com/api/v1/contract/kline/' + symbol + '?interval=Min5'),
    fetchMexcPublic('https://api.mexc.com/api/v1/contract/kline/' + symbol + '?interval=Min15')
  ]);
  const ticker = Array.isArray(tickerData) ? tickerData.find(item => item.symbol === symbol) : tickerData;
  const detail = Array.isArray(detailData) ? detailData.find(item => item.symbol === symbol) : detailData?.symbol === symbol ? detailData : null;
  if (!ticker || !detail || !oneData || !fiveData || !fifteenData) throw new Error('mexc_unavailable');
  const normalizeCandles = raw => {
    let candles = [];
    if (Array.isArray(raw)) candles = raw;
    else if (Array.isArray(raw?.data)) candles = raw.data;
    else if (Array.isArray(raw?.time)) candles = raw.time.map((time, index) => ({ time, open:raw.open?.[index], high:raw.high?.[index], low:raw.low?.[index], close:raw.close?.[index], vol:raw.vol?.[index] }));
    return candles.map(candle => ({ time:Number(candle.time) * (Number(candle.time) < 10_000_000_000 ? 1000 : 1), open:Number(candle.open), high:Number(candle.high), low:Number(candle.low), close:Number(candle.close), volume:Number(candle.vol ?? candle.volume) })).filter(c => [c.time,c.open,c.high,c.low,c.close].every(Number.isFinite)).slice(-240);
  };
  return { symbol, ticker, contract:detail, candles:normalizeCandles(oneData), candles5m:normalizeCandles(fiveData), candles15m:normalizeCandles(fifteenData), checkedAt:Date.now() };
}
async function fetchBotPrivate(pathname, credentials, method='GET', payload=null) {
  const timestamp = String(Date.now());
  const bodyText=payload===null?'':JSON.stringify(payload);
  const query=new URL('https://api.mexc.com'+pathname).searchParams;
  const params=[...query.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>key+'='+value).join('&');
  const signingText=credentials.key+timestamp+(method==='GET'||method==='DELETE'?params:bodyText);
  const signature = crypto.createHmac('sha256', credentials.secret).update(signingText).digest('hex');
  const response = await fetch('https://api.mexc.com' + pathname, { method, signal:AbortSignal.timeout(8_000), headers:{ ApiKey:credentials.key, 'Request-Time':timestamp, Signature:signature, 'Recv-Window':'10000', Accept:'application/json','Content-Type':'application/json','User-Agent':'Event-Futures-Desktop' }, ...(method==='GET'||method==='DELETE'?{}:{body:bodyText}) });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.success !== true) { const error=new Error('mexc_rejected');error.code=body?.code;throw error; }
  return body.data;
}
async function readBotAccount(credentials) {
  const started = Date.now();
  const [assets, positions] = await Promise.all([
    fetchBotPrivate('/api/v1/private/account/assets', credentials),
    fetchBotPrivate('/api/v1/private/position/open_positions', credentials)
  ]);
  return { connected:true, assets:Array.isArray(assets) ? assets : [], positions:Array.isArray(positions) ? positions : [], checkedAt:Date.now(), latencyMs:Date.now()-started };
}
const emaSeries=(values,period)=>{const out=Array(values.length).fill(null);if(values.length<period)return out;let value=values.slice(0,period).reduce((a,b)=>a+b,0)/period;out[period-1]=value;const k=2/(period+1);for(let i=period;i<values.length;i++){value=values[i]*k+value*(1-k);out[i]=value;}return out;};
function trendDirection(candles){const closed=candles.filter(c=>c.time+300_000<=Date.now()).map(c=>c.close);if(closed.length<55)return null;const e20=emaSeries(closed,20).at(-1),e50=emaSeries(closed,50).at(-1),last=closed.at(-1);return e20>e50&&last>e20?'long':e20<e50&&last<e20?'short':null;}
function macdCross(candles){const closed=candles.filter(c=>c.time+60_000<=Date.now()),values=closed.map(c=>c.close);if(values.length<60)return null;const fast=emaSeries(values,12),slow=emaSeries(values,26),line=values.map((_,i)=>fast[i]===null||slow[i]===null?null:fast[i]-slow[i]),valid=line.map((v,i)=>v===null?null:{i,v}).filter(Boolean),sigValues=valid.map(x=>x.v),signal=emaSeries(sigValues,9);if(signal.length<2)return null;const last=valid.at(-1),prev=valid.at(-2),si=signal.at(-1),sp=signal.at(-2);if(!last||!prev)return null;return prev.v<=sp&&last.v>si?'long':prev.v>=sp&&last.v<si?'short':null;}
function atrValue(candles,period=14){const closed=candles.filter(c=>c.time+60_000<=Date.now());if(closed.length<period+1)return null;const trs=[];for(let i=1;i<closed.length;i++){const c=closed[i],p=closed[i-1];trs.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));}const recent=trs.slice(-period);return recent.reduce((a,b)=>a+b,0)/recent.length;}
function normalizeOpenPositions(value){if(Array.isArray(value))return value;if(Array.isArray(value?.resultList))return value.resultList;if(Array.isArray(value?.list))return value.list;return [];}
async function readBotPositions(){const value=await fetchBotPrivate('/api/v1/private/position/open_positions',botCredentials);return normalizeOpenPositions(value);}
async function readBotStopOrders(symbol){const value=await fetchBotPrivate('/api/v1/private/stoporder/open_orders?symbol='+encodeURIComponent(symbol),botCredentials);return Array.isArray(value)?value:Array.isArray(value?.data)?value.data:[];}
function currentBotStop(orders,positionId){return orders.find(o=>String(o.positionId)===String(positionId)&&Number(o.state)===1);}
function quantize(value,tick,direction){const n=value/tick;return (direction==='down'?Math.floor(n):Math.ceil(n))*tick;}
async function closeBotPosition(position){
  const isLong=Number(position.positionType)===1,vol=Number(position.holdVol),symbol=position.symbol;
  if(!Number.isFinite(vol)||vol<=0)throw new Error('position_volume_unknown');
  const modeData=await fetchBotPrivate('/api/v1/private/position/position_mode',botCredentials),positionMode=Number(modeData?.positionMode??modeData?.mode??botRun.config?.positionMode??(typeof modeData==='number'?modeData:NaN));
  if(![1,2].includes(positionMode))throw new Error('position_mode_unknown');
  const payload={symbol,price:0,vol,side:isLong?4:2,type:5,openType:Number(position.openType)||1,leverage:Number(position.leverage)||1,positionId:position.positionId,positionMode,...(positionMode===2?{reduceOnly:true}:{})};
  await fetchBotPrivate('/api/v1/private/order/create',botCredentials,'POST',payload);
  for(let i=0;i<6;i++){await new Promise(resolve=>setTimeout(resolve,700));const positions=await readBotPositions();if(!positions.some(p=>String(p.positionId)===String(position.positionId)&&Number(p.holdVol)>0))return true;}
  return false;
}
async function verifyOrProtectPosition(position,market){
  let orders=await readBotStopOrders(position.symbol),protect=currentBotStop(orders,position.positionId);
  if(!protect){
    const size=Number(position.holdVol),entry=Number(position.openAvgPrice??position.holdAvgPrice??position.openPrice),atr=atrValue(market.candles);
    if(!Number.isFinite(size)||!Number.isFinite(entry)||!atr||atr<=0)return false;
    const long=Number(position.positionType)===1,tick=Number(market.contract.priceUnit)||.000001;
    const sl=quantize(entry+(long?-1.5:1.5)*atr,tick,long?'down':'up'),tp=quantize(entry+(long?3:-3)*atr,tick,long?'up':'down');
    await fetchBotPrivate('/api/v1/private/stoporder/place',botCredentials,'POST',{positionId:position.positionId,vol:size,stopLossPrice:sl,takeProfitPrice:tp,lossTrend:1,profitTrend:1});
    orders=await readBotStopOrders(position.symbol);protect=currentBotStop(orders,position.positionId);
  }
  const sl=Number(protect?.stopLossPrice),tp=Number(protect?.takeProfitPrice);
  if(!protect||!(sl>0)||!(tp>0))return false;
  const isLong=Number(position.positionType)===1,entry=Number(position.openAvgPrice??position.holdAvgPrice??position.openPrice),atr=atrValue(market.candles),px=Number(market.ticker?.lastPrice),tick=Number(market.contract.priceUnit)||.000001;
  if(!botRun.managedPosition||String(botRun.managedPosition.id)!==String(position.positionId)){botRun.managedPosition={id:position.positionId,extreme:px,initialAtr:atr,stopOrderId:protect.id,lastStopLoss:sl,lastTakeProfit:tp};addBotEvent('protection','Protection MEXC confirmée · SL / TP', {price:px,stopLoss:sl,takeProfit:tp,detail:'Position '+(isLong?'Long':'Short')});}
  else if(!botRun.managedPosition.lastStopLoss){botRun.managedPosition.lastStopLoss=sl;botRun.managedPosition.lastTakeProfit=tp;addBotEvent('protection','Protection MEXC confirmée · SL / TP', {price:px,stopLoss:sl,takeProfit:tp,detail:'Ordres conditionnels relus sur MEXC'});}
  if(atr>0&&px>0&&entry>0){const managed=botRun.managedPosition;managed.extreme=isLong?Math.max(managed.extreme,px):Math.min(managed.extreme,px);const moved=(isLong?managed.extreme-entry:entry-managed.extreme)>=1.5*managed.initialAtr;const candidate=quantize(managed.extreme+(isLong?-1.5:1.5)*atr,tick,isLong?'down':'up'),improves=isLong?candidate>sl+tick/2:candidate<sl-tick/2;
    if(moved&&improves&&((isLong&&candidate<px)||( !isLong&&candidate>px))){await fetchBotPrivate('/api/v1/private/stoporder/change_plan_price',botCredentials,'POST',{stopPlanOrderId:protect.id??protect.stopPlanOrderId,stopLossPrice:candidate,takeProfitPrice:tp});orders=await readBotStopOrders(position.symbol);protect=currentBotStop(orders,position.positionId);if(!protect||Math.abs(Number(protect.stopLossPrice)-candidate)>tick/2)return false;addBotEvent('trailing','Stop suiveur déplacé', {price:px,stopLoss:candidate,takeProfit:Number(protect.takeProfitPrice),detail:'Nouvelle valeur relue sur MEXC'});}
  }
  botRun.managedPosition.lastStopLoss=Number(protect.stopLossPrice);botRun.managedPosition.lastTakeProfit=Number(protect.takeProfitPrice);
  return true;
}
function confirmedBotPivots(candles,duration){const closed=(candles||[]).filter(c=>c.time+duration<=Date.now()),levels=[];for(let i=2;i<closed.length-2;i++){const pivot=closed[i],neighbors=closed.slice(i-2,i).concat(closed.slice(i+1,i+3));if(neighbors.every(c=>pivot.high>c.high))levels.push({price:pivot.high,kind:'resistance'});if(neighbors.every(c=>pivot.low<c.low))levels.push({price:pivot.low,kind:'support'});}return levels;}
function botSignal(market){
  const cross=macdCross(market.candles);if(!cross)return null;
  const t5=trendDirection(market.candles5m),t15=trendDirection(market.candles15m);if(cross!==t5||cross!==t15)return null;
  const closed=market.candles.filter(c=>c.time+60_000<=Date.now()),bar=closed.at(-1),price=Number(market.ticker?.lastPrice),atr=atrValue(market.candles),ticker=market.ticker||{};
  if(!bar||!Number.isFinite(price)||price<=0||!Number.isFinite(atr)||atr<=0)return null;
  const atrPct=atr/price;if(atrPct<.0001||atrPct>.015)return null;
  const volumes=closed.slice(-21,-1).map(c=>c.volume).filter(v=>Number.isFinite(v)&&v>=0),average=volumes.length===20?volumes.reduce((a,b)=>a+b,0)/20:0;
  if(!average||!Number.isFinite(bar.volume)||bar.volume<average*.65)return null;
  const volume24=Number(ticker.volume24),amount24=Number(ticker.amount24),openInterest=Number(ticker.holdVol),funding=Number(ticker.fundingRate);
  if(![volume24,amount24,openInterest,funding].every(Number.isFinite)||volume24<=0||amount24<=0||openInterest<=0||Math.abs(funding)>.003)return null;
  const pivots=[...confirmedBotPivots(market.candles,60_000),...confirmedBotPivots(market.candles5m,300_000),...confirmedBotPivots(market.candles15m,900_000)];
  const obstacle=pivots.filter(level=>cross==='long'?level.kind==='resistance'&&level.price>price:level.kind==='support'&&level.price<price).sort((a,b)=>cross==='long'?a.price-b.price:b.price-a.price)[0];
  if(obstacle&&Math.abs(obstacle.price-price)<atr*.75)return null;
  return{side:cross,bar:bar.time,atrPct,volumeRatio:bar.volume/average,blockingLevel:obstacle?.price??null};
}
async function botTradingTick(){
  if(!botRun.active||botRun.loopBusy||!botCredentials)return;botRun.loopBusy=true;
  let entryMayExist=false,entryMarket=null,positionRiskCandidate=botRun.managedPosition?.id||null;
  try{
    const config=botRun.config,market=await fetchBotMarket(config.symbol),contract=market.contract;entryMarket=market;
    if(!contract||Number(contract.state)!==0||contract.apiAllowed!==true||!Number(market.ticker?.lastPrice))throw new Error('contract_blocked');
    const positions=await readBotPositions(),same=positions.find(p=>p.symbol===config.symbol&&Number(p.holdVol)>0);
    if(same){if(!botRun.managedPosition||String(botRun.managedPosition.id)!==String(same.positionId)){stopBotRuntime(false);botRun.status='Position externe détectée · intervention requise';botRun.lastError='Position non créée par cette session';addBotEvent('attention',botRun.status,{price:Number(market.ticker.lastPrice)});return;}positionRiskCandidate=same.positionId;botRun.search={checkedAt:Date.now(),price:Number(market.ticker?.lastPrice),phase:'position',label:'Position ouverte · protections en suivi'};if(botRun.emergency){botRun.active=false;const closed=await closeBotPosition(same);if(closed)botRun.managedPosition=null;botRun.status=closed?'Arrêt d’urgence · position clôturée':'Intervention manuelle requise · clôture non confirmée';botRun.lastError=closed?null:'Clôture non confirmée';addBotEvent('exit',botRun.status,{price:Number(market.ticker.lastPrice)});return;}const protectedPosition=await verifyOrProtectPosition(same,market);if(!protectedPosition){botRun.active=false;botRun.status='Protection incertaine · clôture urgente';const closed=await closeBotPosition(same);botRun.status=closed?'Protection absente · position clôturée':'Intervention manuelle requise';botRun.lastError=closed?null:'Clôture non confirmée';addBotEvent('attention',botRun.status,{price:Number(market.ticker.lastPrice)});}else botRun.status='Position protégée · suivi dynamique';return;}
    if(botRun.managedPosition){addBotEvent('exit','Position fermée ou absente sur MEXC',{price:Number(market.ticker?.lastPrice),stopLoss:botRun.managedPosition.lastStopLoss,takeProfit:botRun.managedPosition.lastTakeProfit,detail:'État vérifié en relisant les positions'});botRun.managedPosition=null;}
    if(botRun.emergency){botRun.active=false;botRun.status='Arrêt d’urgence · aucune nouvelle entrée';return;}
    const cross=macdCross(market.candles),trend5=trendDirection(market.candles5m),trend15=trendDirection(market.candles15m),signal=botSignal(market),closed=market.candles.filter(c=>c.time+60_000<=Date.now()),observedBar=closed.at(-1),phase=signal?'signal confirmé':cross&&cross===trend5&&cross===trend15?'filtres de marché':'confirmation 5/15 min en attente';
    botRun.search={checkedAt:Date.now(),price:Number(market.ticker?.lastPrice),phase,label:signal?'Signal '+(signal.side==='long'?'Long':'Short')+' confirmé · contrôle des conditions':cross&&cross===trend5&&cross===trend15?'MACD et tendance alignés · vérification des filtres':'Recherche active · '+(cross?'confirmation 5/15 min à attendre':'aucun croisement MACD confirmé'),macd:cross,trend5,trend15,candleAt:observedBar?.time||null};
    if(observedBar&&(observedBar.time!==botRun.lastObservedBar||phase!==botRun.lastSearchPhase)){botRun.lastObservedBar=observedBar.time;botRun.lastSearchPhase=phase;addBotEvent('search',botRun.search.label,{price:Number(market.ticker?.lastPrice),detail:'MACD 1 min · tendance 5/15 min'});}
    if(!signal||signal.bar===botRun.lastSignalBar)return;
    botRun.lastSignalBar=signal.bar;
    const candles=market.candles.filter(c=>c.time+60_000<=Date.now()),atr=atrValue(market.candles),entry=Number(market.ticker.lastPrice),share=config.allocated*config.marginPercent/100,notional=share*config.leverage,contractSize=Number(contract.contractSize),volUnit=Number(contract.volUnit)||1;
    if(!atr||!contractSize||!Number.isFinite(entry))throw new Error('signal_data_stale');
    const vol=Math.floor((notional/(entry*contractSize))/volUnit)*volUnit,tiers=Array.isArray(contract.riskLimitCustom)?contract.riskLimitCustom:[],tier=tiers.find(t=>vol<=Number(t.maxVol)),configuredMax=Number(contract.countryConfigContractMaxLeverage)>0?Number(contract.countryConfigContractMaxLeverage):Number(contract.maxLeverage),tierMax=Number(tier?.maxLeverage),maxLeverage=tierMax>0?Math.min(configuredMax,tierMax):configuredMax;
    const minVol=Number(contract.minVol),maxVol=Math.min(Number(contract.maxVol),Number(contract.limitMaxVol)||Infinity);
    if(!Number.isFinite(vol)||vol<minVol||vol>maxVol||config.leverage>maxLeverage)throw new Error('volume_or_leverage_out_of_range');
    const account=await readBotAccount(botCredentials),usdt=account.assets.find(x=>String(x.currency||'').toUpperCase()==='USDT'),available=Number(usdt?.availableBalance??usdt?.available??usdt?.equity);
    if(!Number.isFinite(available)||available<share*1.03)throw new Error('insufficient_available_margin');
    const bar=candles.at(-1);if(!bar||Date.now()-(bar.time+60_000)>90_000)throw new Error('signal_data_stale');
    const long=signal.side==='long',tick=Number(contract.priceUnit)||.000001,sl=quantize(entry+(long?-1.5:1.5)*atr,tick,long?'down':'up'),tp=quantize(entry+(long?3:-3)*atr,tick,long?'up':'down');
    const positionMode=Number(config.positionMode);
    if(![1,2].includes(positionMode))throw new Error('position_mode_unknown');
    const externalOid='ev'+crypto.randomBytes(12).toString('hex');
    botRun.status='Ordre d’entrée envoyé · vérification de la position et des protections';
    if(botRun.emergency||!botRun.active)return;
    entryMayExist=true;
    await fetchBotPrivate('/api/v1/private/order/create',botCredentials,'POST',{symbol:config.symbol,price:0,vol,side:long?1:3,type:5,openType:1,leverage:config.leverage,externalOid,stopLossPrice:sl,takeProfitPrice:tp,lossTrend:1,profitTrend:1,positionMode});
    let opened=null;for(let i=0;i<8;i++){await new Promise(resolve=>setTimeout(resolve,700));opened=(await readBotPositions()).find(p=>p.symbol===config.symbol&&Number(p.holdVol)>0);if(opened)break;}
    if(!opened){botRun.active=false;botRun.status='Ordre envoyé · résultat à vérifier dans MEXC';botRun.lastError='La position n’a pas pu être confirmée; aucune nouvelle entrée.';return;}
    botRun.managedPosition={id:opened.positionId,extreme:Number(market.ticker.lastPrice),initialAtr:atr,stopOrderId:null};
    addBotEvent('entry','Position '+(long?'Long':'Short')+' ouverte',{price:entry,stopLoss:sl,takeProfit:tp,detail:'Ordre et prix relus via MEXC'});
    if(botRun.emergency){botRun.active=false;const closed=await closeBotPosition(opened);if(closed)botRun.managedPosition=null;botRun.status=closed?'Arrêt d’urgence · position clôturée':'Intervention manuelle requise · clôture non confirmée';botRun.lastError=closed?null:'Clôture non confirmée';return;}
    const protectedPosition=await verifyOrProtectPosition(opened,market);
    if(!protectedPosition){botRun.active=false;botRun.status='Protection incertaine · clôture urgente';const closed=await closeBotPosition(opened);botRun.status=closed?'Protection absente · position clôturée':'Intervention manuelle requise';botRun.lastError=closed?null:'Clôture non confirmée';return;}
    botRun.status='Position protégée · suivi dynamique';
  }catch(error){botRun.lastError=String(error.code||error.message||'error');if(entryMayExist||positionRiskCandidate){botRun.active=false;botRun.status='État de position incertain · vérification urgente';try{const positions=await readBotPositions(),position=entryMayExist?positions.find(p=>p.symbol===botRun.config?.symbol&&Number(p.holdVol)>0):positions.find(p=>String(p.positionId)===String(positionRiskCandidate)&&Number(p.holdVol)>0);if(position){botRun.managedPosition={id:position.positionId,extreme:Number(entryMarket?.ticker?.lastPrice)||Number(position.openAvgPrice),initialAtr:atrValue(entryMarket?.candles||[])||botRun.managedPosition?.initialAtr,stopOrderId:botRun.managedPosition?.stopOrderId};const protectedPosition=entryMarket&&await verifyOrProtectPosition(position,entryMarket);if(!protectedPosition){const closed=await closeBotPosition(position);botRun.status=closed?'Protection absente · position clôturée':'Intervention manuelle requise';botRun.lastError=closed?null:'Clôture non confirmée';}else botRun.status='Position protégée · bot arrêté';}else if(entryMayExist){botRun.status='Ordre non réconcilié · vérifiez MEXC avant reprise';botRun.lastError='État de l’ordre inconnu';}else{botRun.status='Position non réconciliée · intervention manuelle';botRun.lastError='Lecture MEXC incertaine';}}catch{let closed=false;try{const positions=await readBotPositions(),position=entryMayExist?positions.find(p=>p.symbol===botRun.config?.symbol&&Number(p.holdVol)>0):positions.find(p=>String(p.positionId)===String(positionRiskCandidate)&&Number(p.holdVol)>0);closed=position?await closeBotPosition(position):!entryMayExist;}catch{}botRun.status=closed?'Erreur de protection · position clôturée':'Intervention manuelle requise · état ou clôture non confirmés';botRun.lastError=closed?null:'Réconciliation ou clôture non confirmée';}}else if(botRun.active)botRun.status='Surveillance suspendue · '+(error.code||error.message||'erreur');}
  finally{botRun.loopBusy=false;if(!botRun.active&&botRun.loopTimer){clearInterval(botRun.loopTimer);botRun.loopTimer=null;}}
}
function startBotRuntime(config){if(botRun.loopTimer)clearInterval(botRun.loopTimer);botRun={active:true,emergency:false,status:'Surveillance MACD active · attente du signal',config,lastSignalBar:0,lastObservedBar:0,lastSearchPhase:null,search:null,events:botRun.events||[],managedPosition:null,lastError:null,loopBusy:false,loopTimer:setInterval(botTradingTick,4_000)};addBotEvent('start','Surveillance démarrée',{detail:'MACD 1 min · tendance 5/15 min'});botTradingTick();}
function stopBotRuntime(emergency=false){botRun.emergency=emergency;botRun.active=false;botRun.status=emergency?'Arrêt d’urgence demandé':'Arrêté · protections MEXC conservées';addBotEvent('stop',botRun.status);if(botRun.loopTimer)clearInterval(botRun.loopTimer);botRun.loopTimer=null;}
function botStatusPayload(){return{active:botRun.active,status:botRun.status,symbol:botRun.config?.symbol||null,lastError:botRun.lastError,search:botRun.search,events:botRun.events,managedPosition:botRun.managedPosition?{id:botRun.managedPosition.id,lastStopLoss:botRun.managedPosition.lastStopLoss,lastTakeProfit:botRun.managedPosition.lastTakeProfit}:null,checkedAt:Date.now()};}
async function preflightBot(config){
  if(!botCredentials)throw new Error('api_key_required');
  if(!allowedBotSymbol(config.symbol)||!Number.isFinite(config.allocated)||!Number.isFinite(config.marginPercent)||!Number.isInteger(config.leverage)||config.allocated<=0||config.marginPercent<=0||config.marginPercent>100||config.leverage<1||config.walletBudget<=0||config.allocated>config.walletBudget||config.consent!==true)throw new Error('settings_invalid');
  const market=await fetchBotMarket(config.symbol),contract=market.contract,price=Number(market.ticker?.lastPrice),atr=atrValue(market.candles);
  if(!contract||Number(contract.state)!==0||contract.futureType!==1||contract.settleCoin!=='USDT'||contract.apiAllowed!==true||!price||!atr||Date.now()-market.checkedAt>20_000)throw new Error('contract_or_market_blocked');
  const positions=await readBotPositions();if(positions.some(p=>p.symbol===config.symbol&&Number(p.holdVol)>0))throw new Error('existing_position');
  const openOrders=await fetchBotPrivate('/api/v1/private/order/list/open_orders/'+encodeURIComponent(config.symbol),botCredentials);const orders=Array.isArray(openOrders)?openOrders:Array.isArray(openOrders?.data)?openOrders.data:[];if(orders.length)throw new Error('existing_orders');
  const modeData=await fetchBotPrivate('/api/v1/private/position/position_mode',botCredentials),positionMode=Number(modeData?.positionMode??modeData?.mode??modeData);if(![1,2].includes(positionMode))throw new Error('position_mode_unknown');
  const account=await readBotAccount(botCredentials),usdt=account.assets.find(x=>String(x.currency||'').toUpperCase()==='USDT'),available=Number(usdt?.availableBalance??usdt?.available??usdt?.equity),margin=config.allocated*config.marginPercent/100;
  if(!Number.isFinite(available)||available<margin*1.03)throw new Error('insufficient_available_margin');
  const notional=margin*config.leverage,volUnit=Number(contract.volUnit)||1,vol=Math.floor((notional/(price*Number(contract.contractSize)))/volUnit)*volUnit,tiers=Array.isArray(contract.riskLimitCustom)?contract.riskLimitCustom:[],tier=tiers.find(t=>vol<=Number(t.maxVol)),baseMax=Number(contract.countryConfigContractMaxLeverage)>0?Number(contract.countryConfigContractMaxLeverage):Number(contract.maxLeverage),tierMax=Number(tier?.maxLeverage),maxLeverage=tierMax>0?Math.min(baseMax,tierMax):baseMax;
  if(!Number.isFinite(vol)||vol<Number(contract.minVol)||vol>Math.min(Number(contract.maxVol),Number(contract.limitMaxVol)||Infinity)||config.leverage>maxLeverage)throw new Error('volume_or_leverage_out_of_range');
  return{market,positionMode,available,vol,margin};
}
export async function restoreMexcCredentials(credentials) {
  if (!credentials || typeof credentials.key !== 'string' || typeof credentials.secret !== 'string' || !credentials.key || !credentials.secret) return false;
  mexcCredentials = { key:credentials.key, secret:credentials.secret };
  return true;
}
export async function restoreBotCredentials(credentials) {
  if (!credentials || typeof credentials.key !== 'string' || typeof credentials.secret !== 'string' || !credentials.key || !credentials.secret) return false;
  botCredentials = { key:credentials.key, secret:credentials.secret };
  return true;
}
function printAccess() {
  console.log('Application locale (Windows) : http://localhost:' + port);
  if (host === '127.0.0.1' || host === '::1') return;
  for (const [name, entries] of Object.entries(os.networkInterfaces())) for (const entry of entries || []) if (entry.family === 'IPv4' && !entry.internal) console.log('Téléphone (même Wi-Fi) : http://' + entry.address + ':' + port + '  [' + name + ']');
}
export const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if(pathname==='/api/market/time'&&req.method==='GET'){
    const symbol=new URL(req.url,'http://localhost').searchParams.get('symbol')||'BTC_USDT';if(!allowedEventSymbol(symbol))return apiReply(res,400,{error:'Marché Event Futures non autorisé.'});
    try{let serverTime=null,source='ping';try{serverTime=Number(await fetchMexcPublic('https://api.mexc.com/api/v1/contract/ping'));}catch{}if(!Number.isFinite(serverTime)||serverTime<=0){source='index';const data=await fetchMexcPublic('https://api.mexc.com/api/v1/contract/index_price/'+encodeURIComponent(symbol));serverTime=Number(data?.timestamp);}if(serverTime>0&&serverTime<100_000_000_000)serverTime*=1000;if(!Number.isFinite(serverTime)||serverTime<1_500_000_000_000||serverTime>Date.now()+86_400_000)throw new Error('timestamp_unavailable');return apiReply(res,200,{serverTime,source});}catch(error){const code=error?.cause?.code||error?.code||error?.name||'unknown';console.error('[market-time] MEXC public endpoint failed:',code);return apiReply(res,502,{error:'Référence horaire MEXC indisponible.',code});}
  }
  if(pathname==='/api/market/candles'&&req.method==='GET'){
    const requestUrl=new URL(req.url,'http://localhost'),source=requestUrl.searchParams.get('source'),tf=requestUrl.searchParams.get('tf'),symbol=requestUrl.searchParams.get('symbol')||'BTC_USDT';
    const allowed={ '1m':1,'5m':5,'15m':15,'1h':60,'4h':240 };
    if(!allowed[tf]||!['spot','index'].includes(source)||!allowedEventSymbol(symbol))return apiReply(res,400,{error:'Source, marché ou horizon invalide.'});
    try{
      let upstream;
      if(source==='spot'){upstream='https://data-api.binance.vision/api/v3/klines?symbol='+symbol.replace('_','')+'&interval='+tf+'&limit=120';}
      else{const mins=allowed[tf],interval=mins===1?'Min1':mins===5?'Min5':mins===15?'Min15':mins===60?'Min60':'Hour4',end=Math.floor(Date.now()/1000),start=end-mins*60*125;upstream='https://api.mexc.com/api/v1/contract/kline/index_price/'+encodeURIComponent(symbol)+'?interval='+interval+'&start='+start+'&end='+end;}
      if(source==='index'){const parsed=new URL(upstream),bases=['https://api.mexc.com','https://contract.mexc.com'];let response,lastError;for(let i=0;i<bases.length;i+=1){try{response=await fetch(bases[i]+parsed.pathname+parsed.search,{signal:AbortSignal.timeout(6000),headers:{Accept:'application/json'}});if(response.ok)break;if(i+1>=bases.length||![404,500,502,503,504].includes(response.status))throw new Error('mexc_http_'+response.status);await response.body?.cancel();}catch(error){lastError=error;if(i+1>=bases.length)throw error;}}if(!response?.ok)throw lastError||new Error('mexc_unavailable');const data=await response.json();return apiReply(res,200,data);}
      const response=await fetch(upstream,{signal:AbortSignal.timeout(10000),headers:{'Accept':'application/json'}});if(!response.ok)throw new Error('upstream');const data=await response.json();return apiReply(res,200,data);
    }catch(error){const code=error?.cause?.code||error?.code||error?.name||'unknown';console.error('[market-candles] MEXC public endpoint failed:',code);return apiReply(res,502,{error:'Chandelles publiques momentanément indisponibles.',code});}
  }
  if (pathname === '/api/bot/market' && req.method === 'GET') {
    const symbol = new URL(req.url, 'http://localhost').searchParams.get('symbol');
    if (!allowedBotSymbol(symbol)) return apiReply(res, 400, { error:'Contrat non autorisé.' });
    try { return apiReply(res, 200, await fetchBotMarket(symbol)); }
    catch { return apiReply(res, 502, { error:'Données publiques MEXC indisponibles ou contrat non vérifié.' }); }
  }
  if (pathname.startsWith('/api/')) {
    if (!isLoopback(req)) return apiReply(res, 403, { error:'Cette fonction est réservée à localhost sur cet ordinateur.' });
    if (!sameOrigin(req)) return apiReply(res, 403, { error:'Origine refusée.' });
    if (pathname === '/api/bot/connect' && req.method === 'POST') {
      if(process.env.EVENT_FUTURES_DESKTOP!=='1')return apiReply(res,403,{error:'La clé de trading est réservée à l’application de bureau sécurisée.'});
      if(botRun.active)return apiReply(res,409,{error:'Arrêtez le bot avant de remplacer la clé.'});
      let body;
      try { body = await readBody(req); } catch (error) { return apiReply(res, 400, { error:error.message === 'too_large' ? 'Entrée trop volumineuse.' : 'Requête invalide.' }); }
      const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : '', secret = typeof body.apiSecret === 'string' ? body.apiSecret.trim() : '';
      if (!key || !secret || key.length > 256 || secret.length > 256) return apiReply(res, 400, { error:'Clé API et clé secrète requises.' });
      try { const result = await readBotAccount({key,secret}); botCredentials = {key,secret}; return apiReply(res, 200, result); }
      catch { botCredentials = null; return apiReply(res, 401, { error:'Lecture MEXC refusée. Vérifiez les droits de consultation et l’horloge.' }); }
    }
    if (pathname === '/api/bot/account' && req.method === 'GET') {
      if (!botCredentials) return apiReply(res, 200, { connected:false });
      try { return apiReply(res, 200, await readBotAccount(botCredentials)); }
      catch { return apiReply(res, 502, { connected:true, error:'Lecture MEXC momentanément indisponible.' }); }
    }
    if (pathname === '/api/bot/disconnect' && req.method === 'POST') {
      if(botRun.active)return apiReply(res,409,{error:'Arrêtez le bot avant de déconnecter la clé.'});
      if (botCredentials) { botCredentials.key = ''; botCredentials.secret = ''; }
      botCredentials = null;
      return apiReply(res, 200, { connected:false });
    }
    if(pathname==='/api/bot/status'&&req.method==='GET')return apiReply(res,200,botStatusPayload());
    if(pathname==='/api/bot/start'&&req.method==='POST'){
      if(process.env.EVENT_FUTURES_DESKTOP!=='1')return apiReply(res,403,{error:'Le bot exige l’application de bureau sécurisée.'});
      if(botRun.active)return apiReply(res,409,{error:'Le bot fonctionne déjà.'});
      let body;try{body=await readBody(req);}catch{return apiReply(res,400,{error:'Paramètres invalides.'});}
      const config={symbol:body.symbol,allocated:Number(body.allocated),walletBudget:Number(body.walletBudget),marginPercent:Number(body.marginPercent),leverage:Number(body.leverage),consent:body.consent===true};
      try{
        const preflight=await preflightBot(config);
        if(preflight.market.candles.some(c=>c.time+60_000<=Date.now())===false||Date.now()-(preflight.market.candles.filter(c=>c.time+60_000<=Date.now()).at(-1)?.time+60_000)>90_000)throw new Error('signal_data_stale');
        const latestClosed=preflight.market.candles.filter(c=>c.time+60_000<=Date.now()).at(-1)?.time||0;
        startBotRuntime({...config,positionMode:preflight.positionMode,initialBar:latestClosed});
        botRun.lastSignalBar=latestClosed;
        return apiReply(res,200,{...botStatusPayload(),margin:preflight.margin,notional:preflight.margin*config.leverage,available:preflight.available,strategy:'MACD 1 min + tendance 5/15 min',exits:'SL 1,5 ATR · TP 3 ATR · trailing après +1,5 ATR'});
      }catch(error){console.warn('Bot preflight blocked:',String(error?.code||error?.message||'unknown'));return apiReply(res,409,{error:({api_key_required:'Clé MEXC non connectée.',settings_invalid:'Réglages invalides.',contract_or_market_blocked:'Contrat ou marché non autorisé par MEXC.',existing_position:'Une position existe déjà sur ce contrat.',existing_orders:'Des ordres sont déjà ouverts sur ce contrat.',position_mode_unknown:'Mode de position MEXC inconnu.',insufficient_available_margin:'Solde Futures disponible insuffisant.',volume_or_leverage_out_of_range:'Taille ou levier hors limites MEXC.',signal_data_stale:'Données du signal périmées.'})[error.message]||'Pré-vérification MEXC impossible.'});}
    }
    if(pathname==='/api/bot/stop'&&req.method==='POST'){
      stopBotRuntime(false);return apiReply(res,200,botStatusPayload());
    }
    if(pathname==='/api/bot/emergency'&&req.method==='POST'){
      stopBotRuntime(true);let closed=true;
      for(let i=0;i<30&&botRun.loopBusy;i++)await new Promise(resolve=>setTimeout(resolve,500));
      if(botRun.loopBusy){botRun.status='Intervention manuelle requise · opération MEXC encore en cours';botRun.lastError='Clôture différée pour éviter deux ordres simultanés';return apiReply(res,502,botStatusPayload());}
      try{if(botCredentials&&botRun.managedPosition){const positions=await readBotPositions(),position=positions.find(p=>String(p.positionId)===String(botRun.managedPosition.id)&&Number(p.holdVol)>0);if(position)closed=await closeBotPosition(position);}}
      catch{closed=false;}
      if(closed)botRun.managedPosition=null;botRun.status=closed?'Arrêt d’urgence · bot arrêté':'Intervention manuelle requise · clôture non confirmée';botRun.lastError=closed?null:'Clôture non confirmée';
      return apiReply(res,closed?200:502,botStatusPayload());
    }
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
server.on('close', () => { if(botRun.loopTimer)clearInterval(botRun.loopTimer);if (mexcCredentials) { mexcCredentials.key = ''; mexcCredentials.secret = ''; } mexcCredentials = null; if (botCredentials) { botCredentials.key = ''; botCredentials.secret = ''; } botCredentials = null; });
server.on('error', error => { if (error.code === 'EADDRINUSE') { console.error('Le port ' + port + ' est déjà utilisé.'); process.exitCode = 1; return; } console.error(error); process.exitCode = 1; });
server.listen(port, host, () => { console.log('Event/Lab prêt.'); printAccess(); console.log('Gardez cette fenêtre ouverte pendant l’utilisation. Arrêt : Ctrl+C.'); });

