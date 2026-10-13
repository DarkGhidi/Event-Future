const REST='https://api.fomoapi.io',SOCKET='wss://api.fomoapi.io/ws/alerts';
const MAX_AGE=120000,SIX_HOURS=21600000;
const cleanId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
export const validFomoKey=v=>typeof v==='string'&&/^[\x21-\x7e]{8,512}$/.test(v);
const networkAliases=new Map([
  [1,['ETH','ERC20','ETHEREUM','ETHEREUM(ERC20)']],
  [56,['BSC','BEP20','BEP20(BSC)','BNB SMART CHAIN(BEP20)']],
  [8453,['BASE','BASE MAINNET']],
  [1399811149,['SOL','SOLANA','SOLANA(SOL)']],
  [42161,['ARB','ARBITRUM','ARBITRUM ONE(ARB)']],
  [137,['MATIC','POLYGON','POLYGON(MATIC)']],
  [4663,['ROBINHOOD','ROBINHOOD CHAIN']],
  [143,['MONAD']]
]);
const chainNames={ethereum:1,eth:1,bsc:56,bnb:56,base:8453,solana:1399811149,sol:1399811149,arbitrum:42161,polygon:137,robinhood:4663,monad:143};
export function tokenIdentity(chainId,address){
  if(!networkAliases.has(chainId)||typeof address!=='string')return null;
  if(chainId===1399811149)return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)?chainId+':'+address:null;
  return /^0x[0-9a-fA-F]{40}$/.test(address)?chainId+':'+address.toLowerCase():null;
}
export function normalizeAlert(m,now=Date.now()){
  if(m?.type!=='alert'||m.source!=='feed'||!['buy','sell'].includes(m.alertType)||!cleanId(m.eventId)||!cleanId(m.userId)||!cleanId(m.tradeId)||typeof m.trader!=='string'||m.trader.length>100)return null;
  const chainId=Number(m.chainId),identity=tokenIdentity(chainId,m.tokenAddress);
  if(!identity||chainNames[m.chain]!==chainId||!Number.isFinite(m.ts)||m.ts>now+5000||now-m.ts>MAX_AGE||!Number.isFinite(m.usdValue)||m.usdValue<=0||m.replay===true&&m.alertType==='buy')return null;
  return {id:'fomo:'+m.eventId,leader:'fomo:'+m.userId,trader:m.trader,tradeId:m.tradeId,identity,chainId,contract:m.tokenAddress,action:m.alertType==='buy'?'LONG':'CLOSE',time:m.ts,usdValue:m.usdValue};
}
// Match exchange-owned currency metadata; ticker text never establishes identity.
export function matchMexcToken(signal,currencies,universe){
  const assets=new Set();
  for(const coin of currencies){if(typeof coin.coin!=='string')continue;
    for(const n of coin.networkList??[]){
      if(n.coin&&n.coin!==coin.coin)continue;
      const names=[n.netWork,n.network].filter(x=>typeof x==='string').map(x=>x.trim().toUpperCase());
      const chains=new Set([...networkAliases].filter(([,aliases])=>names.some(x=>aliases.includes(x))).map(([id])=>id));
      if(chains.size!==1||!chains.has(signal.chainId))continue;
      if(tokenIdentity(signal.chainId,n.contract)===signal.identity)assets.add(coin.coin);
    }
  }
  if(assets.size!==1)return [];
  const asset=[...assets][0];return universe.filter(i=>i.asset===asset&&['spot','futures'].includes(i.market));
}
export class FomoApi {
  constructor(key,{request=fetch,Socket=WebSocket,clock=Date.now,onState=()=>{}}={}){
    if(!validFomoKey(key))throw new Error('FOMO_KEY_INVALID');
    this.key=key;this.request=request;this.Socket=Socket;this.clock=clock;this.onState=onState;this.queue=[];this.seen=new Set();this.sells=new Map();this.boards=new Map();this.status='disconnected';this.error=null;this.statsError=null;this.delaySeconds=null;this.lastEventAt=null;this.lastMessageAt=null;this.received=0;this.rejected=0;this.matched=0;this.unlisted=0;this.creditsRemaining=null;this.retries=0;this.closed=false;this.refreshAt=0;this.mappingError=null;
  }
  snapshot(){return {configured:true,status:this.status,connected:this.status==='connected',error:this.error,statsError:this.statsError,mappingError:this.mappingError,delaySeconds:this.delaySeconds,lastEventAt:this.lastEventAt,received:this.received,rejected:this.rejected,matched:this.matched,unlisted:this.unlisted,creditsRemaining:this.creditsRemaining,rankedTraders:this.boards.size,statsUpdatedAt:this.refreshAt||null};}
  publish(){if(!this.closed)this.onState(this.snapshot());}
  async get(path){
    let r;try{r=await this.request(REST+path,{method:'GET',headers:{authorization:'Bearer '+this.key},redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new Error('FOMO_NETWORK_ERROR');}
    if(!r.ok)throw new Error(({401:'FOMO_KEY_REJECTED',402:'FOMO_CREDITS_EXHAUSTED',429:'FOMO_RATE_LIMIT'})[r.status]||'FOMO_SERVICE_ERROR');
    const credits=r.headers.get('x-credits-remaining');if(credits!==null&&Number.isFinite(Number(credits)))this.creditsRemaining=Number(credits);
    try{const text=await r.text();if(text.length>2000000)throw 0;return JSON.parse(text);}catch{throw new Error('FOMO_DATA_INVALID');}
  }
  setBoard(window,data){
    if(!Array.isArray(data?.traders)||data.stale===true)throw new Error('FOMO_DATA_INVALID');
    if(data.capturedAt!==undefined){const captured=Date.parse(data.capturedAt);if(!Number.isFinite(captured)||this.clock()-captured>SIX_HOURS||captured>this.clock()+300000)throw new Error('FOMO_STATS_STALE');}
    for(const t of data.traders){if(!cleanId(t.userId))continue;
      const entry=this.boards.get(t.userId)??{};
      entry[window]={rank:Number.isSafeInteger(t.rank)?t.rank:null,pnlUsd:Number.isFinite(t.pnlUsd)?t.pnlUsd:null,volumeUsd:Number.isFinite(t.volumeUsd)?t.volumeUsd:null,trades:Number.isSafeInteger(t.trades)?t.trades:null,followers:Number.isSafeInteger(t.followers)?t.followers:null};
      this.boards.set(t.userId,entry);
    }
  }
  stats(leader){return this.refreshAt&&this.clock()-this.refreshAt<=SIX_HOURS?this.boards.get(leader.replace(/^fomo:/,''))??null:null;}
  async connect(){
    if(this.closed)throw new Error('FOMO_DISCONNECTED');this.status='connecting';this.publish();
    try{this.setBoard('7d',await this.get('/v2/leaderboard/7d?limit=150'));this.refreshAt=this.clock();}
    catch(e){
      this.error=e.message;const retry=!['FOMO_KEY_REJECTED','FOMO_CREDITS_EXHAUSTED'].includes(e.message);this.status=retry?'reconnecting':'error';this.publish();
      if(retry&&!this.closed){const wait=Math.min(300000,5000*2**Math.min(this.retries++,6));clearTimeout(this.reconnectTimer);this.reconnectTimer=setTimeout(()=>this.connect().catch(()=>{}),wait);this.reconnectTimer.unref?.();}
      throw e;
    }
    await this.open();return this.snapshot();
  }
  async refreshStats(){
    if(this.closed||this.refreshing||this.statsComplete&&this.clock()-this.refreshAt<SIX_HOURS||this.retryStatsAt>this.clock())return;
    this.refreshing=true;
    try{
      const replace=this.statsComplete||this.clock()-this.refreshAt>=SIX_HOURS;
      const windows=replace?['24h','7d','30d']:['24h','30d'];
      const results=await Promise.all(windows.map(async w=>[w,await this.get('/v2/leaderboard/'+w+'?limit=150')]));
      if(this.closed)return;
      if(replace)this.boards.clear();for(const [w,d] of results)this.setBoard(w,d);
      this.refreshAt=this.clock();this.statsComplete=true;this.statsError=null;
    }catch(e){this.statsError=e.message;this.retryStatsAt=this.clock()+SIX_HOURS;}finally{this.refreshing=false;this.publish();}
  }
  open(){
    if(this.closed)return Promise.reject(new Error('FOMO_DISCONNECTED'));
    this.status='connecting';this.publish();
    return new Promise((resolve,reject)=>{
      let done=false;const ws=new this.Socket(SOCKET+'?key='+encodeURIComponent(this.key));this.ws=ws;
      const deadline=setTimeout(()=>{if(!done){done=true;reject(new Error('FOMO_STREAM_TIMEOUT'));ws.close();}},20000);
      const fail=code=>{if(!done){done=true;clearTimeout(deadline);reject(new Error(code));}this.error=code;};
      ws.addEventListener('message',({data})=>{
        if(this.closed||ws!==this.ws)return;
        if(typeof data!=='string'||data.length>65536){this.rejected++;return;}
        let m;try{m=JSON.parse(data);}catch{this.rejected++;return;}
        this.lastMessageAt=this.clock();
        if(m.type==='welcome'){
          if(typeof m.realtime!=='boolean'||!Number.isFinite(m.delaySeconds)||m.delaySeconds<0||m.delaySeconds>60){fail('FOMO_DATA_INVALID');ws.close();return;}
          this.delaySeconds=m.delaySeconds;this.status='connected';this.error=null;this.retries=0;
          if(!done){done=true;clearTimeout(deadline);resolve(this.snapshot());}
          clearInterval(this.watchdog);this.watchdog=setInterval(()=>{if(this.clock()-this.lastMessageAt>90000)ws.close();},15000);this.watchdog.unref?.();this.publish();return;
        }
        if(m.type==='error'){fail('FOMO_STREAM_REJECTED');ws.close();return;}
        if(this.status!=='connected'||m.type!=='alert')return;
        const signal=normalizeAlert(m,this.clock());if(!signal){this.rejected++;return;}
        if(this.seen.has(signal.id))return;this.seen.add(signal.id);if(this.seen.size>10000)this.seen.delete(this.seen.values().next().value);
        if(signal.action==='CLOSE')this.sells.set(signal.leader+'|'+signal.identity,Math.max(this.sells.get(signal.leader+'|'+signal.identity)??0,signal.time));
        if(this.sells.size>10000)this.sells.delete(this.sells.keys().next().value);
        this.received++;this.lastEventAt=signal.time;this.queue.push(signal);if(this.queue.length>1000){this.queue.shift();this.rejected++;}this.publish();
      });
      ws.addEventListener('error',()=>{fail('FOMO_NETWORK_ERROR');ws.close();});
      ws.addEventListener('close',()=>{
        clearTimeout(deadline);if(ws!==this.ws)return;clearInterval(this.watchdog);
        if(!done){done=true;reject(new Error('FOMO_STREAM_REJECTED'));}
        if(this.closed)return;this.status='reconnecting';this.error??='FOMO_STREAM_CLOSED';this.publish();
        const wait=Math.min(300000,5000*2**Math.min(this.retries++,6));clearTimeout(this.reconnectTimer);
        this.reconnectTimer=setTimeout(()=>{this.open().catch(()=>{});},wait);this.reconnectTimer.unref?.();
      });
    });
  }
  take(){
    const exits=this.queue.filter(x=>x.action==='CLOSE'),buys=this.queue.filter(x=>x.action==='LONG');
    const fresh=buys.filter(x=>this.clock()-x.time<=MAX_AGE);
    this.queue=fresh.slice(16);return [...exits,...fresh.slice(0,16)]; // Batch size, not a position limit.
  }
  validEntry(signal){return this.status==='connected'&&signal.action==='LONG'&&this.clock()-signal.time<=MAX_AGE&&!(this.sells.get(signal.leader+'|'+signal.identity)>=signal.time);}
  close(){this.closed=true;this.status='disconnected';clearTimeout(this.reconnectTimer);clearInterval(this.watchdog);this.ws?.close();this.queue=[];this.key='';}
}
