import type { ApiResponse } from "../shared/contracts";
export async function api<T>(
  route: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<ApiResponse<T>> {
  if (import.meta.env?.MODE === 'showcase') {
    signal?.throwIfAborted();
    const adapter = await (await import('../showcase/browser')).exampleAdapter();
    signal?.throwIfAborted();
    return await adapter.request(route, params) as ApiResponse<T>;
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== null && value !== "")
      if (Array.isArray(value)) value.forEach((entry) => search.append(key, String(entry)));
      else search.set(key, String(value));
  const response = await fetch(
    "/api/" + route + (search.size ? "?" + search : ""),
    { signal },
  );
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || "查询失败");
  return body;
}
export async function mutate<T>(
  route: string,
  body: unknown,
  method = "POST",
): Promise<ApiResponse<T>> {
  if (import.meta.env?.MODE === 'showcase') {
    const adapter = await (await import('../showcase/browser')).exampleAdapter();
    return await adapter.request(route, {}, method, body) as ApiResponse<T>;
  }
  const response = await fetch("/api/" + route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || "操作失败");
  return result;
}
export function exact(value: string | null | undefined): string {
  if (value == null) return "—";
  try {
    return BigInt(value).toLocaleString("zh-CN");
  } catch {
    return value;
  }
}
export function compact(value: string | null | undefined): string {
  if (value == null) return "—";
  const n = BigInt(value),
    sign = n < 0n ? "-" : "",
    a = n < 0n ? -n : n;
  for (const [base, suffix] of [
    [1_000_000_000n, "B"],
    [1_000_000n, "M"],
    [1000n, "K"],
  ] as const)
    if (a >= base) return `${sign}${Number((a * 100n) / base) / 100}${suffix}`;
  return value;
}
export const percent = (value: number | null | undefined) =>
  value == null ? "—" : `${(value * 100).toFixed(1)}%`;
export const projectName = (p: string | null) =>
  p?.split(/[\\/]/).filter(Boolean).at(-1) || "未知";
