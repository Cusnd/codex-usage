import { before,test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { CloudAccountView,CloudSource } from '../shared/cloud-accounts';

type Components=typeof import('./fixtures/cloud-display-components');
let components:Components;
before(async()=>{
  const dir=path.dirname(fileURLToPath(import.meta.url)),harness=path.join(dir,'fixtures/cloud-display-hooks.ts');
  const result=await build({entryPoints:[path.join(dir,'fixtures/cloud-display-components.tsx')],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',loader:{'.css':'empty'},define:{'import.meta.env.MODE':'"cloud"'},logLevel:'silent',plugins:[{name:'component-boundaries',setup(api){
    api.onResolve({filter:/^(react|@tanstack\/react-query|\.\/CloudWorkspace|\.\/cloud-sync\/provider)$/},args=>{
      const name=path.basename(args.importer);
      if(name==='CloudProjects.tsx'||name==='CloudWorkspace.tsx'&&args.path==='./cloud-sync/provider')return {path:harness};
    });
  }}]});
  const module={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);components=module.exports as Components;
});
const nodes=(node:any):any[]=>node==null?[]:Array.isArray(node)?node.flatMap(nodes):typeof node==='object'?[node,...nodes(node.props?.children)]:[];
const content=(node:any):string=>node==null?'':Array.isArray(node)?node.map(content).join(''):typeof node==='object'?content(node.props?.children):String(node);
const text=(html:string)=>html.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const button=(tree:any,label:string)=>nodes(tree).find(n=>n.type==='button'&&content(n)===label);
const nameInput=(tree:any)=>nodes(tree).find(n=>n.type==='input'&&n.props['aria-label']?.startsWith('项目名称'));
function resetProjects(){const {hooks}=components;hooks.state=[];hooks.requests=[];hooks.pendingRequest=null;hooks.sync=null;hooks.view={cut:{organization_version:1},projects:[{id:'p',name:'Original',manual:true,members:['s'],reasons:[]}],sources:[{id:'s',device_id:'d',name:'Source'}],aliases:{},blocked_edges:[]};}

test('editing a rename draft cancels its prior confirmation, and a new preview submits the visible revised name',async()=>{
  resetProjects();let tree=components.projectTree();nameInput(tree).props.onChange({target:{value:'First draft'}});tree=components.projectTree();button(tree,'保存名称').props.onClick();tree=components.projectTree();
  assert.match(content(tree),/将项目「Original」的显示名称保存为「First draft」/);
  nameInput(tree).props.onChange({target:{value:'Revised draft'}});tree=components.projectTree();
  assert.equal(button(tree,'确认应用'),undefined);assert.equal(components.hooks.requests.length,0);
  button(tree,'保存名称').props.onClick();tree=components.projectTree();assert.match(content(tree),/「Revised draft」/);
  button(tree,'确认应用').props.onClick();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(components.hooks.requests[0][2].name,'Revised draft');assert.equal(components.hooks.requests[0][2].project_id,'p');
});

test('clearing a custom project name is explicit and rename inputs stay locked during submission',async()=>{
  resetProjects();let tree=components.projectTree();nameInput(tree).props.onChange({target:{value:'  '}});tree=components.projectTree();button(tree,'保存名称').props.onClick();tree=components.projectTree();assert.match(content(tree),/清除项目「Original」的自定义名称/);
  let finish!:(value:unknown)=>void;components.hooks.pendingRequest=new Promise(resolve=>{finish=resolve;});button(tree,'确认应用').props.onClick();tree=components.projectTree();assert.equal(nameInput(tree).props.disabled,true);assert.equal(components.hooks.requests[0][2].name,null);finish({});await new Promise(resolve=>setImmediate(resolve));
});

