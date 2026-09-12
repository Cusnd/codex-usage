import {
  CLOUD_SYNC_MIN_MS,
  isCloudSnapshot,
  type CloudSnapshot,
} from "../../shared/cloud";
import { sessionUser } from "./auth";
import { deviceAuth } from "./devices";
import { fail, HttpError, json, readJson, requireJson } from "./http";

type SnapshotRow = {
  payload: string;
  sequence: number;
  received_at: number;
  device_id: string;
};
export async function snapshotRoute(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response | null> {
  if (pathname === "/api/v1/quota" && request.method === "GET") {
    const user = await sessionUser(request, env);
    const row = await env.DB.prepare(
      "SELECT q.payload,q.received_at FROM quota_snapshots q WHERE q.user_id=? AND q.device_id=(SELECT d.id FROM devices d WHERE d.user_id=q.user_id AND d.revoked_at IS NULL ORDER BY d.bound_at DESC LIMIT 1)",
    )
      .bind(user.id)
      .first<SnapshotRow>();
    return json({
      snapshot: row ? (JSON.parse(row.payload) as CloudSnapshot) : null,
      receivedAt: row ? new Date(row.received_at).toISOString() : null,
    });
  }
  if (pathname !== "/api/v1/snapshot" || request.method !== "PUT") return null;
  requireJson(request);
  const device = await deviceAuth(request, env),
    body = await readJson(request);
  if(device.paused)return fail(423,'DEVICE_PAUSED','设备同步已在云端暂停。');
  if (!isCloudSnapshot(body) || body.deviceId !== device.id)
    return fail(400, "INVALID_SNAPSHOT", "额度快照格式不正确。");
  const now = Date.now(),
    next = now + CLOUD_SYNC_MIN_MS,
    nonce = crypto.randomUUID();
  // Never infer a new measurement from received_at. Client clocks may be wrong; retain their original times.
  const payload = JSON.stringify(body);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET next_upload_at=?,upload_nonce=? WHERE id=? AND next_upload_at<=?
      AND EXISTS(SELECT 1 FROM devices WHERE user_id=users.id AND id=? AND token_hash=? AND revoked_at IS NULL AND paused=0)
      AND NOT EXISTS(SELECT 1 FROM quota_snapshots WHERE user_id=users.id AND device_id=? AND sequence>=?)`,
    ).bind(
      next,
      nonce,
      device.user_id,
      now,
      device.id,
      device.token_hash,
      device.id,
      body.sequence,
    ),
    env.DB.prepare(
      `INSERT INTO quota_snapshots(user_id,device_id,sequence,payload,received_at)
      SELECT id,?,?,?,? FROM users WHERE id=? AND upload_nonce=?
      ON CONFLICT(user_id,device_id) DO UPDATE SET device_id=excluded.device_id,sequence=excluded.sequence,payload=excluded.payload,received_at=excluded.received_at`,
    ).bind(device.id, body.sequence, payload, now, device.user_id, nonce),
  ]);
  if (results[0].meta.changes)
    return json({
      acceptedSequence: body.sequence,
      receivedAt: new Date(now).toISOString(),
      nextAllowedAt: new Date(next).toISOString(),
    });
  // A revocation/replacement can win between authentication and the guarded transaction.
  await deviceAuth(request, env);
  const current = await env.DB.prepare(
    "SELECT payload,sequence,received_at,device_id FROM quota_snapshots WHERE user_id=? AND device_id=?",
  )
    .bind(device.user_id,device.id)
    .first<SnapshotRow>();
  const clock = await env.DB.prepare(
    "SELECT next_upload_at FROM users WHERE id=?",
  )
    .bind(device.user_id)
    .first<{ next_upload_at: number }>();
  if (
    current?.device_id === device.id &&
    current.sequence === body.sequence &&
    current.payload === payload
  )
    return json({
      acceptedSequence: current.sequence,
      receivedAt: new Date(current.received_at).toISOString(),
      nextAllowedAt: new Date(clock?.next_upload_at || 0).toISOString(),
    });
  if (current?.device_id === device.id && current.sequence >= body.sequence)
    return json(
      {
        error: {
          code: "STALE_SEQUENCE",
          message: "已有更新版本，请重新采集。",
        },
        acceptedSequence: current.sequence,
      },
      409,
    );
  throw new HttpError(
    429,
    "SYNC_RATE_LIMITED",
    "云端额度每分钟最多更新一次。",
    {
      "Retry-After": String(
        Math.max(1, Math.ceil(((clock?.next_upload_at || next) - now) / 1000)),
      ),
    },
  );
}
