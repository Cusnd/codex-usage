import { DateTime } from "luxon";

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
