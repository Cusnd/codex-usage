import type { Database, SqlJsStatic, BindParams } from 'sql.js';
import type { SQLInputValue } from 'node:sqlite';
import { DateTime } from 'luxon';
import type { Settings } from '../shared/contracts.js';
import { officialPrices } from '../server/pricing.js';
import { seedExample } from './fixture.js';

export const exampleSettings = (): Settings => ({ localInterval: 0, accountInterval: 0,
  timezone: 'America/New_York', timezoneMode: 'manual', costEnabled: false,
  modelPrices: structuredClone(officialPrices) });

// Only the queryable synthetic tables exist here; no import, account or filesystem tables.
export class ExampleStore {
  db: Database;
  private value = exampleSettings();
  constructor(SQL: SqlJsStatic) {
    this.db = new SQL.Database();
    this.db.run(`CREATE TABLE threads(id TEXT PRIMARY KEY, project TEXT, title TEXT,
      title_updated_at TEXT, source TEXT, parent_id TEXT, subagent_parent_id TEXT, forked_from_id TEXT);
      CREATE TABLE usage_events(file TEXT,event_key TEXT,thread_id TEXT,turn_id TEXT,response_id TEXT,
      at TEXT,project TEXT,model TEXT,effort TEXT,kind TEXT,signature TEXT,input_tokens INTEGER,
      cached_input_tokens INTEGER,cache_write_input_tokens INTEGER,output_tokens INTEGER,
      reasoning_output_tokens INTEGER,total_tokens INTEGER,incomplete INTEGER,excluded INTEGER,active INTEGER,
      service_tier TEXT,service_tier_source TEXT);
      CREATE VIEW effective_events AS SELECT * FROM usage_events WHERE active=1;`);
    this.db.create_function('local_bucket', (at: string, zone: string, bucket: string) => {
      const d = DateTime.fromISO(at, { zone: 'utc' }).setZone(zone);
      return bucket === 'hour' ? d.startOf('hour').toISO()! : d.toISODate()!;
    });
    seedExample(this);
  }
  all<T = Record<string, any>>(sql: string, params: SQLInputValue[] = []): T[] {
    const stmt = this.db.prepare(sql);
    try {
      // Bind integer strings without converting through Number; SQLite column affinity preserves them.
      stmt.bind(params.map(v => typeof v === 'bigint' ? v.toString() : v) as BindParams);
      const names = stmt.getColumnNames();
      const rows: T[] = [];
      while (stmt.step()) {
        // sql.js supports useBigInt; its DefinitelyTyped declaration omits this argument.
        const values = (stmt.get as (p: null, config: {useBigInt: boolean}) => unknown[])(null, {useBigInt: true});
        rows.push(Object.fromEntries(names.map((name, i) => [name, values[i]])) as T);
      }
      return rows;
    } finally { stmt.free(); }
  }
  one<T = Record<string, any>>(sql: string, params: SQLInputValue[] = []): T | undefined { return this.all<T>(sql, params)[0]; }
  run(sql: string, params: (string | number | null)[] = []) { this.db.run(sql, params); }
  transaction(fn: () => void) {
    this.db.run('BEGIN');
    try { fn(); this.db.run('COMMIT'); } catch(e) { this.db.run('ROLLBACK'); throw e; }
  }
  settings(): Settings {
    return { ...structuredClone(this.value), timezone: this.value.timezoneMode === 'system'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone : this.value.timezone };
  }
  saveSettings(value: Settings) { this.value = structuredClone(value); }
  close() { this.db.close(); }
}
