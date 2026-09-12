import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createApp } from '../apps/local/app.js';
import type { EstimatedCost, Settings } from '../modules/contracts/settings.js';
import type { Metrics } from '../modules/contracts/query.js';

type Components = typeof import('./fixtures/pricing-display-components');
let components: Components;
before(async () => {
  const dir = path.dirname(fileURLToPath(import.meta.url)), harness = path.join(dir,'fixtures/pricing-display-hooks.ts');
  const result = await build({entryPoints:[path.join(dir,'fixtures/pricing-display-components.tsx')],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',loader:{'.css':'empty'},define:{'import.meta.env.MODE':'"test"'},logLevel:'silent',plugins:[{name:'pricing-component-boundaries',setup(api){
    api.onResolve({filter:/^(react|@tanstack\/react-query|react-router-dom)$|\/(workspace|motion|motion-data|motion-state|context)\.js$/},args => {
      const name = path.basename(args.importer);
      if (['PriceSettings.tsx','Usage.tsx','SettingsPage.tsx'].includes(name) && args.path==='react' ||
        name==='PriceSettings.tsx' && /\/(workspace|motion)\.js$/.test(args.path) ||
        name==='SettingsPage.tsx' && (args.path==='@tanstack/react-query'||/\/(context|motion-state)\.js$/.test(args.path)) ||
        name==='workspace.ts' && (['react','react-router-dom','@tanstack/react-query'].includes(args.path)||/\/(context|motion-data)\.js$/.test(args.path))) return {path:harness};
    });
  }}]});
  const module={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);components=module.exports as Components;
});
const nodes=(node:any):any[] => node==null?[]:Array.isArray(node)?node.flatMap(nodes):typeof node==='object'?
  [node,...nodes(typeof node.props?.children==='function' && Array.isArray(node.props?.items) ? node.props.items.map((item:any,index:number)=>node.props.children(item,index,true)) : node.props?.children)]:[];
const content=(node:any):string => node==null?'':Array.isArray(node)?node.map(content).join(''):typeof node==='object'?content(node.props?.children):typeof node==='function'?'':String(node);
function reset(settings?: Partial<Settings>) {
  const {hooks}=components;hooks.states={};hooks.requests=[];hooks.invalidations=[];
  hooks.settings={localInterval:60,accountInterval:300,timezone:'UTC',timezoneMode:'manual',costEnabled:true,...settings};hooks.info=components.pricingInfo();
}
function priceProps(tree:any) {return nodes(tree).find(node=>node.type?.name==='PriceSettings').props;}
function checkbox(tree:any,id:string) {return nodes(tree).find(node=>node.type==='input'&&node.props.id===id);}

test('subscription is the default pricing mode; API selection passes through the real settings save handler and preserves custom prices',async()=>{
  reset({modelPrices:[{...components.pricingInfo().prices[0],input:'123'}]});
  let settings=components.settingsTree(), prices=components.pricingTree(priceProps(settings));
  assert.equal(checkbox(prices,'officialApiPricing').props.checked,false);
  assert.match(content(prices),/官方 Token 美元单价/);
  assert.match(content(prices),/订阅 Fast 为 2.5×，API 官方预置 Fast 为 2×/);
  assert.doesNotMatch(content(prices),/credits|兑换|折算/);
  const astra=nodes(prices).find(node=>node.type==='tr'&&content(node).startsWith('gpt-6-astra'));
  assert.deepEqual(nodes(astra).filter(node=>node.type==='td').map(content),['10','1','50','2.5×']);
  assert.equal(nodes(prices).some(node=>node.type==='input'&&node.props['aria-label']==='模型 1 ID'),false);
  checkbox(prices,'officialApiPricing').props.onChange({target:{checked:true}});
  settings=components.settingsTree();prices=components.pricingTree(priceProps(settings));
  assert.equal(checkbox(prices,'officialApiPricing').props.checked,true);
  assert.ok(nodes(prices).some(node=>node.type==='input'&&node.props.value==='123'));
  const form=nodes(settings).find(node=>node.type==='form');await form.props.onSubmit({preventDefault(){}});
  assert.equal(components.hooks.requests[0][0],'settings');assert.equal(components.hooks.requests[0][2],'PATCH');
  assert.equal(components.hooks.requests[0][1].officialApiPricing,true);assert.equal(components.hooks.requests[0][1].modelPrices[0].input,'123');
  assert.equal(components.hooks.requests[0][1].costEnabled,true);
  checkbox(prices,'officialApiPricing').props.onChange({target:{checked:false}});
  settings=components.settingsTree();await nodes(settings).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});
  assert.equal(components.hooks.requests[1][1].officialApiPricing,false);assert.equal(components.hooks.requests[1][1].modelPrices[0].input,'123');
});

test('explicitly clearing the API Fast multiplier remains blank and persists null',()=>{
  reset({officialApiPricing:true,modelPrices:[components.pricingInfo().prices[0]]});
  let draft=components.hooks.settings;
  let tree=components.pricingTree({draft,setDraft:s=>{draft=s;}});
  const input=nodes(tree).find(node=>node.type==='input'&&node.props['aria-label']?.endsWith('Fast 倍率'));
  input.props.onChange({target:{value:''}});
  tree=components.pricingTree({draft,setDraft:s=>{draft=s;}});
  assert.equal(draft.modelPrices![0].fastMultiplier,null);
  assert.equal(nodes(tree).find(node=>node.type==='input'&&node.props['aria-label']?.endsWith('Fast 倍率')).props.value,'');
});

