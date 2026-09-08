import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTrendBucket } from "../shared/time-range.js";

const zone = "America/New_York";
const from = "2026-09-08T04:00:00Z";
const to = "2026-09-08T14:00:00Z";

test("today opens hourly while multi-day presets open daily, including invalid URL buckets", () => {
  assert.equal(resolveTrendBucket(null, "today", from, to, zone), "hour");
  for (const range of ["7", "30"]) {
    assert.equal(resolveTrendBucket(null, range, from, to, zone), "day");
  }
  assert.equal(resolveTrendBucket("invalid", "today", from, to, zone), "hour");
});

test("manual granularity is respected within the selected range", () => {
  assert.equal(resolveTrendBucket("day", "today", from, to, zone), "day");
  assert.equal(resolveTrendBucket("hour", "30", from, to, zone), "hour");
});

test("short custom ranges and a complete 25-hour local day use hourly buckets", () => {
  for (const [start, end] of [
    [from, to],
    ["2026-09-08T23:00:00Z", "2026-09-09T11:00:00Z"],
    ["2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"],
    ["2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z"],
  ])
    assert.equal(resolveTrendBucket(null, "custom", start, end, zone), "hour");
  assert.equal(
    resolveTrendBucket(null, "custom", from, "2026-09-10T04:00:00Z", zone),
    "day",
  );
  assert.equal(resolveTrendBucket(null, "custom", "invalid", to, zone), "day");
  assert.equal(resolveTrendBucket(null, "custom", to, from, zone), "day");
});
