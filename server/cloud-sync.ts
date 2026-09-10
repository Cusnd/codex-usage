import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { hostname } from "node:os";
import {
  CLOUD_ORIGIN,
  CLOUD_SYNC_MIN_MS,
  cloudErrorCodes,
  isCloudSnapshot,
  type CloudSnapshot,
  type CloudStatus,
  type CloudWindow,
} from "../shared/cloud.js";
import type { LimitObservation } from "./refresh.js";
import type { Store } from "./db.js";

type Credentials = {
  origin: string;
  token: string;
  salt: string;
  requestId?: string;
  pollSecret?: string;
};
type State = Omit<
  CloudStatus,
  "origin" | "connected" | "running" | "pending"
> & {
  sequence: number;
  outbox: CloudSnapshot | null;
  fingerprint: string | null;
  failures: number;
};
type Options = {
  credentialFile: string | null;
  observation: () => Promise<LimitObservation>;
  origin?: string;
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
};
const empty = (): State => ({
  enabled: false,
  revokePending: false,
  deviceId: null,
  deviceName: null,
  userLogin: null,
  binding: null,
  collectedAt: null,
  uploadedAt: null,
  nextUploadAt: null,
  error: null,
  sequence: 0,
  outbox: null,
  fingerprint: null,
  failures: 0,
});
const token = () => randomBytes(32).toString("base64url");
const iso = (n: number) => new Date(n).toISOString();
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function accountRef(identity: string | null, salt: string) {
  return identity
    ? createHmac("sha256", salt).update(identity).digest("hex")
    : null;
}
function window(w: CloudWindow | null): CloudWindow | null {
  return w
    ? {
        usedPercent: w.usedPercent,
        remainingPercent: w.remainingPercent,
        windowDurationMins: w.windowDurationMins,
        resetsAt: w.resetsAt,
      }
    : null;
}
// Deliberately enumerate fields: never serialize the account response or source errors.
export function cloudSnapshot(
  observation: LimitObservation,
  credentials: Pick<Credentials, "salt">,
  deviceId: string,
  sequence: number,
): CloudSnapshot {
  const known = observation.identityKnown && !!observation.identityKey;
  const data = known ? observation.data : null;
  const error =
    observation.errorCode &&
    cloudErrorCodes.includes(
      observation.errorCode as (typeof cloudErrorCodes)[number],
    )
      ? (observation.errorCode as (typeof cloudErrorCodes)[number])
      : observation.errorCode
        ? "ACCOUNT_FAILED"
        : null;
  return {
    schemaVersion: 1,
    deviceId,
    sequence,
    accountRef: known
      ? accountRef(observation.identityKey, credentials.salt)
      : null,
    collectedAt: data ? observation.collectedAt : null,
    attemptedAt: observation.attemptedAt,
    provider: data ? observation.provider : null,
    refreshInterval: observation.refreshInterval,
    status: !known ? "identity_unknown" : error || !data ? "error" : "ok",
    errorCode: !known
      ? error || "IDENTITY_UNKNOWN"
      : error || (!data ? "ACCOUNT_FAILED" : null),
    buckets: data
      ? data.buckets.map((b) => ({
          id: b.id,
          name: b.name,
          primary: window(b.primary),
          secondary: window(b.secondary),
        }))
      : [],
  };
}

