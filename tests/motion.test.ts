import test from 'node:test';
import assert from 'node:assert/strict';
import { settleResult, settlePlot, chartTransition, markQueryMotion, readMotionTicket, beginRefreshMotion, cancelRefreshMotion, type ResultSnapshot, type ChartSnapshot, type PlotSnapshot } from '../modules/web/motion/motion-state.js';
import { animateMotion, cancelMotion } from '../modules/web/motion/motion.js';
import { createCurveInterpolator, interpolateCurve, prepareCurveTransition } from '../modules/web/motion/curve-interpolation.js';

const empty: ResultSnapshot = { data: undefined, at: 0, used: 0, revision: 0, initial: true, animate: false };
test('cached animation survives an identical refetch and query status changes', () => {
  const day = settleResult(empty, 'day', 10, { id: 0, at: 0 });
  const hour = settleResult(day, 'hour', 20, { id: 1, at: 20 });
  const cached = settleResult(hour, 'day', 10, { id: 2, at: 30 });
  const refetched = settleResult(cached, 'day', 40, { id: 2, at: 30 });
  assert.equal(refetched.animate, false, 'an identical refresh must not request a new animation');
  const current: ChartSnapshot = { series: 'tokens', buckets: ['a'], values: [10], coordinates: 'ready' };
  const plot: PlotSnapshot = { input: 'day', current, animate: true, revision: cached.revision };
  assert.equal(settlePlot(plot, 'day', current, refetched), plot, 'nor cancel the animation already in flight');
  assert.equal(settlePlot(plot, 'day', current, { ...refetched, pending: true }), plot);
  const layout = settlePlot(plot, 'day', { ...current, coordinates: 'measured' }, refetched);
  assert.equal(layout.animate, true);
  assert.equal(layout.revision, plot.revision);
  const background = settlePlot(plot, 'changed', { ...current, values: [15] }, refetched);
  assert.equal(background.animate, false, 'a genuinely changed background target still updates without animation');
});
test('prepared curve frames do not reread or recompute their source geometry', () => {
  const previous = [{ x: 0, y: 0 }, { x: 50, y: 80 }, { x: 100, y: 0 }];
  const target = [{ x: 0, y: 10 }, { x: 100, y: 10 }];
  const render = prepareCurveTransition(previous, target);
  for (const point of [...previous, ...target]) {
    Object.defineProperty(point, 'x', { get() { throw new Error('source geometry read inside frame loop'); } });
    Object.defineProperty(point, 'y', { get() { throw new Error('source geometry read inside frame loop'); } });
  }
  for (const t of [.1, .25, .5, .75, .9]) {
    const peak = render(t).find(p => p.x === 50)!;
    assert.ok(Math.abs(peak.y! - (80 - 70 * t)) < 1e-6);
  }
  assert.equal(render(1).at(-1)!.y, 10);
});
test('first transition starts at the displayed layout, even if the library snapshot is stale', () => {
  const interpolate = createCurveInterpolator();
  const initial = [{ x: 0, y: 100 }, { x: 100, y: 200 }];
  const displayed = initial.map(p => ({ ...p, y: p.y - 24 }));
  const target = initial.map(p => ({ ...p, y: p.y / 2 }));
  const match = (before: typeof initial, after: typeof initial) => before.map((prev, i) => ({ status: 'matched' as const, prev, next: after[i] }));
  interpolate(match(initial, initial), 1, 'horizontal');
  interpolate(match(initial, displayed), 1, 'horizontal');
  const stale = match(initial, target);
  assert.deepEqual(interpolate(stale, 0, 'horizontal'), displayed);
  const middle = interpolate(stale, .4, 'horizontal');
  // A reversal must continue from the current intermediate curve, not either endpoint.
  assert.deepEqual(interpolate(match(target, displayed), 0, 'horizontal'), middle);
  assert.deepEqual(interpolate(match(target, displayed), 1, 'horizontal'), displayed);
});
test('dense-to-sparse curve keeps the old peak at the start and the exact target at the end', () => {
  const before = [{ x: 0, y: 0 }, { x: 25, y: 100 }, { x: 50, y: 0 }, { x: 75, y: 80 }, { x: 100, y: 0 }];
  const after = [{ x: 0, y: 10 }, { x: 100, y: 10 }];
  const items = before.map((prev, i) => i < after.length ? { status: 'matched', prev, next: after[i] } : { status: 'removed', prev }) as Parameters<typeof interpolateCurve>[0];
  assert.deepEqual(interpolateCurve(items, 0, 'horizontal'), before);
  assert.deepEqual(interpolateCurve(items, 1, 'horizontal'), after);
  const start = interpolateCurve(items, .001, 'horizontal');
  assert.ok(Math.abs(start.find(p => p.x === 25)!.y! - 100) < .1, 'the old peak must not disappear before morphing');
  const middle = interpolateCurve(items, .5, 'horizontal');
  assert.ok(Math.abs(middle.find(p => p.x === 25)!.y! - 55) < .001);
});
test('user results animate once, including cache hits; polling and identical results stay quiet', () => {
  const initial = settleResult(empty, 'A', 10, { id: 0, at: 0 });
  assert.equal(initial.animate, true);
  const poll = settleResult(initial, 'B', 20, { id: 0, at: 0 });
  assert.equal(poll.animate, false);
  const cached = settleResult(poll, 'A', 10, { id: 1, at: 30 });
  assert.equal(cached.animate, true);
  const same = settleResult(cached, 'A', 40, { id: 2, at: 35 });
  assert.equal(same.animate, false);
  assert.equal(settleResult(same, 'C', 50, { id: 2, at: 35 }).animate, false);
});
test('disclosure URL changes do not create data intent; cancellation preserves newer refresh', () => {
  const previous = new URLSearchParams('range=7');
  const next = new URLSearchParams('range=7&expandedTurn=one&trend=collapsed');
  const before = readMotionTicket(previous, 'local');
  markQueryMotion(next, previous);
  assert.deepEqual(readMotionTicket(next, 'local'), before);
  const old = beginRefreshMotion('all'), newer = beginRefreshMotion('local');
  cancelRefreshMotion(old);
  assert.equal(readMotionTicket(next, 'local').id, newer.id);
  assert.equal(readMotionTicket(next, 'account').id, 0);
  cancelRefreshMotion(newer);
});
test('morph requires matching series, buckets, finite values and actual plot coordinates', () => {
  const before: ChartSnapshot = { series: 'tokens', buckets: ['a', 'b'], values: [10, 20], coordinates: 'domain:0-100;width:600' };
  const after = { ...before, values: [15, 25] };
  assert.equal(chartTransition(before, after, true, false), 'morph');
  for (const changed of [{ ...after, series: 'cost' }, { ...after, buckets: ['b', 'a'] }, { ...after, coordinates: 'domain:0-200;width:600' }, { ...after, values: [NaN, 25] }])
    assert.equal(chartTransition(before, changed, true, false), 'fade');
  assert.equal(chartTransition(before, after, false, false), 'none');
  assert.equal(chartTransition(before, after, true, true), 'none');
  assert.equal(chartTransition(before, before, true, false), 'none');
});
test('curve transitions span different time buckets and scales without animating background data', () => {
  const before: ChartSnapshot = { series: 'local/tokens', buckets: ['day1', 'day2'], values: [10, 20], coordinates: 'day-scale' };
  const after: ChartSnapshot = { series: 'local/tokens', buckets: ['hour1', 'hour2', 'hour3'], values: [3, 8, 4], coordinates: 'hour-scale' };
  assert.equal(chartTransition(before, after, true, false, true), 'morph');
  assert.equal(chartTransition(before, after, true, false), 'fade');
  assert.equal(chartTransition(before, after, false, false, true), 'none');
  assert.equal(chartTransition(before, after, true, true, true), 'none');
  assert.equal(chartTransition(before, { ...after, series: 'account/tokens' }, true, false, true), 'fade');
  assert.equal(chartTransition(before, { ...after, values: [NaN] }, true, false, true), 'fade');
});
test('interrupted animation cannot run an obsolete completion or clear its successor', () => {
  const animations: { id: string; onfinish?: () => void; cancel: () => void }[] = [];
  const attrs = new Map();
  const element = { animate() { const animation = { id: '', cancel() {} }; animations.push(animation); return animation; }, setAttribute(k: string, v: string) { attrs.set(k, v); }, removeAttribute(k: string) { attrs.delete(k); } } as unknown as Element;
  let stale = 0, current = 0;
  animateMotion(element, [], 100, 'open', () => stale++);
  animateMotion(element, [], 100, 'close', () => current++);
  animations[0].onfinish?.();
  assert.equal(stale, 0);
  assert.equal(attrs.get('data-motion-running'), 'close');
  animations[1].onfinish?.();
  assert.equal(current, 1);
  assert.equal(attrs.has('data-motion-running'), false);
  animateMotion(element, [], 100, 'unmount', () => stale++);
  cancelMotion(element); animations[2].onfinish?.();
  assert.equal(stale, 0);
});
