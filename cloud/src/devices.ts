import { sessionUser } from "./auth";
import type { WriteDevice } from './v3/store';
import {
  bearer,
  exactObject,
  fail,
  json,
  limitAuth,
  readJson,
  requireJson,
  requireSameOrigin,
  sha256,
  token,
} from "./http";

export type Device = WriteDevice & {
  user_id: string;
  id: string;
  name: string;
  token_hash: string;
  bound_at: number;
  paused: number;
  protocol: number;
};
type Pending = {
  id: string;
  user_code: string;
  device_id: string;
  resumed_device_id: string | null;
  device_name: string;
  approved_user_id: string | null;
  expires_at: number;
  token_hash: string;
};
const iso = (n: number) => new Date(n).toISOString();
export async function deviceAuth(request: Request, env: Env): Promise<Device> {
  const value = bearer(request);
  if (!value) return fail(401, "DEVICE_REVOKED", "设备未绑定或绑定已撤销。");
  const device = await env.DB.prepare(
    "SELECT * FROM devices WHERE token_hash=? AND revoked_at IS NULL",
  )
    .bind(await sha256(value))
    .first<Device>();
  return device || fail(401, "DEVICE_REVOKED", "设备未绑定或绑定已撤销。");
}
export async function deviceRoute(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response | null> {
  const multi = pathname.startsWith('/api/v2/');
  if (multi) pathname = pathname.replace('/api/v2/', '/api/v1/');
  if (
    pathname === "/api/v1/device-authorizations" &&
    request.method === "DELETE"
  ) {
    requireJson(request);
    const body = await readJson(request, 2048);
    exactObject(body, ["requestId", "pollSecret"]);
    if (
      typeof body.requestId !== "string" ||
      body.requestId.length > 64 ||
      typeof body.pollSecret !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.pollSecret)
    )
      return fail(400, "INVALID_INPUT", "绑定请求不正确。");
    const pollHash = await sha256(body.pollSecret);
    // Cancelling remains safe if browser approval raced with local disconnect.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE devices SET revoked_at=? WHERE EXISTS(SELECT 1 FROM device_authorizations a WHERE a.id=? AND a.poll_hash=? AND devices.id=COALESCE(a.resumed_device_id,a.device_id) AND devices.token_hash=a.token_hash)",
      ).bind(Date.now(),body.requestId,pollHash),
      env.DB.prepare(
        "DELETE FROM device_authorizations WHERE id=? AND poll_hash=?",
      ).bind(body.requestId, pollHash),
    ]);
    return json({ ok: true });
  }
  if (
    pathname === "/api/v1/device-authorizations" &&
    request.method === "POST"
  ) {
    requireJson(request);
    await limitAuth(request, env, "bind-start");
    const body = await readJson(request, 2048);
    exactObject(body, ["deviceName", "tokenHash"]);
    if (
      typeof body.deviceName !== "string" ||
      body.deviceName.trim().length < 1 ||
      body.deviceName.length > 80 ||
      /[\u0000-\u001f\u007f]/.test(body.deviceName) ||
      typeof body.tokenHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.tokenHash)
    )
      return fail(400, "INVALID_INPUT", "设备信息不正确。");
    const id = crypto.randomUUID(),
      pollSecret = token(),
      deviceId = crypto.randomUUID();
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const raw = Array.from(
      crypto.getRandomValues(new Uint8Array(8)),
      (x) => alphabet[x % alphabet.length],
    ).join("");
    const userCode = raw.slice(0, 4) + "-" + raw.slice(4),
      expiresAt = Date.now() + 600000;
    await env.DB.prepare(
      "INSERT INTO device_authorizations(id,poll_hash,token_hash,user_code,device_name,device_id,expires_at) VALUES(?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        await sha256(pollSecret),
        body.tokenHash,
        userCode,
        body.deviceName.trim(),
        deviceId,
        expiresAt,
      )
      .run();
    return json(
      {
        requestId: id,
        pollSecret,
        userCode,
        verificationUrl: `${env.APP_ORIGIN}/bind?code=${userCode}`,
        expiresAt: iso(expiresAt),
        interval: 5,
      },
      201,
    );
  }
  if (
    pathname === "/api/v1/device-authorizations/poll" &&
    request.method === "POST"
  ) {
    requireJson(request);
    const body = await readJson(request, 2048);
    exactObject(body, ["requestId", "pollSecret"]);
    if (
      typeof body.requestId !== "string" ||
      body.requestId.length > 64 ||
      typeof body.pollSecret !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.pollSecret)
    )
      return fail(400, "INVALID_INPUT", "绑定请求不正确。");
    await limitAuth(request, env, "bind-poll", await sha256(body.pollSecret));
    const row = await env.DB.prepare(
      "SELECT * FROM device_authorizations WHERE id=? AND poll_hash=? AND expires_at>?",
    )
      .bind(body.requestId, await sha256(body.pollSecret), Date.now())
      .first<Pending>();
    if (!row)
      return fail(410, "BINDING_EXPIRED", "绑定请求已过期，请重新发起。");
    if (!row.approved_user_id) return json({ status: "pending" });
    const active = await env.DB.prepare(
      "SELECT d.id,d.name,u.login FROM devices d JOIN users u ON u.id=d.user_id WHERE d.id=? AND d.user_id=? AND d.token_hash=? AND d.revoked_at IS NULL",
    )
      .bind(row.resumed_device_id||row.device_id, row.approved_user_id, row.token_hash)
      .first<{ id: string; name: string; login: string }>();
    if (!active)
      return fail(410, "BINDING_EXPIRED", "此绑定已被替换或撤销，请重新发起。");
    return json({
      status: "approved",
      deviceId: active.id,
      deviceName: active.name,
      userLogin: active.login,
    });
  }
  if (
    pathname === "/api/v1/device-authorizations/inspect" &&
    request.method === "POST"
  ) {
    requireSameOrigin(request, env);
    requireJson(request);
    const user = await sessionUser(request, env);
    await limitAuth(request, env, "bind-inspect", user.id);
    const body = await readJson(request, 1024);
    exactObject(body, ["code"]);
    if (
      typeof body.code !== "string" ||
      !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(body.code)
    )
      return fail(400, "INVALID_INPUT", "请输入有效绑定码。");
    const row = await env.DB.prepare(
      "SELECT device_name,expires_at,approved_user_id FROM device_authorizations WHERE user_code=? AND expires_at>?",
    )
      .bind(body.code, Date.now())
      .first<{
        device_name: string;
        expires_at: number;
        approved_user_id: string | null;
      }>();
    if (!row || (row.approved_user_id && row.approved_user_id !== user.id))
      return fail(410, "BINDING_EXPIRED", "绑定码已失效，请在本机重新发起。");
    const current = await env.DB.prepare(
      "SELECT id,name FROM devices WHERE user_id=? AND revoked_at IS NULL ORDER BY bound_at DESC LIMIT 1",
    )
      .bind(user.id)
      .first<{ id: string; name: string }>();
    const resumable=multi?(await env.DB.prepare('SELECT id,name,bound_at,revoked_at,paused,protocol,received_at FROM devices WHERE user_id=? AND history_deleted_at IS NULL ORDER BY bound_at DESC,id LIMIT 1000').bind(user.id).all<{id:string;name:string;bound_at:number;revoked_at:number|null;paused:number;protocol:number;received_at:number|null}>()).results:[];
    return json({
      deviceName: row.device_name,
      expiresAt: iso(row.expires_at),
      approved: !!row.approved_user_id,
      currentDevice: multi ? null : current,
      ...(multi?{resumableDevices:resumable.map(d=>({id:d.id,name:d.name,boundAt:iso(d.bound_at),revoked:d.revoked_at!==null,paused:!!d.paused,protocol:d.protocol,receivedAt:d.received_at===null?null:iso(d.received_at)}))}:{}),
    });
  }
  if (
    pathname === "/api/v1/device-authorizations/approve" &&
    request.method === "POST"
  ) {
    requireSameOrigin(request, env);
    requireJson(request);
    const user = await sessionUser(request, env);
    await limitAuth(request, env, "bind-approve", user.id);
    const body = await readJson(request, 1024);
    exactObject(body, ["code", "replaceDeviceId"]);
    if (
      typeof body.code !== "string" ||
      !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(body.code) ||
      !(
        body.replaceDeviceId === null ||
        (typeof body.replaceDeviceId === "string" &&
          body.replaceDeviceId.length > 0 && body.replaceDeviceId.length <= 64)
      )
    )
      return fail(400, "INVALID_INPUT", "绑定信息不正确。");
    const now = Date.now(),
      nonce = crypto.randomUUID();
    if (multi) {
      const requestRow=await env.DB.prepare('SELECT * FROM device_authorizations WHERE user_code=? AND expires_at>?').bind(body.code,now).first<Pending>();
      if(!requestRow||requestRow.approved_user_id&&requestRow.approved_user_id!==user.id)return fail(410,'BINDING_EXPIRED','绑定码已失效，请在本机重新发起。');
      if(requestRow.approved_user_id){
        if((requestRow.resumed_device_id||null)!==body.replaceDeviceId)return fail(409,'BINDING_CHANGED','此绑定码已确认其他设备选择。');
        const active=await env.DB.prepare('SELECT id FROM devices WHERE user_id=? AND id=? AND token_hash=? AND revoked_at IS NULL AND history_deleted_at IS NULL').bind(user.id,requestRow.resumed_device_id||requestRow.device_id,requestRow.token_hash).first();
        if(!active)return fail(410,'BINDING_EXPIRED','此绑定已被替换或撤销，请重新发起。');return json({ok:true});
      }
      if(body.replaceDeviceId!==null){const target=await env.DB.prepare('SELECT history_deleted_at,token_hash FROM devices WHERE user_id=? AND id=?').bind(user.id,body.replaceDeviceId).first<{history_deleted_at:number|null;token_hash:string}>();if(!target)return fail(404,'DEVICE_NOT_FOUND','可接续设备不存在。');if(target.history_deleted_at!==null)return fail(409,'DEVICE_HISTORY_DELETED','已删除历史的设备不能接续，请新增设备。');if(target.token_hash===requestRow.token_hash)return fail(409,'BINDING_TOKEN_REUSED','接续需要新的上传凭证，请在本机重新发起。');}
      const result = await env.DB.batch([
        env.DB.prepare(`UPDATE device_authorizations SET approved_user_id=?,approved_at=?,approval_nonce=?,resumed_device_id=?
          WHERE user_code=? AND expires_at>? AND approved_user_id IS NULL AND (? IS NULL OR EXISTS(SELECT 1 FROM devices d WHERE d.user_id=? AND d.id=? AND d.history_deleted_at IS NULL))`).bind(user.id,now,nonce,body.replaceDeviceId,body.code,now,body.replaceDeviceId,user.id,body.replaceDeviceId),
        env.DB.prepare(`UPDATE devices SET token_hash=(SELECT token_hash FROM device_authorizations WHERE user_code=? AND approved_user_id=? AND approval_nonce=?),revoked_at=NULL,next_upload_at=0,upload_nonce=NULL,protocol=MAX(protocol,2)
          WHERE user_id=? AND id=? AND history_deleted_at IS NULL AND EXISTS(SELECT 1 FROM device_authorizations WHERE user_code=? AND approved_user_id=? AND approval_nonce=? AND resumed_device_id=devices.id)`).bind(body.code,user.id,nonce,user.id,body.replaceDeviceId,body.code,user.id,nonce),
        env.DB.prepare(`INSERT INTO devices(user_id,id,name,token_hash,bound_at,protocol)
          SELECT approved_user_id,device_id,device_name,token_hash,approved_at,2 FROM device_authorizations
          WHERE user_code=? AND approved_user_id=? AND approval_nonce=? AND resumed_device_id IS NULL`).bind(body.code,user.id,nonce),
      ]);
      if (!result[0].meta.changes) return fail(409,'BINDING_CHANGED','绑定状态已变化，请重新核对设备。');
      return json({ok:true});
    }
    // The guarded approval is the transaction's claim. Later statements only operate on that claim.
    const result = await env.DB.batch([
      env.DB.prepare(
        `UPDATE device_authorizations SET approved_user_id=?,approved_at=?,approval_nonce=? WHERE user_code=? AND expires_at>? AND approved_user_id IS NULL
        AND COALESCE((SELECT id FROM devices WHERE user_id=? AND revoked_at IS NULL ORDER BY bound_at DESC LIMIT 1),'')=?`,
      ).bind(
        user.id,
        now,
        nonce,
        body.code,
        now,
        user.id,
        body.replaceDeviceId || "",
      ),
      env.DB.prepare(
        `UPDATE devices SET revoked_at=unixepoch()*1000 WHERE user_id=? AND id=? AND EXISTS(SELECT 1 FROM device_authorizations WHERE user_code=? AND approved_user_id=? AND approval_nonce=?)`,
      ).bind(user.id,body.replaceDeviceId || '',body.code,user.id,nonce),
      env.DB.prepare(
        `INSERT INTO devices(user_id,id,name,token_hash,bound_at)
        SELECT approved_user_id,device_id,device_name,token_hash,approved_at FROM device_authorizations WHERE user_code=? AND approved_user_id=? AND approval_nonce=?
        ON CONFLICT(id) DO NOTHING`,
      ).bind(body.code, user.id, nonce),
    ]);
    if (!result[0].meta.changes)
      return fail(
        409,
        "BINDING_CHANGED",
        "绑定状态已变化，请重新核对设备后确认。",
      );
    return json({ ok: true });
  }
  if (pathname === "/api/v1/device" && request.method === "GET") {
    const user = await sessionUser(request, env);
    const device = await env.DB.prepare(
      "SELECT id,name,bound_at FROM devices WHERE user_id=? AND revoked_at IS NULL ORDER BY bound_at DESC LIMIT 1",
    )
      .bind(user.id)
      .first<Device>();
    return json({
      device: device
        ? { id: device.id, name: device.name, boundAt: iso(device.bound_at) }
        : null,
    });
  }
  if (pathname === "/api/v1/device" && request.method === "DELETE") {
    const machine = !!request.headers.get("authorization");
    if (!machine) requireSameOrigin(request, env);
    const device = machine ? await deviceAuth(request, env) : null;
    const userId = device
      ? device.user_id
      : (await sessionUser(request, env)).id;
    const id =
      device?.id ||
      (
        await env.DB.prepare("SELECT id FROM devices WHERE user_id=? AND revoked_at IS NULL ORDER BY bound_at DESC LIMIT 1")
          .bind(userId)
          .first<{ id: string }>()
      )?.id;
    if (id)
      await env.DB.batch([
        env.DB.prepare("UPDATE devices SET revoked_at=unixepoch()*1000 WHERE user_id=? AND id=?").bind(
          userId,
          id,
        ),
      ]);
    return json({ ok: true });
  }
  return null;
}
