import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('CLI complet: MEXC/GPT simulés → décisions → portefeuilles → SQLite → reprise',()=>{
  const dir=mkdtempSync(join(tmpdir(),'bot-crypto-test-'));
  try {
    const env={...process.env,BOT_DATA_DIR:dir,OPENAI_API_KEY:'fixture-no-secret',OPENAI_MODEL:'gpt-fixture'};
    const call=()=>spawnSync(process.execPath,['--import','./tests/mock-api.mjs','core/run.mjs','once'],{env,encoding:'utf8',timeout:30000});
    const first=call();assert.equal(first.status,0,first.stderr);assert.ok(!first.stdout.includes('fixture-no-secret'));assert.ok(!existsSync(join(dir,'run.lock')));
    const r=JSON.parse(readFileSync(join(dir,'report.json'),'utf8'));assert.equal(r.mode,'paper');assert.equal(r.liveEnabled,false);assert.equal(r.lanes.length,12);assert.equal(r.lanes.reduce((a,l)=>a+l.all.open,0),30);
    const second=call();assert.equal(second.status,0,second.stderr);const r2=JSON.parse(readFileSync(join(dir,'report.json'),'utf8'));assert.equal(r2.lanes.reduce((a,l)=>a+l.all.open,0),30);assert.equal(r2.startedAt,r.startedAt);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('STOP créé pendant la réponse GPT bloque les entrées avant exécution',()=>{
  const dir=mkdtempSync(join(tmpdir(),'bot-crypto-stop-'));
  try {
    const env={...process.env,BOT_DATA_DIR:dir,OPENAI_API_KEY:'fixture-no-secret',OPENAI_MODEL:'gpt-fixture',TEST_STOP_DURING_GPT:'1'};
    const r=spawnSync(process.execPath,['--import','./tests/mock-api.mjs','core/run.mjs','once'],{env,encoding:'utf8',timeout:30000});
    assert.equal(r.status,0,r.stderr);
    const report=JSON.parse(readFileSync(join(dir,'report.json'),'utf8'));
    assert.equal(report.lanes.reduce((a,l)=>a+l.all.open,0),0);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
