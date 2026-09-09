import { createReadStream } from "node:fs";
import { readdir, stat, open } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import type { Store } from "./db.js";
import { integer, json, parseJson, projectPath, yieldLoop } from "./util.js";

import { tokenFields } from "../shared/query-values.js";
export { tokenFields } from "../shared/query-values.js";
type Tokens = Record<(typeof tokenFields)[number], bigint | null>;
type State = {
  metadataVersion?: number;
  thread: string;
  turn: string | null;
  project: string | null;
  model: string | null;
  effort: string | null;
  high: Record<string, string> | null;
  signatures: Record<string, string>;
  previous: string | null;
  parent: string | null;
  inherited: boolean;
  line: number;
  issues: number;
  cutoff: string | null;
  deferred?: boolean;
};
type ThreadMetadata = {
  project: string | null;
  source: string | null;
  parent: string | null;
  subagentParent: string | null;
  forkedFrom: string | null;
};
const metadataVersion = 1;
type Event = Tokens & {
  event_key: string;
  thread_id: string;
  turn_id: string | null;
  response_id: string | null;
  at: string;
  project: string | null;
  model: string | null;
  effort: string | null;
  kind: string;
  signature: string | null;
  incomplete: number;
  excluded: number;
};
const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
const tokens = (x: any): Tokens =>
  Object.fromEntries(
    tokenFields.map((k) => [
      k,
      integer(
        x?.[k] ??
          (k === "cached_input_tokens"
            ? x?.input_tokens_details?.cached_tokens
            : k === "cache_write_input_tokens"
              ? (x?.input_tokens_details?.cache_write_tokens ??
                x?.cache_write_tokens)
              : k === "reasoning_output_tokens"
                ? x?.output_tokens_details?.reasoning_tokens
                : undefined),
      ),
    ]),
  ) as Tokens;
const iso = (x: unknown) =>
  typeof x === "string" && Number.isFinite(Date.parse(x))
    ? new Date(x).toISOString()
    : null;

async function discover(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e: any) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory())
      result.push(...(await discover(path.join(dir, entry.name))));
    else if (entry.isFile() && entry.name.endsWith(".jsonl"))
      result.push(path.join(dir, entry.name));
  }
  return result.sort();
}

