import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'modules.json'),'utf8'));
const requested=process.argv.slice(2),selected=manifest.modules.filter(module=>requested.includes(module.id));
if(!requested.length||selected.length!==requested.length){console.error('Choose module IDs from modules.json:\n'+manifest.modules.map(m=>m.id).join('\n'));process.exit(1);}
function run(args,cwd=root){const result=spawnSync(process.execPath,args,{cwd,stdio:'inherit',windowsHide:true});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);}
run(['tooling/check-architecture.mjs']);
run(['scripts/build-version.mjs']);
const tests=[...new Set(selected.flatMap(m=>m.tests))],cloudTests=[...new Set(selected.flatMap(m=>m.cloudTests))];
if(tests.length)run(['--import','tsx','--test',...tests]);
if(cloudTests.length){
  for(const fixture of ['cloud-parity-fixture','cloud-origin-fixture','cloud-billing-fixture'])run(['--import','tsx','scripts/'+fixture+'.ts']);
  run(['node_modules/vitest/vitest.mjs','run',...cloudTests],path.join(root,'cloud'));
}
if(!tests.length&&!cloudTests.length)throw new Error('This module has no verification mapping. Add a meaningful validation before changing it.');
