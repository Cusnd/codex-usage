import { SYNC_HEADER, SYNC_VERSION } from '../../shared/cloud-version';
/** Transport/domain tests assume an upgraded client; version-gate.test uses raw Requests. */
export class MatchingRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init);
    this.headers.set(SYNC_HEADER, SYNC_VERSION);
  }
}
export async function matchingDevice(db: D1Database, device: string) {
  await db.prepare('INSERT INTO device_sync_versions(device_id,sync_version,checked_at) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET sync_version=excluded.sync_version')
    .bind(device,SYNC_VERSION,Date.now()).run();
}
