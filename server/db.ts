import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import type { Settings } from "../shared/contracts.js";
import { json } from "./util.js";
import { officialPrices } from "./pricing.js";
import { tokenFields } from '../shared/query-values.js';

export class Store {
  db: DatabaseSync;
  private transactionDepth = 0;
  private prepared = new Map<string,StatementSync>();
  private cacheReady = false;
  constructor(filename: string) {
    if (filename !== ":memory:")
      mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    const schema=this.db.prepare('PRAGMA user_version').get()!.user_version;
    if(schema!==3&&this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get()) {
      this.db.close();
      throw Object.assign(new Error('本地数据库版本不匹配。请使用空的数据目录，并从 Codex 原始日志重新采集。'), {code:'LOCAL_SCHEMA_MISMATCH'});
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_files (
        path TEXT PRIMARY KEY, identity TEXT NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL,
        offset INTEGER NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, issues INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, project TEXT, source TEXT, parent_id TEXT, subagent_parent_id TEXT, forked_from_id TEXT, title TEXT, title_updated_at TEXT);
      CREATE TABLE IF NOT EXISTS usage_events (
        file TEXT NOT NULL, event_key TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT, response_id TEXT,
        at TEXT NOT NULL, project TEXT, model TEXT, effort TEXT, kind TEXT NOT NULL, signature TEXT,
        input_tokens TEXT, cached_input_tokens TEXT, cache_write_input_tokens TEXT,
        output_tokens TEXT, reasoning_output_tokens TEXT, total_tokens TEXT,
        incomplete INTEGER NOT NULL DEFAULT 0, excluded INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 0,
        service_tier TEXT, service_tier_source TEXT,
        PRIMARY KEY(file,event_key)
      );
      CREATE INDEX IF NOT EXISTS events_identity ON usage_events(event_key);
      CREATE INDEX IF NOT EXISTS events_turn ON usage_events(thread_id,turn_id,kind);
      CREATE INDEX IF NOT EXISTS events_time ON usage_events(at);
      CREATE INDEX IF NOT EXISTS events_thread_time ON usage_events(thread_id,at);
      CREATE INDEX IF NOT EXISTS events_model_time ON usage_events(model,at);
      CREATE INDEX IF NOT EXISTS events_project_time ON usage_events(project,at);
      CREATE TABLE IF NOT EXISTS account_snapshots (
        id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL,
        at TEXT NOT NULL, data TEXT NOT NULL, identity_key TEXT, provider TEXT, fallback_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS snapshots_latest ON account_snapshots(account_id,kind,id DESC);
    `);
    this.db.exec(`PRAGMA user_version=3;
      CREATE INDEX IF NOT EXISTS threads_subagent_parent ON threads(subagent_parent_id);
      CREATE INDEX IF NOT EXISTS snapshots_identity ON account_snapshots(identity_key,kind,id DESC);
      CREATE VIEW IF NOT EXISTS effective_events AS SELECT * FROM usage_events WHERE active=1;
      CREATE INDEX IF NOT EXISTS active_time ON usage_events(at) WHERE active=1;
      CREATE INDEX IF NOT EXISTS active_thread ON usage_events(thread_id,at) WHERE active=1;
    `);
    this.db.prepare("INSERT OR IGNORE INTO settings VALUES(1,?)").run(
      json({
        localInterval: 60,
        accountInterval: 300,
        timezone: "America/New_York",
        timezoneMode: "manual",
      }),
    );
    // Filtering uses indexed UTC timestamps. Only the selected rows need local-time bucketing.
    this.db.function("local_bucket", (at, zone, bucket) => {
      const d = DateTime.fromISO(String(at), { zone: "utc" }).setZone(
        String(zone),
      );
      return bucket === "hour" ? d.startOf("hour").toISO()! : d.toISODate()!;
    });
    this.cacheReady = true;
  }
  /** Bound prepared statements only; query results and parameters are never cached. */
  private statement(sql:string,read:boolean):StatementSync {
    const key=(read?'read:':'write:')+sql,existing=this.cacheReady?this.prepared.get(key):undefined;
    if(existing){this.prepared.delete(key);this.prepared.set(key,existing);return existing;}
    const statement=this.db.prepare(sql);if(read)statement.setReadBigInts(true);
    if(this.cacheReady){this.prepared.set(key,statement);if(this.prepared.size>256)this.prepared.delete(this.prepared.keys().next().value!);}
    return statement;
  }
  all<T = Record<string, any>>(sql: string, params: SQLInputValue[] = []): T[] {
    return this.statement(sql,true).all(...params) as T[];
  }
  one<T = Record<string, any>>(
    sql: string,
    params: SQLInputValue[] = [],
  ): T | undefined {
    return this.statement(sql,true).get(...params) as T|undefined;
  }
  run(sql: string, params: SQLInputValue[] = []) {
    // node:sqlite binds Number as DOUBLE; TEXT affinity would otherwise store a safe integer as "123.0".
    // Only already-safe integer Numbers may be converted. Unsafe values are never reconstructed this way.
    return this.statement(sql,false).run(...params.map(value => typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : value));
  }
  transaction(fn: () => void) {
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth++;
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally { this.transactionDepth--; }
  }
  /** Every safety probe, SQL aggregate and fallback page sees the same local database snapshot. */
  readSnapshot<T>(fn: () => T): T {
    if (this.transactionDepth) return fn();
    this.db.exec('BEGIN'); this.transactionDepth++;
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.transactionDepth--; }
  }
  settings(): Settings {
    const stored = JSON.parse(
      this.one("SELECT value FROM settings WHERE id=1")!.value,
    );
    return {
      ...stored,
      costEnabled: stored.costEnabled ?? false,
      officialApiPricing: stored.officialApiPricing ?? false,
      modelPrices: stored.modelPrices ?? officialPrices,
      timezoneMode: stored.timezoneMode || "manual",
      timezone:
        stored.timezoneMode === "system"
          ? Intl.DateTimeFormat().resolvedOptions().timeZone
          : stored.timezone,
    };
  }
  saveSettings(settings: Settings) {
    this.run("UPDATE settings SET value=? WHERE id=1", [json(settings)]);
  }
  reconcile(threads?: string[]) {
    if (threads?.length === 0) return;
    const where = threads
      ? "WHERE thread_id IN (" + threads.map(() => "?").join(",") + ")"
      : "";
    const params = threads || [];
    this.run(`UPDATE usage_events SET active=0 ${where}`, params);
    this.run(
      `UPDATE usage_events SET active=1 WHERE rowid IN (
      SELECT event_rowid FROM (
        SELECT e.rowid event_rowid,ROW_NUMBER() OVER(PARTITION BY event_key ORDER BY incomplete,file) rank
        FROM usage_events e ${where ? where + " AND" : "WHERE"} excluded=0
        AND (kind='record' OR turn_id IS NULL OR NOT EXISTS(
          SELECT 1 FROM usage_events r WHERE r.kind='record' AND r.excluded=0
          AND r.thread_id=e.thread_id AND r.turn_id=e.turn_id))
      ) WHERE rank=1)`,
      params,
    );
  }
  close() {
    this.prepared.clear();
    this.db.close();
  }
}
