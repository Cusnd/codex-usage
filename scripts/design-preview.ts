// Deterministic design dataset: isolated in-memory database, no account or user files.
// Run with: npx tsx scripts/design-preview.ts
import { createApp } from "../server/app.js";
import { type AccountSource } from "../server/account.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

class ExampleAccount implements AccountSource {
  async selection() { return { identity: { key: "example", accountId: "example" }, confirmed: true }; }
  async readUsage() {
    return { data: { accountId: "example", summary: { lifetimeTokens: null, peakDailyTokens: null,
      longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: null },
      identity: { key: "example", accountId: "example" }, provider: "app-server" as const, fallbackReason: null };
  }
  async readLimits() { return { data: { accountId: "example", buckets: [] },
    identity: { key: "example", accountId: "example" }, provider: "app-server" as const, fallbackReason: null }; }
  close() {}
}
const emptyHome = await mkdtemp(path.join(tmpdir(), "codex-atlas-design-"));
const { app, store, queries } = await createApp({
  database: ":memory:",
  codexHome: emptyHome,
  startup: false,
  accountReader: new ExampleAccount(),
  exampleData: true,
});
store.saveSettings({
  ...store.settings(),
  timezone: "America/New_York",
  timezoneMode: "manual",
  localInterval: 0,
  accountInterval: 0,
  costEnabled: false,
});
const projectNames = [
  "codex-usage",
  "demo-api",
  "sample-notes",
  "playground",
];
const projects = projectNames.map((name) => `c:\\design\\${name}`);
const projectTotals = [48_600_000, 35_200_000, 21_410_000, 14_000_000];
const daily = [
  8_200_000, 12_500_000, 18_400_000, 31_400_000, 16_200_000, 14_010_000,
  18_500_000,
];
const capacity = [...daily];
let eventIndex = 0,
  sessionIndex = 0,
  turnIndex = 0;
function emit(
  thread: string,
  turn: string,
  project: string,
  model: string,
  total: number,
  output: number,
  day: number,
  minute = 0,
) {
  const input = total - output,
    cached = Math.floor(input * 0.95);
  const at = `2026-09-${String(day + 2).padStart(2, "0")}T${String(5 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`;
  store.run(
    `INSERT INTO usage_events(file,event_key,thread_id,turn_id,response_id,at,project,model,effort,kind,signature,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,incomplete,excluded,active) VALUES(?,?,?,?,?,?,?,?,?,'record',NULL,?,?,0,?,?,?,0,0,1)`,
    [
      "example",
      `event-${eventIndex}`,
      thread,
      turn,
      `response-${eventIndex++}`,
      at,
      project,
      model,
      model === "gpt-6-astra" ? "high" : "medium",
      input,
      cached,
      output,
      Math.floor(output / 5),
      total,
    ],
  );
  capacity[day] -= total;
}
store.transaction(() => {
  for (let project = 0; project < 4; project++) {
    const count = project === 0 ? 4 : 8;
    const totals =
      project === 0
        ? [18_200_000, 12_600_000, 8_400_000, 9_400_000]
        : Array.from(
            { length: count },
            (_, index) =>
              Math.floor(projectTotals[project] / count) +
              (index === count - 1 ? projectTotals[project] % count : 0),
          );
    for (let local = 0; local < count; local++) {
      const id = `example-session-${String(++sessionIndex).padStart(2, "0")}`;
      const title =
        project === 0
          ? [
              "用量分析界面设计",
              "本地记录导入",
              "统计查询与 API",
              "筛选与统计口径校验",
            ][local]
          : `${["", "接口与文档", "学习笔记", "示例项目"][project]} · ${local + 1}`;
      store.run(
        "INSERT INTO threads(id,project,title,title_updated_at) VALUES(?,?,?,?)",
        [id, projects[project], title, "2026-09-08T04:00:00Z"],
      );
      if (sessionIndex === 1) {
        const totals = [
          3_600_000, 2_800_000, 4_200_000, 3_100_000, 2_500_000, 2_000_000,
        ];
        const outputs = [60_000, 60_000, 80_000, 80_000, 60_000, 60_000];
        totals.forEach((total, index) => {
          const turn = `turn-${String(index + 1).padStart(2, "0")}`;
          turnIndex++;
          if (index === 2) {
            emit(
              id,
              turn,
              projects[project],
              "gpt-6-astra",
              3_200_000,
              60_000,
              6,
              index * 18,
            );
            emit(
              id,
              turn,
              projects[project],
              "gpt-5.6-sol",
              1_000_000,
              20_000,
              6,
              index * 18 + 1,
            );
          } else
            emit(
              id,
              turn,
              projects[project],
              index < 4 ? "gpt-6-astra" : "gpt-5.6-sol",
              total,
              outputs[index],
              6,
              index * 18,
            );
        });
      } else {
        const turns = sessionIndex <= 6 ? 4 : 3;
        for (let t = 0; t < turns; t++) {
          const turn = `turn-${String(t + 1).padStart(2, "0")}`;
          turnIndex++;
          let remaining =
            Math.floor(totals[local] / turns) +
            (t === turns - 1 ? totals[local] % turns : 0);
          for (let day = 0; day < capacity.length && remaining > 0; day++) {
            const amount = Math.min(remaining, capacity[day]);
            if (amount <= 0) continue;
            emit(
              id,
              turn,
              projects[project],
              sessionIndex % 4 === 0 ? "gpt-5.6-sol" : "gpt-6-astra",
              amount,
              Math.floor(amount / 150),
              day,
              (eventIndex * 13) % 180,
            );
            remaining -= amount;
          }
          assert.equal(remaining, 0);
        }
      }
    }
  }
});
assert.equal(queries.summary().totalTokens, "119210000");
assert.equal(queries.summary().threadCount, 28);
assert.equal(queries.summary().turnCount, 92);
assert.equal(
  queries.summary({ threadId: "example-session-01" }).inputTokens,
  "17800000",
);
assert.equal(
  queries.summary({ threadId: "example-session-01" }).outputTokens,
  "400000",
);
assert.deepEqual(
  queries.trend({}, "day").map((r) => Number(r.totalTokens)),
  daily,
);
const previewPort = Number(process.env.CODEX_USAGE_PREVIEW_PORT || 8766);
await app.listen({ host: "127.0.0.1", port: previewPort });
console.log(
  `Design dataset verified: 119.21M / 28 Sessions / 92 Turns. Preview: http://127.0.0.1:${previewPort}/analysis?range=custom&from=2026-09-02T04:00:00Z&to=2026-09-09T04:00:00Z`,
);
const close = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
