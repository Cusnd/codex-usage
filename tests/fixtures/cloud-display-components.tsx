import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { CloudDeviceSettings } from '../../modules/web/features/devices/DeviceSettings.js';
import { CloudAccounts } from '../../modules/web/features/accounts/CloudAccounts.js';
import { CloudSyncStatus } from '../../modules/web/features/devices/CloudSyncStatus.js';
import { CloudProjects } from '../../modules/web/features/projects/CloudProjects.js';
import { Workspace,defaultSettings } from '../../modules/web/data/workspace.js';
import { createWebRuntime, WebRuntimeProvider } from '../../modules/web/runtime/context.js';
import type { UsageDataSource } from '../../modules/contracts/data-source.js';
import { dataQuery } from '../../modules/web/data/data-query.js';
import { hooks } from './cloud-display-hooks';
import type { CloudSource,CloudAccountView } from '../../modules/contracts/cloud-accounts.js';

export { hooks,CloudProjects };
export function projectTree(){hooks.cursor=0;return CloudProjects();}
export function renderCloud(kind:'devices'|'accounts'|'quota'|'sync',data:CloudSource[]|CloudAccountView[],timezone='Asia/Tokyo'){
  const settings={...defaultSettings,timezone},client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
  const source: UsageDataSource = {mode:'cloud',revision:()=> 'display-test',capture:()=>({namespace:'display-test',lease:null}),query:async()=>{throw new Error('Unexpected network request in presentation test');},mutate:async()=>{throw new Error('Unexpected mutation');}};
  const runtime=createWebRuntime(source,{deviceScope:true,multipleAccounts:true,remotePolling:true});
  try {
    if(kind==='devices')client.setQueryData(['cloud-devices'],{devices:data});
    else client.setQueryData(dataQuery('account/cloud',{deviceIds:[]},timezone,true,source).queryKey,{data,meta:{source:'cloud',updatedAt:null,timezone,warnings:[]}});
    return renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter><WebRuntimeProvider runtime={runtime}><Workspace.Provider value={{settings,now:Date.parse('2026-09-12T12:00:00.000Z'),status:undefined}}>{kind==='devices'?<CloudDeviceSettings/>:kind==='sync'?<CloudSyncStatus/>:<CloudAccounts history={kind==='accounts'}/>}</Workspace.Provider></WebRuntimeProvider></MemoryRouter></QueryClientProvider>);
  } finally {client.clear();}
}
