import { useCapabilities } from '../runtime/context.js';

import { DateTime } from "luxon";
import { memo, useContext, useMemo } from "react";
import { AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TrendRow } from '../../contracts/query.js';
import { exact } from '../ui/format.js';
import { Workspace } from "../data/workspace.js";
import { MotionArea } from "../motion/ChartMotion.js";
import type { ResultMotion } from "../motion/motion-state.js";
import { useReducedMotion } from "../motion/motion.js";

export type ChartProps = {
    rows: TrendRow[] | {
        time: string;
        totalTokens: string;
    }[];
    account?: boolean;
    bucket?: "day" | "hour";
    change: ResultMotion;
};

export const ChartCanvas = memo(function ChartCanvas({ rows, account = false, bucket = "day", change, zone, }: ChartProps & {
    zone: string;
}) {
  const { deviceScope } = useCapabilities();
    const reduced = useReducedMotion();
    const data = useMemo(() => rows.map((row) => ({
        ...row,
        totalPlot: Number(BigInt(row.totalTokens || "0") / 1000n) / 1000,
    })), [rows]);
    const points = useMemo(() => data.map((row) => ({ time: row.time, value: row.totalPlot })), [data]);
    return (<div className="chart" role="img" aria-label={account ? "账户每日 Token 趋势" : deviceScope ? "设备 Token 趋势" : "本地 Token 趋势"}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ left: 0, right: 12, top: 18, bottom: 0 }}>
          <defs>
            <linearGradient id={account ? "accountFill" : "localFill"} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={account ? "var(--chart-account)" : "var(--blue)"} stopOpacity={0.1}/>
              <stop offset="100%" stopColor={account ? "var(--chart-account)" : "var(--blue)"} stopOpacity={0}/>
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 5" vertical={false}/>
          <XAxis dataKey="time" tickLine={false} axisLine={false} minTickGap={32} tickFormatter={(v) => v.length <= 10
            ? v.slice(5)
            : DateTime.fromISO(v)
                .setZone(zone)
                .toFormat(bucket === "hour" ? "HH:mm" : "MM-dd HH:mm")}/>
          <YAxis tickLine={false} axisLine={false} width={52} tickFormatter={(v) => v + "M"}/>
          <Tooltip isAnimationActive={!reduced} animationDuration={180} animationEasing="ease-out" content={({ active, payload }) => active && payload?.length ? (<div className="chart-tip">
                  <span>{payload[0].payload.time}</span>
                  <strong>{exact(payload[0].payload.totalTokens)} Token</strong>
                  {"cachedInputTokens" in payload[0].payload && (<>
                      <small>
                        输入 {exact(payload[0].payload.inputTokens)} · 输出{" "}
                        {exact(payload[0].payload.outputTokens)}
                      </small>
                      <small>
                        缓存输入 {exact(payload[0].payload.cachedInputTokens)} ·
                        推理输出{" "}
                        {exact(payload[0].payload.reasoningOutputTokens)}
                      </small>
                    </>)}
                </div>) : null}/>
          <Legend verticalAlign="bottom" height={24} iconType="plainline"/>
          <MotionArea change={change} points={points} series={`${account ? "account" : "local"}/${zone}/million-tokens`} type="monotone" dataKey="totalPlot" name="总 Token" stroke={account ? "var(--chart-account)" : "var(--blue)"} strokeWidth={2} dot={data.length === 1 ? { r: 4 } : false} fill={`url(#${account ? "accountFill" : "localFill"})`}/>
        </AreaChart>
      </ResponsiveContainer>
    </div>);
});

export function Chart(props: ChartProps) {
  const zone = useContext(Workspace).settings.timezone;
  // Query timestamps, busy state and identical refreshes must not re-enter Recharts.
  // Capture intent with the actual data, while letting a real timezone change redraw the plot.
  const change = useMemo(() => props.change, [props.rows, zone, props.account]);
  return <ChartCanvas {...props} zone={zone} change={change} />;
}
