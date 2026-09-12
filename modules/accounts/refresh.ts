import { Store } from "../storage/sqlite.js";
import type { LocalImporter } from "../collection/importer.js";
import { AccountError, type AccountSource } from "./reader.js";
import type { SourceStatus, AccountStatus, Status, RefreshSource } from "../contracts/status.js";
import type { AccountLimits } from "../contracts/accounts.js";
import { json } from '../foundation/values.js';
import { type LimitObservation } from './observation.js';

const initial = (): SourceStatus => ({
  running: false, startedAt: null, updatedAt: null, error: null,
  filesScanned: 0, filesChanged: 0, events: 0, issues: 0,
});

const accountInitial = (): AccountStatus => ({ ...initial(), provider: null, fallbackReason: null,
  errorCode: null, accountId: null, identityKey: null, identityConfirmed: false, available: false, stale: false });

type Job = "local" | "accountLimits" | "accountHistory";

type AccountJob = Exclude<Job, "local">;

export class Refresh {
  status: Status = { local: initial(), account: initial(), accountLimits: accountInitial(), accountHistory: accountInitial() };
  private jobs: Partial<Record<Job, Promise<void>>> = {};
  private successes: Partial<Record<AccountJob, string>> = {};
  private closed = false;
  private limitsListeners = new Set<() => Promise<void>>();
  constructor(private store: Store, private importer: LocalImporter, private account: AccountSource) {
    this.status.local.updatedAt = store.one("SELECT MAX(updated_at) at FROM source_files")?.at || null;
    this.status.local.events = Number(store.one("SELECT COUNT(*) n FROM effective_events")!.n);
    this.status.local.issues = Number(store.one("SELECT COALESCE(SUM(issues),0) n FROM source_files")!.n);
  }
  private aggregate() {
    const a = this.status.accountLimits, b = this.status.accountHistory;
    this.status.account = { ...initial(), running: a.running || b.running,
      startedAt: [a.startedAt, b.startedAt].filter((x): x is string => !!x).sort().at(-1) || null,
      // Compatibility summary is only wholly successful when both capabilities have a snapshot.
      updatedAt: a.updatedAt && b.updatedAt ? [a.updatedAt, b.updatedAt].sort()[0] : null,
      error: [a.error && `额度：${a.error}`, b.error && `每日历史：${b.error}`].filter(Boolean).join(" ") || null };
  }
  private applySnapshot(key: AccountJob, identityKey: string | null, confirmed: boolean) {
    const s = this.status[key];
    const row = identityKey ? this.store.one(
      "SELECT account_id,data,at,provider,fallback_reason FROM account_snapshots WHERE identity_key=? AND kind=? ORDER BY id DESC LIMIT 1",
      [identityKey, key === "accountLimits" ? "limits" : "usage"],
    ) : undefined;
    s.updatedAt = row?.at || null;
    s.identityKey = identityKey;
    s.provider = row?.provider || null;
    s.fallbackReason = row?.fallback_reason || null;
    s.accountId = row?.account_id || null;
    s.identityConfirmed = confirmed;
    s.available = !!row;
    s.stale = !!row && (!!s.error || !confirmed || this.successes[key] !== identityKey);
    return row ? JSON.parse(row.data) : null;
  }
  async getStatus(): Promise<Status> {
    const selection = await this.account.selection();
    for (const key of ["accountLimits", "accountHistory"] as const)
      this.applySnapshot(key, selection.identity?.key || null, selection.confirmed);
    this.aggregate();
    return this.status;
  }
  async accountSnapshot(kind: "limits" | "usage") {
    const selection = await this.account.selection();
    const key = kind === "limits" ? "accountLimits" : "accountHistory";
    const data = this.applySnapshot(key, selection.identity?.key || null, selection.confirmed);
    this.aggregate();
    return data;
  }
  onLimits(listener: () => Promise<void>) { this.limitsListeners.add(listener); return () => this.limitsListeners.delete(listener); }
  async cloudObservation(): Promise<LimitObservation> {
    const data: AccountLimits | null = await this.accountSnapshot('limits');
    const state = this.status.accountLimits;
    const identityError = ['IDENTITY_CHANGED', 'IDENTITY_UNKNOWN', 'LOGIN_EXPIRED', 'UNSUPPORTED_LOGIN', 'CREDENTIALS_MISSING', 'CREDENTIALS_INVALID', 'CREDENTIALS_UNREADABLE'].includes(state.errorCode || '');
    // A just-verified App Server identity may use keyring storage and have no file-based confirmation.
    const identityKnown = !!state.identityKey && !identityError && (state.identityConfirmed || (!state.error && this.successes.accountLimits === state.identityKey));
    const selection = await this.account.selection();
    return { stableIdentity: identityKnown && selection.confirmed && selection.identity?.key===state.identityKey ? selection.identity.key : null,
      identityKey: identityKnown ? state.identityKey : null, identityKnown, data: identityKnown ? data : null,
      provider: identityKnown ? state.provider : null, collectedAt: identityKnown ? state.updatedAt : null,
      attemptedAt: state.startedAt || new Date().toISOString(), errorCode: state.errorCode,
      refreshInterval: this.store.settings().accountInterval };
  }
  trigger(source: RefreshSource, force = false) {
    const keys: Job[] = source === "all" ? ["local", "accountLimits", "accountHistory"]
      : source === "account" ? ["accountLimits", "accountHistory"] : [source];
    for (const key of keys) {
      if (this.closed || this.jobs[key]) continue;
      const s = this.status[key];
      const interval = this.store.settings()[key === "local" ? "localInterval" : "accountInterval"];
      const gap = (interval || (key === "local" ? 10 : 60)) * 1000;
      if (!force && s.startedAt && Date.now() - Date.parse(s.startedAt) < gap) continue;
      s.running = true; s.startedAt = new Date().toISOString(); s.error = null;
      if (key !== "local") this.status[key].errorCode = null;
      this.jobs[key] = this.run(key).finally(() => { s.running = false; delete this.jobs[key]; this.aggregate(); });
    }
    this.aggregate();
    return this.status;
  }
  async refreshAccountLimits() {
    this.trigger('accountLimits', true);
    // Resuming cloud sync must not wait for an unrelated history import or account-history job.
    await this.jobs.accountLimits;
  }
  private async run(key: Job) {
    const s = this.status[key];
    try {
      if (key === "local") {
        await this.importer.scan((p) => { Object.assign(s, { filesScanned: p.filesScanned, filesChanged: p.filesChanged });
          if (p.events || p.issues) { s.events = p.events; s.issues = p.issues; } });
        s.updatedAt = new Date().toISOString();
      } else {
        const result = await (key === "accountLimits" ? this.account.readLimits() : this.account.readUsage());
        const selection = await this.account.selection();
        if (this.closed) throw new AccountError("CANCELLED", "账户读取已取消。");
        if (selection.identity?.key !== result.identity.key)
          throw new AccountError("IDENTITY_CHANGED", "账户归属发生变化，未保存本次结果。");
        if (result.data.accountId !== result.identity.accountId)
          throw new AccountError("IDENTITY_CHANGED", "结果与账户身份不一致，未保存本次结果。");
        this.store.run("INSERT INTO account_snapshots(account_id,kind,at,data,identity_key,provider,fallback_reason) VALUES(?,?,?,?,?,?,?)", [
          result.identity.accountId, key === "accountLimits" ? "limits" : "usage", new Date().toISOString(),
          json(result.data), result.identity.key, result.provider, result.fallbackReason,
        ]);
        this.successes[key] = result.identity.key;
      }
    } catch (e) {
      s.error = key === "local" ? (e instanceof Error ? e.message : "刷新失败")
        : e instanceof AccountError ? e.message : "账户刷新失败。";
      if (key !== "local") this.status[key].errorCode = e instanceof AccountError ? e.code : "ACCOUNT_FAILED";
    } finally {
      await this.getStatus();
      if (key === 'accountLimits' && !this.closed) {
        // Sync failures have their own state and must not turn a successful account read into a failure.
        await Promise.allSettled([...this.limitsListeners].map(listener => listener()));
      }
    }
  }
  async wait() { await Promise.all(Object.values(this.jobs)); }
  async close() { this.closed = true; this.importer.stopped = true; this.account.close(); await this.importer.close?.(); await this.wait(); }
}

export type { LimitObservation } from './observation.js';
