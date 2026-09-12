import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { ApiResponse, Settings } from '../../shared/contracts';
import { CloudUsageDataSource, installCloudDataSource } from '../data-source';
import { setCloudClock } from '../runtime';
import { IndexedDbCloudCache, namespaceOf, type CacheState } from './cache';
import { CloudSyncController } from './controller';

export type CloudSyncContextValue = {
  state: CacheState; online: boolean; source: CloudUsageDataSource;
  refresh: (source?: 'local' | 'account') => Promise<void>;
  invalidateHistory: () => Promise<void>;
};
const Context = createContext<CloudSyncContextValue | undefined>(undefined);
export const useCloudSync = () => useContext(Context);
const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;
const fallbackSettings = { localInterval: 60, accountInterval: 300 };
type Session = { key: string; source: CloudUsageDataSource };

export function CloudSyncProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const client = useQueryClient(), [search] = useSearchParams();
  const deviceIds = [...new Set(search.getAll('deviceIds'))].sort();
  const key = namespaceOf({ origin: window.location.origin, userId, deviceIds });
  const [session, setSession] = useState<Session | null>(null), [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false, uninstall: (() => void) | undefined;
    const [origin, userId, selected] = JSON.parse(key) as [string, string, string[]];
    const cache = new IndexedDbCloudCache(), controller = new CloudSyncController({ cache, identity: { origin, userId, deviceIds: selected } });
    const source = new CloudUsageDataSource(controller);
    setError('');
    void controller.initialize().then(() => {
      if (cancelled) return;
      uninstall = installCloudDataSource(source); setCloudClock(source.clock); setSession({ key, source });
      if (isOnline() && controller.state().phase !== 'full_ready') void controller.trigger('initial').catch(() => {});
    }, error => { if (!cancelled) setError(error instanceof Error ? error.message : String(error)); });
    return () => {
      cancelled = true; uninstall?.(); controller.dispose(); cache.close(); setCloudClock();
      void client.cancelQueries({ predicate: query => ['local', 'account', 'settings', 'status'].includes(String(query.queryKey[0])) });
      client.removeQueries({ predicate: query => ['local', 'account', 'settings', 'status'].includes(String(query.queryKey[0])) });
    };
  }, [key, client]);
  if (session?.key !== key) return <p role={error ? 'alert' : 'status'}>{error || '正在打开此空间的离线缓存…'}</p>;
  return <ActiveCloudSync source={session.source}>{children}</ActiveCloudSync>;
}

function ActiveCloudSync({ source, children }: { source: CloudUsageDataSource; children: ReactNode }) {
  const client = useQueryClient(), controller = source.controller;
  const state = useSyncExternalStore(controller.subscribe, controller.state, controller.state);
  const [online, setOnline] = useState(isOnline);
  const settings = useSyncExternalStore(
    listener => client.getQueryCache().subscribe(listener),
    () => client.getQueryData<ApiResponse<Settings>>(['settings'])?.data ?? fallbackSettings,
    () => fallbackSettings,
  );
  const revision = source.revision();
  useEffect(() => { void client.invalidateQueries({ predicate: query => ['local', 'account', 'settings', 'status'].includes(String(query.queryKey[0])) }); }, [revision, client]);
  useEffect(() => {
    const changed = () => {
      setOnline(isOnline());
      // Reopening/connectivity recovery completes interrupted initial history even if normal polling is disabled.
      if (isOnline() && controller.state().phase !== 'full_ready') void controller.trigger('initial').catch(() => {});
    };
    window.addEventListener('online', changed); window.addEventListener('offline', changed);
    return () => { window.removeEventListener('online', changed); window.removeEventListener('offline', changed); };
  }, [controller]);
  useEffect(() => {
    if (!online || settings.localInterval <= 0) return;
    const timer = window.setInterval(() => { void controller.trigger('automatic').catch(() => {}); }, settings.localInterval * 1000);
    return () => window.clearInterval(timer);
  }, [controller, online, settings.localInterval]);
  useEffect(() => {
    if (!online || settings.accountInterval <= 0) return;
    const timer = window.setInterval(() => { source.invalidateAccounts(); void client.invalidateQueries({ queryKey: ['account'] }); }, settings.accountInterval * 1000);
    return () => window.clearInterval(timer);
  }, [source, client, online, settings.accountInterval]);
  const refresh = async (kind: 'local' | 'account' = 'local') => {
    await source.mutate('refresh', { source: kind, force: true });
    await client.invalidateQueries({ queryKey: [kind] });
  };
  const invalidateHistory = async () => {
    await controller.invalidateForDeletion();
    client.removeQueries({ predicate: query => ['local', 'account', 'settings', 'status'].includes(String(query.queryKey[0])) });
    await controller.settle();
    if (isOnline()) await controller.trigger('manual');
  };
  return <Context.Provider value={{ state, online, source, refresh, invalidateHistory }}>{children}</Context.Provider>;
}
