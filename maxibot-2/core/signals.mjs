import { readFileSync, existsSync } from 'node:fs';
export function readSignals(path,state,c,now) {
  if (!existsSync(path)) return {signals:[],rejected:[]};
  const lines=readFileSync(path,'utf8').split('\n').filter(Boolean), signals=[], rejected=[], seen=new Set(state.processedSignals);
  for (const line of lines) {
    let s;
    try { s=JSON.parse(line); } catch { rejected.push({id:null,reason:'invalid_json'}); continue; }
    if (typeof s.id!=='string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(s.id)) { rejected.push({id:null,reason:'invalid_id'}); continue; }
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    let reason=null;
    if (typeof s.time!=='number' || now-s.time<0 || now-s.time>c.maxSignalAgeSeconds*1000 || s.time<state.startedAt) reason='stale_or_future';
    else if (!c.markets.includes(s.market) || !c.symbols.includes(s.asset) || !['LONG','SHORT','CLOSE'].includes(s.action) || typeof s.leader!=='string' || !/^[A-Za-z0-9_@.-]{1,80}$/.test(s.leader)) reason='invalid_signal';
    else if (s.market==='spot' && s.action==='SHORT') reason='spot_short';
    else if (s.action!=='CLOSE' && (!s.stats || !Number.isFinite(s.stats.closedTrades) || !Number.isFinite(s.stats.winRate) || !Number.isFinite(s.stats.topCoinShare) || !Number.isFinite(s.stats.pnl7d) || s.stats.closedTrades<c.minLeaderClosedTrades || s.stats.winRate<c.minLeaderWinRate || s.stats.winRate>1 || s.stats.topCoinShare<0 || s.stats.topCoinShare>c.maxLeaderTopCoinShare || s.stats.pnl7d<0)) reason='leader_cut';
    if (reason) rejected.push({id:s.id,reason});
    else signals.push({id:s.id,time:s.time,market:s.market,asset:s.asset,action:s.action,leader:s.leader,stats:s.action==='CLOSE'?null:{closedTrades:s.stats.closedTrades,winRate:s.stats.winRate,topCoinShare:s.stats.topCoinShare,pnl7d:s.stats.pnl7d}});
  }
  return {signals,rejected};
}