const device:CloudSource={id:'a',name:'A',boundAt:'2026-09-12T11:00:00.000Z',protocol:3,paused:false,revoked:false,historyDeleted:false,collectedAt:'2026-09-12T11:59:00.000Z',receivedAt:'2026-09-12T11:59:10.000Z',appliedAt:'2026-09-12T11:59:20.000Z',coverageFrom:'2026-09-11T00:00:00.000Z',coverageTo:'2026-09-12T11:59:00.000Z',syncedThreads:0,retainedThreads:3,totalThreads:1,initialComplete:false,error:null};
test('device collection, receipt, application and coverage use the workspace timezone and preserve separate count scopes',()=>{
  components.hooks.sync=null;const tokyo=text(components.renderCloud('devices',[device]));
  assert.match(tokyo,/采集：09-12 20:59:00 · 接收：09-12 20:59:10 · 应用：09-12 20:59:20/);assert.match(tokyo,/历史覆盖：09-11 09:00:00 — 09-12 20:59:00/);
  assert.match(tokyo,/云端已保留 3 个会话 · 本次采集报告 1 个会话/);assert.doesNotMatch(tokyo,/已同步 3 \/ 1/);
  const utc=text(components.renderCloud('devices',[device],'UTC'));assert.match(utc,/采集：09-12 11:59:00/);
  const old=text(components.renderCloud('devices',[{...device,retainedThreads:undefined}]));assert.match(old,/云端保留会话数暂不可用/);assert.doesNotMatch(old,/云端已保留 0/);
});

test('browser sync completion follows the workspace timezone',()=>{
  components.hooks.sync={online:true,state:{phase:'full_ready',baseline:null,lastSyncAt:'2026-09-12T11:59:00.000Z',receivedCommitSeq:1,appliedCommitSeq:1}};
  assert.match(text(components.renderCloud('sync',[])),/最近完成 09-12 20:59:00/);
  assert.match(text(components.renderCloud('sync',[],'UTC')),/最近完成 09-12 11:59:00/);components.hooks.sync=null;
});


const account:CloudAccountView={accountRef:'known',deviceId:'a',deviceName:'Quota A',receivedAt:'2026-09-12T11:59:50.000Z',stale:false,quota:{schemaVersion:3,deviceId:'a',sequence:1,accountRef:'known',collectedAt:'2026-09-12T11:59:00.000Z',attemptedAt:'2026-09-12T11:59:00.000Z',provider:'app-server',refreshInterval:60,status:'ok',errorCode:null,buckets:[]},history:{summary:{lifetimeTokens:'999',peakDailyTokens:'100',longestRunningTurnSec:'1',currentStreakDays:'1',longestStreakDays:'1'},dailyUsageBuckets:null},historyCollectedAt:'2026-09-12T11:58:00.000Z',historyMeta:{summarySource:{deviceId:'b',deviceName:'History B',collectedAt:'2026-09-12T11:58:00.000Z',receivedAt:'2026-09-12T11:58:50.000Z',stale:true},dailySources:[]}};
test('account history renders its own source, timestamps and freshness without borrowing quota metadata',()=>{
  const html=text(components.renderCloud('accounts',[account]));assert.match(html,/账户 1 · History B/);assert.match(html,/汇总来源：History B · 历史快照 · 尚未确认更新 09-12 20:58:00 · 接收 09-12 20:58:50/);assert.match(html,/累计 999/);assert.doesNotMatch(html,/Quota A|20:59:50/);
  const quota=text(components.renderCloud('quota',[account]));assert.match(quota,/账户 1 · Quota A/);assert.match(quota,/最近采集 09-12 20:59:00 · 接收 09-12 20:59:50/);
});

test('merged daily history exposes each contributing device and date rather than assigning all history to one device',()=>{
  const merged={...account,historyMeta:{...account.historyMeta!,dailySources:[{...account.historyMeta!.summarySource,dates:['2026-09-12']},{deviceId:'c',deviceName:'History C',collectedAt:'2026-09-12T11:57:00.000Z',receivedAt:'2026-09-12T11:57:50.000Z',stale:false,dates:['2026-09-10','2026-09-11']}]}};
  const html=text(components.renderCloud('accounts',[merged]));assert.match(html,/账户 1 · 2 台设备的历史/);assert.match(html,/每日历史来源：2 台设备/);assert.match(html,/History C · 2 个日期 · 最近采集 09-12 20:57:00 · 接收 09-12 20:57:50/);assert.match(html,/日期：2026-09-10、2026-09-11/);assert.doesNotMatch(html,/Quota A/);
});

test('old cached history without provenance remains visibly unknown instead of using the quota source',()=>{
  const html=text(components.renderCloud('accounts',[{...account,historyMeta:undefined}]));assert.match(html,/历史来源待确认/);assert.match(html,/尚无独立来源信息/);assert.doesNotMatch(html,/Quota A|20:59:50/);
});
