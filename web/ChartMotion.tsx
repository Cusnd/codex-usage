import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { Area, Bar, usePlotArea, useXAxisScale, useYAxisScale } from "recharts";
import { animateMotion, cancelMotion, motion, useReducedMotion } from "./motion";
import { chartTransition, settlePlot, type ChartSnapshot, type PlotSnapshot, type ResultMotion } from "./motion-state";
import { createCurveInterpolator, curveEase, preserveCurvePoints } from "./curve-interpolation";

type PlotMotion = { change: ResultMotion; series: string; points: readonly { time: string; value: number }[] };

function usePlotMotion({ change, series, points }: PlotMotion, continuous = false) {
  const layer = `motion-plot-${useId().replace(/[^a-z0-9]/gi, "")}`;
  const reduced = useReducedMotion();
  const x = useXAxisScale(), y = useYAxisScale(), area = usePlotArea();
  const coordinates = x && y && area?.width && area.height
    ? JSON.stringify([area, y(0), y(1), points.map((point) => x(point.time))]) : "";
  const next: ChartSnapshot = { series, buckets: points.map((point) => point.time), values: points.map((point) => point.value), coordinates };
  const input = JSON.stringify([series, next.buckets, next.values]);
  const [state, setState] = useState<PlotSnapshot>({ input, current: next, animate: change.animate, revision: change.revision });
  const settled = settlePlot(state, input, next, change);
  if (settled !== state) setState(settled);
  const stamp = `${continuous ? state.revision : change.revision}:${input}`;
  const [finished, setFinished] = useState("");
  // A cold reverse request retains the old data while fetching. Keep its current animation
  // running until the new geometry arrives instead of forcing its endpoint in the meantime.
  const animate = continuous || change.pending ? state.animate : change.animate;
  // An already visible initial curve must not replay an entrance fade while its first request is pending.
  const kind = continuous && !state.from ? "none" : chartTransition(state.from, next, animate, reduced, continuous);
  const active = kind === "morph" && finished !== stamp && !!coordinates;
  const ref = useRef<SVGGElement>(null);
  useLayoutEffect(() => { if (!active) ref.current?.removeAttribute("data-chart-running"); }, [active]);
  useLayoutEffect(() => {
    const node = ref.current?.closest(".recharts-wrapper")?.querySelector(`.${layer}`);
    if (!node) return;
    if (!animate || reduced) { cancelMotion(node); return; }
    if (kind === "fade" && coordinates && finished !== stamp) {
      // Keep a populated plot visible when switching ranges; fading from zero reads as a flash.
      const opacity = node.hasAttribute("data-motion-running") ? getComputedStyle(node).opacity : state.from ? "0.7" : "0";
      animateMotion(node, [{ opacity }, { opacity: 1 }], motion.fade, "chart-fade", () => setFinished(stamp));
    }
    return () => cancelMotion(node);
  }, [kind, stamp, coordinates, reduced, animate]);
  useLayoutEffect(() => {
    const node = ref.current;
    return () => { if (node) cancelMotion(node); };
  }, []);
  const start = useCallback(() => { if (ref.current) ref.current.dataset.chartRunning = "morph"; }, []);
  const end = useCallback(() => { ref.current?.removeAttribute("data-chart-running"); setFinished(stamp); }, [stamp]);
  return {
    ref, kind, active, layer,
    start, end,
  };
}

export function MotionBar({ change, series, points, ...props }: Omit<ComponentProps<typeof Bar>, keyof PlotMotion> & PlotMotion) {
  const plot = usePlotMotion({ change, series, points });
  return <g ref={plot.ref} data-chart-transition={plot.kind}>
    <Bar {...props} className={`${props.className || ""} ${plot.layer}`} isAnimationActive={plot.active} animationDuration={motion.chart} animationEasing="ease-out"
      onAnimationStart={plot.start} onAnimationEnd={plot.end} />
  </g>;
}

export function MotionArea({ change, series, points, ...props }: Omit<ComponentProps<typeof Area>, keyof PlotMotion> & PlotMotion) {
  const plot = usePlotMotion({ change, series, points }, true);
  const interpolate = useMemo(createCurveInterpolator, []);
  return <g ref={plot.ref} data-chart-transition={plot.kind}>
    <Area {...props} className={`${props.className || ""} ${plot.layer}`} isAnimationActive={plot.active} animationDuration={297} animationEasing={curveEase}
      animationMatchBy={preserveCurvePoints} animationInterpolateFn={interpolate}
      onAnimationStart={plot.start} onAnimationEnd={plot.end} />
  </g>;
}

export function QuotaProgress({ identity, value, label, change }: { identity: string; value: number; label: string; change: ResultMotion }) {
  const previous = useRef(identity);
  const animate = previous.current === identity && change.animate && !change.initial;
  useLayoutEffect(() => { previous.current = identity; }, [identity]);
  return <progress className="motion-quota" data-animate={animate} max="100" value={value} aria-label={label} />;
}
