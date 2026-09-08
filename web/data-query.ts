import { api } from "./api";

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
  return {
    queryKey: [source, route, live ? { ...params, to: { live: true } } : params, timezone],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api<T>(route, live ? { ...params, to: new Date().toISOString() } : params, signal),
  };
}
