import path from "node:path";
import { homedir } from "node:os";
import type { AccountUsage, AccountLimits } from "../contracts/accounts.js";
import { AccountError, observeAuth } from "./credentials.js";
import { resolveCodexCommand, type CodexCommand } from "./command.js";
import { type AccountSource, type ReaderOptions, type AccountSelection, type AccountResult } from "./ports.js";
import { fail } from "./parse.js";
import { AccountProviders } from './providers.js';

export { AccountError } from "./credentials.js";

export class AccountReader implements AccountSource {
  private root: string;
  private providers: AccountProviders;
  private controllers = new Set<AbortController>();
  private closed = false;



  constructor(private options: ReaderOptions = {}) {
    this.root = options.root || process.env.CODEX_HOME || path.join(homedir(), ".codex");
    this.providers = new AccountProviders(this.root,options);
  }
  async selection(): Promise<AccountSelection> {
    const observed = await observeAuth(this.root);
    if (observed.credentials) {
      const { key, accountId } = observed.credentials;
      return { identity: { key, accountId }, confirmed: this.providers.confirmed?.guard === observed.guard && this.providers.confirmed.identity.key === key };
    }
    // Keyring identities cannot be revalidated without another RPC. Cached data is explicitly historical.
    return { identity: this.providers.confirmed?.guard === observed.guard ? this.providers.confirmed.identity : null, confirmed: false };
  }

  private async operation<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) return fail("CANCELLED", "账户读取已取消。");
    const controller = new AbortController(); this.controllers.add(controller);
    try { return await fn(controller.signal); }
    catch (e) {
      if (controller.signal.aborted) return fail("CANCELLED", "账户读取已取消。");
      if (e instanceof AccountError) throw e;
      return fail("ACCOUNT_FAILED", "账户读取失败，请检查 Codex 安装与登录。");
    } finally { this.controllers.delete(controller); }
  }
  private command(): Promise<CodexCommand> {
    return this.options.resolveCommand ? this.options.resolveCommand()
      : this.options.openRpc ? Promise.resolve({ bin: process.execPath, args: [] }) : resolveCodexCommand();
  }


  readUsage(): Promise<AccountResult<AccountUsage>> {
    return this.operation(async (signal) => {
      let command: CodexCommand;
      try { command = await this.command(); }
      catch (e) {
        if (e instanceof AccountError && e.code === "CLI_NOT_FOUND")
          return fail("CLI_NOT_FOUND", "账户每日历史需要 Codex CLI；本地统计与 OAuth 额度查询可独立使用。");
        throw e;
      }
      return this.providers.appServer("usage", signal, command);
    });
  }
  readLimits(): Promise<AccountResult<AccountLimits>> {
    return this.operation(async (signal) => {
      let command: CodexCommand;
      try { command = await this.command(); }
      catch (e) {
        if (signal.aborted || !(e instanceof AccountError) || e.code !== "CLI_NOT_FOUND") throw e;
        return { ...await this.providers.http(signal), fallbackReason: "未检测到 Codex CLI，使用现有 OAuth 登录。" };
      }
      // A detected CLI owns this read. Runtime/interface failures do not change authentication routes.
      return this.providers.appServer("limits", signal, command);
    });
  }
  close() { this.closed = true; for (const c of this.controllers) c.abort(); }
}

export { parseLimits } from './parse.js';

export type { AccountSource } from './ports.js';
