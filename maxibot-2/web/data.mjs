import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { stats } from '../core/engine.mjs';

export function readDashboard(path,laneId='spot:autonomous:balanced') {
  if(!existsSync(path)) return {status:'not_started',mode:'paper',liveEnabled:false,updatedAt:null,lanes:[],selected:null,events:[],history:[],positions:[],api:{calls:0,tokens:0},copyConnected:false};
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    db.exec('PRAGMA busy_timeout=3000');
    const row=db.prepare('SELECT json FROM state WHERE id=1').get();
    if(!row) return {status:'not_started',mode:'paper',liveEnabled:false,updatedAt:null,lanes:[],selected:null,events:[],history:[],positions:[],api:{calls:0,tokens:0},copyConnected:false};
    const state=JSON.parse(row.json);
    const lane=state.lanes[laneId] ?? state.lanes['spot:autonomous:balanced'] ?? Object.values(state.lanes)[0];
    const all=stats(lane), initial=state.config.virtualCapitalUSDT;
    const unrealized=lane.positions.reduce((a,p)=>a+p.side*p.quantity*(p.lastPrice-p.entry),0);
    const equity=lane.balance+unrealized;
    const last=db.prepare('SELECT max(time) AS time FROM events').get()?.time;
    const marketTime=db.prepare("SELECT max(time) AS time FROM events WHERE kind='snapshot' AND json_extract(json,'$.market')=?").get(lane.market)?.time;
    const raw=db.prepare('SELECT id,time,kind,json FROM events WHERE kind != ? AND kind != ? ORDER BY id DESC LIMIT 600').all('snapshot','portfolio');
    const events=raw.flatMap(r=>{
      const data=JSON.parse(r.json);
      if(data.lane && data.lane!==lane.id) return [];
      if(r.kind==='gpt') return data.decisions.filter(d=>d.id.startsWith(lane.source==='copy'?'copy:':`auto:${lane.market}:`)).map(d=>({id:`${r.id}:${d.id}`,time:r.time,kind:d.action==='WAIT'?'skip':'decision',text:`${d.id.replace(/^auto:/,'')} · ${d.action} · ${d.reason}`}));
      if(r.kind==='close') return [{id:r.id,time:r.time,kind:'close',text:`${data.trade.snapshotId.split(':')[1]} · ${data.trade.reason}`,net:data.trade.net}];
      if(r.kind==='open') return [{id:r.id,time:r.time,kind:'open',text:`${data.position.snapshotId.split(':')[1]} · ${data.position.side===1?'LONG':'SHORT'} · ${data.position.leader||'GPT'}`}];
      if(r.kind==='skip') return [{id:r.id,time:r.time,kind:'skip',text:`${data.candidate||''} · ${data.reason}`}];
      if(['gpt_skip','market_skip','post_gpt_quote_skip','gpt_budget_skip','week_finished','selection_frozen','stop_skip'].includes(r.kind)) return [{id:r.id,time:r.time,kind:r.kind,text:data.reason||r.kind}];
      return [];
    }).slice(0,60);
    let history=db.prepare("SELECT time,json FROM events WHERE kind='portfolio' AND json_extract(json,'$.lane')=? ORDER BY id DESC LIMIT 12000").all(lane.id).reverse().map(r=>({time:r.time,value:JSON.parse(r.json).equity}));
    if(!history.length) {
      let value=initial; history=[{time:state.startedAt,value}];
      for(const t of lane.closed) {value+=t.net;history.push({time:t.exitedAt,value});}
      history.push({time:last||state.startedAt,value:equity});
    }
    const progress=Math.max(0,Math.min(1,(Date.now()-state.startedAt)/(state.endsAt-state.startedAt)));
    return {status:state.status,mode:'paper',liveEnabled:false,updatedAt:marketTime||last||state.startedAt,heartbeatAt:state.updatedAt||last||state.startedAt,startedAt:state.startedAt,endsAt:state.endsAt,phase:state.frozenAt?'validation':'exploration',progress,dataGaps:state.dataGaps,
      selected:{id:lane.id,initial,equity,realized:lane.balance-initial,unrealized,pnl:equity-initial,pnlPct:(equity/initial-1)*100,winRate:all.winRate,closed:all.closed,wins:lane.closed.filter(t=>t.net>0).length,losses:lane.closed.filter(t=>t.net<=0).length,drawdown:all.drawdown,halted:lane.halted||lane.dailyHalt},
      lanes:Object.values(state.lanes).map(l=>({id:l.id,market:l.market,source:l.source,profile:l.profile.name,net:l.balance-initial,closed:l.closed.length,open:l.positions.length,halted:l.halted})),
      positions:lane.positions.map(p=>({id:p.id,asset:p.snapshotId.split(':')[1],side:p.side===1?'LONG':'SHORT',leader:p.leader,entry:p.entry,mark:p.lastPrice,pnl:p.side*p.quantity*(p.lastPrice-p.entry),openedAt:p.openedAt,stop:p.stop,take:p.take})),
      events,history,api:{calls:state.api.calls,reservedTokens:state.api.tokens,maxCalls:state.config.maxCallsPerDay,maxTokens:state.config.maxTokensPerDay},selection:state.selection,copyConnected:false};
  } finally {db.close();}
}
