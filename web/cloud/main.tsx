import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Cloud,
  CodeXml,
  LogIn,
  LogOut,
  Monitor,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import "@fontsource-variable/inter";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "./styles.css";
import "./quota.css";
import { QuotaCards } from "../QuotaCards";
import {
  cloudStatusText,
  type CloudDevice,
  type CloudQuota,
} from "../../shared/cloud";

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok)
    throw new ApiError(
      response.status,
      value.error?.message || "云端暂不可用，请稍后重试。",
    );
  return value as T;
}
const stamp = (at: string | null) =>
  at
    ? new Date(at).toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "尚无记录";
function age(at: string | null, now: number) {
  if (!at) return "尚未采集";
  const ms = now - Date.parse(at);
  if (ms < -60000) return "采集电脑时间超前，请检查时钟";
  if (ms < 60000) return "刚刚采集";
  if (ms < 3600000) return `${Math.floor(ms / 60000)} 分钟前采集`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)} 小时前采集`;
  return `${Math.floor(ms / 86400000)} 天前采集`;
}
type Inspection = {
  code: string;
  deviceName: string;
  expiresAt: string;
  approved: boolean;
  currentDevice: { id: string; name: string } | null;
};
function App() {
  const reloadSerial = useRef(0), mutating = useRef(false);
  const [user, setUser] = useState<{ login: string } | null>(null),
    [loaded, setLoaded] = useState(false);
  const [quota, setQuota] = useState<CloudQuota>({
      snapshot: null,
      receivedAt: null,
    }),
    [device, setDevice] = useState<CloudDevice | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [now, setNow] = useState(Date.now()),
    [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"device" | "me" | null>(null),
    [inspection, setInspection] = useState<Inspection | null>(null),
    [approved, setApproved] = useState(false);
  const [code, setCode] = useState(
    new URLSearchParams(location.search).get("code") || "",
  );
  const bind = location.pathname === "/bind";
  const reload = async (quiet = false, afterMutation = false) => {
    if (mutating.current && !afterMutation) return;
    const serial = ++reloadSerial.current;
    if (!quiet) setBusy(true);
    try {
      const me = await api<{ user: { login: string } }>("/api/v1/me");
      if (serial !== reloadSerial.current) return;
      const [q, d] = await Promise.all([
        api<CloudQuota>("/api/v1/quota"),
        api<{ device: CloudDevice | null }>("/api/v1/device"),
      ]);
      if (serial !== reloadSerial.current) return;
      setUser(me.user);
      setQuota(q);
      setDevice(d.device);
      setNow(Date.now());
      setCheckedAt(new Date().toISOString());
      setError("");
    } catch (e) {
      if (serial !== reloadSerial.current) return;
      if (e instanceof ApiError && e.status === 401) {
        setUser(null);
        setQuota({ snapshot: null, receivedAt: null });
        setDevice(null);
      } else setError((e as Error).message);
    } finally {
      if (serial === reloadSerial.current) {
        setLoaded(true);
        if (!afterMutation) setBusy(false);
      }
    }
  };
  useEffect(() => {
    void reload();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reload(true);
    }, 60000);
    const visible = () => {
      if (document.visibilityState === "visible") void reload(true);
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      ++reloadSerial.current;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  const inspect = async () => {
    setBusy(true);
    setError("");
    try {
      const inspectedCode = code.trim().toUpperCase();
      const result = await api<Omit<Inspection, 'code'>>("/api/v1/device-authorizations/inspect", "POST", {code: inspectedCode});
      setInspection({...result, code: inspectedCode});
    } catch (e) {
      setInspection(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (user && bind && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) void inspect();
  }, [user?.login]);
  const approve = async () => {
    if (!inspection || inspection.code !== code.trim().toUpperCase() || busy) return;
    mutating.current = true;
    ++reloadSerial.current;
    setBusy(true);
    setError("");
    try {
      await api("/api/v1/device-authorizations/approve", "POST", {
        code: code.trim().toUpperCase(),
        replaceDeviceId: inspection.currentDevice?.id || null,
      });
      setApproved(true);
      await reload(true, true);
    } catch (e) {
      setError((e as Error).message);
      setInspection(null);
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm || busy) return;
    mutating.current = true;
    ++reloadSerial.current;
    setBusy(true);
    setError("");
    try {
      await api("/api/v1/" + confirm, "DELETE");
      setConfirm(null);
      await reload(true, true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  };
  const logout = async () => {
    mutating.current = true;
    ++reloadSerial.current;
    setBusy(true);
    try {
      await api("/auth/logout", "POST");
      setUser(null);
      setQuota({ snapshot: null, receivedAt: null });
      setDevice(null);
      setInspection(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  };
  const s = quota.snapshot;
  const stale =
    s &&
    now - Date.parse(s.collectedAt || s.attemptedAt) >
      Math.max(600000, s.refreshInterval * 2000);
  const loginUrl =
    "/auth/github?returnTo=" +
    encodeURIComponent(
      bind && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)
        ? "/bind?code=" + code
        : "/",
    );
  return (
    <div className="cloud-shell">
      <header className="cloud-header">
        <a href="/" className="cloud-brand">
          <span className="brand-icon">
            <CodeXml size={25} />
          </span>
          <span>
            Codex Usage<small>云端额度</small>
          </span>
        </a>
        <span className="cloud-header-note">
          <Cloud size={15} /> 最新快照
        </span>
        {user && (
          <button
            className="cloud-logout"
            onClick={() => void logout()}
            disabled={busy}
            aria-label="退出登录"
          >
            <LogOut size={16} />
            <span>退出</span>
          </button>
        )}
      </header>
      <main>
        {error && (
          <div className="notice cloud-error" role="alert">
            {error}
            <button onClick={() => void reload()} disabled={busy}>
              重试读取
            </button>
          </div>
        )}
        {!loaded ? (
          <section className="panel cloud-loading" role="status">
            正在读取云端状态…
          </section>
        ) : !user ? (
          <section className="cloud-login">
            <div className="cloud-eyebrow">CODEX USAGE / CLOUD</div>
            <h1>额度，随手可见。</h1>
            <p>
              电脑上的最后一次采集，
              <br />
              在你需要的时候打开。
            </p>
            <a className="primary-button cloud-login-button" href={loginUrl}>
              <LogIn size={20} /> 使用 GitHub 登录
            </a>
            <div className="cloud-login-details">
              <div>
                <Monitor size={22} />
                <strong>绑定一台采集电脑</strong>
                <span>本地服务按你的刷新设置采集。</span>
              </div>
              <div>
                <Cloud size={22} />
                <strong>保留最新额度</strong>
                <span>电脑关机后，快照与采集时间仍可查看。</span>
              </div>
              <div>
                <ShieldCheck size={22} />
                <strong>只同步必要数据</strong>
                <span>任务、聊天和 Codex 凭据保留在本机。</span>
              </div>
            </div>
            <p className="cloud-login-foot">
              开源 ·{" "}
              <a
                href="https://github.com/Cusnd/codex-usage"
                target="_blank"
                rel="noreferrer"
              >
                Codex Usage
              </a>{" "}
              · 登录仅用于识别你的云端账户
            </p>
          </section>
        ) : bind ? (
          <section className="panel cloud-bind-panel">
            <div className="cloud-eyebrow">CONNECT A DEVICE</div>
            <h1>
              {approved || inspection?.approved
                ? "设备已确认"
                : "确认这台采集电脑"}
            </h1>
            {approved || inspection?.approved ? (
              <>
                <p>返回本地 Codex Usage，后台会自动完成绑定并同步额度。</p>
                <a className="primary-button" href="/">
                  查看云端额度
                </a>
              </>
            ) : (
              <>
                <p>核对本地显示的绑定码与设备名称。只确认由你发起的请求。</p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void inspect();
                  }}
                >
                  <label htmlFor="binding-code">绑定码</label>
                  <div className="cloud-code-row">
                    <input
                      id="binding-code"
                      autoComplete="off"
                      maxLength={9}
                      value={code}
                      onChange={(e) => {
                        setCode(e.target.value.toUpperCase());
                        setInspection(null);
                      }}
                      placeholder="ABCD-2345"
                    />
                    <button disabled={busy}>核对设备</button>
                  </div>
                </form>
                {inspection && inspection.code === code.trim().toUpperCase() && (
                  <div className="cloud-device-review">
                    <Monitor size={24} />
                    <h2>{inspection.deviceName}</h2>
                    <p>将绑定到 GitHub @{user.login}</p>
                    <small>请求有效期至 {stamp(inspection.expiresAt)}</small>
                    {inspection.currentDevice && (
                      <p className="notice">
                        当前设备“{inspection.currentDevice.name}
                        ”将被替换，其同步凭据立即失效，旧快照会删除。
                      </p>
                    )}
                    <button
                      className="primary-button"
                      disabled={busy}
                      onClick={() => void approve()}
                    >
                      {inspection.currentDevice
                        ? "替换设备并清除旧快照"
                        : "确认绑定这台设备"}
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        ) : (
          <>
            <div className="cloud-page-title">
              <div>
                <div className="cloud-eyebrow">
                  @{user.login} / QUOTA SNAPSHOT
                </div>
                <h1>我的额度</h1>
              </div>
              <button
                className="cloud-refresh"
                onClick={() => void reload()}
                disabled={busy}
              >
                <RefreshCw size={16} className={busy ? "cloud-spinning" : ""} />
                {busy ? "读取中…" : "重新读取快照"}
              </button>
            </div>
            {s ? (
              <>
                <section
                  className={
                    "cloud-snapshot-meta" + (stale ? " cloud-stale" : "")
                  }
                >
                  <div>
                    <span className="cloud-status-dot" />
                    <strong>{age(s.collectedAt, now)}</strong>
                    <p>
                      {s.refreshInterval === 0
                        ? "采集电脑已关闭自动刷新，仅在手动刷新或服务启动时采集。"
                        : stale
                          ? "长时间未取得新快照，采集电脑可能离线或已暂停同步。"
                          : "显示采集电脑最后同步的结果。"}
                    </p>
                  </div>
                  <dl>
                    <dt>实际采集</dt>
                    <dd>{stamp(s.collectedAt)}</dd>
                    <dt>云端接收</dt>
                    <dd>{stamp(quota.receivedAt)}</dd>
                  </dl>
                </section>
                {s.status !== "ok" && (
                  <p className="notice" role="status">
                    {cloudStatusText(s.errorCode)}
                  </p>
                )}
                <QuotaCards buckets={s.buckets} formatTime={stamp} now={now} />
                {!s.buckets.length && (
                  <section className="panel cloud-empty">
                    <h2>
                      {s.status === "identity_unknown"
                        ? "等待确认采集账户"
                        : "暂未返回额度窗口"}
                    </h2>
                    <p>请在采集电脑上检查 Codex 登录，并刷新一次额度。</p>
                  </section>
                )}
                <p className="cloud-read-note">
                  页面于 {stamp(checkedAt)}{" "}
                  读取快照。重新读取只获取云端副本，不会触发电脑采集。
                </p>
              </>
            ) : (
              <section className="panel cloud-empty">
                <Cloud size={34} />
                <h2>
                  {device ? "设备已绑定，等待第一次同步" : "连接你的采集电脑"}
                </h2>
                <p>
                  {device
                    ? "请保持本地 Codex Usage 服务运行，确认同步已开启。"
                    : "在电脑上打开 Codex Usage → 设置 → 云端查看，或运行："}
                </p>
                {!device && <code>codex-usage cloud connect</code>}
                <p className="footnote">
                  每个账户保留一台采集设备与一份最新快照。
                </p>
              </section>
            )}
            <section className="panel cloud-device-panel">
              <div className="cloud-device-line">
                <Monitor size={24} />
                <div>
                  <h2>{device?.name || "尚未绑定设备"}</h2>
                  <p>
                    {device
                      ? "绑定于 " + stamp(device.boundAt)
                      : "绑定后可在这里管理设备。"}
                  </p>
                </div>
                {device && (
                  <button onClick={() => setConfirm("device")}>撤销设备</button>
                )}
              </div>
              <p className="footnote">
                暂停同步请在本机设置中操作；替换设备请从新电脑发起绑定。
              </p>
              <button
                className="cloud-delete-account"
                onClick={() => setConfirm("me")}
              >
                删除云端账户与数据
              </button>
            </section>
            {confirm && (
              <div className="cloud-modal-backdrop">
                <section
                  className="panel cloud-modal"
                  role="alertdialog"
                  aria-modal="true"
                  aria-labelledby="delete-title"
                >
                  <h2 id="delete-title">
                    {confirm === "me"
                      ? "删除云端账户与全部数据？"
                      : "撤销设备并删除快照？"}
                  </h2>
                  <p>
                    {confirm === "me"
                      ? "登录会话、设备凭据和最新额度将立即删除。你可以重新登录并绑定。"
                      : "这台电脑将不能再同步，云端最新快照会同时删除。"}
                  </p>
                  <div>
                    <button
                      onClick={() => setConfirm(null)}
                      disabled={busy}
                      autoFocus
                    >
                      取消
                    </button>
                    <button
                      className="primary-button"
                      onClick={() => void remove()}
                      disabled={busy}
                    >
                      确认{confirm === "me" ? "删除" : "撤销"}
                    </button>
                  </div>
                </section>
              </div>
            )}
          </>
        )}
      </main>
      <footer className="cloud-footer">
        <span>Codex Usage Cloud</span>
        <span>额度不是 Token 用量历史 · 时间按当前设备时区显示</span>
      </footer>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