export class Importer {
  stopped = false;
  constructor(
    private store: Store,
    private root: string,
  ) {}
  async scan(
    progress: (p: {
      filesScanned: number;
      filesChanged: number;
      events: number;
      issues: number;
    }) => void,
  ) {
    const files = [
      ...(await discover(path.join(this.root, "sessions"))),
      ...(await discover(path.join(this.root, "archived_sessions"))),
    ];
    let filesScanned = 0,
      filesChanged = 0;
    for (const file of files) {
      if (this.stopped) break;
      filesChanged += (await this.importFile(file)) ? 1 : 0;
      filesScanned++;
      progress({ filesScanned, filesChanged, events: 0, issues: 0 });
      await yieldLoop();
    }
    // A parent may have been encountered later, especially in archived_sessions.
    for (const row of this.store.all("SELECT path,state FROM source_files")) {
      if (this.stopped) break;
      const state = JSON.parse(row.state) as State;
      if (
        state.deferred &&
        state.parent &&
        this.store.one("SELECT 1 FROM threads WHERE id=?", [state.parent]) &&
        files.includes(row.path)
      )
        await this.importFile(row.path);
    }
    const titleIssues = await this.syncTitles();
    const issues =
      titleIssues +
      Number(
        this.store.one("SELECT COALESCE(SUM(issues),0) n FROM source_files")!.n,
      );
    const events = Number(
      this.store.one("SELECT COUNT(*) n FROM effective_events")!.n,
    );
    progress({ filesScanned, filesChanged, events, issues });
  }
  async syncTitles(): Promise<number> {
    const latest = new Map<string, { title: string; at: string }>();
    let issues = 0;
    try {
      const stream = createReadStream(
        path.join(this.root, "session_index.jsonl"),
        { encoding: "utf8" },
      );
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          const at = iso(row.updated_at);
          if (
            typeof row.id !== "string" ||
            !row.id ||
            typeof row.thread_name !== "string" ||
            !row.thread_name.trim() ||
            !at
          ) {
            issues++;
            continue;
          }
          if (!latest.has(row.id) || latest.get(row.id)!.at <= at)
            latest.set(row.id, { title: row.thread_name.trim(), at });
        } catch {
          issues++;
        }
      }
    } catch (error: any) {
      return error.code === "ENOENT" ? 0 : 1;
    }
    this.store.transaction(() => {
      for (const [id, row] of latest)
        this.store.run(
          "UPDATE threads SET title=?,title_updated_at=? WHERE id=? AND (title_updated_at IS NULL OR title_updated_at<=?)",
          [row.title, row.at, id, row.at],
        );
    });
    return issues;
  }
  async importFile(file: string): Promise<boolean> {
    const info = await stat(file);
    const saved = this.store.one("SELECT * FROM source_files WHERE path=?", [
      file,
    ]);
    const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    const savedState = saved ? (JSON.parse(saved.state) as State) : null;
    // Re-read old files once, including unchanged logs, to recover typed edges.
    const needsMetadata = savedState?.metadataVersion !== metadataVersion;
    const retryParent =
      !!savedState?.deferred &&
      !!savedState.parent &&
      !!this.store.one("SELECT 1 FROM threads WHERE id=?", [savedState.parent]);
    if (
      !retryParent &&
      !needsMetadata &&
      saved &&
      saved.identity === identity &&
      Number(saved.size) === info.size &&
      saved.mtime === info.mtimeMs
    )
      return false;
    const handle = await open(file, "r");
    let prefix: Buffer;
    try {
      // Compare the same prefix length even when a previously short file grows.
      const bytes = Buffer.alloc(
        Math.min(saved ? Number(saved.offset) : info.size, 4096),
      );
      const r = await handle.read(bytes, 0, bytes.length, 0);
      prefix = bytes.subarray(0, r.bytesRead);
    } finally {
      await handle.close();
    }
    let append =
      !retryParent &&
      !needsMetadata &&
      !!saved &&
      saved.identity === identity &&
      info.size > Number(saved.size) &&
      hash(prefix) === saved.fingerprint;
    let state: State = append
      ? JSON.parse(saved!.state)
      : {
          metadataVersion,
          thread:
            path
              .basename(file)
              .match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i)?.[0] ||
            hash(file),
          turn: null,
          project: null,
          model: null,
          effort: null,
          high: null,
          signatures: {},
          previous: null,
          parent: null,
          inherited: false,
          line: 0,
          issues: 0,
          cutoff: null,
        };
    const events: Event[] = [];
    const threads = new Map<
      string,
      ThreadMetadata
    >();
    let offset = append ? Number(saved!.offset) : 0;
    let pending = Buffer.alloc(0);
    const startOffset = offset;
    if (info.size > startOffset) {
      // Freeze EOF at stat time. Concurrent appends are picked up on the next scan.
      for await (const chunk of createReadStream(file, {
        start: startOffset,
        end: info.size - 1,
        highWaterMark: 128 * 1024,
      })) {
        if (this.stopped) return false;
        pending = Buffer.concat([pending, chunk as Buffer]);
        let newline;
        while ((newline = pending.indexOf(10)) >= 0) {
          const line = pending.subarray(0, newline).toString("utf8");
          offset += newline + 1;
          pending = pending.subarray(newline + 1);
          state.line++;
          try {
            this.consume(parseJson(line), state, events, threads);
          } catch {
            state.issues++;
          }
        }
        await yieldLoop();
      }
    }
    // Fingerprint exactly the consumed prefix, not the unfinished tail.
    const h = await open(file, "r");
    let fingerprint: string;
    try {
      const b = Buffer.alloc(Math.min(offset, 4096));
      const r = await h.read(b, 0, b.length, 0);
      fingerprint = hash(b.subarray(0, r.bytesRead));
    } finally {
      await h.close();
    }
    this.store.transaction(() => {
      const affected = new Set(events.map((e) => e.thread_id));
      if (!append)
        for (const row of this.store.all(
          "SELECT DISTINCT thread_id FROM usage_events WHERE file=?",
          [file],
        ))
          affected.add(row.thread_id);
      if (!append)
        this.store.run("DELETE FROM usage_events WHERE file=?", [file]);
      const insert = this.store.db.prepare(`INSERT OR REPLACE INTO usage_events
        (file,event_key,thread_id,turn_id,response_id,at,project,model,effort,kind,signature,${tokenFields.join(",")},incomplete,excluded)
        VALUES(${Array(19).fill("?").join(",")})`);
      for (const e of events)
        insert.run(
          file,
          e.event_key,
          e.thread_id,
          e.turn_id,
          e.response_id,
          e.at,
          e.project,
          e.model,
          e.effort,
          e.kind,
          e.signature,
          ...tokenFields.map((k) => e[k]),
          e.incomplete,
          e.excluded,
        );
      for (const [id, t] of threads)
        this.store.run(
          `INSERT INTO threads(id,project,source,parent_id,subagent_parent_id,forked_from_id) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        project=COALESCE(excluded.project,threads.project),source=COALESCE(excluded.source,threads.source),parent_id=excluded.parent_id,
        subagent_parent_id=excluded.subagent_parent_id,forked_from_id=excluded.forked_from_id`,
          [id, t.project, t.source, t.parent, t.subagentParent, t.forkedFrom],
        );
      this.store.reconcile([...affected]);
      this.store.run(
        `INSERT OR REPLACE INTO source_files VALUES(?,?,?,?,?,?,?,?,?)`,
        [
          file,
          identity,
          info.size,
          info.mtimeMs,
          offset,
          fingerprint!,
          json(state),
          state.issues,
          new Date().toISOString(),
        ],
      );
    });
    return true;
  }
  private consume(
    obj: any,
    s: State,
    events: Event[],
    threads: Map<
      string,
      ThreadMetadata
    >,
  ) {
    const p = obj?.payload;
    if (!p || typeof p !== "object") return;
    if (obj.type === "session_meta") {
      const id = p.id || p.session_id;
      if (typeof id === "string") {
        if (id !== s.thread) {
          s.high = null;
          s.previous = null;
          s.signatures = {};
          s.turn = null;
        }
        s.thread = id;
      }
      s.project = projectPath(p.cwd);
      const nonempty = (value: unknown) =>
        typeof value === "string" && value.trim() ? value : null;
      const subagentParent = nonempty(p.source?.subagent?.thread_spawn?.parent_thread_id);
      const forkedFrom = nonempty(p.forked_from_id);
      // Preserve the existing inheritance baseline; team membership uses its own edge.
      s.parent = forkedFrom || subagentParent;
      s.inherited = !!s.parent;
      s.cutoff = iso(p.timestamp || obj.timestamp);
      threads.set(s.thread, {
        project: s.project,
        source:
          typeof p.source === "string" ? p.source : p.thread_source || null,
        parent: s.parent,
        subagentParent,
        forkedFrom,
      });
      return;
    }
    if (obj.type === "turn_context") {
      s.turn = typeof p.turn_id === "string" ? p.turn_id : null;
      s.model = typeof p.model === "string" ? p.model : null;
      s.effort = typeof p.effort === "string" ? p.effort : null;
      s.project = projectPath(p.cwd) || s.project;
      return;
    }
    const at = iso(obj.timestamp);
    if (obj.type === "token_usage_record") {
      if (!at) {
        s.issues++;
        return;
      }
      const t = tokens(p.usage);
      const thread = typeof p.thread_id === "string" ? p.thread_id : s.thread;
      const turn = typeof p.turn_id === "string" ? p.turn_id : s.turn;
      const response = typeof p.response_id === "string" ? p.response_id : null;
      if (t.total_tokens === null) {
        s.issues++;
        return;
      }
      events.push({
        ...t,
        event_key: response
          ? "response:" + response
          : "record:" + hash(json([thread, turn, at, t])),
        thread_id: thread,
        turn_id: turn,
        response_id: response,
        at,
        project: s.project,
        model: s.model,
        effort: s.effort,
        kind: "record",
        signature: null,
        incomplete: response ? 0 : 1,
        excluded: 0,
      });
      return;
    }
    if (obj.type !== "event_msg" || p.type !== "token_count" || !p.info) return;
    if (!at) {
      s.issues++;
      return;
    }
    const total = p.info.total_token_usage
      ? tokens(p.info.total_token_usage)
      : null;
    const last = p.info.last_token_usage
      ? tokens(p.info.last_token_usage)
      : null;
    if (!total && !last) return;
    const signature = json([total, last]);
    const source =
      typeof p.rate_limits?.limit_id === "string"
        ? p.rate_limits.limit_id
        : "default";
    const duplicate =
      !!total &&
      (s.signatures[source] === signature || s.previous === signature);
    if (total) s.signatures[source] = signature;
    s.previous = signature;
    let t = last,
      incomplete = 0;
    if (!t && total) {
      t = { ...total };
      for (const k of tokenFields) {
        const prev = s.high?.[k] !== undefined ? BigInt(s.high[k]) : 0n;
        if (total[k] !== null) {
          if (total[k]! < prev) {
            incomplete = 1;
            t[k] = 0n;
          } else t[k] = total[k]! - prev;
        }
      }
      // A baseline without a complete preceding history cannot establish the time attribution.
      if (!s.high && s.parent) incomplete = 1;
    }
    if (total) {
      s.high ??= {};
      for (const k of tokenFields)
        if (total[k] !== null)
          s.high[k] = (
            total[k]! > BigInt(s.high[k] || "0")
              ? total[k]
              : BigInt(s.high[k] || "0")
          )!.toString();
    }
    if (incomplete) s.issues++;
    if (duplicate || !t || t.total_tokens === 0n) return;
    let excluded = 0;
    if (s.inherited && s.parent) {
      const parentExists = this.store.one("SELECT 1 FROM threads WHERE id=?", [
        s.parent,
      ]);
      const match = this.store.one(
        "SELECT 1 FROM usage_events WHERE thread_id=? AND signature=? AND at<=? LIMIT 1",
        [s.parent, signature, s.cutoff || at],
      );
      if (match) excluded = 1;
      else if (parentExists) s.inherited = false;
      else {
        excluded = 1;
        incomplete = 1;
        s.deferred = true;
        s.issues++;
      }
    }
    if (t.total_tokens === null) {
      s.issues++;
      return;
    }
    events.push({
      ...t,
      event_key: "legacy:" + hash(json([s.thread, s.turn, at, signature])),
      thread_id: s.thread,
      turn_id: s.turn,
      response_id: null,
      at,
      project: s.project,
      model: s.model,
      effort: s.effort,
      kind: "legacy",
      signature,
      incomplete,
      excluded,
    });
  }
}
