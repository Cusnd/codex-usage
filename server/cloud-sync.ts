import { SYNC_HEADER, SYNC_VERSION, CloudVersionError, checkCloudVersion } from '../shared/cloud-version.js';
import { createHash, randomBytes } from "node:crypto";
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
  type CloudStatus,
} from "../shared/cloud.js";
import type { LimitObservation } from "./refresh.js";
import type { Store } from "./db.js";
import { AccountSync } from './account-sync.js';
import type { V3Uploader } from './sync-v3/uploader.js';
import type { AccountUsage } from '../shared/contracts.js';

type Credentials = {
  origin: string;
  token: string;
  requestId?: string;
  pollSecret?: string;
};
type State = Omit<
  CloudStatus,
  "origin" | "connected" | "running" | "pending"
> & {
  failures: number;
  pausePending: boolean | null;
};
type Options = {
  credentialFile: string | null;
  observation: () => Promise<LimitObservation>;
  refreshLimits: () => Promise<void>;
  origin?: string;
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  history?: () => Promise<{data:AccountUsage|null;collectedAt:string|null;identityKey:string|null}>;
  uploader: V3Uploader;
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
  failures: 0,
  pausePending: null,
});
const token = () => randomBytes(32).toString("base64url");
const iso = (n: number) => new Date(n).toISOString();
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
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
  private accounts: AccountSync;
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
    this.accounts = new AccountSync(store, (route,method,body) => this.request(route,method,body,true), options.observation, options.history, this.now);
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
          /^[A-Za-z0-9_-]{43}$/.test(c.token)
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
      this.state.error =
        "同步凭据缺失或云端地址已改变，请在原云端撤销设备后重新绑定。";
    }
  }
  status(): CloudStatus {
    const usage=this.options.uploader.status();
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
      collectedAt: usage.collectedAt,
      uploadedAt: usage.uploadedAt,
      nextUploadAt: nextUploadAt || usage.nextUploadAt,
      error: usage.error || this.accounts.status().error || error,
      pending: usage.pendingBatches > 0,
      running: !!this.active,
      usage,
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
    const delay=this.state.enabled&&this.state.deviceId
      ?this.options.uploader.takeNextTickDelayMs()??1000:1000;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick().finally(() => this.schedule());
    }, delay);
    this.timer.unref();
  }
  private async request(
    route: string,
    method: string,
    body?: unknown,
    bearer = false,

  ) {
    this.controller = new AbortController();
    // Cancellation/revocation sends no statistics and must remain possible during an upgrade.
    if (!(method === 'DELETE' && ['device', 'device-authorizations'].includes(route)))
      await checkCloudVersion(this.fetcher, this.origin, AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]), bearer ? this.credentials!.token : undefined);
    const response = await this.fetcher(this.origin + `/api/v3/` + route, {
      method,
      headers: {
        [SYNC_HEADER]: SYNC_VERSION,
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
      };
      const { response, data } = await this.request(
        "device-authorizations",
        "POST",
        { deviceName, tokenHash: hash(c.token) },
        false,
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
    } catch (error) {
      throw Object.assign(new Error(error instanceof CloudVersionError ? error.message : "无法发起云端绑定，请检查网络后重试。"), {
        statusCode: 502,
      });
    } finally {
      this.starting = false;
    }
  }
  async setEnabled(enabled: boolean) {
    if (!this.credentials || !this.state.deviceId || this.state.revokePending)
      throw Object.assign(new Error("请先完成设备绑定。"), { statusCode: 409 });
    const resuming=enabled&&!this.state.enabled,epoch=++this.epoch;
    if(resuming){
      // Keep uploads paused while obtaining a current observation, even when automatic refresh is off.
      await this.options.refreshLimits();
      if(this.closed||epoch!==this.epoch||!this.credentials||this.state.revokePending)return this.status();
      this.accounts.refreshAccounts();
    }
    this.state.enabled = enabled;
    this.state.pausePending=!enabled;
    if (!enabled) {this.controller?.abort();this.options.uploader.cancel();}
    this.save();
    if (enabled) {
      // A pause request from the preceding epoch must finish before the resume request is sent.
      if(this.active)await this.active;
      if(!this.closed&&epoch===this.epoch)void this.tick();
    }
    return this.status();
  }
  async disconnect() {
    this.state.enabled = false;
    this.state.revokePending = !!this.credentials;
    this.state.nextUploadAt = null;
    this.state.error = this.credentials
      ? "正在撤销云端设备；完成前将保留撤销凭据。"
      : null;
    ++this.epoch;
    this.controller?.abort();
    this.options.uploader.cancel();
    this.save();
    if (this.active) await this.active;
    if (this.credentials) await this.tick();
    else {
      await this.options.uploader.unbind();
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
      .catch((error) => {
        if (!this.closed && epoch === this.epoch)
          this.retry(
            undefined,
            error instanceof CloudVersionError ? error.message : this.state.revokePending
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
        await this.options.uploader.unbind();
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
      });
      this.save();
    }
    if(this.state.deviceId && this.state.pausePending!==null && current()) {
      const pending=this.state.pausePending;
      const result=await this.request('collector/pause','PUT',{paused:pending},true);
      if(!current())return;
      if(!result.response.ok){this.retry(result.response);return;}
      this.state.pausePending=null;this.save();
    }
    if (this.state.enabled && this.state.deviceId && current()) {
      const enabled=()=>current()&&this.state.enabled;
      await Promise.all([
        this.options.uploader.tick({deviceId:this.state.deviceId,token:this.credentials!.token,origin:this.origin},enabled),
        this.accounts.tick(this.state.deviceId,enabled),
      ]);
    }
  }
  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.controller?.abort();
    await this.options.uploader.close();
    if (this.active) await this.active;
  }
}
