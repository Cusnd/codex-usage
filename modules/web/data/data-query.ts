import type { UsageDataSource } from '../../contracts/data-source.js';
import { localDataSource } from '../adapters/local.js';

// A rolling range is one query, even as its upper bound advances.
// Keep explicit custom dates, filters and pagination in the cache identity.
export function dataQuery<T>(
  route: string,
  params: Record<string, unknown>,
  timezone: string,
  rolling: boolean,
  adapter: UsageDataSource = localDataSource,
  clock: () => number = adapter.clock ?? Date.now,
) {
  const source = route.startsWith("account") ? "account" : "local";
  const live = source === "local" && rolling && typeof params.to === "string";
  const view = adapter.capture();
  const fixed = view !== undefined;
  return {
    queryKey: [source, route, live ? { ...params, to: { live: true } } : params, timezone, ...(fixed ? [adapter.revision()] : [])],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      adapter.query<T>(route, live && !fixed ? { ...params, to: new Date(clock()).toISOString() } : params, signal, view ? { ...view, rolling: live } : undefined),
  };
}
