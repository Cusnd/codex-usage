import type { ApiResponse } from '../../../modules/contracts/responses.js';
import type { ReadLease } from './read-lease.js';

// Frozen pre-online browser contract. Do not replace this with production PageRead.
export type QueryView = { namespace: string; lease: ReadLease | null; rolling?: boolean; timezone?: string };

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
