import test from 'node:test';
import assert from 'node:assert/strict';
import { navigationSearch } from '../web/navigation.js';
test('all selected devices survive filtered, full-session, related-task and Agent navigation',()=>{
  const current='deviceIds=A&range=7&deviceIds=B&scope=filtered';
  const filtered=new URLSearchParams(navigationSearch(current,{returnTo:'/threads?'+current}));
  assert.deepEqual(filtered.getAll('deviceIds'),['A','B']);assert.equal(filtered.get('range'),'7');
  const full=new URLSearchParams(navigationSearch(filtered,{},true));
  assert.deepEqual(full.getAll('deviceIds'),['A','B']);assert.equal(full.get('range'),null);assert.equal(full.get('scope'),null);
  assert.equal(navigationSearch('range=7',{},true),'');
});
