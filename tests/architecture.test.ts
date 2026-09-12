import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {dependencyViolations,moduleOwner,ignoredSourceFiles,type ModuleBoundary} from '../tooling/architecture-rules.mjs';

const modules:ModuleBoundary[]=[
  {id:'foundation',runtime:'universal',paths:['modules/foundation/'],dependencies:[],public:['modules/foundation/clock.ts']},
  {id:'collection',runtime:'node',paths:['modules/collection/'],dependencies:['foundation'],public:['modules/collection/index.ts']},
  {id:'web',runtime:'browser',paths:['modules/web/'],dependencies:['foundation','collection'],public:[]},
];
test('architectural boundary rejects a browser importing Node even through a type-only import',()=>{
  assert.match(dependencyViolations(modules,{from:'modules/web/page.ts',to:'modules/collection/index.ts',line:1,typeOnly:true}).join('\n'),/browser cannot import node/);
});
test('private implementation paths and undeclared dependencies cannot bypass module entrypoints',()=>{
  assert.match(dependencyViolations(modules,{from:'modules/collection/index.ts',to:'modules/foundation/private.ts',line:1}).join('\n'),/private entry/);
  assert.match(dependencyViolations(modules,{from:'modules/foundation/clock.ts',to:'modules/collection/index.ts',line:1}).join('\n'),/cannot depend on/);
  assert.deepEqual(dependencyViolations(modules,{from:'modules/web/page.ts',to:'modules/foundation/clock.ts',line:1}),[]);
});
test('specific runtime adapter ownership overrides a broad domain directory',()=>{
  const all=[...modules,{id:'browser-adapter',runtime:'browser',paths:['modules/collection/browser.ts'],dependencies:[],public:[]}];
  assert.equal(moduleOwner(all,'modules/collection/browser.ts')?.id,'browser-adapter');
  assert.equal(moduleOwner(all,'modules/missing/entry.ts'),undefined);
});

test('runtime data ignore rules cannot silently omit a nested source module from a checkout',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'architecture-ignore-'));
  try{
    const init=spawnSync('git',['init','--quiet',root],{encoding:'utf8',windowsHide:true});
    assert.equal(init.status,0,init.stderr);
    const files=['modules/web/data/workspace.ts','data/runtime.json'];
    writeFileSync(path.join(root,'.gitignore'),'data/\n');
    assert.deepEqual(ignoredSourceFiles(root,files),files);
    writeFileSync(path.join(root,'.gitignore'),'/data/\n');
    assert.deepEqual(ignoredSourceFiles(root,files),['data/runtime.json']);
    assert.deepEqual(ignoredSourceFiles(path.join(root,'source-export'),files),[]);
  }finally{
    const target=path.resolve(root);
    assert.equal(path.dirname(target),path.resolve(tmpdir()));
    assert.ok(path.basename(target).startsWith('architecture-ignore-'));
    rmSync(target,{recursive:true,force:true});
  }
});
