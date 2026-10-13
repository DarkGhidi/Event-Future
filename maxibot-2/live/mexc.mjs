import { createHmac } from 'node:crypto';
import { Mexc } from '../core/mexc.mjs';
const BASE='https://api.mexc.com';
export const finite=(v)=>{if(v===null||v===undefined||v===''||!Number.isFinite(Number(v)))throw new Error('MEXC_DATA_INVALID');return Number(v);};
export const floorStep=(v,step)=>{if(!(v>=0)||!(step>0))throw new Error('MEXC_SIZE_INVALID');return Number((Math.floor((v+step*1e-9)/step)*step).toFixed(16));};
export class ApiError extends Error{constructor(code,definite=false){super('MEXC_'+String(code).replace(/[^A-Z0-9_]/gi,'_'));this.definite=definite;}}
export class LiveMexc extends Mexc {
  constructor(credentials,request=fetch){super();this.credentials=credentials;this.fetcher=request;this.offset=0;this.synced=0;this.lastCall=0;}
  async json(path,options={}){
    if(Date.now()<this.blockedUntil)throw new ApiError('COOLDOWN');
    const wait=Math.max(0,260-(Date.now()-this.lastCall));if(wait)await new Promise(r=>setTimeout(r,wait));this.lastCall=Date.now();
    const {guard,...requestOptions}=options;if(guard&&!guard())throw new ApiError('OFF_CANCELLED',true);
    const r=await this.fetcher(BASE+path,{...requestOptions,signal:AbortSignal.timeout(15000)});
    if(r.status===429||r.status===418){this.blockedUntil=Date.now()+Math.max(60000,(Number(r.headers.get('retry-after'))||60)*1000);throw new ApiError('RATE_LIMIT');}
    if(!r.ok)throw new ApiError('HTTP_'+r.status); // No URL, body or headers in errors.
    const text=await r.text();const safe=text.replace(/("(?:\\[\s\S]|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,(all,string,number)=>string?all:/^-?\d+$/.test(number)&&BigInt(number)>BigInt(Number.MAX_SAFE_INTEGER)?JSON.stringify(number):all);
    const d=JSON.parse(safe);if(d.success===false||(d.code!==undefined&&![0,200].includes(Number(d.code))))throw new ApiError(d.code,true);
    return d.data??d;
  }
  async clock(){if(Date.now()-this.synced<60000)return;const start=Date.now(),d=await this.json('/api/v3/time');this.offset=finite(d.serverTime)-(start+Date.now())/2;this.synced=Date.now();}
  async signed(market,path,method='GET',params={},guard=null){
    await this.clock();const keys=this.credentials();const key=market==='spot'?keys?.spotKey:keys?.futuresKey,secret=market==='spot'?keys?.spotSecret:keys?.futuresSecret;
    if(!key||!secret)throw new ApiError('KEYS_REQUIRED',true);
    const timestamp=String(Math.round(Date.now()+this.offset));
    if(market==='spot'){
      const qs=new URLSearchParams({...params,recvWindow:'5000',timestamp}).toString();const sig=createHmac('sha256',secret).update(qs).digest('hex');
      return this.json(path+'?'+qs+'&signature='+sig,{method,guard,headers:{'X-MEXC-APIKEY':key}});
    }
    const text=method==='POST'?JSON.stringify(params):new URLSearchParams(Object.entries(params).filter(([,v])=>v!==null&&v!==undefined).sort(([a],[b])=>a.localeCompare(b))).toString();
    const sig=createHmac('sha256',secret).update(key+timestamp+text).digest('hex');
    return this.json(path+(method==='GET'&&text?'?'+text:''),{method,guard,headers:{ApiKey:key,'Request-Time':timestamp,Signature:sig,'Content-Type':'application/json'},...(method==='POST'?{body:text}:{})});
  }
  async keyInfo(key){const d=await this.signed('spot','/api/v3/apiKeyInfo','GET',{accessKey:key});if(d.status!=='VALID'||typeof d.permissions!=='string')throw new ApiError('KEY_PERMISSIONS_UNVERIFIED',true);const scopes=d.permissions.split(',').map(x=>x.trim());if(scopes.some(x=>/WITHDRAW.*WRITE|TRANSFER.*WRITE/.test(x)))throw new ApiError('WITHDRAW_TRANSFER_PERMISSION',true);return scopes;}
  async connectCheck(){
    const k=this.credentials(),spotScopes=await this.keyInfo(k.spotKey);const account=await this.signed('spot','/api/v3/account');const uid=String((await this.signed('spot','/api/v3/uid')).uid);if(!/^\d+$/.test(uid))throw new ApiError('ACCOUNT_ID_UNVERIFIED',true);
    let futuresScopes=[],futuresRead=false;if(k.futuresKey){futuresScopes=k.futuresKey===k.spotKey?spotScopes:await this.keyInfo(k.futuresKey);await this.signed('futures','/api/v1/private/account/assets');const other=new LiveMexc(()=>({spotKey:k.futuresKey,spotSecret:k.futuresSecret}),this.fetcher);const otherUid=String((await other.signed('spot','/api/v3/uid')).uid);if(otherUid!==uid)throw new ApiError('ACCOUNT_MISMATCH',true);futuresRead=true;}
    return {uid,verified:true,spotRead:true,currencyRead:spotScopes.includes('SPOT_WITHDRAW_READ'),spotCanTrade:account.canTrade===true&&spotScopes.includes('SPOT_DEAL_WRITE')&&spotScopes.includes('SPOT_DEAL_READ'),futuresRead,futuresCanTrade:futuresScopes.includes('CONTRACT_DEAL_WRITE')&&futuresScopes.includes('CONTRACT_DEAL_READ')};
  }
  async spotBalances(){return (await this.signed('spot','/api/v3/account')).balances??[];}
  async currencyInfo(){
    if(this.currencyCache&&Date.now()-this.currencyCache.at<900000)return this.currencyCache.rows;
    const scopes=await this.keyInfo(this.credentials()?.spotKey);
    if(!scopes.includes('SPOT_WITHDRAW_READ'))throw new ApiError('CURRENCY_READ_PERMISSION',true);
    const rows=await this.signed('spot','/api/v3/capital/config/getall');
    if(!Array.isArray(rows))throw new ApiError('CURRENCY_DATA_INVALID');
    this.currencyCache={at:Date.now(),rows};return rows;
  }
  async accounts(){
    const keys=this.credentials(),spot=keys?.spotKey?await this.signed('spot','/api/v3/account'):null;
    const futures=keys?.futuresKey?await this.signed('futures','/api/v1/private/account/assets'):[];
    return {spot:finite(spot?.balances?.find(b=>b.asset==='USDT')?.free??0),futures:finite(futures.find(b=>b.currency==='USDT')?.availableBalance??0),balances:spot?.balances??[]};
  }
  async discovery(enabled){
    const markets=[];
    if(enabled.spotCanTrade){const [info,allowed,tickers]=await Promise.all([this.json('/api/v3/exchangeInfo'),this.signed('spot','/api/v3/selfSymbols'),this.json('/api/v3/ticker/24hr')]);const allowedSet=new Set(allowed);for(const s of info.symbols??[]){if(s.quoteAsset!=='USDT'||s.status!=='1'||s.isSpotTradingAllowed!==true||!allowedSet.has(s.symbol)||![1,'1'].includes(s.tradeSideType))continue;const t=tickers.find(t=>t.symbol===s.symbol);if(!t)continue;markets.push({market:'spot',asset:s.baseAsset,symbol:s.symbol,meta:s,score:finite(t.quoteVolume)*(.1+Math.abs(finite(t.priceChangePercent))/100)});}}
    if(enabled.futuresCanTrade){const [contracts,tickers]=await Promise.all([this.json('/api/v1/contract/detail/country'),this.json('/api/v1/contract/ticker')]);for(const s of Array.isArray(contracts)?contracts:[contracts]){if(s.quoteCoin!=='USDT'||s.settleCoin!=='USDT'||s.state!==0||s.apiAllowed!==true||![1,3].includes(s.positionOpenType))continue;const t=tickers.find(t=>t.symbol===s.symbol);if(!t)continue;markets.push({market:'futures',asset:s.baseCoin,symbol:s.symbol,meta:s,score:finite(t.amount24??0)*(.1+Math.abs(finite(t.riseFallRate??0)))});}}
    return markets.sort((a,b)=>b.score-a.score);
  }
  async quote(item){const q=await this.snapshot(item.asset,item.market);return {...q,meta:item.meta};}
  async prepare(q,d,budget){
    if(q.market==='spot'){
      const meta=(await this.json('/api/v3/exchangeInfo?symbol='+encodeURIComponent(q.symbol))).symbols?.[0];if(!meta||meta.status!=='1'||meta.isSpotTradingAllowed!==true||!meta.orderTypes.includes('MARKET'))throw new ApiError('MARKET_UNAVAILABLE',true);
      const fee=finite((await this.signed('spot','/api/v3/tradeFee','GET',{symbol:q.symbol})).takerCommission);
      const notional=floorStep(budget/(1+2*fee+.002),10**-meta.quoteAssetPrecision);if(notional<finite(meta.quoteAmountPrecisionMarket??meta.quoteAmountPrecision)||notional>finite(meta.maxQuoteAmountMarket??meta.maxQuoteAmount))throw new ApiError('ORDER_MIN_MAX',true);
      return {market:q.market,asset:q.asset,symbol:q.symbol,quantity:null,notional,reserve:notional*(1+2*fee+.002),leverage:1,fee,meta,side:'LONG',stop:d.stop,take:d.take,source:d.source||'autonomous',reason:d.reason};
    }
    const [meta,fee,risk,positions,modeResult]=await Promise.all([this.json('/api/v1/contract/detail/country?symbol='+encodeURIComponent(q.symbol)),this.signed('futures','/api/v1/private/account/tiered_fee_rate/v2','GET',{symbol:q.symbol}),this.signed('futures','/api/v1/private/account/risk_limit','GET',{symbol:q.symbol}),this.positions(q.symbol),this.signed('futures','/api/v1/private/position/position_mode')]);
    const m=Array.isArray(meta)?meta[0]:meta;const mode=typeof modeResult==='number'?modeResult:modeResult?.positionMode;if(![1,2].includes(mode))throw new ApiError('POSITION_MODE_UNVERIFIED',true);
    if(!m||m.state!==0||m.apiAllowed!==true||![1,3].includes(m.positionOpenType)||positions.some(p=>finite(p.holdVol)>0))throw new ApiError('CONTRACT_ALREADY_HELD_OR_UNAVAILABLE',true);
    const lever=d.leverage,max=Math.min(finite(m.maxLeverage),finite(fee.maxLeverage),finite(m.countryConfigContractMaxLeverage)>0?finite(m.countryConfigContractMaxLeverage):Infinity);
    if(!Number.isSafeInteger(lever)||lever<Math.max(finite(m.minLeverage),finite(fee.minLeverage))||lever>max)throw new ApiError('LEVERAGE_UNAVAILABLE',true);
    let rate=finite(fee.realTakerFee);for(const band of fee.leverageFeeRates??[])if(lever>=finite(band.minLeverage??1)&&lever<=finite(band.maxLeverage??max))rate=Math.max(rate,finite(band.realTakerFee??band.takerFeeRate));
    const riskRow=(risk[q.symbol]??[]).find(r=>r.positionType===(d.action==='LONG'?1:2));if(!riskRow)throw new ApiError('RISK_TIER_UNAVAILABLE',true);const initialRate=Math.max(1/lever,finite(riskRow.imr));
    const price=d.action==='LONG'?q.ask:q.bid,notional=budget/(initialRate+2*rate+.003),vol=floorStep(notional/(price*finite(m.contractSize)),finite(m.volUnit));
    if(vol<finite(m.minVol)||vol>Math.min(finite(m.maxVol),finite(riskRow.maxVol))||lever>finite(riskRow.maxLeverage))throw new ApiError('RISK_TIER_UNAVAILABLE',true);
    const stop=floorStep(d.stop,finite(m.priceUnit)),take=floorStep(d.take,finite(m.priceUnit));if(d.action==='LONG'?!(stop<price&&take>price):!(stop>price&&take<price))throw new ApiError('EXIT_TICK_INVALID',true);
    const mmr=Math.max(finite(m.maintenanceMarginRate),finite(riskRow.mmr));const distance=(initialRate-mmr-2*rate)/(1+mmr);if(distance<=0||Math.abs(stop/price-1)>=distance*.9)throw new ApiError('STOP_BEYOND_LIQUIDATION',true);
    const actual=vol*finite(m.contractSize)*price;
    return {market:q.market,asset:q.asset,symbol:q.symbol,quantity:vol,notional:actual,reserve:actual*(initialRate+2*rate+.003),initialRate,leverage:lever,fee:rate,meta:m,positionMode:mode,side:d.action,source:d.source||'autonomous',reason:d.reason,stop,take};
  }
  async submit(order,guard=null){
    const p=order.plan;
    if(p.market==='spot')return this.signed('spot','/api/v3/order','POST',{symbol:p.symbol,side:order.kind==='open'?'BUY':'SELL',type:'MARKET',...(order.kind==='open'?{quoteOrderQty:p.notional.toFixed(p.meta.quoteAssetPrecision)}:{quantity:floorStep(order.quantity,10**-p.meta.baseAssetPrecision).toFixed(p.meta.baseAssetPrecision)}),newClientOrderId:order.id},guard);
    const side=order.kind==='open'?(p.side==='LONG'?1:3):(p.side==='LONG'?4:2);
    return this.signed('futures','/api/v1/private/order/create','POST',{symbol:p.symbol,price:0,vol:order.quantity??p.quantity,leverage:p.leverage,side,type:5,openType:1,externalOid:order.id,positionMode:p.positionMode,...(order.kind==='close'?{positionId:order.exchangePositionId,...(p.positionMode===2?{reduceOnly:true}:{})}:{stopLossPrice:p.stop,takeProfitPrice:p.take,lossTrend:p.meta.stopOnlyFair?2:1,profitTrend:p.meta.stopOnlyFair?2:1})},guard);
  }
  async orderStatus(o){return o.plan.market==='spot'?this.signed('spot','/api/v3/order','GET',{symbol:o.plan.symbol,origClientOrderId:o.id}):this.signed('futures','/api/v1/private/order/external/'+encodeURIComponent(o.plan.symbol)+'/'+encodeURIComponent(o.id));}
  async cancel(o){if(o.plan.market==='spot')return this.signed('spot','/api/v3/order','DELETE',{symbol:o.plan.symbol,origClientOrderId:o.id});return this.signed('futures','/api/v1/private/order/cancel','POST',{orderIds:[o.exchangeId]});}
  async fills(o,status){
    if(o.plan.market==='futures'){if(o.kind==='open'&&(!/^\d+$/.test(String(status.positionId))||BigInt(status.positionId)<=0n))throw new ApiError('POSITION_ID_PENDING');return {quantity:finite(status.dealVol),price:finite(status.dealAvgPrice),fee:Math.abs(finite(status.takerFee??0))+Math.abs(finite(status.makerFee??0)),positionId:String(status.positionId??''),nativeProtection:Math.abs(Number(status.stopLossPrice)-o.plan.stop)<=Number(o.plan.meta.priceUnit)&&Math.abs(Number(status.takeProfitPrice)-o.plan.take)<=Number(o.plan.meta.priceUnit),profit:finite(status.profit??0)};}
    const trades=await this.signed('spot','/api/v3/myTrades','GET',{symbol:o.plan.symbol,orderId:String(status.orderId),limit:1000});let qty=0,quote=0,fee=0,baseFee=0;for(const t of trades){if(String(t.orderId)!==String(status.orderId))continue;qty+=finite(t.qty);quote+=finite(t.quoteQty);const commission=finite(t.commission);if(t.commissionAsset==='USDT')fee+=commission;else if(t.commissionAsset===o.plan.asset)baseFee+=commission;else if(commission>0){const conversion=await this.json('/api/v3/ticker/price?symbol='+encodeURIComponent(t.commissionAsset+'USDT'));fee+=commission*finite(conversion.price);}}
    if(Math.abs(qty-finite(status.executedQty))>Math.max(1e-12,qty*1e-8))throw new ApiError('FILLS_INCOMPLETE');return {quantity:qty,quote,price:qty?quote/qty:0,fee,baseFee,commissions:trades.filter(t=>String(t.orderId)===String(status.orderId)).map(t=>({asset:t.commissionAsset,amount:t.commission})),thirdAssetFeeEstimated:trades.some(t=>Number(t.commission)>0&&!['USDT',o.plan.asset].includes(t.commissionAsset))};
  }
  async positions(symbol){return this.signed('futures','/api/v1/private/position/open_positions','GET',symbol?{symbol}:{});}
  async disableAutoMargin(positionId){return this.signed('futures','/api/v1/private/position/change_auto_add_im','POST',{positionId,isEnabled:false});}
  async historicalPosition(p){for(let page=1;page<=20;page++){const data=await this.signed('futures','/api/v1/private/position/list/history_positions','GET',{symbol:p.plan.symbol,page_num:page,page_size:100,start_time:p.openedAt-60000});const rows=Array.isArray(data)?data:data.resultList??[];const found=rows.find(r=>String(r.positionId)===p.exchangePositionId);if(found)return found;if(rows.length<100)return null;}throw new ApiError('HISTORY_INCOMPLETE');}
}
