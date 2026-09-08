import { SystemSettings } from './SystemSettings';
import { AtlasAnalysis, AtlasThreads, AtlasDetail } from "./Atlas";
import { PriceSettings } from "./PriceSettings";
import { Workspace, defaultSettings, useRange, useData } from "./workspace";
import {
  time,
  SourceBadge,
  Header,
  ErrorBox,
  Loading,
  Notes,
  FilterBar,
  MetricsCards,
} from "./ui";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  CodeXml,
  LayoutDashboard,
  ChartNoAxesCombined,
  ListTree,
  Settings2,
  Globe2,
  RefreshCw,
  ArrowUpRight,
  BookOpen,
} from "lucide-react";
import { NavLink, Link, Route, Routes, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DateTime } from "luxon";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";
import type {
  AccountLimits,
  AccountStatus,
  AccountUsage,
  Metrics,
  Settings,
  Status,
  TrendRow,
} from "../shared/contracts";
import { api, mutate, exact, compact } from "./api";
import { Choice } from "./Choice";
import { useActiveRule, useArrival } from "./motion";

function Chart({
  rows,
  account = false,
  bucket = "day",
}: {
  rows: TrendRow[] | { time: string; totalTokens: string }[];
  account?: boolean;
  bucket?: "day" | "hour";
}) {
  const zone = useContext(Workspace).settings.timezone;
  const data = rows.map((row) => ({
    ...row,
    totalPlot: Number(BigInt(row.totalTokens || "0") / 1000n) / 1000,
  }));
  return (
    <div
      className="chart"
      role="img"
      aria-label={account ? "账户每日 Token 趋势" : "本地 Token 趋势"}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ left: 0, right: 12, top: 18, bottom: 0 }}
        >
          <defs>
            <linearGradient
              id={account ? "accountFill" : "localFill"}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop
                offset="0%"
                stopColor={account ? "#4074c7" : "#258977"}
                stopOpacity={0.16}
              />
              <stop
                offset="100%"
                stopColor={account ? "#4074c7" : "#258977"}
                stopOpacity={0}
              />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#e8edf3" vertical={false} />
          <XAxis
            dataKey="time"
            tickLine={false}
            axisLine={false}
            minTickGap={32}
            tickFormatter={(v) =>
              v.length <= 10
                ? v.slice(5)
                : DateTime.fromISO(v)
                    .setZone(zone)
                    .toFormat(bucket === "hour" ? "HH:mm" : "MM-dd HH:mm")
            }
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={52}
            tickFormatter={(v) => v + "M"}
          />
          <Tooltip
            content={({ active, payload }) =>
              active && payload?.length ? (
                <div className="chart-tip">
                  <span>{payload[0].payload.time}</span>
                  <strong>{exact(payload[0].payload.totalTokens)} Token</strong>
                  {"cachedInputTokens" in payload[0].payload && (
                    <>
                      <small>
                        输入 {exact(payload[0].payload.inputTokens)} · 输出{" "}
                        {exact(payload[0].payload.outputTokens)}
                      </small>
                      <small>
                        缓存输入 {exact(payload[0].payload.cachedInputTokens)} ·
                        推理输出{" "}
                        {exact(payload[0].payload.reasoningOutputTokens)}
                      </small>
                    </>
                  )}
                </div>
              ) : null
            }
          />
          <Legend verticalAlign="bottom" height={24} iconType="plainline" />
          <Area
            type="monotone"
            dataKey="totalPlot"
            name="总 Token"
            stroke={account ? "#4074c7" : "#258977"}
            strokeWidth={2}
            dot={data.length === 1 ? { r: 4 } : false}
            fill={`url(#${account ? "accountFill" : "localFill"})`}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
