import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import type { Settings } from "../shared/contracts.js";
import { json } from "./util.js";
import { officialPrices } from "./pricing.js";

export class Store {
  db: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ":memory:")
      mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_files (
        path TEXT PRIMARY KEY, identity TEXT NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL,
        offset INTEGER NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, issues INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, project TEXT, source TEXT, parent_id TEXT);
      CREATE TABLE IF NOT EXISTS usage_events (
        file TEXT NOT NULL, event_key TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT, response_id TEXT,
        at TEXT NOT NULL, project TEXT, model TEXT, effort TEXT, kind TEXT NOT NULL, signature TEXT,
        input_tokens INTEGER, cached_input_tokens INTEGER, cache_write_input_tokens INTEGER,
        output_tokens INTEGER, reasoning_output_tokens INTEGER, total_tokens INTEGER,
        incomplete INTEGER NOT NULL DEFAULT 0, excluded INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 0,
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
        at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS snapshots_latest ON account_snapshots(account_id,kind,id DESC);
    `);
    const threadColumns = this.db.prepare("PRAGMA table_info(threads)").all();
    const snapshotColumns = this.db.prepare("PRAGMA table_info(account_snapshots)").all();
    for (const column of ["identity_key", "provider", "fallback_reason"])
      if (!snapshotColumns.some((c) => c.name === column))
        this.db.exec(`ALTER TABLE account_snapshots ADD COLUMN ${column} TEXT`);
    this.db.exec("CREATE INDEX IF NOT EXISTS snapshots_identity ON account_snapshots(identity_key,kind,id DESC)");
    if (!threadColumns.some((c) => c.name === "title"))
      this.db.exec(
        "ALTER TABLE threads ADD COLUMN title TEXT; ALTER TABLE threads ADD COLUMN title_updated_at TEXT;",
      );
    const columns = this.db.prepare("PRAGMA table_info(usage_events)").all();
    const migrate = !columns.some((c) => c.name === "active");
    if (migrate)
      this.db.exec(
        "ALTER TABLE usage_events ADD COLUMN active INTEGER NOT NULL DEFAULT 0",
      );
    this.db.exec(`DROP VIEW IF EXISTS effective_events;
      CREATE VIEW effective_events AS SELECT * FROM usage_events WHERE active=1;
      CREATE INDEX IF NOT EXISTS active_time ON usage_events(at) WHERE active=1;
      CREATE INDEX IF NOT EXISTS active_thread ON usage_events(thread_id,at) WHERE active=1;
    `);
    if (migrate) this.reconcile();
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
  }
  all<T = Record<string, any>>(sql: string, params: SQLInputValue[] = []): T[] {
    const statement = this.db.prepare(sql);
    statement.setReadBigInts(true);
    return statement.all(...params) as T[];
  }
  one<T = Record<string, any>>(
    sql: string,
    params: SQLInputValue[] = [],
  ): T | undefined {
    return this.all<T>(sql, params)[0];
  }
  run(sql: string, params: SQLInputValue[] = []) {
    return this.db.prepare(sql).run(...params);
  }
  transaction(fn: () => void) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  settings(): Settings {
    const stored = JSON.parse(
      this.one("SELECT value FROM settings WHERE id=1")!.value,
    );
    return {
      ...stored,
      costEnabled: stored.costEnabled ?? false,
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
    this.db.close();
  }
}
