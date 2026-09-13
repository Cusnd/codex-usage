import type { ApiResponse } from '../../contracts/responses.js';
import { jsonRequest } from './http.js';
import { type UsageDataSource } from '../../contracts/data-source.js';
import { queryParameters } from '../../foundation/query-parameters.js';

type LocalLabel = {id:string;name:string;kind:'git'|'app'|'session'|'project'|'unknown'};
const labels = new Map<string, LocalLabel>();

export const localDataSource: UsageDataSource = {
  mode: 'local', revision: () => 'local', capture: () => undefined,
  projectName: id => labels.get(id)?.name,
  projectKind: id => labels.get(id)?.kind,
  async query<T>(route: string, params = {}, signal?: AbortSignal) {
    const search = queryParameters(params);
    const result = route.startsWith('local/')
      ? await jsonRequest<ApiResponse<T>>('/api/local/query?route=' + encodeURIComponent(route.slice(6)), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal,
      })
      : await jsonRequest<ApiResponse<T>>('/api/' + route + (search.size ? '?' + search : ''), { signal });
    for (const label of result.meta.projectLabels ?? []) labels.set(label.id, label);
    return result;
  },
  mutate<T>(route: string, body: unknown, method = 'POST') {
    return jsonRequest<ApiResponse<T>>('/api/' + route, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  },
};
