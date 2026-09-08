import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { dataQuery } from "../web/data-query";

const params = { from: "2026-09-08T04:00:00Z", to: "2026-09-08T12:00:00Z" };
const query = (to: string) => dataQuery<string>("local/summary", { ...params, to }, "America/New_York", true);

test("rolling refresh keeps existing data while pending and after a network failure", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const first = query(params.to);
  const oldData = { data: "332180000", meta: { source: "local" as const, updatedAt: null, timezone: "America/New_York", warnings: [] } };
  client.setQueryData(first.queryKey, oldData);
  const observer = new QueryObserver(client, first);
  const states: { data: unknown; pending: boolean }[] = [];
  const unsubscribe = observer.subscribe((state) => states.push({ data: state.data, pending: state.isPending }));
  try {
    let finish!: (data: typeof oldData) => void;
    observer.setOptions({ ...query("2026-09-08T12:01:00Z"), queryFn: () => new Promise<typeof oldData>((resolve) => { finish = resolve; }) });
    const refresh = observer.refetch();
    assert.equal(observer.getCurrentResult().isFetching, true);
    assert.deepEqual(observer.getCurrentResult().data, oldData);
    const nextData = { ...oldData, data: "333000000" };
    finish(nextData);
    await refresh;
    assert.deepEqual(observer.getCurrentResult().data, nextData);
    observer.setOptions({ ...query("2026-09-08T12:02:00Z"), queryFn: async () => { throw new Error("offline"); } });
    await observer.refetch();
    assert.equal(observer.getCurrentResult().isError, true);
    assert.deepEqual(observer.getCurrentResult().data, nextData);
    assert.ok(states.length > 0);
    assert.ok(states.every((state) => state.data !== undefined && !state.pending));
  } finally {
    unsubscribe();
    client.clear();
  }
});

test("explicit dates, filters, buckets, timezone and day rollover remain distinct queries", () => {
  const base = query(params.to).queryKey;
  assert.deepEqual(base, query("2026-09-08T13:00:00Z").queryKey);
  for (const changed of [
    { ...params, from: "2026-09-09T04:00:00Z" },
    { ...params, project: "other" },
    { ...params, offset: 50 },
    { ...params, bucket: "hour" },
  ]) assert.notDeepEqual(base, dataQuery("local/summary", changed, "America/New_York", true).queryKey);
  assert.notDeepEqual(base, dataQuery("local/summary", params, "UTC", true).queryKey);
  assert.notDeepEqual(base, dataQuery("local/trend", params, "America/New_York", true).queryKey);
  const custom = dataQuery("local/summary", params, "America/New_York", false);
  assert.notDeepEqual(base, custom.queryKey);
  assert.notDeepEqual(custom.queryKey, dataQuery("local/summary", { ...params, to: "2026-09-08T13:00:00Z" }, "America/New_York", false).queryKey);
});

test("rolling requests advance the cutoff at fetch time; custom dates remain exact", async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url);
    return { ok: true, json: async () => ({ data: [] }) };
  });
  const before = Date.now();
  await query(params.to).queryFn({ signal: new AbortController().signal });
  const cutoff = new URL(urls[0], "http://localhost").searchParams.get("to")!;
  assert.ok(Date.parse(cutoff) >= before && Date.parse(cutoff) <= Date.now());
  await dataQuery("local/summary", params, "UTC", false).queryFn({ signal: new AbortController().signal });
  assert.equal(new URL(urls[1], "http://localhost").searchParams.get("to"), params.to);
});
