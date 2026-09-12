import type { ApiResponse } from '../../contracts/responses.js';
import { jsonRequest } from "../../sync/browser/transport.js";
import { type UsageDataSource } from '../../contracts/data-source.js';
import { queryParameters } from '../../foundation/query-parameters.js';

export const localDataSource: UsageDataSource = {
  mode: 'local', revision: () => 'local', capture: () => undefined,
  async query<T>(route: string, params = {}, signal?: AbortSignal) {
    const search = queryParameters(params);
    return jsonRequest<ApiResponse<T>>('/api/' + route + (search.size ? '?' + search : ''), { signal });
  },
  mutate<T>(route: string, body: unknown, method = 'POST') {
    return jsonRequest<ApiResponse<T>>('/api/' + route, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  },
};
