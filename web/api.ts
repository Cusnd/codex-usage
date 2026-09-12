import type { ApiResponse } from "../shared/contracts";
import { cloudProjectName, usageDataSource, type QueryView } from './data-source';
import { cloudMode } from './runtime';
export async function api<T>(
  route: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
  view?: QueryView,
): Promise<ApiResponse<T>> {
  return usageDataSource().query<T>(route, params, signal, view);
}
export async function mutate<T>(
  route: string,
  body: unknown,
  method = "POST",
): Promise<ApiResponse<T>> {
  return usageDataSource().mutate<T>(route, body, method);
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
export const projectName = (p: string | null) => !p ? '未知' : cloudMode
  ? cloudProjectName(p) || '项目名称未缓存'
  : p.split(/[\\/]/).filter(Boolean).at(-1) || '未知';
export const projectDescription = (p: string | null) => !p ? '未知项目' : cloudMode ? projectName(p) : p;
