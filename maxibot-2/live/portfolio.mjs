import { randomUUID } from 'node:crypto';
import { finite } from './mexc.mjs';
export function freshPortfolio(capital,mode='paper'){if(!Number.isFinite(capital)||capital<=0)throw new Error('CAPITAL_INVALID');return {version:1,mode,allocated:capital,cash:capital,orders:[],positions:[],closed:[],peak:capital,drawdown:0,history:[],events:[],startedAt:Date.now(),updatedAt:null};}
export function reserved(s){return s.orders.filter(o=>!o.settled&&o.kind==='open').reduce((n,o)=>n+o.reserve,0);}
export function available(s){return Math.max(0,s.cash-reserved(s));}
export function log(s,kind,text,net){s.events.unshift({time:Date.now(),kind,text,...(Number.isFinite(net)?{net}:{})});s.events=s.events.slice(0,200);}
export function reserveOrder(s,plan,kind='open',position=null){
  if(kind==='open'&&(!(plan.reserve>0)||plan.reserve>available(s)+1e-8))throw new Error('CAPITAL_RESERVED');
  if(kind==='open'&&s.positions.some(p=>p.plan.symbol===plan.symbol&&p.plan.market===plan.market))throw new Error('ALREADY_EXPOSED');
  if(s.orders.some(o=>!o.settled&&o.plan.symbol===plan.symbol&&o.plan.market===plan.market))throw new Error('ORDER_PENDING');
  const o={id:'mb'+randomUUID().replaceAll('-',''),kind,plan:structuredClone(plan),reserve:kind==='open'?plan.reserve:0,status:'intent',sentAt:Date.now(),settled:false,...(position?{positionId:position.id,exchangePositionId:position.exchangePositionId,quantity:position.quantity}:{})};
  s.orders.push(o);return o;
}
export function rejectOrder(s,o,reason){o.settled=true;o.status='rejected';log(s,'skip',reason);}
export function settleOrder(s,o,f){
  if(o.settled)return;
  o.fills=structuredClone(f);
  const qty=finite(f.quantity);if(qty<0)throw new Error('FILL_INVALID');
  if(qty===0){o.settled=true;o.status='unfilled';return;}
  const plan=o.plan;
  if(o.kind==='open'){
    const principal=plan.market==='spot'?finite(f.quote):qty*finite(plan.meta.contractSize)*finite(f.price)*(plan.initialRate??1/plan.leverage);
    const cost=principal+finite(f.fee);if(cost>o.reserve+Math.max(.01,o.reserve*.00001))log(s,'reconcile','L’exécution dépasse la réserve ; nouvelles entrées suspendues.');
    s.cash-=cost;
    const p={id:o.id,plan,originalQuantity:qty,quantity:qty-(plan.market==='spot'?(f.baseFee??0):0),principal,cost,entryFee:f.fee,entry:f.price,mark:f.price,openedAt:Date.now(),exchangePositionId:f.positionId||null,realizedNet:0,unrealized:0,protected:plan.market==='spot'?false:f.nativeProtection===true};
    s.positions.push(p);log(s,'open',plan.asset+' · '+plan.side+' · '+plan.market+' · '+plan.leverage+'× · '+plan.source);
    if(cost>o.reserve+Math.max(.01,o.reserve*.00001))s.reconcileFault='RESERVE_EXCEEDED';
  }else{
    const p=s.positions.find(p=>p.id===o.positionId);if(!p)throw new Error('POSITION_MISSING');
    if(plan.market==='futures'){o.status='await_history';o.fill=f;return;} // Funds released only after official position history.
    const disposed=Math.min(p.quantity,qty+(f.baseFee??0));const costPart=p.cost*disposed/p.quantity,net=finite(f.quote)-f.fee-costPart;
    s.cash+=finite(f.quote)-f.fee;p.quantity-=disposed;p.cost-=costPart;p.principal=p.cost;p.realizedNet+=net;
    log(s,'close',plan.asset+' · sortie confirmée '+qty,net);
    if(p.quantity<=1e-14){s.closed.push({id:p.id,asset:plan.asset,market:plan.market,side:plan.side,source:plan.source,net:p.realizedNet,exitedAt:Date.now(),reason:o.reason||'GPT'});s.positions=s.positions.filter(x=>x.id!==p.id);}
  }
  o.settled=true;o.status='settled';
}
export function settleFuturesHistory(s,p,h){
  if(!s.positions.some(x=>x.id===p.id))return false;
  if(Number(h.state)!==3||finite(h.holdVol)!==0)return false;
  const net=finite(h.closeProfitLoss)+finite(h.holdFee)-Math.abs(finite(h.totalFee));
  s.cash+=p.principal+net+p.entryFee;
  s.closed.push({id:p.id,asset:p.plan.asset,market:'futures',side:p.plan.side,source:p.plan.source,net,exitedAt:Date.now(),reason:'MEXC confirmé'});s.positions=s.positions.filter(x=>x.id!==p.id);
  for(const o of s.orders.filter(o=>o.positionId===p.id&&!o.settled)){o.settled=true;o.status='settled';}
  log(s,'close',p.plan.asset+' · position clôturée sur MEXC',net);return true;
}
export function markPortfolio(s,quotes){
  for(const p of s.positions){const q=quotes[p.plan.market+':'+p.plan.asset];if(q){p.mark=p.plan.side==='LONG'?q.bid:q.ask;if(p.plan.market==='spot')p.unrealized=p.quantity*p.mark-p.cost;else if(s.mode==='paper')p.unrealized=(p.plan.side==='LONG'?1:-1)*p.quantity*p.plan.meta.contractSize*(p.mark-p.entry);}}
  const eq=s.cash+s.positions.reduce((n,p)=>n+(p.plan.market==='spot'?p.quantity*p.mark:p.principal+p.unrealized),0);s.peak=Math.max(s.peak,eq);s.drawdown=Math.max(s.drawdown,1-eq/s.peak);s.updatedAt=Date.now();s.history.push({time:s.updatedAt,value:eq});s.history=s.history.slice(-50000);return eq;
}
