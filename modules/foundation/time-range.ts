import { DateTime } from "luxon";

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
): "day" | "hour" {
  if (requested === "day" || requested === "hour") return requested;
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
  bucket: "day" | "hour",
  timezone: string,
  from: string,
  to: string,
) {
  const start = DateTime.fromISO(time, { zone: timezone }).startOf(bucket);
  const end = start.plus(bucket === "day" ? { days: 1 } : { hours: 1 });
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
  bucket: "day" | "hour",
) {
  const result: string[] = [];
  let point = DateTime.fromISO(from).setZone(timezone).startOf(bucket);
  const end = DateTime.fromISO(to);
  while (point < end && result.length < 2000) {
    result.push(bucket === "day" ? point.toISODate()! : point.toISO()!);
    point = point.plus(bucket === "day" ? { days: 1 } : { hours: 1 });
  }
  // Let the caller use observed buckets for very long ranges; never truncate silently.
  return point < end ? [] : result;
}
