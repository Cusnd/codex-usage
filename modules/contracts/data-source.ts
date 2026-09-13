import type { ApiResponse } from "./index.js";

export type QueryView = { namespace: string; lease: Pick<import('./read-lease.js').ReadLease, 'lease_id' | 'cut' | 'expires_at' | 'settings'> | null; generation?: number; rolling?: boolean; timezone?: string };

export interface UsageDataSource {
  readonly mode: 'local' | 'cloud' | 'example';
  revision(route?: string): string;
  subscribe?(listener: () => void): () => void;
  clock?: () => number;
  projectName?(id: string): string | undefined;
  capture(): QueryView | undefined;
  query<T>(route: string, params?: Record<string, unknown>, signal?: AbortSignal, view?: QueryView): Promise<ApiResponse<T>>;
  mutate<T>(route: string, body: unknown, method?: string): Promise<ApiResponse<T>>;
}
