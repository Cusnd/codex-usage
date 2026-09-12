import { useCapabilities } from '../../runtime/context.js';

import { CloudAccounts } from '../accounts/CloudAccounts.js';
import { AccountNotice } from "../accounts/AccountNotice.js";
import { QuotaCards } from "../accounts/QuotaCards.js";
import { ArrowUpRight } from "lucide-react";
import { useContext, useState } from "react";
import { Link } from "react-router-dom";
import type { AccountLimits, AccountUsage } from '../../../contracts/accounts.js';
import type { Metrics, TrendRow } from '../../../contracts/query.js';
import { compact, exact } from '../../ui/format.js';
import { ErrorBox, FilterBar, Header, Loading, MetricsCards, Notes, SourceBadge, time } from "../../widgets/ui.js";
import { Workspace, useData, useRange } from "../../data/workspace.js";
import { MotionDetails, ResultRegion, Segmented, Updating } from "../../motion/MotionPrimitives.js";
import { QuotaProgress } from "../../motion/ChartMotion.js";
import { Chart } from '../../widgets/Chart.js';

export function LocalTrend() {
  const { deviceScope } = useCapabilities();
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
          <p>按{(displayed?.bucket ?? bucket) === "day" ? "日" : "小时"}观察{deviceScope ? "所选设备记录" : "本机记录"}</p>
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
  const { deviceScope } = useCapabilities();
  const r = useRange();
  const account = useData<AccountUsage>("account/usage", {}, !deviceScope);
  const limits = useData<AccountLimits>("account/limits", {}, !deviceScope);
  const summary = useData<Metrics>("local/summary", r.filters);
  const { status } = useContext(Workspace);
  return (
    <>
      <Header
        title="用量总览"
        description={deviceScope ? "按当前时区汇总所选设备的用量，并查看账户额度。" : "按当前时区重新统计本机用量，并查看账户额度。"}
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
          {deviceScope ? <CloudAccounts /> : <>
          <AccountNotice
            compact
            state={status?.accountLimits}
            label="账户额度"
            timezone={r.timezone}
          />
          <ErrorBox error={limits.error} />
          <QuotaCards buckets={limits.data?.data.buckets || []} formatTime={at => time(at, r.timezone)} progress={props => <QuotaProgress {...props} change={limits.motion} />} />
          {!limits.data?.data.buckets.length && (
            <div className="notice">
              {status?.accountLimits.running
                ? "正在读取账户额度…"
                : "暂无账户额度。请确认本机 Codex 已登录，再点击刷新。"}
            </div>
          )}
          </>}
        </aside>
      </div>
      {deviceScope ? <CloudAccounts history /> : <MotionDetails className="panel account-chart" duration={260} summary="官方原始每日记录（独立参考）">
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
      </MotionDetails>}
    </>
  );
}
