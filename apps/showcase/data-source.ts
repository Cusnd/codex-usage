import type { ApiResponse } from '../../modules/contracts/responses.js';
import { type UsageDataSource } from '../../modules/contracts/data-source.js';

export const exampleDataSource: UsageDataSource = {
  mode: 'example', revision: () => 'example', capture: () => undefined,
  async query<T>(route: string, params = {}, signal?: AbortSignal) {
    signal?.throwIfAborted(); const adapter = await (await import('./browser.js')).exampleAdapter(); signal?.throwIfAborted();
    return await adapter.request(route, params) as ApiResponse<T>;
  },
  async mutate<T>(route: string, body: unknown, method = 'POST') {
    return await (await (await import('./browser.js')).exampleAdapter()).request(route, {}, method, body) as ApiResponse<T>;
  },
};
