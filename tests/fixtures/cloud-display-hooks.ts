// Controlled hook/network boundaries for actual component event-handler tests.
export const hooks:{state:any[];cursor:number;requests:any[][];view:any;sync:any;pendingRequest:Promise<unknown>|null}={state:[],cursor:0,requests:[],view:null,sync:null,pendingRequest:null};
export function useState(initial:any){const i=hooks.cursor++;if(!(i in hooks.state))hooks.state[i]=typeof initial==='function'?initial():initial;return [hooks.state[i],(next:any)=>{hooks.state[i]=typeof next==='function'?next(hooks.state[i]):next;}];}
export const useQuery=()=>({data:hooks.view});
export const useQueryClient=()=>({invalidateQueries:async()=>{}});
export const useCloudDevices=()=>({data:{devices:[{id:'d',name:'Device'}]}});
export const useCloudSync=()=>hooks.sync;
export const CloudSyncProvider=({children}:{children:unknown})=>children;
export const cloudRequest=async(...args:any[])=>{hooks.requests.push(args);return hooks.pendingRequest??{};};
