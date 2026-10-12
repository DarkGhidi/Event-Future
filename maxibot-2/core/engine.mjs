const DAY = 86400000;
export const dayKey = now => new Date(now).toISOString().slice(0,10);
export function initialState(c, now) {
  const lanes = {};
  for (const market of c.markets) for (const source of ['autonomous','copy']) for (const profile of c.profiles) {
    const id = `${market}:${source}:${profile.name}`;
    lanes[id] = { id, market, source, profile, balance:c.virtualCapitalUSDT, positions:[], closed:[], cooldown:{}, peak:c.virtualCapitalUSDT, drawdown:0, halted:false, day:dayKey(now), dayEquity:c.virtualCapitalUSDT };
  }
  return { version:1, mode:'paper', config:c, startedAt:now, endsAt:now+c.days*DAY, frozenAt:null, selection:null, status:'running', lanes, processedSignals:[], lastDecisionAt:0, api:{day:dayKey(now),calls:0,tokens:0}, dataGaps:0, cycles:0 };
}
export function equity(lane, quotes) {
  return lane.balance + lane.positions.reduce((sum,p) => {
    const q = quotes[p.snapshotId];
    const price = q ? (p.side === 1 ? q.bid : q.ask) : p.lastPrice;
    return sum + p.side * p.quantity * (price - p.entry);
  },0);
}
function event(events, kind, data, now) { events.push({kind,data,time:now}); }
export function closePosition(lane, p, q, reason, c, now, events, rawPrice) {
  const base = rawPrice ?? (p.side === 1 ? q.bid : q.ask);
  const price = base * (1 - p.side * c.slippageBps / 10000);
  const exitFee = p.quantity * price * c.feesBps[lane.market] / 10000;
  const gross = p.side * p.quantity * (price - p.entry);
  lane.balance += gross - exitFee;
  const trade = { ...p, exit:price, exitedAt:now, reason, gross, exitFee, net:gross - exitFee - p.entryFee + p.fundingNet, phase:p.openedAt >= (c.trainingDays * DAY + p.runStartedAt) ? 'validation' : 'training' };
  lane.closed.push(trade); lane.positions = lane.positions.filter(x => x.id !== p.id);
  lane.cooldown[p.snapshotId] = now;
  event(events,'close',{lane:lane.id,trade},now);
}
export function advance(state, quotes, c, now, events) {
  const boundary = state.startedAt + c.trainingDays * DAY;
  const freeze = !state.frozenAt && now >= boundary;
  const finish = now >= state.endsAt;
  let gaps = false;
  if (state.lastAdvanceAt && now-state.lastAdvanceAt > 180000) state.dataGaps++;
  state.lastAdvanceAt=now;
  for (const lane of Object.values(state.lanes)) {
    for (const p of [...lane.positions]) {
      const q = quotes[p.snapshotId];
      if (!q || now - q.observedAt > 120000) { gaps = true; continue; }
      p.lastPrice = p.side === 1 ? q.bid : q.ask;
      if (q.market === 'futures') {
        p.fundingSeen ??= [];
        for (const f of q.fundingHistory ?? []) if (!p.fundingSeen.includes(f.time) && f.time <= now && f.time > p.openedAt) {
          const price = q.candles.find(b => b.t <= f.time && b.closeTime > f.time)?.open ?? (q.bid + q.ask)/2;
          const cashflow = -p.side * p.quantity * price * f.rate;
          lane.balance += cashflow; p.fundingNet += cashflow;
          p.fundingSeen.push(f.time);
          event(events,'funding',{lane:lane.id,position:p.id,cashflow,time:f.time},now);
        }
        p.lastFundingAt = now;
      }
      let reason = null, rawPrice;
      const bars = q.candles.filter(b => b.t >= p.openedAt && b.closeTime > p.lastCheckedAt);
      for (const bar of bars) {
        const stopHit = p.side === 1 ? bar.low <= p.stop : bar.high >= p.stop;
        const takeHit = p.side === 1 ? bar.high >= p.take : bar.low <= p.take;
        if (stopHit) { reason='stop'; rawPrice=p.side === 1 ? Math.min(p.stop,q.bid) : Math.max(p.stop,q.ask); break; }
        if (takeHit) { reason='take_profit'; rawPrice=p.side === 1 ? Math.min(p.take,q.bid) : Math.max(p.take,q.ask); break; }
      }
      if (!reason && (p.side === 1 ? q.bid <= p.stop : q.ask >= p.stop)) reason='stop';
      if (!reason && (p.side === 1 ? q.bid >= p.take : q.ask <= p.take)) reason='take_profit';
      if (!reason && now-p.openedAt >= c.maxHoldMinutes*60000) reason='max_hold';
      if (!reason && freeze) reason='training_boundary';
      if (!reason && finish) reason='end_of_week';
      p.lastCheckedAt = now;
      if (reason) closePosition(lane,p,q,reason,c,now,events,rawPrice);
    }
    const value = equity(lane,quotes);
    lane.peak = Math.max(lane.peak,value); lane.drawdown = Math.max(lane.drawdown,1-value/lane.peak);
    if (lane.day !== dayKey(now)) { lane.day=dayKey(now); lane.dayEquity=value; }
    if (lane.drawdown >= c.maxDrawdownPct) lane.halted=true;
    const dailyHalt = value <= lane.dayEquity*(1-c.maxDailyLossPct);
    if (lane.halted || dailyHalt) for (const p of [...lane.positions]) {
      if (quotes[p.snapshotId]) closePosition(lane,p,quotes[p.snapshotId],lane.halted?'drawdown_halt':'daily_halt',c,now,events);
    }
    lane.dailyHalt=dailyHalt;
  }
  if (gaps) state.dataGaps++;
  if (freeze) {
    state.frozenAt = now;
    state.selection = selectProfiles(state,c);
    event(events,'selection_frozen',state.selection,now);
  }
  if (finish) {
    state.status = Object.values(state.lanes).some(l => l.positions.length) ? 'finished_unresolved_positions' : 'finished';
    event(events,'week_finished',{status:state.status},now);
  }
  state.cycles++;
}
export function applyDecision(state, candidate, d, c, now, quotes, events) {
  const q = quotes[candidate.snapshot.id];
  if (!q || now-q.observedAt > 120000 || q.spreadBps > c.maxSpreadBps) return;
  for (const lane of Object.values(state.lanes).filter(l => l.market===q.market && l.source===candidate.source)) {
    const existing = lane.positions.find(p => p.snapshotId===q.id);
    if (d.action==='CLOSE') {
      if (existing && (candidate.source==='autonomous' || existing.leader===candidate.signal?.leader)) closePosition(lane,existing,q,'gpt_close',c,now,events);
      continue;
    }
    let skip=null;
    if (!['LONG','SHORT'].includes(d.action)) skip='WAIT';
    else if (q.market==='spot' && d.action==='SHORT') skip='spot_short_forbidden';
    else if (candidate.source==='copy' && d.action !== candidate.signal.action) skip='copy_direction_mismatch';
    else if (d.confidence < lane.profile.minConfidence) skip='confidence';
    else if (existing) skip='already_exposed';
    else if (lane.halted || lane.dailyHalt || state.status!=='running' || now>=state.endsAt) skip='risk_halt';
    else if (lane.positions.length >= c.maxPositions) skip='max_positions';
    else if (now - (lane.cooldown[q.id]??0) < c.cooldownMinutes*60000) skip='cooldown';
    else if (lane.positions.length*c.ticketUSDT+c.ticketUSDT > Math.max(0,lane.balance)) skip='capital';
    if (skip) { event(events,'skip',{lane:lane.id,candidate:candidate.id,reason:skip},now); continue; }
    const side=d.action==='LONG'?1:-1;
    const entry=(side===1?q.ask:q.bid)*(1+side*c.slippageBps/10000);
    const quantity=c.ticketUSDT/entry;
    const entryFee=c.ticketUSDT*c.feesBps[lane.market]/10000;
    lane.balance-=entryFee;
    const p={id:`${lane.id}:${candidate.id}:${now}`,snapshotId:q.id,leader:candidate.signal?.leader??null,side,entry,quantity,entryFee,fundingNet:0,openedAt:now,lastCheckedAt:now,lastFundingAt:now,runStartedAt:state.startedAt,lastPrice:side===1?q.bid:q.ask,stop:entry*(1-side*c.stopPct),take:entry*(1+side*c.takeProfitPct)};
    lane.positions.push(p);
    event(events,'open',{lane:lane.id,candidate:candidate.id,position:p},now);
  }
}
export function stats(lane, phase) {
  const trades=lane.closed.filter(t => !phase || t.phase===phase);
  const net=trades.reduce((s,t)=>s+t.net,0), gains=trades.reduce((s,t)=>s+Math.max(t.net,0),0), losses=trades.reduce((s,t)=>s+Math.max(-t.net,0),0);
  return {closed:trades.length,netUSDT:net,expectancy:trades.length?net/trades.length:null,winRate:trades.length?trades.filter(t=>t.net>0).length/trades.length:null,profitFactor:losses?gains/losses:null,drawdown:lane.drawdown,open:lane.positions.length};
}
export function selectProfiles(state,c) {
  const selection={};
  for (const market of c.markets) for (const source of ['autonomous','copy']) {
    const eligible=Object.values(state.lanes).filter(l=>l.market===market && l.source===source).map(l=>({lane:l,stats:stats(l,'training')})).filter(({lane,stats:s})=>s.closed>=c.minClosedForSelection && s.expectancy>0 && (s.profitFactor===null || s.profitFactor>=1.1) && !lane.halted && s.open===0);
    eligible.sort((a,b)=>b.stats.expectancy-a.stats.expectancy);
    selection[`${market}:${source}`]=eligible.length?{lane:eligible[0].lane.id,profile:eligible[0].lane.profile.name,reason:'best_training_expectancy'}:{lane:null,reason:'insufficient_or_unprofitable_training'};
  }
  return selection;
}
export function buildReport(state) {
  const validation = {};
  for (const [group,pick] of Object.entries(state.selection??{})) {
    const lane=pick.lane?state.lanes[pick.lane]:null, s=lane?stats(lane,'validation'):null;
    validation[group]={selected:pick.lane,stats:s,passed:state.status==='finished' && state.dataGaps===0 && s?.closed>=30 && s.expectancy>0 && (s.profitFactor===null || s.profitFactor>=1.1) && !lane?.halted};
  }
  return {mode:'paper',status:state.status,startedAt:new Date(state.startedAt).toISOString(),endsAt:new Date(state.endsAt).toISOString(),frozenAt:state.frozenAt,cycles:state.cycles,dataGaps:state.dataGaps,selection:state.selection,validation,lanes:Object.values(state.lanes).map(l=>({id:l.id,balance:l.balance,all:stats(l),training:stats(l,'training'),validation:stats(l,'validation')})),liveImplemented:false,liveEnabled:false};
}
