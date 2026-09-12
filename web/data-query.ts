import { api } from "./api";
import { currentTime, cloudMode } from './runtime';
import { usageDataSource } from './data-source';

// A rolling range is one query, even as its upper bound advances.
// Keep explicit custom dates, filters and pagination in the cache identity.
export function dataQuery<T>(
  route: string,
  params: Record<string, unknown>,
  timezone: string,
  rolling: boolean,
) {
  const source = route.startsWith("account") ? "account" : "local";
  const live = source === "local" && rolling && typeof params.to === "string";
  const adapter = usageDataSource(), view = adapter.capture();
  return {
    queryKey: [source, route, live ? { ...params, to: { live: true } } : params, timezone, ...(cloudMode ? [adapter.revision()] : [])],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api<T>(route, live && !cloudMode ? { ...params, to: new Date(currentTime()).toISOString() } : params, signal, view ? { ...view, rolling: live } : undefined),
  };
}
