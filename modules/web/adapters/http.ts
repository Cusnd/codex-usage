import { SYNC_HEADER, SYNC_VERSION, assertCloudVersion, VERSION_MISMATCH } from '../../contracts/cloud-version.js';

export class RequestError extends Error {
  constructor(message: string, readonly code = 'HTTP_ERROR', readonly status?: number) { super(message); }
}

const emit = (name: string) => { if (typeof window !== 'undefined') window.dispatchEvent(new Event(name)); };

/** Shared by local and cloud adapters; only cloud API requests use the protocol gate. */
export async function jsonRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers), pathname = url.split('?')[0];
  const cloud = /^\/api\/v[123]\//.test(pathname);
  if (cloud) headers.set(SYNC_HEADER, SYNC_VERSION);
  let response: Response;
  try { response = await fetch(url, { credentials: 'same-origin', ...init, headers }); }
  catch (error) { if (cloud && error instanceof TypeError) Object.assign(error, { code: 'CLOUD_NETWORK_ERROR' }); throw error; }
  try { if (cloud && pathname !== '/api/v3/me' && pathname !== '/api/v3/compatibility') assertCloudVersion(response); }
  catch (error) { emit('cloud-version-mismatch'); throw error; }
  const body = await response.json();
  if (body.error?.code === VERSION_MISMATCH) emit('cloud-version-mismatch');
  if (cloud && [401, 403].includes(response.status)) emit('cloud-auth-rejected');
  if (!response.ok) throw new RequestError(body.error?.message || '请求失败，请稍后重试。', body.error?.code || 'HTTP_ERROR', response.status);
  return body as T;
}
