import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  appendFile,
  rename,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/db.js";
import { Importer } from "../server/importer.js";
import { Queries } from "../server/queries.js";
import { createApp } from "../server/app.js";
import { json, parseJson } from "../server/util.js";
import { bucketRange, bucketTimes } from "../shared/time-range.js";
import { officialPrices } from "../server/pricing.js";

const usage = (n: number | bigint) => ({
  input_tokens: n,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  total_tokens: n,
});
const meta = (id = "t", parent?: string) => ({
  type: "session_meta",
  payload: { id, cwd: "C:\\work\\demo", forked_from_id: parent },
  timestamp: "2026-09-08T04:00:00Z",
});
const context = (turn = "turn") => ({
  type: "turn_context",
  payload: {
    turn_id: turn,
    model: "model-a",
    effort: "high",
    cwd: "C:\\work\\demo",
  },
});
const record = (
  response: string,
  n: number | bigint,
  at = "2026-09-08T04:01:00Z",
) => ({
  type: "token_usage_record",
  timestamp: at,
  payload: {
    thread_id: "t",
    turn_id: "turn",
    response_id: response,
    usage: usage(n),
  },
});
const legacy = (
  total: number,
  last: number | undefined,
  at = "2026-09-08T04:01:00Z",
  source = "a",
) => ({
  type: "event_msg",
  timestamp: at,
  payload: {
    type: "token_count",
    info: {
      total_token_usage: usage(total),
      ...(last === undefined ? {} : { last_token_usage: usage(last) }),
    },
    rate_limits: { limit_id: source },
  },
});
const lines = (items: unknown[]) => items.map(json).join("\n") + "\n";
async function fixture(
  fn: (s: Store, i: Importer, dir: string, q: Queries) => Promise<void>,
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-usage-"));
  await mkdir(path.join(dir, "sessions"));
  await mkdir(path.join(dir, "archived_sessions"));
  const store = new Store(":memory:");
  try {
    await fn(store, new Importer(store, dir), dir, new Queries(store));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("explicit usage replaces mirror, imports are idempotent, copies and archives deduplicate", async () =>
  fixture(async (s, i, d, q) => {
    const file = path.join(d, "sessions", "a.jsonl");
    await writeFile(
      file,
      lines([meta(), context(), legacy(10, 10), record("r1", 10)]),
    );
    await i.scan(() => {});
    assert.equal(q.summary().totalTokens, "10");
    await i.scan(() => {});
    assert.equal(q.summary().totalTokens, "10");
    await writeFile(
      path.join(d, "sessions", "copy.jsonl"),
      lines([meta(), context(), record("r1", 10)]),
    );
    await rename(file, path.join(d, "archived_sessions", "a.jsonl"));
    await i.scan(() => {});
    assert.equal(q.summary().totalTokens, "10");
    await appendFile(
      path.join(d, "archived_sessions", "a.jsonl"),
      lines([record("r2", 5)]),
    );
    await i.scan(() => {});
    assert.equal(q.summary().totalTokens, "15");
  }));
test("legacy duplicate and interleaved snapshots prefer explicit last, cumulative fallback uses high water", async () =>
  fixture(async (s, i, d, q) => {
    await writeFile(
      path.join(d, "sessions", "a.jsonl"),
      lines([
        meta(),
        context(),
        legacy(100, 100),
        legacy(100, 100, undefined, "b"),
        legacy(200, 20, "2026-09-08T04:02:00Z"),
        legacy(150, 10, "2026-09-08T04:03:00Z"),
        legacy(210, undefined, "2026-09-08T04:04:00Z"),
        legacy(190, undefined, "2026-09-08T04:05:00Z"),
      ]),
    );
    await i.scan(() => {});
    assert.equal(q.summary().totalTokens, "140");
  }));
test("partial line is resumed, corrupt line skipped, truncation replaces own contribution", async () =>
  fixture(async (s, i, d, q) => {
    const f = path.join(d, "sessions", "a.jsonl");
    const r = json(record("r2", 7));
    await writeFile(
      f,
      lines([meta(), context(), record("r1", 10)]) +
        "{bad json}\n" +
        r.slice(0, 35),
    );
    await i.scan(() => {});
    assert.equal(q.summary().totalTokens, "10");
    await appendFile(f, r.slice(35) + "\n");
    await i.scan(() => {});
    assert.equal(q.summary().totalTokens, "17");
    await writeFile(f, lines([meta(), context(), record("r3", 2)]));
    await i.scan(() => {});
    assert.equal(q.summary().totalTokens, "2");
  }));
test("known inherited prefix is excluded", async () =>
  fixture(async (s, i, d, q) => {
    await writeFile(
      path.join(d, "sessions", "a.jsonl"),
      lines([
        meta("parent"),
        context(),
        legacy(10, 10, "2026-09-08T03:59:00Z"),
      ]),
    );
    await i.scan(() => {});
    await writeFile(
      path.join(d, "sessions", "b.jsonl"),
      lines([
        meta("child", "parent"),
        context(),
        legacy(10, 10, "2026-09-08T03:59:00Z"),
        legacy(15, 5, "2026-09-08T04:01:00Z"),
      ]),
    );
    await i.scan(() => {});
    assert.equal(q.summary().totalTokens, "15");
  }));
test("a child is retried when its parent is discovered later in archives", async () =>
  fixture(async (s, i, d, q) => {
    await writeFile(
      path.join(d, "sessions", "child.jsonl"),
      lines([
        meta("child", "parent"),
        context(),
        legacy(10, 10, "2026-09-08T03:59:00Z"),
        legacy(15, 5, "2026-09-08T04:01:00Z"),
      ]),
    );
    await writeFile(
      path.join(d, "archived_sessions", "parent.jsonl"),
      lines([
        meta("parent"),
        context(),
        legacy(10, 10, "2026-09-08T03:59:00Z"),
      ]),
    );
    await i.scan(() => {});
    assert.equal(q.summary().totalTokens, "15");
  }));
test("timezone boundaries, missing fields, big integers and aggregation agree", async () =>
  fixture(async (s, i, d, q) => {
    const big = 9007199254740993n;
    await writeFile(
      path.join(d, "sessions", "a.jsonl"),
      lines([
        meta(),
        context(),
        record("r1", big, "2026-09-08T03:59:00Z"),
        record("r2", 7, "2026-09-08T04:00:00Z"),
      ]),
    );
    await i.scan(() => {});
    assert.equal(q.summary().totalTokens, (big + 7n).toString());
    const trend = q.trend({}, "day");
    assert.equal(trend.length, 2);
    assert.equal(trend[0].time, "2026-09-07");
    const sum = (xs: { totalTokens: string | null }[]) =>
      xs.reduce((n, x) => n + BigInt(x.totalTokens || 0), 0n);
    assert.equal(sum(trend), BigInt(q.summary().totalTokens!));
    assert.equal(sum(q.groups({}, "model")), sum(trend));
    assert.equal(
      q.summary({ from: "2026-09-08T04:00:00Z", to: "2026-09-09T04:00:00Z" })
        .totalTokens,
      "7",
    );
    assert.equal(q.summary({ from: "2027-01-01T00:00:00Z" }).cacheRatio, null);
    assert.equal(parseJson('{"n":9007199254740993}').n, big);
    s.saveSettings({
      ...s.settings(),
      timezone: "Asia/Shanghai",
      timezoneMode: "manual",
    });
    assert.equal(q.trend({}, "day").length, 1);
    assert.equal(q.summary().totalTokens, (big + 7n).toString());
    const oldZone = process.env.TZ;
    try {
      s.saveSettings({ ...s.settings(), timezoneMode: "system" });
      process.env.TZ = "Asia/Tokyo";
      assert.equal(s.settings().timezone, "Asia/Tokyo");
      process.env.TZ = "America/New_York";
      assert.equal(s.settings().timezone, "America/New_York");
      assert.equal(q.trend({}, "day").length, 2);
    } finally {
      if (oldZone === undefined) delete process.env.TZ;
      else process.env.TZ = oldZone;
    }
  }));
test("API query chain, validation, comparison and settings persist", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-api-"));
  await mkdir(path.join(dir, "sessions"));
  await writeFile(
    path.join(dir, "sessions", "a.jsonl"),
    lines([meta(), context(), record("r1", 10)]),
  );
  const database = path.join(dir, "test.sqlite");
  const a = await createApp({ database, codexHome: dir, startup: false });
  try {
    a.refresh.trigger("local", true);
    await a.refresh.wait();
    const summary = await a.app.inject("/api/local/summary");
    assert.equal(summary.statusCode, 200);
    assert.equal(summary.json().data.totalTokens, "10");
    const trend = await a.app.inject("/api/local/trend?bucket=day");
    assert.equal(trend.json().data[0].totalTokens, "10");
    const groups = await a.app.inject("/api/local/breakdown?groupBy=model");
    assert.equal(groups.json().data.items[0].totalTokens, "10");
    const compare = await a.app.inject(
      "/api/local/compare?from=2026-09-08T00:00:00Z&to=2026-09-09T00:00:00Z",
    );
    assert.equal(compare.json().data.items[0].changeRatio, null);
    assert.equal((await a.app.inject("/api/local/threads/t")).statusCode, 200);
    assert.equal(
      (
        await a.app.inject(
          "/api/local/summary?from=2026-09-09T00:00:00Z&to=2026-09-08T00:00:00Z",
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await a.app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { localInterval: 1 },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await a.app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { localInterval: 30, timezone: "Asia/Shanghai" },
        })
      ).statusCode,
      200,
    );
    assert.ok(
      (await a.app.inject("/openapi.json")).json().paths["/api/local/summary"],
    );
  } finally {
    await a.app.close();
  }
  const b = await createApp({ database, codexHome: dir, startup: false });
  try {
    assert.equal(
      (await b.app.inject("/api/settings")).json().data.localInterval,
      30,
    );
  } finally {
    await b.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("session index names use newest metadata, survive bad lines and missing source, search before pagination", async () =>
  fixture(async (s, i, d, q) => {
    await writeFile(
      path.join(d, "sessions", "a.jsonl"),
      lines([meta(), context(), record("r1", 10)]),
    );
    const index = path.join(d, "session_index.jsonl");
    await writeFile(
      index,
      lines([
        { id: "t", thread_name: "旧标题", updated_at: "2026-09-07T00:00:00Z" },
        {
          id: "t",
          thread_name: "真实分析任务",
          updated_at: "2026-09-08T00:00:00Z",
        },
        {
          id: "t",
          thread_name: "过期标题",
          updated_at: "2026-09-06T00:00:00Z",
        },
      ]) + "bad line\n",
    );
    let issues = 0;
    await i.scan((p) => {
      issues = p.issues;
    });
    assert.equal(issues, 1);
    assert.equal(q.detail("t")!.thread.title, "真实分析任务");
    assert.equal(q.threads({}, 1, 0, "tokens", undefined, "分析").total, 1);
    assert.equal(
      q.threads({}, 1, 1, "tokens", undefined, "分析").items.length,
      0,
    );
    assert.equal(
      q.threads({}, 20, 0, "tokens", undefined, "not present").total,
      0,
    );
    await rename(index, index + ".saved");
    await i.scan(() => {});
    assert.equal(q.detail("t")!.thread.title, "真实分析任务");
    await writeFile(
      index,
      lines([
        { id: "t", thread_name: "新名称", updated_at: "2026-09-09T00:00:00Z" },
      ]),
    );
    await i.scan(() => {});
    assert.equal(q.detail("t")!.thread.title, "新名称");
    assert.equal(q.summary().totalTokens, "10");
  }));

test("global turns preserve session identity, unknown turns, filtered composition and exact costs", async () =>
  fixture(async (s, i, d, q) => {
    const event = (
      thread: string,
      turn: string | null,
      response: string,
      model: string,
      input: number,
      cached: number,
      output: number,
      write: number | null,
      at: string,
    ) => [
      { ...context(), payload: { ...context().payload, model, turn_id: turn } },
      {
        type: "token_usage_record",
        timestamp: at,
        payload: {
          thread_id: thread,
          turn_id: turn,
          response_id: response,
          usage: {
            input_tokens: input,
            cached_input_tokens: cached,
            cache_write_input_tokens: write,
            output_tokens: output,
            reasoning_output_tokens: 0,
            total_tokens: input + output,
          },
        },
      },
    ];
    await writeFile(
      path.join(d, "sessions", "a.jsonl"),
      lines([
        meta(),
        ...event(
          "t",
          "same",
          "a",
          "gpt-6-astra",
          1000,
          800,
          100,
          50,
          "2026-09-08T04:00:00Z",
        ),
        ...event(
          "t",
          "same",
          "b",
          "gpt-5.6-sol",
          2000,
          1000,
          200,
          0,
          "2026-09-08T05:00:00Z",
        ),
        ...event(
          "t",
          null,
          "c",
          "gpt-6-astra",
          100,
          80,
          10,
          null,
          "2026-09-08T06:00:00Z",
        ),
      ]),
    );
    await writeFile(
      path.join(d, "sessions", "b.jsonl"),
      lines([
        meta("other"),
        ...event(
          "other",
          "same",
          "d",
          "gpt-6-astra",
          300000,
          290000,
          100,
          1000,
          "2026-09-08T04:30:00Z",
        ),
      ]),
    );
    await i.scan(() => {});
    s.saveSettings({
      ...s.settings(),
      costEnabled: true,
      officialApiPricing: true,
      modelPrices: officialPrices,
    });
    // This case isolates the pre-existing API arithmetic from legacy parsing;
    // native tier extraction is exercised through the streaming collector tests.
    s.run("UPDATE usage_events SET service_tier='standard',service_tier_source='record'");
    const all = q.allTurns({}, 20, 0);
    assert.equal(all.total, 3);
    assert.equal(q.summary().turnCount, 2);
    const same = all.items.find((r) => r.threadId === "t" && r.id === "same")!;
    assert.equal(same.composition.length, 2);
    assert.equal(same.uncachedInputTokens, "1200");
    assert.equal(same.ordinaryInputTokens, "1150");
    assert.equal(same.cost!.amount, "0.016325000000");
    assert.equal(same.cost!.complete, true);
    const large = all.items.find((r) => r.threadId === "other")!;
    assert.equal(large.cost!.amount, "0.792500000000");
    const missing = all.items.find((r) => r.id === null)!;
    assert.equal(missing.cacheWriteInputTokens, null);
    assert.equal(missing.cost!.complete, false);
    assert.ok(missing.cost!.notes.some((n) => n.includes("写入")));
    const f = { threadId: "t", to: "2026-09-08T05:00:00Z" };
    assert.equal(q.summary(f).totalTokens, "1100");
    assert.equal(q.turns("t", f, 20, 0).items[0].composition.length, 1);
    assert.equal(
      q.turns("t", f, 20, 0).items[0].cost!.amount,
      q.summary(f).cost!.amount,
    );
    assert.equal(
      q.groups(f, "model")[0].cost!.amount,
      q.summary(f).cost!.amount,
    );
    assert.equal(q.trend(f, "day")[0].cost!.amount, q.summary(f).cost!.amount);
    assert.equal(q.allTurns({}, 1, 0, "tokens", "other").total, 1);
    assert.equal(q.allTurns({}, 1, 0, "tokens", "same").total, 2);
  }));

test("day selection respects DST, current cutoff and half-open intervals", () => {
  const spring = bucketRange(
    "2026-03-08",
    "day",
    "America/New_York",
    "2026-03-01T00:00:00Z",
    "2026-03-20T00:00:00Z",
  )!;
  assert.equal(Date.parse(spring.to) - Date.parse(spring.from), 23 * 3600000);
  assert.equal(
    bucketTimes(spring.from, spring.to, "America/New_York", "hour").length,
    23,
  );
  const fall = bucketRange(
    "2026-11-01",
    "day",
    "America/New_York",
    "2026-11-01T00:00:00Z",
    "2026-11-03T00:00:00Z",
  )!;
  assert.equal(Date.parse(fall.to) - Date.parse(fall.from), 25 * 3600000);
  assert.equal(
    new Set(bucketTimes(fall.from, fall.to, "America/New_York", "hour")).size,
    25,
  );
  const today = bucketRange(
    "2026-09-08",
    "day",
    "America/New_York",
    "2026-09-02T04:00:00Z",
    "2026-09-08T14:32:00Z",
  )!;
  assert.equal(today.from, "2026-09-08T04:00:00.000Z");
  assert.equal(today.to, "2026-09-08T14:32:00.000Z");
});

test("future cache-write usage details and manual price overrides remain explicit", async () =>
  fixture(async (s, i, d, q) => {
    await writeFile(
      path.join(d, "sessions", "a.jsonl"),
      lines([
        meta(),
        {
          ...context(),
          payload: { ...context().payload, model: "gpt-6-astra" },
        },
        {
          ...record("future", 1000),
          payload: {
            ...record("future", 1000).payload,
            usage: {
              input_tokens: 1000,
              input_tokens_details: {
                cached_tokens: 800,
                cache_write_tokens: 50,
              },
              output_tokens: 100,
              output_tokens_details: { reasoning_tokens: 20 },
              total_tokens: 1100,
            },
          },
        },
      ]),
    );
    await i.scan(() => {});
    assert.equal(q.summary().cacheWriteInputTokens, "50");
    assert.equal(q.summary().ordinaryInputTokens, "150");
    assert.equal(q.summary().reasoningOutputTokens, "20");
    s.saveSettings({
      ...s.settings(),
      costEnabled: true,
      officialApiPricing: true,
      modelPrices: officialPrices.map((p) =>
        p.model === "gpt-6-astra" ? { ...p, input: "20" } : p,
      ),
    });
    s.run("UPDATE usage_events SET service_tier='standard',service_tier_source='record'");
    assert.equal(q.summary().cost!.amount, "0.009425000000");
    s.saveSettings({ ...s.settings(), modelPrices: [] });
    assert.equal(q.summary().cost!.amount, null);
    assert.equal(q.summary().cost!.complete, false);
    s.saveSettings({ ...s.settings(), costEnabled: false });
    assert.equal(q.summary().cost, null);
    assert.equal(q.summary().totalTokens, "1100");
  }));
