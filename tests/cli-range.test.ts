import test from 'node:test';
import assert from 'node:assert/strict';
import { recentCalendarRange } from '../modules/foundation/time-range.js';

test('CLI recent days end now and use calendar midnights across DST', () => {
  const now = Date.parse('2026-11-01T18:00:00Z');
  assert.deepEqual(recentCalendarRange(1, 'America/New_York', now), { from: '2026-11-01T04:00:00.000Z', to: '2026-11-01T18:00:00.000Z' });
  assert.deepEqual(recentCalendarRange(2, 'America/New_York', now), { from: '2026-10-31T04:00:00.000Z', to: '2026-11-01T18:00:00.000Z' });
  assert.throws(() => recentCalendarRange(0, 'UTC', now));
  assert.throws(() => recentCalendarRange(7, 'Not/AZone', now));
});