test('USD billing basis comes from each result, legacy units stay truthful, and exact large amounts survive formatting',()=>{
  reset({officialApiPricing:false});
  const cost:EstimatedCost={amount:'9007199254740993.123456',currency:'USD',complete:true,notes:[]};
  const usd=components.costMarkup(cost);assert.match(usd,/\$/);assert.match(usd,/9,007,199,254,740,993\.1235/);assert.match(usd,/9007199254740993\.123456 USD/);
  assert.match(usd,/参考成本 · USD/);assert.doesNotMatch(usd,/订阅参考|API参考|> credits</);
  assert.match(components.headingsMarkup(cost),/参考成本 · USD/);
  assert.match(components.costMarkup({...cost,billingBasis:'api'}),/API参考 · USD/);
  components.hooks.settings.officialApiPricing=true;
  const subscription={...cost,billingBasis:'subscription' as const};
  assert.match(components.costMarkup(subscription),/订阅参考 · USD/);assert.match(components.costMarkup(subscription),/不代表实际支出/);
  assert.match(components.headingsMarkup(subscription),/订阅参考 · USD/);
  const credits=components.costMarkup({...cost,currency:'credits'});assert.doesNotMatch(credits,/\$/);assert.match(credits,/> credits</);
  const creditHeadings=components.headingsMarkup({...cost,currency:'credits'});assert.match(creditHeadings,/参考消耗 · credits/);assert.doesNotMatch(creditHeadings,/USD/);
  assert.equal(components.formatCostAmount('999.99995'),'1,000.0000');
});

test('Fast and unknown records stay visible in summary and per-row cost explanation',()=>{
  reset();const cost:EstimatedCost={currency:'USD',billingBasis:'subscription',amount:'2.000000000000',complete:false,notes:['未识别档位'],serviceTiers:[{tier:'fast',eventCount:1,totalTokens:'100',amount:'2.000000000000'},{tier:'unknown',eventCount:2,totalTokens:'75',amount:null}]};
  const tooltip=components.costMarkup(cost);assert.match(tooltip,/Fast：1 条记录 · 100 Token/);assert.match(tooltip,/未知档位：2 条记录 · 75 Token · 未计价/);
  const summary=components.usageMarkup({cost,uncachedInputTokens:'50',cachedInputTokens:'0',outputTokens:'50',cacheRatio:0,cacheWriteInputTokens:null,cacheWriteMissingEvents:3} as Metrics);
  assert.match(summary,/Fast Token/);assert.match(summary,/未知档位 Token/);assert.match(summary,/不完整估算/);assert.match(summary,/订阅参考 · USD/);assert.doesNotMatch(summary,/credits/);
});

test('changing local pricing mode drops old cached placeholders while ordinary filter refreshes preserve them',()=>{
  reset();const subscription=components.queryOptions(components.hooks.settings),previous={data:{cost:{currency:'USD',billingBasis:'subscription'}}};
  const same=components.queryOptions({...components.hooks.settings});
  assert.equal(same.placeholderData(previous,{queryKey:subscription.queryKey}),previous);
  const api=components.queryOptions({...components.hooks.settings,officialApiPricing:true});
  assert.notDeepEqual(api.queryKey,subscription.queryKey);assert.equal(api.placeholderData(previous,{queryKey:subscription.queryKey}),undefined);
  const oldCreditKey=[...subscription.queryKey.slice(0,-1),JSON.stringify([true,false,null])];
  assert.equal(same.placeholderData({data:{cost:{currency:'credits'}}},{queryKey:oldCreditKey}),undefined);
});

test('local settings default to subscription and preserve API choice and custom prices across restart',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'usage-pricing-settings-')),database=path.join(dir,'usage.sqlite');
  let instance=await createApp({database,codexHome:dir,startup:false});
  try {
    const initial=(await instance.app.inject('/api/settings')).json().data;assert.equal(initial.officialApiPricing,false);
    const modelPrices=[{...initial.modelPrices[0],input:'17',fastMultiplier:null}];
    let result=await instance.app.inject({method:'PATCH',url:'/api/settings',payload:{officialApiPricing:true,modelPrices}});assert.equal(result.statusCode,200);assert.equal(result.json().data.officialApiPricing,true);
    await instance.app.close();instance=await createApp({database,codexHome:dir,startup:false});
    const saved=(await instance.app.inject('/api/settings')).json().data;assert.equal(saved.officialApiPricing,true);assert.equal(saved.modelPrices[0].input,'17');assert.equal(saved.modelPrices[0].fastMultiplier,null);
    result=await instance.app.inject({method:'PATCH',url:'/api/settings',payload:{officialApiPricing:false}});assert.equal(result.statusCode,200);assert.deepEqual(result.json().data.modelPrices,modelPrices);
    assert.equal((await instance.app.inject({method:'PATCH',url:'/api/settings',payload:{officialApiPricing:'yes'}})).statusCode,400);
  } finally {await instance.app.close();await rm(dir,{recursive:true,force:true});}
});
