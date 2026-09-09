import test from 'node:test';
import assert from 'node:assert/strict';
import { settleResult, chartTransition, markQueryMotion, readMotionTicket, beginRefreshMotion, cancelRefreshMotion, type ResultSnapshot, type ChartSnapshot } from '../web/motion-state';
import { animateMotion, cancelMotion } from '../web/motion';

const empty: ResultSnapshot = { data: undefined, at: 0, used: 0, revision: 0, initial: true, animate: false };
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
