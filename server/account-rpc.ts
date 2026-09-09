import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { CodexCommand } from "./codex-command.js";
import { AccountError } from "./account-credentials.js";
import { json, parseJson } from "./util.js";

export interface AccountRpc { request(method: string, params?: unknown): Promise<any>; notify(method: string): void; close(): void | Promise<void>; }
export function openAccountRpc(command: CodexCommand, root: string, signal: AbortSignal, timeout = 25000): AccountRpc {
  signal.throwIfAborted();
  let child;
  try { child = spawn(command.bin, [...command.args, "app-server"], {
    windowsHide: true, detached: process.platform === 'darwin', stdio: "pipe", env: { ...process.env, CODEX_HOME: root },
  }); } catch { throw new AccountError("CLI_START", "无法启动 Codex App Server，请检查安装入口。"); }
  let next = 1, failure: AccountError | null = null;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const fail = (e: AccountError) => {
    failure = e;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(e); }
    pending.clear();
  };
  child.on("error", () => fail(new AccountError("CLI_START", "无法启动 Codex App Server，请检查安装入口。")));
  child.on("exit", () => fail(new AccountError("CLI_EXIT", "Codex App Server 已退出。")));
  child.stdin.on("error", () => fail(new AccountError("CLI_EXIT", "Codex 账户连接已关闭。")));
  child.stderr.resume();
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    let message: any;
    try { message = parseJson(line); } catch { return; }
    const p = pending.get(message?.id);
    if (!p) return;
    clearTimeout(p.timer); pending.delete(message.id);
    if (message.error) p.reject(new AccountError(
      message.error.code === -32601 ? "UNSUPPORTED_METHOD" : "RPC_ERROR",
      message.error.code === -32601 ? "当前 Codex 版本不支持此账户接口。" : "Codex 账户接口读取失败，请检查登录。",
    )); else p.resolve(message.result);
  });
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closing) return closing;
    fail(new AccountError("CANCELLED", "账户读取已取消。"));
    reader.close(); signal.removeEventListener("abort", abort);
    closing = (async () => {
      if (process.platform === 'darwin' && child.pid) {
        // Only this spawned session's process group, including the npm wrapper's native child.
        const group = -child.pid;
        const signalGroup = (signal: NodeJS.Signals | 0) => {
          try { process.kill(group, signal); return true; }
          catch (error: any) {
            if (error.code === 'ESRCH') return false;
            // A denied zero-signal probe is inconclusive, not a failed termination.
            // Keep waiting; any necessary SIGKILL still goes through permission checks.
            if (error.code === 'EPERM' && signal === 0) return true;
            if (error.code === 'EPERM') {
              // Darwin killpg skips zombies and can return EPERM for a group
              // whose last member is being reaped. Preserve real permission errors.
              const processes = execFileSync('/bin/ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', timeout: 3000 });
              const live = processes.split('\n').some(line => {
                const [pgid, state] = line.trim().split(/\s+/);
                return Number(pgid) === -group && state && !state.startsWith('Z');
              });
              if (!live) return false;
            }
            throw error;
          }
        };
        child.stdin.end();
        if (signalGroup('SIGTERM')) {
          const deadline = Date.now() + 1500;
          while (signalGroup(0) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
          if (signalGroup(0)) signalGroup('SIGKILL');
        }
        return;
      }
      if (process.platform === "win32" && child.pid && child.exitCode === null && child.signalCode === null) {
        // npm's JS entry can own a native Codex child. Terminate only this spawned process tree.
        await new Promise<void>((resolve) => {
          const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
          const timer = setTimeout(() => { killer.kill(); resolve(); }, 3000);
          const done = () => { clearTimeout(timer); resolve(); };
          killer.once("error", done); killer.once("exit", done);
        });
      }
      child.stdin.end(); child.kill();
    })();
    return closing;
  };
  const abort = () => { void close(); };
  signal.addEventListener("abort", abort, { once: true });
  return {
    notify(method) { if (!failure) child.stdin.write(json({ method }) + "\n"); },
    request(method, params) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const id = next++;
        const timer = setTimeout(() => {
          pending.delete(id); reject(new AccountError("RPC_TIMEOUT", "Codex 账户接口读取超时。"));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(json({ id, method, ...(params === undefined ? {} : { params }) }) + "\n", (e) => {
          if (e) fail(new AccountError("CLI_EXIT", "Codex 账户连接已关闭。"));
        });
      });
    }, close,
  };
}