function LocalTrend() {
  const r = useRange();
  const bucket = r.bucket;
  const q = useData<TrendRow[]>("local/trend", { ...r.filters, bucket });
  return (
    <section className="panel overview-trend">
      <div className="panel-heading">
        <div>
          <h2>消耗趋势</h2>
          <p>按{bucket === "day" ? "日" : "小时"}观察本机记录</p>
        </div>
        <div className="segmented">
          <button
            aria-pressed={bucket === "day"}
            className={bucket === "day" ? "selected" : ""}
            onClick={() => r.update({ bucket: "day" })}
          >
            按日
          </button>
          <button
            aria-pressed={bucket === "hour"}
            className={bucket === "hour" ? "selected" : ""}
            onClick={() => r.update({ bucket: "hour" })}
          >
            按小时
          </button>
        </div>
      </div>
      <ErrorBox error={q.error} />
      <Loading isLoading={q.isLoading} empty={q.data?.data.length === 0} />
      {!!q.data?.data.length && <Chart rows={q.data.data} bucket={bucket} />}
    </section>
  );
}
function AccountNotice({
  state,
  label,
  timezone,
  compact = false,
}: {
  state: AccountStatus | undefined;
  label: string;
  timezone: string;
  compact?: boolean;
}) {
  return (
    <div className="notice" role="status" aria-label={`${label}状态`}>
      <strong>
        {label}：
        {state?.running
          ? "正在更新"
          : state?.error
            ? "更新失败"
            : state?.available
              ? "已读取"
              : "尚未取得数据"}
      </strong>
      <details
        className="account-source-details"
        open={compact ? undefined : true}
      >
        <summary>来源与更新时间</summary>
        {state?.provider && (
          <span>
            {state.provider === "http" ? "OAuth / HTTP" : "Codex App Server"}
          </span>
        )}
        {state?.accountId && (
          <p>
            账户：<code>{state.accountId}</code>
          </p>
        )}
        <p>最近成功：{time(state?.updatedAt, timezone)}</p>
      </details>
      {state?.available && (state.stale || !state.identityConfirmed) && (
        <p>历史快照，不能视为当前账户的实时状态。</p>
      )}
      {state?.error && <p>{state.error}</p>}
      {state?.fallbackReason && (
        <p>
          {state.stale
            ? "上次成功读取使用 OAuth；本次结果仍为历史快照。"
            : "未检测到 Codex CLI，已使用现有 OAuth 登录读取额度。"}
        </p>
      )}
      {!state?.identityConfirmed && (
        <p>当前身份尚未确认；已有旧记录仍保留在本机。</p>
      )}
    </div>
  );
}
function Overview() {
  const r = useRange();
  const account = useData<AccountUsage>("account/usage");
  const limits = useData<AccountLimits>("account/limits");
  const summary = useData<Metrics>("local/summary", r.filters);
  const { status } = useContext(Workspace);
  return (
    <>
      <Header
        title="用量总览"
        description="按当前时区重新统计本机用量，并查看账户额度。"
      />
      <FilterBar />
      <div className="overview-grid">
        <div className="overview-local">
          <div className="section-title">
            <SourceBadge />
            <Link
              to={"/analysis?" + r.search.toString()}
              className="inline-link"
            >
              分析消耗来源 <ArrowUpRight size={15} />
            </Link>
          </div>
          <MetricsCards data={summary.data?.data} />
          <ErrorBox error={summary.error} />
          <LocalTrend />
          <Notes response={summary.data} />
        </div>
        <aside className="overview-account" aria-label="账户额度">
          <div className="section-title">
            <SourceBadge account />
            <span>剩余额度</span>
          </div>
          <AccountNotice
            compact
            state={status?.accountLimits}
            label="账户额度"
            timezone={r.timezone}
          />
          <ErrorBox error={limits.error} />
          <div className="limits-grid">
            {limits.data?.data.buckets.map((b) => (
              <section className="panel limit-panel" key={b.id}>
                <h2>{b.name}</h2>
                {(
                  [
                    ["主窗口", b.primary],
                    ["次窗口", b.secondary],
                  ] as const
                ).map(([name, w]) =>
                  w ? (
                    <div className="limit-window" key={name}>
                      <div>
                        <span>
                          {w.windowDurationMins
                            ? `${w.windowDurationMins >= 1440 ? w.windowDurationMins / 1440 + " 天" : w.windowDurationMins / 60 + " 小时"}窗口`
                            : name}
                        </span>
                        <strong>
                          {w.remainingPercent === null
                            ? "未知"
                            : w.remainingPercent.toFixed(0)}
                          <small>
                            {w.remainingPercent === null ? "" : "% 剩余"}
                          </small>
                        </strong>
                      </div>
                      {w.remainingPercent !== null && (
                        <progress
                          max="100"
                          value={w.remainingPercent}
                          aria-label={`${b.name} ${name}剩余额度`}
                        />
                      )}
                      <small>
                        已用{" "}
                        {w.usedPercent === null
                          ? "未知"
                          : w.usedPercent.toFixed(1) + "%"}{" "}
                        ·{" "}
                        {w.resetsAt
                          ? time(w.resetsAt, r.timezone) + " 重置"
                          : "重置时间未知"}
                      </small>
                    </div>
                  ) : null,
                )}
              </section>
            ))}
          </div>
          {!limits.data?.data.buckets.length && (
            <div className="notice">
              {status?.accountLimits.running
                ? "正在读取账户额度…"
                : "暂无账户额度。请确认本机 Codex 已登录，再点击刷新。"}
            </div>
          )}
        </aside>
      </div>
      <details className="panel account-chart">
        <summary>官方原始每日记录（独立参考）</summary>
        <AccountNotice
          state={status?.accountHistory}
          label="账户每日历史"
          timezone={r.timezone}
        />
        <p className="footnote">
          账户接口没有日内明细，无法按 {r.timezone}{" "}
          重新划分每日用量。此处显示全部已返回的原始日期，与上方时间筛选和按时区重算的统计分开。
        </p>
        <div className="panel-heading">
          <div>
            <h2>官方原始每日 Token</h2>
            <p>原始日期 · 不代表按当前时区重算的账户日用量</p>
          </div>
          <div className="account-total">
            <span>账户累计</span>
            <strong title={exact(account.data?.data.summary.lifetimeTokens)}>
              {compact(account.data?.data.summary.lifetimeTokens)}
            </strong>
          </div>
        </div>
        <ErrorBox error={account.error} />
        {account.data?.data.dailyUsageBuckets?.length ? (
          <Chart
            account
            rows={account.data.data.dailyUsageBuckets.map((x) => ({
              time: x.startDate,
              totalTokens: x.tokens,
            }))}
          />
        ) : (
          <div className="empty">
            {status?.accountHistory.running || account.isLoading
              ? "正在读取账户每日历史…"
              : "暂无账户每日历史；这不代表用量为零。"}
          </div>
        )}
        <div className="account-facts">
          <span>
            单日峰值{" "}
            <b>{compact(account.data?.data.summary.peakDailyTokens)}</b>
          </span>
          <span>
            当前连续活跃{" "}
            <b>{exact(account.data?.data.summary.currentStreakDays)} 天</b>
          </span>
          <span>
            最长连续活跃{" "}
            <b>{exact(account.data?.data.summary.longestStreakDays)} 天</b>
          </span>
        </div>
      </details>
    </>
  );
}
function SettingsPage() {
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
    const localInterval = Number(intervalDraft.local);
    const accountInterval = Number(intervalDraft.account);
    for (const [label, text, value, minimum] of [
      ["本地记录刷新", intervalDraft.local, localInterval, 10],
      ["账户接口刷新", intervalDraft.account, accountInterval, 60],
    ] as const) {
      if (!text.trim() || !Number.isInteger(value) || value < 0 || value > 86400 || (value !== 0 && value < minimum)) {
        setMessage(`${label}请输入 ${minimum}–86400 的整数秒数，或输入 0 关闭自动刷新。`);
        return;
      }
    }
    setSaving(true);
    setMessage("");
    try {
      const result = await mutate<Settings>("settings", {
        ...draft,
        localInterval,
        accountInterval,
      }, "PATCH");
      client.setQueryData(["settings"], result);
      await client.invalidateQueries({ queryKey: ["local"] });
      setMessage("设置已保存。");
    } catch (e) {
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
          </div>
          <PriceSettings draft={draft} setDraft={setDraft} />
          <p className="footnote">
            当前生效：{settings.timezone}（UTC
            {DateTime.now().setZone(settings.timezone).toFormat("ZZ")}
            ）。时区切换后会更新本地筛选、趋势与任务时间。自动采集仅在工作台打开期间触发。
          </p>
          <button className="primary-button" disabled={saving}>
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
          范围：本机 Windows 的 sessions 和
          archived_sessions。部分旧格式、缺失父任务或已删除记录不能恢复为完整账本。
        </p>
      </section>
    </>
  );
}
export function App() {
  const location = useLocation();
  const pageMotion = useArrival<HTMLElement>(location.pathname);
  const navMotion = useActiveRule<HTMLElement>(location.pathname);
  const scopeSearch = useMemo(() => {
    const current = new URLSearchParams(
      location.search ||
        (location.state as { from?: string } | null)?.from?.split("?")[1] ||
        "",
    );
    const scope = new URLSearchParams();
    for (const key of [
      "range",
      "from",
      "to",
      "project",
      "model",
      "effort",
      "unknown",
      "group",
      "compareGroup",
    ])
      if (current.has(key)) scope.set(key, current.get(key)!);
    return scope.size ? "?" + scope.toString() : "";
  }, [location]);
  const client = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => api<Settings>("settings", {}, signal),
    refetchInterval: 60_000,
    refetchOnWindowFocus: "always",
  });
  const settings = settingsQuery.data?.data || defaultSettings;
  const statusQuery = useQuery({
    queryKey: ["status"],
    queryFn: ({ signal }) => api<Status>("status", {}, signal),
    refetchInterval: (q) =>
      q.state.data?.data.local.running || q.state.data?.data.account.running
        ? 2000
        : 15000,
  });
  const status = statusQuery.data?.data;
  const [now, setNow] = useState(Date.now());
  const [refreshError, setRefreshError] = useState("");
  const previous = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!status) return;
    for (const key of ["local", "accountLimits", "accountHistory"] as const) {
      // Progress belongs in the status bar; refresh statistics after the scan settles.
      if (key === "local" && status.local.running) continue;
      const fingerprint = JSON.stringify(
        key === "local"
          ? [status.local.updatedAt, status.local.error, status.local.events]
          : status[key],
      );
      if (fingerprint !== previous.current[key]) {
        previous.current[key] = fingerprint;
        void client.invalidateQueries({
          queryKey: [key === "local" ? "local" : "account"],
        });
        if (key === "local") setNow(Date.now());
      }
    }
  }, [status, client]);
  useEffect(() => {
    void mutate("refresh", { source: "all", force: false })
      .then(() => client.invalidateQueries({ queryKey: ["status"] }))
      .catch((e) => setRefreshError(e.message));
  }, [client]);
  useEffect(() => {
    const timers: ReturnType<typeof setInterval>[] = [];
    for (const key of ["local", "account"] as const) {
      const seconds =
        key === "local" ? settings.localInterval : settings.accountInterval;
      if (seconds)
        timers.push(
          setInterval(() => {
            void mutate("refresh", { source: key, force: false })
              .then(() => client.invalidateQueries({ queryKey: ["status"] }))
              .catch((e) => setRefreshError(e.message));
          }, seconds * 1000),
        );
    }
    return () => timers.forEach(clearInterval);
  }, [settings.localInterval, settings.accountInterval, client]);
  const refresh = async (source: string) => {
    setRefreshError("");
    try {
      await mutate("refresh", { source, force: true });
      await client.invalidateQueries({ queryKey: ["status"] });
    } catch (e) {
      setRefreshError((e as Error).message);
    }
  };
  return (
    <Workspace.Provider value={{ settings, now, status }}>
      <div className="app-shell">
        <aside className="sidebar">
          <Link to={"/" + scopeSearch} className="brand">
            <span className="brand-icon">
              <CodeXml size={26} strokeWidth={1.8} />
            </span>
            <div>
              Codex<small>用量图录</small>
            </div>
          </Link>
          <nav className="motion-rule" ref={navMotion}>
            {[
              { to: "/", icon: LayoutDashboard, text: "总览" },
              { to: "/analysis", icon: ChartNoAxesCombined, text: "消耗分析" },
              { to: "/threads", icon: ListTree, text: "任务明细" },
              { to: "/settings", icon: Settings2, text: "设置" },
            ].map(({ to, icon: Icon, text }) => (
              <NavLink end={to === "/"} key={to} to={to + scopeSearch}>
                <Icon size={20} strokeWidth={1.7} aria-hidden="true" />
                <span>{text}</span>
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-footer">
            <span className="live-dot" />
            本机运行<small>数据留在这台电脑</small>
            <a href="/docs" target="_blank" rel="noreferrer">
              <BookOpen size={16} /> API 文档 <ArrowUpRight size={14} />
            </a>
          </div>
        </aside>
        <div className="main-shell">
          <div className="topbar">
            <span className="breadcrumb">
              个人空间 <span>/</span> Codex 用量
            </span>
            <div className="actions">
              <Link
                to={"/settings" + scopeSearch}
                className="timezone-link"
                title="调整时区"
              >
                <Globe2 size={15} aria-hidden="true" />
                {settings.timezone}
                {settings.timezoneMode === "system" ? " · 系统" : ""}
              </Link>
              <span className="sync-status">
                {status?.local.running
                  ? `导入中 · ${status.local.filesScanned} 个文件`
                  : status?.account.running
                    ? "账户更新中"
                    : status?.local.updatedAt
                      ? "本地更新 " +
                        time(status.local.updatedAt, settings.timezone)
                      : "等待首次导入"}
              </span>
              <button
                onClick={() => refresh("all")}
                className={status?.local.running || status?.account.running ? "refresh-running" : undefined}
                aria-busy={!!(status?.local.running || status?.account.running)}
                disabled={status?.local.running && status?.account.running}
              >
                <RefreshCw size={15} aria-hidden="true" /> 刷新全部
              </button>
              <Choice
                label="单独刷新来源"
                value=""
                placeholder="单独刷新"
                options={[
                  { value: "local", label: "刷新本地记录" },
                  { value: "account", label: "刷新全部账户数据" },
                  { value: "accountLimits", label: "仅刷新额度" },
                  { value: "accountHistory", label: "仅刷新每日历史" },
                ]}
                onChange={(value) => void refresh(value)}
              />
            </div>
          </div>
          <main ref={pageMotion}>
            {refreshError && (
              <div role="alert" className="notice error">
                {refreshError}
              </div>
            )}
            <ErrorBox error={settingsQuery.error || statusQuery.error} />
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/analysis" element={<AtlasAnalysis />} />
              <Route path="/threads" element={<AtlasThreads />} />
              <Route path="/threads/:id" element={<AtlasDetail />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route
                path="*"
                element={
                  <Header
                    title="页面不存在"
                    description="从顶部导航返回用量图录。"
                  />
                }
              />
            </Routes>
          </main>
          <footer>
            Codex 用量图录 <span>账户与本机数据分别统计 · 仅个人使用</span>
          </footer>
        </div>
      </div>
    </Workspace.Provider>
  );
}
