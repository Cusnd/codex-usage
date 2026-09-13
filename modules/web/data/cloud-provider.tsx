import { Fragment, createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { ApiResponse } from '../../contracts/responses.js';
import type { Settings } from '../../contracts/settings.js';
import { CloudDataSource, cloudNamespace, type CloudPageState } from '../adapters/cloud.js';
import { createWebRuntime, WebRuntimeProvider } from '../runtime/context.js';
import { prepareCloudRefresh } from './cloud-refresh.js';

type CloudContextValue = { state: CloudPageState; online: boolean; source: CloudDataSource;
  refresh: (source?: 'local' | 'account') => Promise<void>; invalidateHistory: () => Promise<void>; };
const Context = createContext<CloudContextValue | undefined>(undefined);
export const useCloud = () => useContext(Context);
const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;
const privateQuery = (query: { queryKey: readonly unknown[] }) => ['local', 'account', 'settings', 'status', 'cloud-projects', 'cloud-origins'].includes(String(query.queryKey[0]));

export function CloudProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [search] = useSearchParams(), deviceIds = [...new Set(search.getAll('deviceIds'))].sort();
  const client = useQueryClient(), key = cloudNamespace({ origin: window.location.origin, userId, deviceIds });
  const [source, setSource] = useState<CloudDataSource | null>(null);
  useEffect(() => {
    const [origin, userId, deviceIds] = JSON.parse(key) as [string, string, string[]];
    const next = new CloudDataSource({ origin, userId, deviceIds });
    next.prepareRefresh = (candidate, signal) => prepareCloudRefresh(client, candidate, signal, next);
    next.discardHistory = () => { void client.cancelQueries({ predicate: privateQuery }); client.removeQueries({ predicate: privateQuery }); };
    setSource(next);
    return () => { next.dispose(); void client.cancelQueries({ predicate: privateQuery }); client.removeQueries({ predicate: privateQuery }); };
  }, [key, client]);
  if (!source || source.namespace !== key) return <p role="status">正在打开云端空间…</p>;
  return <CloudSession source={source}>{children}</CloudSession>;
}

function CloudSession({ source, children }: { source: CloudDataSource; children: ReactNode }) {
  const client = useQueryClient();
  const identity = source.identity;
  const state = useSyncExternalStore(source.subscribe, source.state, source.state);
  const [online, setOnline] = useState(isOnline);
  const channel = useRef<BroadcastChannel | null>(null);
  const settings = useSyncExternalStore(listener => client.getQueryCache().subscribe(listener),
    () => client.getQueryData<ApiResponse<Settings>>(['settings'])?.data, () => undefined);
  const revision = source.revision();
  const refresh = async (kind: 'local' | 'account' = 'local') => {
    await source.mutate('refresh', { source: kind });
    await client.invalidateQueries({ queryKey: [kind] });
  };
  const clearHistory = async () => {
    source.invalidate();
    await client.cancelQueries({ predicate: privateQuery });
    client.removeQueries({ predicate: privateQuery });
    if (isOnline()) await source.refresh();
  };
  const invalidateHistory = async () => {
    channel.current?.postMessage({ userId: identity.userId, type: 'history-invalidated' });
    await clearHistory();
  };
  useEffect(() => {
    if (isOnline()) void source.refresh().catch(() => {});
  }, [source]);
  useEffect(() => {
    if (state.read) void client.invalidateQueries({ predicate: query => ['local', 'settings', 'status'].includes(String(query.queryKey[0])) });
  }, [revision, state.viewAt, client]);
  useEffect(() => {
    const changed = () => { setOnline(isOnline()); if (isOnline()) void source.refresh().catch(() => {}); };
    const focused = () => { if (isOnline() && document.visibilityState === 'visible') void source.refresh().catch(() => {}); };
    window.addEventListener('online', changed); window.addEventListener('offline', changed); window.addEventListener('focus', focused);
    return () => { window.removeEventListener('online', changed); window.removeEventListener('offline', changed); window.removeEventListener('focus', focused); };
  }, [source]);
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const current = new BroadcastChannel('codex-usage:online-pages:v1'); channel.current = current;
    current.onmessage = event => {
      if (event.data?.userId !== identity.userId || event.data?.type !== 'history-invalidated') return;
      void clearHistory().catch(() => {});
    };
    return () => { current.close(); if (channel.current === current) channel.current = null; };
  }, [source, client, identity.userId]);
  useEffect(() => {
    const seconds = settings?.localInterval ?? 60;
    if (!online || seconds <= 0) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void source.refresh().catch(() => {}); }, seconds * 1000);
    return () => window.clearInterval(timer);
  }, [online, settings?.localInterval, source]);
  useEffect(() => {
    const seconds = settings?.accountInterval ?? 300;
    if (!online || seconds <= 0) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') { source.invalidateAccounts(); void client.invalidateQueries({ queryKey: ['account'] }); }
    }, seconds * 1000);
    return () => window.clearInterval(timer);
  }, [online, settings?.accountInterval, source, client]);
  const runtime = useMemo(() => createWebRuntime(source, { deviceScope: true, multipleAccounts: true, remotePolling: true }), [source]);
  return <WebRuntimeProvider runtime={runtime}><Context.Provider value={{ state, online, source, refresh, invalidateHistory }}>
    {!online && <div className="notice" role="status">网络已断开，当前显示内容可能不是最新数据。联网后可继续查询。</div>}
    {state.error && <div className="notice" role="alert">刷新失败：{state.error}{state.read ? ' 当前仍显示上次成功读取的结果。' : ''}</div>}
    <Fragment key={JSON.stringify([source.namespace, source.capture().generation])}>{children}</Fragment>
  </Context.Provider></WebRuntimeProvider>;
}
