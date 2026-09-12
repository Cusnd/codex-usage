import { createContext } from 'react';
import type { Settings } from '../../shared/contracts';
export { createContext };
export const hooks = {
  states: {} as Record<string, any[]>, active: 'settings', cursor: 0,
  settings: {localInterval:60,accountInterval:300,timezone:'UTC',timezoneMode:'manual'} as Settings,
  info: null as any, query: null as any, requests: [] as any[], invalidations: [] as any[],
};
export function useState(initial: any) {
  const state = hooks.states[hooks.active] ??= [], i = hooks.cursor++;
  if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial;
  return [state[i], (next: any) => { state[i] = typeof next === 'function' ? next(state[i]) : next; }];
}
export function useRef(initial: any) { return useState({current:initial})[0]; }
export const useContext = () => ({settings:hooks.settings,now:0,status:undefined});
export const useEffect = () => {};
export const useLayoutEffect = () => {};
export const useSyncExternalStore = () => {};
export const useMemo = (fn: () => unknown) => fn();
export const useSearchParams = () => [new URLSearchParams()];
export const useData = () => ({data:{data:hooks.info},error:null});
export const useReveal = () => undefined;
export const useResultMotion = () => ({});
export const useQuery = (options: any) => {hooks.query=options;return {data:undefined};};
export const useQueryClient = () => ({setQueryData:()=>{},invalidateQueries:async(options:any)=>{hooks.invalidations.push(options);}});
export const mutate = async (...args: any[]) => {hooks.requests.push(args);return {data:args[1]};};
export const beginRefreshMotion = () => ({});
export const cancelRefreshMotion = () => {};
export const markQueryMotion = () => {};
