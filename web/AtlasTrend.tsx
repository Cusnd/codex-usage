import { ArrowLeft, ChevronDown } from "lucide-react";
import { DateTime } from "luxon";
import { useMemo, useRef } from "react";
import {
  BarChart,
  Brush,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Metrics, TrendRow } from "../shared/contracts";
import { bucketRange, bucketTimes } from "../shared/time-range";
import { compact, exact } from "./api";
import { useUrlPatch } from "./AtlasShared";
import { Choice } from "./Choice";
import { readTrendParent, selectedBrushIndices } from "./trend-range";
import { ErrorBox, Loading, time } from "./ui";
import { UsageBreakdown } from "./Usage";
import { useData, useRange } from "./workspace";
import { Segmented, Updating } from "./MotionPrimitives";
import { MotionBar } from "./ChartMotion";
import { useTrendLayout } from "./TrendMotion";
import { useReducedMotion } from "./motion";

export function TrendWorkspace() {
  const reduced = useReducedMotion();
  const r = useRange();
  const patch = useUrlPatch();
  const bucket = r.bucket;
  const collapsed = r.search.get("trend") === "collapsed";
  const layout = useTrendLayout(collapsed);
  const parent = readTrendParent(r.search.get("parentRange"));
  // Keep the brush's complete domain while the page queries the selected window.
  const domain = {
    from: parent?.from || r.filters.from!,
    to: parent?.to || r.filters.to!,
  };
  const trendFilters = { ...r.filters, ...domain };
  const trend = useData<TrendRow[]>(
    "local/trend",
    { ...trendFilters, bucket },
    !collapsed,
  );
  const summary = useData<Metrics>("local/summary", r.filters);
  const brush = useRef<{ startIndex?: number; endIndex?: number } | null>(null);
  const points = useMemo(() => {
    const rows = new Map(
      (trend.data?.data || []).map((row) => [
        DateTime.fromISO(row.time, { zone: r.timezone }).toMillis(),
        row,
      ]),
    );
    const continuous = bucketTimes(domain.from, domain.to, r.timezone, bucket);
    return (
      continuous.length
        ? continuous
        : (trend.data?.data || []).map((row) => row.time)
    ).map((at) => {
      const row = rows.get(
        DateTime.fromISO(at, { zone: r.timezone }).toMillis(),
      );
      return {
        time: at,
        value:
          row?.totalTokens == null ? 0 : Number(row.totalTokens) / 1_000_000,
        row,
        hasRecords: Boolean(row),
      };
    });
  }, [trend.data, domain.from, domain.to, r.timezone, bucket]);
  const selection = selectedBrushIndices(
    points.map((p) => p.time),
    bucket,
    r.timezone,
    r.filters.from!,
    r.filters.to!,
  );
  const selectRange = (from: string, to: string, hourly: boolean) => {
    const savedParent =
      (parent ? JSON.stringify(parent) : null) ||
      JSON.stringify({
        range: r.range,
        from: r.filters.from,
        to: r.filters.to,
        bucket,
      });
    r.update({
      range: "custom",
      from,
      to,
      bucket: hourly ? "hour" : bucket,
      parentRange: savedParent,
    });
  };
  const drillDay = (at: string) => {
    if (bucket !== "day") return;
    const next = bucketRange(
      at,
      "day",
      r.timezone,
      r.filters.from!,
      r.filters.to!,
    );
    if (next) selectRange(next.from, next.to, true);
  };
  const restore = () => {
    brush.current = null;
    if (!parent) return patch({ parentRange: undefined });
    r.update({
      range: parent.range,
      from: parent.range === "custom" ? parent.from : undefined,
      to: parent.range === "custom" ? parent.to : undefined,
      bucket: parent.bucket,
      parentRange: undefined,
    });
  };
  const commitBrush = (
    range: { startIndex?: number; endIndex?: number } | null,
  ) => {
    if (!range || !points.length) return;
    const first = range.startIndex ?? 0;
    const last = range.endIndex ?? points.length - 1;
    if (first === 0 && last === points.length - 1) {
      if (parent) restore();
      return;
    }
    const left = bucketRange(
      points[first]?.time,
      bucket,
      r.timezone,
      domain.from,
      domain.to,
    );
    const right = bucketRange(
      points[last]?.time,
      bucket,
      r.timezone,
      domain.from,
      domain.to,
    );
    if (left && right) selectRange(left.from, right.to, false);
  };
  return (
    <section className="atlas-time">
      <div className="atlas-section-bar">
        <h2>
          {collapsed
            ? "范围内统计"
            : bucket === "day"
              ? "每日消耗"
              : "每小时消耗"}
        </h2>
        <div className="actions">
          {r.search.has("parentRange") && (
            <button className="text-button" onClick={restore}>
              <ArrowLeft size={14} />
              返回原时间范围
            </button>
          )}
          <button
            className="text-button"
            aria-expanded={!collapsed}
            onClick={() => {
              layout.capture();
              patch({ trend: collapsed ? undefined : "collapsed" });
            }}
          >
            {collapsed ? "展开趋势" : "收起趋势"}
            <ChevronDown size={14} />
          </button>
        </div>
      </div>
      <ErrorBox error={summary.error || trend.error} />
      <div ref={layout.ref} className={"atlas-trend-grid " + (collapsed ? "is-collapsed" : "")}>
        {layout.present && (
          <div className="atlas-chart-panel" inert={collapsed} aria-hidden={collapsed}>
            <div className="chart-toolbar">
              {bucket === "day" ? (
                <Choice
                  label="选择一天查看小时趋势"
                  value=""
                  placeholder="百万 Token · 选择日期下钻"
                  options={points.map((p) => ({
                    value: p.time,
                    label: p.time,
                  }))}
                  onChange={drillDay}
                />
              ) : (
                <small>单位：百万 Token · {r.timezone}</small>
              )}
              <Segmented value={bucket} label="趋势粒度" small>
                {(["day", "hour"] as const).map((value) => (
                  <button
                    key={value}
                    aria-pressed={bucket === value}
                    className={bucket === value ? "selected" : ""}
                    onClick={() => patch({ bucket: value })}
                  >
                    {value === "day" ? "按日" : "按小时"}
                  </button>
                ))}
              </Segmented>
            </div>
            <Loading isLoading={trend.isPending} />
            {trend.data && (
              <div
                className="atlas-chart result-region"
                aria-busy={trend.motion.pending}
                onKeyUp={() => {
                  commitBrush(brush.current);
                  brush.current = null;
                }}
              >
                <Updating pending={trend.motion.pending} />
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    key={`${domain.from}/${parent || r.range === "custom" ? domain.to : "live"}/${bucket}`}
                    data={points}
                    margin={{ left: 0, right: 12, top: 8, bottom: 5 }}
                  >
                    <CartesianGrid
                      vertical={false}
                      stroke="var(--line)"
                      strokeDasharray="3 5"
                    />
                    <XAxis
                      dataKey="time"
                      axisLine={false}
                      tickLine={false}
                      minTickGap={24}
                      tickFormatter={(at) =>
                        DateTime.fromISO(at, { zone: r.timezone }).toFormat(
                          bucket === "day" ? "MM.dd" : "HH:mm",
                        )
                      }
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      width={48}
                      tickFormatter={(n) => `${n}M`}
                    />
                    <Tooltip
                      isAnimationActive={!reduced}
                      animationDuration={180}
                      animationEasing="ease-out"
                      cursor={{ fill: "var(--accent-soft)" }}
                      content={({ active, payload }) => {
                        const point = payload?.[0]?.payload as
                          (typeof points)[number] | undefined;
                        return active && point ? (
                          <div className="atlas-tooltip">
                            <b>
                              {time(
                                DateTime.fromISO(point.time, {
                                  zone: r.timezone,
                                }).toISO(),
                                r.timezone,
                              )}
                            </b>
                            <strong>
                              {point.row ? exact(point.row.totalTokens) : "0"}{" "}
                              Token
                            </strong>
                            {point.row && (
                              <>
                                <span>
                                  非缓存输入{" "}
                                  {exact(point.row.uncachedInputTokens)}
                                </span>
                                <span>
                                  缓存读取 {exact(point.row.cachedInputTokens)}
                                </span>
                                <span>
                                  输出 {exact(point.row.outputTokens)}
                                </span>
                              </>
                            )}
                            <small>
                              {point.hasRecords
                                ? "本机记录"
                                : "该时段无本地记录"}
                            </small>
                          </div>
                        ) : null;
                      }}
                    />
                    <MotionBar
                      change={trend.motion} points={points} series={`${bucket}/${r.timezone}/million-tokens`}
                      dataKey="value"
                      onClick={(entry) => {
                        const point = entry as unknown as {
                          time?: string;
                          payload?: { time?: string };
                        };
                        const at = point.time || point.payload?.time;
                        if (at) drillDay(at);
                      }}
                      fill="var(--blue)"
                      radius={[3, 3, 0, 0]}
                      maxBarSize={48}
                    />
                    {points.length > 1 && (
                      <Brush
                        dataKey="time"
                        startIndex={selection.startIndex}
                        endIndex={selection.endIndex}
                        height={18}
                        travellerWidth={8}
                        stroke="var(--blue)"
                        fill="var(--accent-soft)"
                        ariaLabel="选择分析时间范围"
                        tickFormatter={(at) =>
                          DateTime.fromISO(String(at), {
                            zone: r.timezone,
                          }).toFormat(bucket === "day" ? "MM.dd" : "HH:mm")
                        }
                        onChange={(range) => {
                          brush.current = range;
                        }}
                        onDragEnd={(range) => {
                          commitBrush(range);
                          brush.current = null;
                        }}
                      />
                    )}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            {parent && (
              <div className="atlas-brush-reset">
                <small>已缩小范围，可拖动两端重新展开</small>
                <button className="text-button" onClick={restore}>
                  恢复完整范围
                </button>
              </div>
            )}
          </div>
        )}
        <div className="atlas-total">
          <span>范围内 Token</span>
          <strong title={exact(summary.data?.data.totalTokens)}>
            {compact(summary.data?.data.totalTokens)}
          </strong>
          <dl>
            <dt>Sessions</dt>
            <dd>{summary.data?.data.threadCount ?? "—"}</dd>
            <dt>Turns</dt>
            <dd>{summary.data?.data.turnCount ?? "—"}</dd>
          </dl>
          <small>{r.timezone} · 本机记录</small>
        </div>
      </div>
      <UsageBreakdown data={summary.data?.data} />
    </section>
  );
}
