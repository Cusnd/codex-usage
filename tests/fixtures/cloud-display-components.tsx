import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { CloudDeviceSettings,CloudAccounts,CloudSyncStatus } from '../../web/CloudWorkspace';
import { CloudProjects } from '../../web/CloudProjects';
import { Workspace,defaultSettings } from '../../web/workspace';
import { installCloudDataSource } from '../../web/data-source';
import { dataQuery } from '../../web/data-query';
import { hooks } from './cloud-display-hooks';
import type { CloudSource,CloudAccountView } from '../../shared/usage-sync';

export { hooks,CloudProjects };
export function projectTree(){hooks.cursor=0;return CloudProjects();}
export function renderCloud(kind:'devices'|'accounts'|'quota'|'sync',data:CloudSource[]|CloudAccountView[],timezone='Asia/Tokyo'){
  const settings={...defaultSettings,timezone},client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
  const uninstall=installCloudDataSource({revision:()=> 'display-test',capture:()=>undefined,controller:{subscribe:()=>()=>{}}} as any);
  try {
    if(kind==='devices')client.setQueryData(['cloud-devices'],{devices:data});
    else client.setQueryData(dataQuery('account/cloud',{deviceIds:[]},timezone,true).queryKey,{data,meta:{source:'cloud',updatedAt:null,timezone,warnings:[]}});
    return renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter><Workspace.Provider value={{settings,now:Date.parse('2026-09-12T12:00:00.000Z'),status:undefined}}>{kind==='devices'?<CloudDeviceSettings/>:kind==='sync'?<CloudSyncStatus/>:<CloudAccounts history={kind==='accounts'}/>}</Workspace.Provider></MemoryRouter></QueryClientProvider>);
  } finally {uninstall();client.clear();}
}
