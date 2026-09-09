// Deterministic design dataset: isolated in-memory database, no account or user files.
// Run with: npx tsx scripts/design-preview.ts
import { createApp } from "../server/app.js";
import { ExampleAccount } from "../showcase/account.js";
import { seedExample } from "../showcase/fixture.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const emptyHome = await mkdtemp(path.join(tmpdir(), "codex-atlas-design-"));
const { app, store, queries } = await createApp({
  database: ":memory:",
  codexHome: emptyHome,
  startup: false,
  accountReader: new ExampleAccount(process.env.CODEX_USAGE_PREVIEW_ACCOUNT === "1"),
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
seedExample(store);
const team = queries.agents("example-session-01")!;
assert.equal(team.self.totalTokens, "18200000");
assert.equal(team.subagents.totalTokens, "30400000");
assert.equal(team.team.totalTokens, "48600000");
assert.equal(
  BigInt(team.team.totalTokens),
  BigInt(team.self.totalTokens) + BigInt(team.subagents.totalTokens),
);
assert.deepEqual(
  team.agents.map(({ depth }) => depth),
  [0, 1, 2, 1],
);
assert.equal(
  team.agents.reduce((sum, agent) => sum + BigInt(agent.usage.totalTokens), 0n),
  BigInt(team.team.totalTokens),
);
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
  [8200000, 12500000, 18400000, 31400000, 16200000, 14010000, 18500000],
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
