import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Cloud, ExternalLink } from "lucide-react";
import type { CloudStatus } from "../shared/cloud";
import { api, mutate } from "./api";
import { exampleMode } from "./runtime";
import "./cloud-settings.css";

const stamp = (s: string | null) =>
  s ? new Date(s).toLocaleString() : "尚无记录";
export function CloudSettings() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["cloud"],
    queryFn: ({ signal }) => api<CloudStatus>("cloud/status", {}, signal),
    enabled: !exampleMode,
    refetchInterval: 3000,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState(false),
    [name, setName] = useState("");
  const state = query.data?.data;
  const action = async (
    kind: "connect" | "pause" | "resume" | "disconnect" | "upgrade",
  ) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result =
        kind === "connect"
          ? await mutate<CloudStatus>(
              "cloud/connect",
              name.trim() ? { deviceName: name.trim() } : {},
            )
          : kind === "disconnect"
            ? await mutate<CloudStatus>("cloud/connection", undefined, "DELETE")
            : await mutate<CloudStatus>(
                "cloud/settings",
                { enabled: kind === "resume" || kind === "upgrade", ...(kind === "upgrade" ? {fullUsage:true} : {}) },
                "PATCH",
              );
      client.setQueryData(["cloud"], result);
      setConfirm(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (exampleMode) return null;
  return (
    <section
      className="panel settings-panel cloud-settings"
      aria-labelledby="cloud-settings-title"
    >
      <div className="panel-heading">
        <h2 id="cloud-settings-title">
          <Cloud size={19} /> 云端查看
        </h2>
        {state && (
          <a href={state.origin} target="_blank" rel="noreferrer">
            打开云端 <ExternalLink size={14} />
          </a>
        )}
      </div>
      <p className="footnote">
        将本机完整用量、原标题、项目路径与账户快照同步到云端；本地界面仍只显示本机。聊天正文、工具正文和登录凭据不上传。
      </p>
      {(error || query.error) && (
        <p className="error-text" role="alert">
          {error || query.error?.message}
        </p>
      )}
      {!state && !query.error && <p>正在读取同步状态…</p>}
      {state && (
        <>
          <div className="setting-row">
            <div>
              <strong>
                {state.revokePending
                  ? "云端撤销待完成"
                  : state.connected
                    ? state.enabled
                      ? "同步已开启"
                      : "同步已暂停"
                    : "同步未开启"}
              </strong>
              <p>
                {state.connected
                  ? `GitHub @${state.userLogin} · ${state.deviceName}`
                  : "登录 GitHub，核对绑定码后，启用这台设备采集。"}
              </p>
            </div>
            {state.connected && !state.revokePending && (
              <button
                disabled={busy}
                onClick={() => void action(state.enabled ? "pause" : "resume")}
              >
                {state.enabled ? "暂停同步" : "恢复同步"}
              </button>
            )}
          </div>
          {state.connected && !state.fullUsage && <button disabled={busy} onClick={() => void action("upgrade")}>启用完整历史同步（含原标题与路径）</button>}
          {state.usage && <p role="status">{state.usage.totalSources!==undefined?`待同步 ${state.usage.pendingSources??0} / ${state.usage.totalSources} 个来源`:`已完成 ${Math.max(0,state.usage.totalThreads-state.usage.pendingThreads)} / ${state.usage.totalThreads} 个会话`} · {state.usage.error || (state.usage.pendingBatches?'后台同步中':'已确认的批次可在云端查询')}
            {!!state.usage.receivedBatches&&` · ${state.usage.receivedBatches} 个批次已接收，等待云端应用`}</p>}
          {!!state.usage?.migrationPending&&<p className="footnote">{state.usage.migrationPending} 个旧版会话等待完成历史交接；原有云端历史继续保留。</p>}
          {state.error && (
            <p className="notice" role="status">
              {state.error}
            </p>
          )}
          {state.connected && (
            <dl className="cloud-settings-times">
              <dt>最近采集</dt>
              <dd>{stamp(state.collectedAt)}</dd>
              <dt>{state.fullUsage?'云端可查询确认':'云端接收'}</dt>
              <dd>{stamp(state.uploadedAt)}</dd>
              <dt>下次允许发送 / 重试</dt>
              <dd>
                {stamp(state.nextUploadAt)}
                {state.pending ? " · 最新结果待传" : ""}
              </dd>
            </dl>
          )}
          {state.binding && (
            <div className="notice">
              <p>请在云端核对设备名称和绑定码：</p>
              <strong className="cloud-binding-code">
                {state.binding.userCode}
              </strong>
              <p>
                <a
                  className="primary-button"
                  href={state.binding.verificationUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  登录并确认绑定 <ExternalLink size={14} />
                </a>
              </p>
              <small>
                有效期至 {stamp(state.binding.expiresAt)}
                ；确认后本机自动完成绑定。
              </small>
            </div>
          )}
          {!state.connected && !state.binding && !state.revokePending && (
            <div className="cloud-connect-row">
              <label htmlFor="cloud-device-name">设备名称（可选）</label>
              <input
                id="cloud-device-name"
                placeholder="默认使用电脑名称"
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <button
                className="primary-button"
                disabled={busy}
                onClick={() => void action("connect")}
              >
                {busy ? "正在连接…" : "连接 GitHub 云端"}
              </button>
            </div>
          )}
          {(state.connected ||
            state.binding ||
            state.revokePending ||
            state.deviceId) && (
            <div className="cloud-disconnect">
              {confirm ? (
                <div className="notice">
                  <p>
                    断开后将撤销这台设备，云端用量历史保留。网络不可用时，本地会立即停止发送并继续尝试撤销。
                  </p>
                  <button
                    disabled={busy}
                    onClick={() => void action("disconnect")}
                  >
                    确认断开连接
                  </button>{" "}
                  <button onClick={() => setConfirm(false)}>取消</button>
                </div>
              ) : (
                <button disabled={busy} onClick={() => setConfirm(true)}>
                  {state.revokePending
                    ? "重试撤销"
                    : state.binding
                      ? "取消绑定"
                      : "断开连接"}
                </button>
              )}
            </div>
          )}
          <p className="footnote">
            关闭网页后，后台服务仍按刷新设置采集。账户快照每分钟最多更新一次，历史分批传输；暂停同步保留云端历史。
          </p>
        </>
      )}
    </section>
  );
}
