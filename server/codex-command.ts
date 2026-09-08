import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { AccountError } from "./account-credentials.js";

export type CodexCommand = { bin: string; args: string[] };
export async function resolveCodexCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<CodexCommand> {
  const resolve = async (file: string): Promise<CodexCommand> => {
    await access(file);
    const ext = path.extname(file).toLowerCase();
    if ([".js", ".mjs", ".cjs"].includes(ext))
      return { bin: process.execPath, args: [path.resolve(file)] };
    if (ext === ".cmd") {
      // Recognize the npm shim, but never execute its shell contents.
      const shim = await readFile(file, "utf8");
      if (!/node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js/i.test(shim))
        throw new Error("unsupported shim");
      const script = path.join(path.dirname(file), "node_modules/@openai/codex/bin/codex.js");
      await access(script);
      return { bin: process.execPath, args: [path.resolve(script)] };
    }
    if (platform === "win32" && ext !== ".exe") throw new Error("unsupported executable");
    return { bin: path.resolve(file), args: [] };
  };
  if (env.CODEX_BIN) {
    try { return await resolve(env.CODEX_BIN); }
    catch { throw new AccountError("CLI_START", "CODEX_BIN 无效：请指定 Codex .exe、JS 入口或标准 npm codex.cmd。"); }
  }
  const directories = (env.PATH || env.Path || "").split(platform === "win32" ? ";" : ":")
    .map((p) => p.replace(/^"|"$/g, "")).filter(Boolean);
  const candidates = directories.flatMap((dir) =>
    (platform === "win32" ? ["codex.exe", "codex.cmd"] : ["codex"]).map((name) => path.join(dir, name)));
  if (platform === "win32") candidates.push(path.join(
    env.APPDATA || path.join(homedir(), "AppData/Roaming"), "npm/node_modules/@openai/codex/bin/codex.js"));
  for (const candidate of candidates) {
    try { return await resolve(candidate); } catch { /* Try the next installed entry. */ }
  }
  throw new AccountError("CLI_NOT_FOUND", "未找到 Codex CLI，将使用现有 OAuth 登录查询额度。");
}
