import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Store } from "../server/db.js";
import { Importer } from "../server/importer.js";
import { Queries } from "../server/queries.js";
import { createApp } from "../server/app.js";
import { json } from "../server/util.js";

const at = "2026-09-08T04:01:00Z";
const meta = (id: string, parent?: string, fork?: string) => ({
  type: "session_meta", timestamp: at,
  payload: { id, cwd: "C:/test/project", forked_from_id: fork,
    source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : "cli" },
});
const context = (model = "model-a", effort = "high", cwd = "C:/test/project") => ({
  type: "turn_context", payload: { turn_id: "turn", model, effort, cwd },
});
const usage = (n: number | bigint) => ({ input_tokens: n, cached_input_tokens: 0,
  cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: n });
const record = (id: string, n: number | bigint, response: string | null = id, time = at) => ({
  type: "token_usage_record", timestamp: time,
  payload: { thread_id: id, turn_id: "turn", response_id: response, usage: usage(n) },
});
const legacy = (total: number, last: number) => ({
  type: "event_msg", timestamp: at, payload: { type: "token_count",
    info: { total_token_usage: usage(total), last_token_usage: usage(last) } },
});
async function fixture(fn: (s: Store, i: Importer, q: Queries, dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-agents-"));
  await mkdir(path.join(dir, "sessions"));
  await mkdir(path.join(dir, "archived_sessions"));
  const store = new Store(":memory:");
  try { await fn(store, new Importer(store, dir), new Queries(store), dir); }
  finally { store.close(); await rm(dir, { recursive: true, force: true }); }
}
async function log(dir: string, name: string, rows: unknown[], archive = false) {
  const file = path.join(dir, archive ? "archived_sessions" : "sessions", `${name}.jsonl`);
  await writeFile(file, rows.map(json).join("\n") + "\n");
  return file;
}

test("team totals include nested agents once, exclude forks, preserve bigint and typed links", async () => fixture(async (s, i, q, d) => {
  const large = 9007199254740993n;
  await log(d, "root", [meta("root"), context(), record("root", large)]);
  await log(d, "child", [meta("child", "root"), context(), record("child", 20)]);
  await log(d, "nested", [meta("nested", "child"), context(), record("nested", 30)]);
  await log(d, "sibling", [meta("sibling", "root"), context(), record("sibling", 40)]);
  await log(d, "fork", [meta("fork", undefined, "root"), context(), record("fork", 100)]);
  await log(d, "fork-child", [meta("fork-child", "fork"), context(), record("fork-child", 200)]);
  await log(d, "copy", [meta("child", "root"), context(), record("child", 20)], true);
  await i.scan(() => {});
  const team = q.agents("root")!;
  assert.equal(team.self.totalTokens, String(large));
  assert.equal(team.subagents.totalTokens, "90");
  assert.equal(team.team.totalTokens, String(large + 90n));
  assert.equal(team.team.turnCount, 4);
  assert.deepEqual(team.agents.map((a) => [a.id, a.depth]), [["root", 0], ["child", 1], ["nested", 2], ["sibling", 1]]);
  assert.equal(q.detail("root")!.thread.totalTokens, String(large));
  assert.equal(q.detail("root")!.related.find((r) => r.id === "fork")?.relation, "fork");
  assert.equal(q.detail("child")!.related.find((r) => r.id === "root")?.relation, "subagent_parent");
  await i.scan(() => {});
  assert.deepEqual(q.agents("root"), team);
}));

test("filters apply to events after traversal and preserve zero-usage nodes", async () => fixture(async (s, i, q, d) => {
  await log(d, "root", [meta("root"), context(), record("root", 10)]);
  await log(d, "child", [meta("child", "root"), context(), record("child", 20)]);
  await log(d, "nested", [meta("nested", "child"), context("model-b", "low", "C:/test/other"), record("nested", 30, "nested", "2026-09-09T04:01:00Z")]);
  await log(d, "empty", [meta("empty", "root")]);
  await i.scan(() => {});
  const result = q.agents("root", { model: "model-b", effort: "low", project: "c:\\test\\other", from: "2026-09-09T00:00:00Z", to: "2026-09-10T00:00:00Z", threadId: "root" })!;
  assert.equal(result.team.totalTokens, "30");
  assert.equal(result.self.totalTokens, "0");
  assert.equal(result.agents.length, 4);
  assert.equal(result.agents.find((a) => a.id === "child")!.usage.eventCount, 0);
  assert.deepEqual(result.agents.find((a) => a.id === "nested")!.models, ["model-b"]);
  assert.equal(q.detail("empty")!.thread.eventCount, 0);
  assert.equal(q.agents("root", { model: "absent" })!.team.eventCount, 0);
  assert.equal(q.agents("missing"), null);
}));

test("unknown parents, cycles and dual metadata do not infer or double-count membership", async () => fixture(async (s, i, q, d) => {
  await log(d, "a", [meta("a", "b"), context(), record("a", 10)]);
  await log(d, "b", [meta("b", "a"), context(), record("b", 20)]);
  await log(d, "orphan", [meta("orphan", "absent"), context(), record("orphan", 5)]);
  await log(d, "dual", [meta("dual", "a", "orphan"), context(), record("dual", 30)]);
  await i.scan(() => {});
  s.run("INSERT INTO threads(id,parent_id) VALUES('unknown','a')");
  assert.equal(q.agents("a")!.team.totalTokens, "60");
  assert.equal(q.agents("a")!.agents.length, 3);
  assert.equal(q.agents("orphan")!.team.totalTokens, "5");
  assert.equal(q.agents("orphan")!.agents[0].parentId, "absent");
  assert.equal(q.detail("a")!.related.find((r) => r.id === "unknown")!.relation, "unknown");
  assert.equal(q.detail("dual")!.related.find((r) => r.id === "orphan")!.relation, "fork_parent");
}));

test("legacy inherited prefix is excluded when parent arrives later in archives", async () => fixture(async (s, i, q, d) => {
  await log(d, "child", [meta("child", "parent"), context(), legacy(10, 10), legacy(15, 5)]);
  await log(d, "parent", [meta("parent"), context(), legacy(10, 10)], true);
  await i.scan(() => {});
  assert.equal(q.agents("parent")!.self.totalTokens, "10");
  assert.equal(q.agents("parent")!.subagents.totalTokens, "5");
  assert.equal(q.agents("parent")!.team.totalTokens, "15");
}));

test("cost and incomplete metrics retain existing aggregation semantics", async () => fixture(async (s, i, q, d) => {
  s.saveSettings({ ...s.settings(), costEnabled: true, modelPrices: [{ model: "model-a", input: "1", cachedInput: "0", cacheWrite: "0", output: "2", longContextThreshold: null, longInput: null, longCachedInput: null, longCacheWrite: null, longOutput: null }] });
  await log(d, "root", [meta("root"), context(), record("root", 1000000)]);
  await log(d, "child", [meta("child", "root"), context(), record("child", 2000000, null)]);
  await i.scan(() => {});
  const result = q.agents("root")!;
  assert.equal(Number(result.team.cost!.amount), 3);
  assert.equal(Number(result.self.cost!.amount), 1);
  assert.equal(Number(result.subagents.cost!.amount), 2);
  assert.equal(result.team.incompleteEvents, 1);
  assert.deepEqual(result.team, q.summary());
}));

test("database migration reparses unchanged old source state once without modifying logs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-agent-migration-"));
  await mkdir(path.join(dir, "sessions"));
  const filename = path.join(dir, "usage.sqlite");
  let store = new Store(filename);
  try {
    const file = await log(dir, "child", [meta("child", "root"), context(), record("child", 10)]);
    await log(dir, "root", [meta("root"), context(), record("root", 20)]);
    const original = await readFile(file);
    const before = await stat(file);
    await new Importer(store, dir).scan(() => {});
    store.db.exec("DROP INDEX threads_subagent_parent; ALTER TABLE threads DROP COLUMN subagent_parent_id; ALTER TABLE threads DROP COLUMN forked_from_id;");
    for (const row of store.all("SELECT path,state FROM source_files")) {
      const state = JSON.parse(row.state); delete state.metadataVersion;
      store.run("UPDATE source_files SET state=? WHERE path=?", [JSON.stringify(state), row.path]);
    }
    store.close(); store = new Store(filename);
    const importer = new Importer(store, dir);
    assert.equal(await importer.importFile(file), true);
    assert.equal(store.one("SELECT subagent_parent_id FROM threads WHERE id='child'")!.subagent_parent_id, "root");
    await importer.scan(() => {});
    assert.equal(new Queries(store).agents("root")!.team.totalTokens, "30");
    assert.equal(await importer.importFile(file), false);
    assert.deepEqual(await readFile(file), original);
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("agents API validates ranges, serializes exact metrics, supports empty sessions and 404", async () => {
  const a = await createApp({ database: ":memory:", startup: false });
  try {
    a.store.run("INSERT INTO threads(id,subagent_parent_id,title) VALUES('root',NULL,'Main'),('child','root','Child')");
    const response = await a.app.inject("/api/local/threads/root/agents");
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.data.team.totalTokens, "0");
    assert.equal(body.data.agents.length, 2);
    assert.ok(body.meta.warnings.length);
    a.store.run(`INSERT INTO usage_events(file,event_key,thread_id,at,kind,active,total_tokens)
      VALUES('test','response:large','root','2026-09-08T04:00:00Z','record',1,9007199254740993)`);
    const large = (await a.app.inject("/api/local/threads/root/agents")).json().data;
    assert.equal(large.self.totalTokens, "9007199254740993");
    assert.equal(large.team.totalTokens, "9007199254740993");
    assert.equal(large.team.inputTokens, null);
    assert.equal((await a.app.inject("/api/local/threads/child")).statusCode, 200);
    assert.equal((await a.app.inject("/api/local/threads/missing/agents")).statusCode, 404);
    assert.equal((await a.app.inject("/api/local/threads/root/agents?from=2026-09-09T00:00:00Z&to=2026-09-08T00:00:00Z")).statusCode, 400);
    assert.equal((await a.app.inject("/api/local/threads/root/agents?model=a&unknown=model")).statusCode, 400);
  } finally { await a.app.close(); }
});
