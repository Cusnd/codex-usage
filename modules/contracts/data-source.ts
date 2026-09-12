import type { ApiResponse } from "./index.js";

export type QueryView = { namespace: string; lease: import('./read-lease.js').ReadLease | null; rolling?: boolean; timezone?: string };

export interface UsageDataSource {
  readonly mode: 'local' | 'cloud' | 'example';
  revision(): string;
  subscribe?(listener: () => void): () => void;
  clock?: () => number;
  projectName?(id: string): string | undefined;
  capture(): QueryView | undefined;
  query<T>(route: string, params?: Record<string, unknown>, signal?: AbortSignal, view?: QueryView): Promise<ApiResponse<T>>;
  mutate<T>(route: string, body: unknown, method?: string): Promise<ApiResponse<T>>;
}
