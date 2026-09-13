import type { QueryClient } from '@tanstack/react-query';
import type { CloudDataSource } from '../adapters/cloud.js';
import { DateTime } from 'luxon';

/** A new lease for the same cut does not invalidate fixed historical queries. */
export function refreshRollingQueries(client: QueryClient) {
  return client.invalidateQueries({ predicate: query => {
    if (query.queryKey[0] !== 'local') return false;
    const params = query.queryKey[2] as Record<string, unknown> | undefined;
    return !!params?.to && typeof params.to === 'object';
  } });
}

/** Stage only currently displayed queries. Failed refreshes never publish half a page. */
export async function prepareCloudRefresh(client: QueryClient, candidate: CloudDataSource, signal: AbortSignal, previous?: CloudDataSource) {
  const visible = client.getQueryCache().findAll({ type: 'active', predicate: query =>
    query.state.data !== undefined && ['local', 'settings', 'status'].includes(String(query.queryKey[0])) });
  const results = await Promise.all(visible.map(async query => {
    const key = query.queryKey, usage = key[0] === 'local';
    const route = String(usage ? key[1] : key[0]);
    const params = usage ? { ...key[2] as Record<string, unknown> } : {};
    const rolling = !!params.to && typeof params.to === 'object';
    const view = candidate.capture();
    // Rolling dates follow the displayed timezone and read clock, including midnight.
    if (rolling && previous && typeof params.from === 'string') {
      const zone = String(key[3]), from = DateTime.fromISO(params.from, { zone });
      const days = DateTime.fromMillis(previous.clock(), { zone }).startOf('day').diff(from.startOf('day'), 'days').days;
      if (from.isValid && Number.isFinite(days)) params.from = DateTime.fromMillis(candidate.clock(), { zone: view.timezone }).startOf('day').minus({ days: Math.round(days) }).toUTC().toISO()!;
    }
    const keyParams = rolling ? { ...params, to: { live: true } } : params;
    if (rolling) params.to = new Date(candidate.clock()).toISOString();
    const data = await candidate.query(route, params, signal, { ...view, rolling });
    const nextKey = usage ? [key[0], key[1], keyParams, view.timezone, candidate.revision(route)] : key;
    return { key: nextKey, data };
  }));
  signal.throwIfAborted();
  return () => { for (const result of results) client.setQueryData(result.key, result.data); };
}
