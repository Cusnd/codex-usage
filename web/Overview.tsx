import { AccountNotice } from "./AccountNotice";
import { ArrowUpRight } from "lucide-react";
import { DateTime } from "luxon";
import { memo, useContext, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  AccountLimits,
  AccountUsage,
  Metrics,
  TrendRow,
} from "../shared/contracts";
import { compact, exact } from "./api";
import {
  ErrorBox,
  FilterBar,
  Header,
  Loading,
  MetricsCards,
  Notes,
  SourceBadge,
  time,
} from "./ui";
import { Workspace, useData, useRange } from "./workspace";
import { MotionDetails, ResultRegion, Segmented, Updating } from "./MotionPrimitives";
import { MotionArea, QuotaProgress } from "./ChartMotion";
import type { ResultMotion } from "./motion-state";
import { useReducedMotion } from "./motion";

type ChartProps = {
  rows: TrendRow[] | { time: string; totalTokens: string }[];
  account?: boolean;
  bucket?: "day" | "hour";
  change: ResultMotion;
};

export function Chart(props: ChartProps) {
  const zone = useContext(Workspace).settings.timezone;
  // Query timestamps, busy state and identical refreshes must not re-enter Recharts.
  // Capture intent with the actual data, while letting a real timezone change redraw the plot.
  const change = useMemo(() => props.change, [props.rows, zone, props.account]);
  return <ChartCanvas {...props} zone={zone} change={change} />;
}

const ChartCanvas = memo(function ChartCanvas({
  rows,
  account = false,
  bucket = "day",
  change,
  zone,
}: ChartProps & { zone: string }) {
  const reduced = useReducedMotion();
  const data = useMemo(() => rows.map((row) => ({
    ...row,
    totalPlot: Number(BigInt(row.totalTokens || "0") / 1000n) / 1000,
  })), [rows]);
  const points = useMemo(() => data.map((row) => ({ time: row.time, value: row.totalPlot })), [data]);
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
                stopColor={account ? "var(--chart-account)" : "var(--blue)"}
                stopOpacity={0.1}
              />
              <stop
                offset="100%"
                stopColor={account ? "var(--chart-account)" : "var(--blue)"}
                stopOpacity={0}
              />
            </linearGradient>
          </defs>
          <CartesianGrid
            stroke="var(--line)"
            strokeDasharray="3 5"
            vertical={false}
          />
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
            isAnimationActive={!reduced}
            animationDuration={180}
            animationEasing="ease-out"
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
          <MotionArea
            change={change} points={points} series={`${account ? "account" : "local"}/${zone}/million-tokens`}
            type="monotone"
            dataKey="totalPlot"
            name="总 Token"
            stroke={account ? "var(--chart-account)" : "var(--blue)"}
            strokeWidth={2}
            dot={data.length === 1 ? { r: 4 } : false}
            fill={`url(#${account ? "accountFill" : "localFill"})`}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
});

export function LocalTrend() {
  const r = useRange();
  const bucket = r.bucket;
  const q = useData<TrendRow[]>("local/trend", { ...r.filters, bucket });
  const [displayed, setDisplayed] = useState<{ rows: TrendRow[]; bucket: typeof bucket }>();
  if (q.data && !q.isPlaceholderData && (displayed?.rows !== q.data.data || displayed.bucket !== bucket))
    setDisplayed({ rows: q.data.data, bucket });
  return (
    <section className="panel overview-trend">
      <div className="panel-heading">
        <div>
          <h2>消耗趋势</h2>
          <p>按{(displayed?.bucket ?? bucket) === "day" ? "日" : "小时"}观察本机记录</p>
        </div>
        <Segmented value={bucket} label="趋势粒度" small>
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
        </Segmented>
      </div>
      <ErrorBox error={q.error} />
      <Loading isLoading={q.isLoading && !displayed} empty={displayed?.rows.length === 0} />
      <div className="result-region" aria-busy={q.motion.pending}>
        <Updating pending={q.motion.pending} />
        {!!displayed?.rows.length && <Chart rows={displayed.rows} bucket={displayed.bucket} change={q.motion} />}
      </div>
    </section>
  );
}

export function Overview() {
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
      {summary.data?.meta.exampleData && (
        <p className="example-label">示例数据 · 用量与账户额度均为合成示例</p>
      )}
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
          <ResultRegion change={summary.motion} pending={summary.motion.pending} animate={false}><MetricsCards data={summary.data?.data} /></ResultRegion>
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
                        <QuotaProgress
                          identity={`${b.id}/${name}/${w.resetsAt}`}
                          value={w.remainingPercent}
                          label={`${b.name} ${name}剩余额度`}
                          change={limits.motion}
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
      <MotionDetails className="panel account-chart" duration={260} summary="官方原始每日记录（独立参考）">
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
            change={account.motion}
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
      </MotionDetails>
    </>
  );
}
