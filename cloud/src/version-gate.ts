import { SYNC_HEADER, SYNC_VERSION, VERSION_MISMATCH, type CloudCompatibility } from '../../shared/cloud-version';
import { deviceAuth } from './devices';
import { sessionUser } from './auth';
import { json } from './http';

export async function compatibility(env: Env, user: string, browserVersion: string | null): Promise<CloudCompatibility> {
  const rows = await env.DB.prepare(`SELECT d.id,d.name,b.sync_version AS syncVersion FROM devices d LEFT JOIN device_sync_versions b ON b.device_id=d.id
    WHERE d.user_id=? AND d.revoked_at IS NULL AND d.history_deleted_at IS NULL ORDER BY d.bound_at,d.id`).bind(user)
    .all<{ id: string; name: string; syncVersion: string | null }>();
  const devices = rows.results.map(d => ({ ...d, compatible: d.syncVersion === SYNC_VERSION }));
  return { requiredVersion: SYNC_VERSION, browserVersion, devices,
    compatible: browserVersion === SYNC_VERSION && devices.length > 0 && devices.every(d => d.compatible) };
}
const collectorRoute = (path:string,method:string) =>
  ['/api/v3/collector/handshake','/api/v3/collector/config','/api/v3/collector/pause','/api/v3/ingest','/api/v3/receipts','/api/v3/accounts/observations'].includes(path)
  || path==='/api/v3/sync/status'&&method==='PUT';
// Binding and device administration stay reachable so users can resolve a mismatch.
const panelRoute = (path:string) => path.startsWith('/api/v3/')
  && !['/api/v3/me','/api/v3/device','/api/v3/compatibility'].includes(path)
  && !path.startsWith('/api/v3/device-authorizations') && !path.startsWith('/api/v3/devices');
export async function versionGate(request: Request, env: Env, path: string): Promise<Response | null> {
  const version = request.headers.get(SYNC_HEADER);
  if (path === '/api/v3/compatibility' && request.method === 'GET') {
    const user = await sessionUser(request, env);
    return json(await compatibility(env, user.id, version));
  }
  if (collectorRoute(path, request.method)) {
    const device = await deviceAuth(request, env);
    // Record a downgrade too: a previously matching device cannot keep unlocking the panel.
    const reported = version && /^\d+\.\d+\.\d+$/.test(version) && version.length <= 40 ? version : null;
    await env.DB.prepare(`INSERT INTO device_sync_versions(device_id,sync_version,checked_at) VALUES(?,?,?)
      ON CONFLICT(device_id) DO UPDATE SET sync_version=excluded.sync_version,checked_at=excluded.checked_at
      WHERE device_sync_versions.sync_version IS NOT excluded.sync_version`).bind(device.id, reported, Date.now()).run();
    if (version !== SYNC_VERSION) return mismatch();
    if (path === '/api/v3/collector/handshake') return request.method === 'POST' ? json({ ok: true }) : json({ error: { code: 'METHOD_NOT_ALLOWED', message: '版本握手需要 POST。' } }, 405);
    return null;
  }
  if (panelRoute(path)) {
    const user = await sessionUser(request, env);
    const status = await compatibility(env, user.id, version);
    if (!status.compatible) return json({ error: { code: VERSION_MISMATCH, message: '云端面板已锁定：请让所有未撤销的采集设备与云端使用相同同步协议。' }, compatibility: status }, 426);
  }
  return null;
}
function mismatch() {
  return json({ error: { code: VERSION_MISMATCH, message: `云端仅接受相同同步协议的 v3 采集器。请将本地端与云端对齐到 ${SYNC_VERSION}。` }, requiredVersion: SYNC_VERSION }, 426);
}
