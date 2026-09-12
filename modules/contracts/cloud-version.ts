import { BUILD_VERSION, PACKAGE_VERSION } from '../../tooling/generated/build-version.js';
import { SYNC_HEADER, SYNC_VERSION } from './sync-version.js';
export { BUILD_VERSION, PACKAGE_VERSION };
export { SYNC_HEADER, SYNC_VERSION };
export const BUILD_HEADER = 'X-Codex-Usage-Build';
export const VERSION_MISMATCH = 'VERSION_MISMATCH';
export const versionMessage = (actual: string | null) =>
  `本地端与云端同步协议版本不匹配。当前端：${SYNC_VERSION}；云端：${actual || '未提供版本'}。请更新为使用当前同步协议的采集器后重试。`;
export class CloudVersionError extends Error {
  readonly code = VERSION_MISMATCH;
  constructor(readonly actual: string | null) { super(versionMessage(actual)); }
}
export function assertCloudVersion(response: Response) {
  const actual = response.headers.get(SYNC_HEADER);
  if (actual !== SYNC_VERSION) throw new CloudVersionError(actual);
}
/** A preflight prevents sending data to old backends that do not enforce headers. */
export async function checkCloudVersion(fetcher: typeof fetch, origin: string, signal?: AbortSignal, credential?: string) {
  const response = await fetcher(origin + (credential ? '/api/v3/collector/handshake' : '/api/health'), {
    method: credential ? 'POST' : 'GET', headers: { [SYNC_HEADER]: SYNC_VERSION, ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, redirect: 'error', signal });
  try { assertCloudVersion(response); if (!response.ok) throw new Error('云端健康检查失败。'); }
  finally { await response.body?.cancel(); }
}
export type CloudCompatibility = {
  requiredVersion: string; browserVersion: string | null; compatible: boolean;
  devices: { id: string; name: string; syncVersion: string | null; compatible: boolean }[];
};
