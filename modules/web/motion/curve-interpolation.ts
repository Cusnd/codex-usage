import type { ComponentProps } from 'react';
import type { Area } from 'recharts';

type Pixel = { x: number; y: number };
// Explicit smoothstep: zero velocity at both endpoints, fastest at the midpoint.
export const curveEase = (t: number) => t * t * (3 - 2 * t);
/** Evaluate the monotone Hermite curve used by the plot, retaining peaks between sparse targets. */
export function curveSampler(points: readonly Pixel[]) {
  const slopes = points.slice(1).map((p, i) => (p.y - points[i].y) / (p.x - points[i].x || 1));
  const tangent = points.map((p, i) => {
    if (!i || i === points.length - 1) return 0;
    const left = p.x - points[i - 1].x, right = points[i + 1].x - p.x;
    const a = slopes[i - 1], b = slopes[i];
    const mean = (a * right + b * left) / (left + right || 1);
    return (Math.sign(a) + Math.sign(b)) * Math.min(Math.abs(a), Math.abs(b), Math.abs(mean) / 2);
  });
  if (points.length > 1) {
    tangent[0] = points.length === 2 ? slopes[0] : (3 * slopes[0] - tangent[1]) / 2;
    tangent[points.length - 1] = points.length === 2 ? slopes[0] : (3 * slopes.at(-1)! - tangent.at(-2)!) / 2;
  }
  return (fraction: number): Pixel => {
    const x = points[0].x + (points.at(-1)!.x - points[0].x) * fraction;
    let i = 0;
    while (i < points.length - 2 && points[i + 1].x < x) i++;
    const a = points[i], b = points[i + 1] ?? a, width = b.x - a.x;
    const t = width ? (x - a.x) / width : 0, t2 = t * t, t3 = t2 * t;
    return { x, y: (2 * t3 - 3 * t2 + 1) * a.y + (t3 - 2 * t2 + t) * width * tangent[i]
      + (-2 * t3 + 3 * t2) * b.y + (t3 - t2) * width * (tangent[i + 1] ?? 0) };
  };
}

// A key function preserves *all* old points as matched/removed, unlike proportional index
// matching, which discards most of the hourly curve before the first daily animation frame.
export const preserveCurvePoints = (_point: unknown, index: number) => index;
type Interpolator = NonNullable<ComponentProps<typeof Area>['animationInterpolateFn']>;
type Points = ReturnType<Interpolator>;

/** Sorting, tangents and sampling belong to preparation, never to the frame loop. */
export function prepareCurveTransition(previous: Points, target: Points) {
  if ([...previous, ...target].some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return () => target;
  const before = previous.map(p => ({ ...p, x: p.x!, y: p.y! })).sort((a, b) => a.x - b.x);
  const after = target.map(p => ({ ...p, x: p.x!, y: p.y! })).sort((a, b) => a.x - b.x);
  if (!before.length || !after.length) return () => after;
  const oldCurve = curveSampler(before), newCurve = curveSampler(after);
  // Include original knots as well as a shared grid so narrow peaks are not dropped.
  const fractions = new Set(Array.from({ length: 257 }, (_, i) => i / 256));
  for (const points of [before, after]) {
    const width = points.at(-1)!.x - points[0].x;
    if (width) for (const p of points) fractions.add(Math.round((p.x - points[0].x) / width * 1e6) / 1e6);
  }
  const samples = [...fractions].sort((a, b) => a - b).map(fraction => {
    const a = oldCurve(fraction), b = newCurve(fraction);
    return { point: after[Math.round(fraction * (after.length - 1))],
      x: a.x, y: a.y, dx: b.x - a.x, dy: b.y - a.y };
  });
  return (progress: number): Points => {
    if (progress <= 0) return before;
    if (progress >= 1) return after;
    return samples.map(({ point, x, y, dx, dy }) => ({ ...point, x: x + dx * progress, y: y + dy * progress }));
  };
}

/** One prepared transition per target, retaining the displayed layout and interrupted frame. */
export function createCurveInterpolator(): Interpolator {
  let visible: Points = [], start: Points = [], target: Points = [];
  let prepared: ReturnType<typeof prepareCurveTransition> | undefined;
  return (items, progress) => {
    if (!items) return [];
    const next = items.flatMap(item => item.status === 'removed' ? [] : [item.next]);
    if (next.length !== target.length || next.some((p, i) => p.x !== target[i].x || p.y !== target[i].y)) {
      start = visible.length ? visible : items.flatMap(item => item.status === 'added' ? [] : [item.prev]);
      target = next;
      prepared = undefined;
    }
    // Inactive layout updates still refresh the visible snapshot; they require no curve preparation.
    if (progress >= 1) return visible = next;
    prepared ??= prepareCurveTransition(start, target);
    return visible = prepared(progress);
  };
}

export const interpolateCurve: Interpolator = (items, progress) => {
  if (!items) return [];
  return prepareCurveTransition(
    items.flatMap(item => item.status === 'added' ? [] : [item.prev]),
    items.flatMap(item => item.status === 'removed' ? [] : [item.next]),
  )(progress);
};
