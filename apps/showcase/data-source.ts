import type { ApiResponse, ProjectLabel } from '../../modules/contracts/responses.js';
import { type UsageDataSource } from '../../modules/contracts/data-source.js';

const labels = new Map<string, ProjectLabel>();
export const exampleDataSource: UsageDataSource = {
  mode: 'example', revision: () => 'example', capture: () => undefined,
  projectName: id => labels.get(id)?.name,
  projectKind: id => labels.get(id)?.kind,
  async query<T>(route: string, params = {}, signal?: AbortSignal) {
    signal?.throwIfAborted(); const adapter = await (await import('./browser.js')).exampleAdapter(); signal?.throwIfAborted();
    const result = await adapter.request(route, params) as ApiResponse<T>;
    for (const label of result.meta.projectLabels ?? []) labels.set(label.id, label);
    return result;
  },
  async mutate<T>(route: string, body: unknown, method = 'POST') {
    return await (await (await import('./browser.js')).exampleAdapter()).request(route, {}, method, body) as ApiResponse<T>;
  },
};
