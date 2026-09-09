import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bucketTimes, bucketRange } from '../shared/time-range';
import { readTrendParent, selectedBrushIndices } from '../web/trend-range';

test('shrinking and expanding address the same original brush domain', () => {
  const parent = readTrendParent(JSON.stringify({ range: '7', from: '2026-09-02T04:00:00Z', to: '2026-09-08T16:00:00Z', bucket: 'day' }))!;
  const times = bucketTimes(parent.from, parent.to, 'America/New_York', 'day');
  const narrowed = selectedBrushIndices(times, 'day', 'America/New_York', '2026-09-04T04:00:00Z', '2026-09-06T04:00:00Z');
  assert.deepEqual(narrowed, { startIndex: 2, endIndex: 3 });
  // The left/right outer buckets remain available after narrowing.
  assert.equal(bucketRange(times[0], 'day', 'America/New_York', parent.from, parent.to)!.from, '2026-09-02T04:00:00.000Z');
  assert.equal(bucketRange(times.at(-1)!, 'day', 'America/New_York', parent.from, parent.to)!.to, '2026-09-08T16:00:00.000Z');
  assert.deepEqual(selectedBrushIndices(times, 'day', 'America/New_York', parent.from, parent.to), { startIndex: 0, endIndex: 6 });
  assert.equal(parent.range, '7');
});

test('invalid parent URLs cannot replace the chart domain', () => {
  for (const raw of [null, '{', '{}', JSON.stringify({ range: '7', from: 'bad', to: 'bad', bucket: 'day' })]) assert.equal(readTrendParent(raw), null);
});
