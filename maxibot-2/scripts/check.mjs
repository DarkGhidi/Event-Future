import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
for(const root of ['desktop','core','ui','scripts','tests'])for(const name of readdirSync(root)){
  if(!/\.(mjs|cjs|js)$/.test(name))continue;
  const r=spawnSync(process.execPath,['--check',join(root,name)],{encoding:'utf8'});
  if(r.status!==0){console.error(r.stderr);process.exit(1);}
}
const html=readFileSync('ui/index.html','utf8'),js=readFileSync('ui/app.js','utf8');
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]),known=new Set(ids);
if(ids.length!==known.size)throw new Error('Duplicate DOM id');
for(const m of js.matchAll(/\$\('([^']+)'\)/g))if(!known.has(m[1]))throw new Error('Unknown DOM id: '+m[1]);
for(const p of ['package.json','config.json','package-lock.json'])JSON.parse(readFileSync(p,'utf8'));
console.log('Syntax, DOM IDs and JSON checked.');
