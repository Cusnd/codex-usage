import { DateTime } from "luxon";

export type TrendBucket = 'hour' | 'day' | 'week' | 'month';
export const trendBucketLabels: Record<TrendBucket, string> = { hour: '小时', day: '日', week: '周', month: '月' };

export function resolveUsageRange(range: string, timezone: string, now: number, customFrom?: string | null, customTo?: string | null) {
  const end = DateTime.fromMillis(now, { zone: timezone });
  if (range === 'all') return { from: undefined, to: end.toUTC().toISO()!, valid: end.isValid };
  const from = range === 'custom' ? DateTime.fromISO(customFrom || '', { zone: timezone })
    : end.startOf('day').minus({ days: range === 'today' ? 0 : Number(range) - 1 });
  const to = range === 'custom' ? DateTime.fromISO(customTo || '', { zone: timezone }) : end;
  const valid = from.isValid && to.isValid && from < to;
  return { from: (valid ? from : end.startOf('day')).toUTC().toISO()!, to: (valid ? to : end).toUTC().toISO()!, valid };
}

/** Recent calendar days include today's partial day, ending at the query instant. */
export function recentCalendarRange(days: number, timezone: string, now = Date.now()) {
  if (!Number.isInteger(days) || days < 1 || days > 3660) throw new Error('--days must be 1–3660.');
  const end = DateTime.fromMillis(now).setZone(timezone);
  if (!end.isValid) throw new Error('Invalid workbench timezone.');
  return { from: end.startOf('day').minus({ days: days - 1 }).toUTC().toISO()!, to: end.toUTC().toISO()! };
}

/** Explicit chart choices apply to the current range; otherwise choose a useful scale. */
export function resolveTrendBucket(
  requested: string | null,
  range: string,
  from: string,
  to: string,
  timezone: string,
): TrendBucket {
  if (requested === "day" || requested === "hour" || requested === 'week' || requested === 'month') return requested;
  if (range === 'all') {
    const days = DateTime.fromISO(to).diff(DateTime.fromISO(from), 'days').days;
    return days > 730 ? 'month' : days > 180 ? 'week' : 'day';
  }
  if (range === "today") return "hour";
  if (range === "custom") {
    const start = DateTime.fromISO(from).setZone(timezone);
    const end = DateTime.fromISO(to).setZone(timezone);
    if (start.isValid && end.isValid && start < end) {
      // A local day can last 25 hours at the autumn DST transition.
      if (
        end.diff(start, "hours").hours <= 24 ||
        start.hasSame(end.minus({ milliseconds: 1 }), "day")
      )
        return "hour";
    }
  }
  return "day";
}

export function bucketRange(
  time: string,
  bucket: TrendBucket,
  timezone: string,
  from: string,
  to: string,
) {
  const start = DateTime.fromISO(time, { zone: timezone }).startOf(bucket);
  const end = start.plus({ [bucket + 's']: 1 });
  const low = Math.max(start.toMillis(), DateTime.fromISO(from).toMillis());
  const high = Math.min(end.toMillis(), DateTime.fromISO(to).toMillis());
  return low < high
    ? { from: new Date(low).toISOString(), to: new Date(high).toISOString() }
    : null;
}

export function bucketTimes(
  from: string,
  to: string,
  timezone: string,
  bucket: TrendBucket,
) {
  const result: string[] = [];
  let point = DateTime.fromISO(from).setZone(timezone).startOf(bucket);
  const end = DateTime.fromISO(to);
  while (point < end && result.length < 2000) {
    result.push(bucket === "hour" ? point.toISO()! : point.toISODate()!);
    point = point.plus({ [bucket + 's']: 1 });
  }
  // Let the caller use observed buckets for very long ranges; never truncate silently.
  return point < end ? [] : result;
}
