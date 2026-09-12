import type { AccountUsage, AccountLimits } from "../contracts/accounts.js";
import { type AccountIdentity } from "./credentials.js";
import { type CodexCommand } from "./command.js";
import { type AccountRpc } from "./rpc.js";

export type AccountProvider = "app-server" | "http";

export type AccountResult<T> = { data: T; identity: AccountIdentity; provider: AccountProvider; fallbackReason: string | null };

export type AccountSelection = { identity: AccountIdentity | null; confirmed: boolean };

export interface AccountSource {
  readLimits(): Promise<AccountResult<AccountLimits>>;
  readUsage(): Promise<AccountResult<AccountUsage>>;
  selection(): Promise<AccountSelection>;
  close(): void;
}

export type ReaderOptions = {
    root?: string;
    fetch?: typeof fetch;
    openRpc?: (signal: AbortSignal) => Promise<AccountRpc>;
    resolveCommand?: () => Promise<CodexCommand>;
    httpTimeoutMs?: number;
};
