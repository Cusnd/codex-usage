import { DateTime } from 'luxon';
import { bucketRange } from '../../../foundation/time-range.js';

export function readTrendParent(raw: string | null): { range: string; from: string; to: string; bucket: 'day' | 'hour' } | null {
  try {
    const value = JSON.parse(raw || 'null');
    if (!value || typeof value.from !== 'string' || typeof value.to !== 'string') return null;
    if (!['custom', 'today', '7', '30'].includes(value.range) || !['day', 'hour'].includes(value.bucket)) return null;
    const from = DateTime.fromISO(value.from), to = DateTime.fromISO(value.to);
    return from.isValid && to.isValid && from < to ? value : null;
  } catch { return null; }
}

/** Indices always address the original domain, including buckets outside the selection. */
export function selectedBrushIndices(times: string[], bucket: 'day' | 'hour', timezone: string, from: string, to: string) {
  const selected = times.flatMap((time, index) => bucketRange(time, bucket, timezone, from, to) ? [index] : []);
  return { startIndex: selected[0] ?? 0, endIndex: selected.at(-1) ?? Math.max(0, times.length - 1) };
}
