import { useQueryClient } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useContext, useEffect, useState } from "react";
import type { Settings } from "../shared/contracts";
import { mutate } from "./api";
import { Choice } from "./Choice";
import { AccountNotice } from "./AccountNotice";
import { PriceSettings } from "./PriceSettings";
import { SystemSettings } from "./SystemSettings";
import { Header, SourceBadge, time } from "./ui";
import { Workspace } from "./workspace";
import { AdaptiveRegion } from "./MotionPrimitives";
import { beginRefreshMotion, cancelRefreshMotion } from "./motion-state";

export function SettingsPage() {
  const { settings, status } = useContext(Workspace);
  const client = useQueryClient();
  const [draft, setDraft] = useState(settings);
  const [intervalDraft, setIntervalDraft] = useState({
    local: String(settings.localInterval),
    account: String(settings.accountInterval),
  });
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setDraft(settings);
    setIntervalDraft({
      local: String(settings.localInterval),
      account: String(settings.accountInterval),
    });
  }, [settings]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const localInterval = Number(intervalDraft.local);
    const accountInterval = Number(intervalDraft.account);
    for (const [label, text, value, minimum] of [
      ["本地记录刷新", intervalDraft.local, localInterval, 10],
      ["账户接口刷新", intervalDraft.account, accountInterval, 60],
    ] as const) {
      if (
        !text.trim() ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > 86400 ||
        (value !== 0 && value < minimum)
      ) {
        setMessage(
          `${label}请输入 ${minimum}–86400 的整数秒数，或输入 0 关闭自动刷新。`,
        );
        return;
      }
    }
    setSaving(true);
    setMessage("");
    const ticket = beginRefreshMotion("local");
    try {
      const result = await mutate<Settings>(
        "settings",
        {
          ...draft,
          localInterval,
          accountInterval,
        },
        "PATCH",
      );
      client.setQueryData(["settings"], result);
      await client.invalidateQueries({ queryKey: ["local"] });
      setMessage("设置已保存。");
    } catch (e) {
      cancelRefreshMotion(ticket);
      setMessage((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <Header
        title="设置"
        description="控制更新频率，查看当前数据的覆盖与状态。"
      />
      <SystemSettings />
      <section className="panel settings-panel">
        <h2>刷新与时间</h2>
        <form onSubmit={save}>
          {(["local", "account"] as const).map((key) => (
            <div className="setting-row" key={key}>
              <div>
                <label htmlFor={key + "Interval"}>
                  {key === "local" ? "本地记录刷新" : "账户接口刷新"}
                </label>
                <p>
                  {key === "local"
                    ? "最少 10 秒；扫描新增和变化的记录。"
                    : "最少 60 秒；读取账户汇总和额度。"}
                  输入 0 关闭自动刷新。
                </p>
              </div>
              <div>
                <input
                  id={key + "Interval"}
                  type="number"
                  required
                  step="1"
                  min="0"
                  max="86400"
                  value={intervalDraft[key]}
                  onChange={(e) =>
                    setIntervalDraft((current) => ({
                      ...current,
                      [key]: e.target.value,
                    }))
                  }
                />
                <span> 秒</span>
              </div>
            </div>
          ))}
          <div className="setting-row">
            <div>
              <label htmlFor="timezoneMode">时区模式</label>
              <p>跟随系统时，每分钟及重新回到窗口时检查变化。</p>
            </div>
            <Choice
              label="时区模式"
              value={draft.timezoneMode}
              options={[
                { value: "system", label: "跟随系统时区" },
                { value: "manual", label: "手动指定时区" },
              ]}
              onChange={(value) =>
                setDraft({
                  ...draft,
                  timezoneMode: value as Settings["timezoneMode"],
                })
              }
            />
          </div>
          <div className="setting-row">
            <div>
              <label htmlFor="timezone">显示时区</label>
              <p>
                决定“今天”的起止时间和每日趋势分组，并重算所选范围的本地用量。
              </p>
            </div>
            <AdaptiveRegion className="setting-control">
            {draft.timezoneMode === "system" ? (
              <div className="system-zone">
                <strong>{settings.timezone}</strong>
                <small>系统自动识别 · 切换为手动模式后可选择</small>
              </div>
            ) : (
              <Choice
                label="显示时区"
                value={draft.timezone}
                searchable
                allowCustom={(value) => DateTime.now().setZone(value).isValid}
                options={[
                  ["Asia/Shanghai", "上海 / 北京"],
                  ["Asia/Tokyo", "东京"],
                  ["Asia/Singapore", "新加坡"],
                  ["Europe/London", "伦敦"],
                  ["Europe/Berlin", "柏林"],
                  ["America/New_York", "纽约"],
                  ["America/Los_Angeles", "洛杉矶"],
                  ["Australia/Sydney", "悉尼"],
                  ["UTC", "协调世界时"],
                ].map(([value, label]) => ({
                  value,
                  label,
                  description: value,
                }))}
                onChange={(value) => setDraft({ ...draft, timezone: value })}
              />
            )}
            </AdaptiveRegion>
          </div>
          <PriceSettings draft={draft} setDraft={setDraft} />
          <p className="footnote">
            当前生效：{settings.timezone}（UTC
            {DateTime.now().setZone(settings.timezone).toFormat("ZZ")}
            ）。时区切换后会更新本地筛选、趋势与任务时间。自动采集仅在工作台打开期间触发。
          </p>
          <button className="primary-button save-button" disabled={saving} aria-busy={saving}>
            {saving ? "保存中…" : "保存设置"}
          </button>
          <span role="status" className="save-message">
            {message}
          </span>
        </form>
      </section>
      <section className="panel">
        <h2>数据源状态</h2>
        <div className="source-status-grid">
          {(["local", "accountLimits", "accountHistory"] as const).map(
            (key) => (
              <div key={key}>
                <h3>
                  {key === "local"
                    ? "本机记录"
                    : key === "accountLimits"
                      ? "账户额度"
                      : "账户每日历史"}
                </h3>
                <SourceBadge account={key !== "local"} />
                {key !== "local" && (
                  <AccountNotice
                    state={status?.[key]}
                    label={
                      key === "accountLimits" ? "账户额度" : "账户每日历史"
                    }
                    timezone={settings.timezone}
                  />
                )}
                <dl>
                  <dt>状态</dt>
                  <dd>
                    {status?.[key].running
                      ? "正在更新"
                      : status?.[key].error
                        ? "更新失败"
                        : "就绪"}
                  </dd>
                  <dt>最近成功</dt>
                  <dd>{time(status?.[key].updatedAt, settings.timezone)}</dd>
                  {key === "local" && (
                    <>
                      <dt>已扫描文件</dt>
                      <dd>{status?.local.filesScanned ?? 0}</dd>
                      <dt>可统计记录</dt>
                      <dd>{status?.local.events.toLocaleString() ?? 0}</dd>
                      <dt>解析异常</dt>
                      <dd>{status?.local.issues ?? 0}</dd>
                    </>
                  )}
                </dl>
                {status?.[key].error && (
                  <p className="error-text">{status[key].error}</p>
                )}
              </div>
            ),
          )}
        </div>
        <p className="footnote">
          范围：本机 Codex 的 sessions 和
          archived_sessions。部分旧格式、缺失父任务或已删除记录不能恢复为完整账本。
        </p>
      </section>
    </>
  );
}
