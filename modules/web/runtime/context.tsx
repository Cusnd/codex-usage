import React, { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { UsageDataSource } from '../../contracts/data-source.js';
import { localDataSource } from '../adapters/local.js';

/** Capabilities describe available operations, independently of the deployment entrypoint. */
export type WebCapabilities = {
  deviceScope: boolean;
  multipleAccounts: boolean;
  remotePolling: boolean;
  demoPreview: boolean;
};
export type WebRuntime = {
  source: UsageDataSource;
  capabilities: WebCapabilities;
  clock: () => number;
  projectName: (id: string | null) => string;
  projectDescription: (id: string | null) => string;
};
export const localProjectName = (id: string | null) => !id ? '未知' : id.split(/[\\/]/).filter(Boolean).at(-1) || '未知';
export function createWebRuntime(source: UsageDataSource, capabilities: Partial<WebCapabilities> = {}, clock = source.clock ?? Date.now): WebRuntime {
  const caps = { deviceScope: false, multipleAccounts: false, remotePolling: false, demoPreview: false, ...capabilities };
  const projectName = caps.deviceScope
    ? (id: string | null) => !id ? '未知' : source.projectName?.(id) || '项目名称未缓存'
    : localProjectName;
  return { source, capabilities: caps, clock, projectName,
    projectDescription: id => !id ? '未知项目' : caps.deviceScope ? projectName(id) : id };
}
// The immutable local default also supports isolated presentation tests. No session is installed globally.
const Context = createContext<WebRuntime>(createWebRuntime(localDataSource));
export function WebRuntimeProvider({ runtime, children }: { runtime: WebRuntime; children: ReactNode }) {
  return <Context.Provider value={runtime}>{children}</Context.Provider>;
}
export const useWebRuntime = () => useContext(Context);
export const useCapabilities = () => useWebRuntime().capabilities;
export const useProjectLabels = () => {
  const { projectName, projectDescription } = useWebRuntime();
  return { projectName, projectDescription };
};
export function useApi() {
  const { source } = useWebRuntime();
  return useMemo(() => ({ api: source.query.bind(source), mutate: source.mutate.bind(source) }), [source]);
}