export class CloudSync {
  private state: State;
  private credentials: Credentials | null = null;
  private active: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private controller: AbortController | undefined;
  private epoch = 0;
  private pollAt = 0;
  private starting = false;
  readonly origin: string;
  private now: () => number;
  private fetcher: typeof fetch;
  constructor(
    private store: Store,
    private options: Options,
  ) {
    const url = new URL(options.origin || CLOUD_ORIGIN);
    if (
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Cloud origin must be HTTPS (HTTP loopback is allowed for development).",
      );
    this.origin = url.origin;
    this.now = options.now || Date.now;
    this.fetcher = options.fetch || fetch;
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS cloud_sync (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
    );
    const row = store.one("SELECT value FROM cloud_sync WHERE id=1");
    this.state = row ? { ...empty(), ...JSON.parse(row.value) } : empty();
    if (options.credentialFile && existsSync(options.credentialFile)) {
      try {
        const c = JSON.parse(
          readFileSync(options.credentialFile, "utf8"),
        ) as Credentials;
        if (
          c.origin === this.origin &&
          /^[A-Za-z0-9_-]{43}$/.test(c.token) &&
          /^[A-Za-z0-9_-]{43}$/.test(c.salt)
        )
          this.credentials = c;
      } catch {
        /* Public state below exposes a fixed, non-secret diagnostic. */
      }
    }
    if (
      !this.credentials &&
      (this.state.deviceId || this.state.binding || this.state.revokePending)
    ) {
      this.state.enabled = false;
      this.state.outbox = null;
      this.state.error =
        "同步凭据缺失或云端地址已改变，请在原云端撤销设备后重新绑定。";
    }
  }
  status(): CloudStatus {
    const {
      enabled,
      revokePending,
      deviceId,
      deviceName,
      userLogin,
      binding,
      collectedAt,
      uploadedAt,
      nextUploadAt,
      error,
    } = this.state;
    return {
      origin: this.origin,
      connected: !!deviceId && !!this.credentials,
      enabled,
      revokePending,
      deviceId,
      deviceName,
      userLogin,
      binding,
      collectedAt,
      uploadedAt,
      nextUploadAt,
      error,
      pending: !!this.state.outbox,
      running: !!this.active,
    };
  }
  private save() {
    if (!this.closed)
      this.store.run(
        "INSERT INTO cloud_sync VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        [JSON.stringify(this.state)],
      );
  }
  private saveCredentials(c: Credentials | null) {
    const file = this.options.credentialFile;
    if (file) {
      if (c) {
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file + ".tmp", JSON.stringify(c), { mode: 0o600 });
        renameSync(file + ".tmp", file);
      } else if (existsSync(file)) unlinkSync(file);
    }
    this.credentials = c;
  }
  start() {
    this.schedule();
  }
  private schedule() {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick().finally(() => this.schedule());
    }, 1000);
    this.timer.unref();
  }
  private async request(
    route: string,
    method: string,
    body?: unknown,
    bearer = false,
  ) {
    this.controller = new AbortController();
    const response = await this.fetcher(this.origin + "/api/v1/" + route, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(bearer
          ? { Authorization: `Bearer ${this.credentials!.token}` }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.any([
        this.controller.signal,
        AbortSignal.timeout(15000),
      ]),
    });
    // Only our small protocol responses are accepted. Do not retain upstream HTML/error bodies.
    const length = Number(response.headers.get("content-length") || 0);
    if (length > 16384) throw new Error("Invalid cloud response");
    const reader = response.body?.getReader();
    let bytes = 0,
      raw = "";
    const decoder = new TextDecoder();
    if (reader) {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 16384) {
            await reader.cancel();
            throw new Error("Invalid cloud response");
          }
          raw += decoder.decode(chunk.value, { stream: true });
        }
        raw += decoder.decode();
      } finally {
        reader.releaseLock();
      }
    }
    let data: Record<string, any> = {};
    try {
      data = JSON.parse(raw);
    } catch {
      /* Handle by HTTP status. */
    }
    return {
      response,
      data:
        data && typeof data === "object" && !Array.isArray(data) ? data : {},
    };
  }
  async connect(deviceName = hostname()) {
    if (this.starting)
      throw Object.assign(new Error("正在发起绑定，请稍候。"), {
        statusCode: 409,
      });
    if (this.state.revokePending)
      throw Object.assign(new Error("请先等待云端撤销完成。"), {
        statusCode: 409,
      });
    if (this.credentials && this.state.deviceId) return this.status();
    if (
      this.credentials &&
      this.state.binding &&
      Date.parse(this.state.binding.expiresAt) > this.now()
    )
      return this.status();
    // An approval may have completed while polling was offline. Revoke the old
    // proposed token before replacing credentials, even if its request expired.
    if (this.credentials && !this.state.deviceId) {
      await this.disconnect();
      if (this.state.revokePending)
        throw Object.assign(new Error("请先等待原绑定的云端撤销完成。"), {
          statusCode: 409,
        });
    }
    if (
      !deviceName.trim() ||
      deviceName.length > 80 ||
      /[\u0000-\u001f\u007f]/.test(deviceName)
    )
      throw Object.assign(new Error("设备名称须为 1–80 个可见字符。"), {
        statusCode: 400,
      });
    this.starting = true;
    const epoch = ++this.epoch;
    try {
      const c: Credentials = {
        origin: this.origin,
        token: token(),
        salt: token(),
      };
      const { response, data } = await this.request(
        "device-authorizations",
        "POST",
        { deviceName, tokenHash: hash(c.token) },
      );
      if (
        !response.ok ||
        typeof data.requestId !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(data.pollSecret) ||
        !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(data.userCode) ||
        !Number.isFinite(Date.parse(data.expiresAt))
      )
        throw new Error("Binding failed");
      if (this.closed || epoch !== this.epoch) return this.status();
      c.requestId = data.requestId;
      c.pollSecret = data.pollSecret;
      this.saveCredentials(c);
      this.state = {
        ...empty(),
        deviceName,
        binding: {
          userCode: data.userCode,
          verificationUrl: this.origin + "/bind?code=" + data.userCode,
          expiresAt: data.expiresAt,
        },
      };
      this.pollAt = 0;
      this.save();
      this.schedule();
      return this.status();
    } catch {
      throw Object.assign(new Error("无法发起云端绑定，请检查网络后重试。"), {
        statusCode: 502,
      });
    } finally {
      this.starting = false;
    }
  }
  async capture() {
    if (
      this.closed ||
      !this.state.enabled ||
      !this.state.deviceId ||
      !this.credentials ||
      this.state.revokePending
    )
      return;
    const epoch = this.epoch,
      observation = await this.options.observation();
    if (
      this.closed ||
      epoch !== this.epoch ||
      !this.state.enabled ||
      !this.credentials ||
      !this.state.deviceId
    )
      return;
    const snapshot = cloudSnapshot(
      observation,
      this.credentials,
      this.state.deviceId,
      this.state.sequence + 1,
    );
    if (!isCloudSnapshot(snapshot)) {
      this.state.outbox = null;
      this.state.error = "额度格式未通过同步校验，未上传。";
      this.save();
      return;
    }
    const fingerprint = hash(JSON.stringify({ ...snapshot, sequence: 0 }));
    if (fingerprint === this.state.fingerprint) return;
    this.state.fingerprint = fingerprint;
    this.state.sequence = snapshot.sequence;
    this.state.outbox = snapshot;
    this.state.collectedAt = snapshot.collectedAt;
    this.save();
  }
  async setEnabled(enabled: boolean) {
    if (!this.credentials || !this.state.deviceId || this.state.revokePending)
      throw Object.assign(new Error("请先完成设备绑定。"), { statusCode: 409 });
    this.state.enabled = enabled;
    ++this.epoch;
    if (!enabled) this.controller?.abort();
    this.save();
    if (enabled) {
      await this.capture();
      void this.tick();
    }
    return this.status();
  }
  async disconnect() {
    this.state.enabled = false;
    this.state.outbox = null;
    this.state.revokePending = !!this.credentials;
    this.state.nextUploadAt = null;
    this.state.error = this.credentials
      ? "正在撤销云端设备；完成前将保留撤销凭据。"
      : null;
    ++this.epoch;
    this.controller?.abort();
    this.save();
    if (this.active) await this.active;
    if (this.credentials) await this.tick();
    else {
      this.state = empty();
      this.save();
    }
    return this.status();
  }
  private retry(
    response?: Response,
    message = "同步失败，正在等待网络恢复后重试。",
  ) {
    ++this.state.failures;
    const retryAfter = response?.headers.get("retry-after");
    const wait = retryAfter
      ? /^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1000
        : Math.max(0, Date.parse(retryAfter) - this.now())
      : 0;
    const jitter = 0.75 + (this.options.random || Math.random)() * 0.5;
    const delay = Math.min(
      900000,
      5000 * 2 ** Math.min(this.state.failures - 1, 8) * jitter,
    );
    this.state.nextUploadAt = iso(
      Math.max(
        this.now() + Math.max(delay, Number.isFinite(wait) ? wait : 0),
        Date.parse(this.state.nextUploadAt || "") || 0,
      ),
    );
    this.state.error = message;
    this.save();
  }
  tick(): Promise<void> {
    if (this.active) return this.active;
    if (this.closed || this.starting || !this.credentials)
      return Promise.resolve();
    const epoch = this.epoch;
    this.active = this.run(epoch)
      .catch(() => {
        if (!this.closed && epoch === this.epoch)
          this.retry(
            undefined,
            this.state.revokePending
              ? "云端撤销尚未完成；本地已停止同步，将联网重试。"
              : undefined,
          );
      })
      .finally(() => {
        this.active = null;
      });
    return this.active;
  }
  private async run(epoch: number) {
    if (Date.parse(this.state.nextUploadAt || "") > this.now()) return;
    const current = () => !this.closed && epoch === this.epoch;
    if (this.state.revokePending) {
      const pending = this.credentials!.requestId;
      if (pending) {
        const { response } = await this.request("device-authorizations", "DELETE", {
          requestId: pending,
          pollSecret: this.credentials!.pollSecret,
        });
        if (!current()) return;
        if (!response.ok && response.status !== 401 && response.status !== 410) {
          this.retry(response, "云端撤销尚未完成；本地已停止同步，将联网重试。");
          return;
        }
      }
      // Cleanup may already have removed the pending request. The proposed
      // token still revokes a device approved just before that expiry.
      const { response } = await this.request("device", "DELETE", undefined, true);
      if (!current()) return;
      if (response.ok || response.status === 401 || response.status === 410) {
        this.saveCredentials(null);
        this.state = empty();
        this.save();
      } else
        this.retry(response, "云端撤销尚未完成；本地已停止同步，将联网重试。");
      return;
    }
    if (this.state.binding) {
      if (Date.parse(this.state.binding.expiresAt) <= this.now()) {
        this.state.binding = null;
        this.state.revokePending = true;
        this.state.error = "绑定已过期，正在撤销可能已确认的设备，请稍后重新发起。";
        this.save();
        return;
      }
      if (this.pollAt > this.now()) return;
      this.pollAt = this.now() + 5000;
      const { response, data } = await this.request(
        "device-authorizations/poll",
        "POST",
        {
          requestId: this.credentials!.requestId,
          pollSecret: this.credentials!.pollSecret,
        },
      );
      if (!current()) return;
      if (response.status === 410) {
        this.state.binding = null;
        this.state.revokePending = true;
        this.state.nextUploadAt = null;
        this.state.error = "绑定已失效，正在完成云端撤销，请稍后重新发起。";
        this.save();
        return;
      }
      if (!response.ok) {
        this.retry(response, "暂时无法确认绑定，正在重试。");
        return;
      }
      if (data.status !== "approved") return;
      if (
        typeof data.deviceId !== "string" ||
        typeof data.deviceName !== "string" ||
        typeof data.userLogin !== "string"
      )
        throw new Error("Invalid binding");
      this.state.deviceId = data.deviceId;
      this.state.deviceName = data.deviceName;
      this.state.userLogin = data.userLogin;
      this.state.enabled = true;
      this.state.binding = null;
      this.state.error = null;
      this.state.failures = 0;
      this.state.nextUploadAt = null;
      this.saveCredentials({
        origin: this.origin,
        token: this.credentials!.token,
        salt: this.credentials!.salt,
      });
      this.save();
      await this.capture();
    }
    if (!this.state.enabled || !this.state.outbox || !current()) return;
    // Recheck the selected identity immediately before retrying persisted data.
    const observation = await this.options.observation();
    if (!current() || !this.state.enabled) return;
    const expected = observation.identityKnown
      ? accountRef(observation.identityKey, this.credentials!.salt)
      : null;
    if (expected !== this.state.outbox.accountRef) await this.capture();
    if (!current() || !this.state.outbox) return;
    const snapshot = this.state.outbox;
    const { response, data } = await this.request(
      "snapshot",
      "PUT",
      snapshot,
      true,
    );
    if (!current()) return;
    if (response.status === 401) {
      this.state.enabled = false;
      this.state.outbox = null;
      this.state.error = "云端设备已撤销或替换，请断开后重新绑定。";
      this.save();
      return;
    }
    if (
      response.status === 409 &&
      data.error?.code === "STALE_SEQUENCE" &&
      Number.isSafeInteger(data.acceptedSequence)
    ) {
      this.state.sequence = Math.max(
        this.state.sequence,
        data.acceptedSequence,
      );
      this.state.fingerprint = null;
      await this.capture();
      this.retry(response);
      return;
    }
    if (!response.ok || !Number.isFinite(Date.parse(data.receivedAt))) {
      this.retry(response);
      return;
    }
    this.state.uploadedAt = data.receivedAt;
    this.state.nextUploadAt = iso(
      Math.max(
        this.now() + CLOUD_SYNC_MIN_MS,
        Date.parse(data.nextAllowedAt) || 0,
      ),
    );
    if (this.state.outbox?.sequence === snapshot.sequence)
      this.state.outbox = null;
    this.state.failures = 0;
    this.state.error = null;
    this.save();
  }
  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.controller?.abort();
    if (this.active) await this.active;
  }
}
