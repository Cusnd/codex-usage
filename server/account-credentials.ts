import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export type AccountIdentity = { key: string; accountId: string };
export type Credentials = AccountIdentity & { token: string; guard: string };
export class AccountError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export type AuthObservation = { guard: string; credentials: Credentials | null; error: AccountError | null };
const present = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
function claims(token: unknown): any {
  if (!present(token)) return {};
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); }
  catch { return {}; }
}
async function optionalFile(filename: string): Promise<string | null> {
  try { return await readFile(filename, "utf8"); }
  catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw new AccountError("CREDENTIALS_UNREADABLE", "无法读取 Codex 登录配置。");
  }
}
export async function observeAuth(root: string): Promise<AuthObservation> {
  let raw: string | null, config: string | null;
  try { [raw, config] = await Promise.all([optionalFile(path.join(root, "auth.json")), optionalFile(path.join(root, "config.toml"))]); }
  catch (e) { return { guard: "unreadable", credentials: null, error: e as AccountError }; }
  const guard = digest(JSON.stringify([raw, config]));
  const fail = (code: string, message: string): AuthObservation => ({ guard, credentials: null, error: new AccountError(code, message) });
  // Only the top-level setting controls native credential storage.
  const top = (config || "").split(/^\s*\[/m)[0];
  const mode = top.match(/^\s*cli_auth_credentials_store\s*=\s*["']([^"']+)["']/m)?.[1];
  if (mode && mode !== "file") return fail("UNSUPPORTED_STORE", "HTTP 回退不支持当前凭据存储方式；请使用 Codex App Server。");
  if (!raw) return fail("CREDENTIALS_MISSING", "未找到文件形式的 Codex 登录信息；系统凭据存储请使用 App Server。");
  let auth: any;
  try { auth = JSON.parse(raw); } catch { return fail("CREDENTIALS_INVALID", "Codex 登录文件格式无效。"); }
  if (auth?.auth_mode !== "chatgpt") return fail("UNSUPPORTED_LOGIN", "HTTP 额度查询需要 ChatGPT OAuth 登录，当前登录模式不支持。");
  const t = auth.tokens;
  if (!present(t?.access_token) || !present(t?.account_id)) return fail("CREDENTIALS_INVALID", "登录信息缺少访问令牌或账户标识。");
  const id = claims(t.id_token), access = claims(t.access_token);
  const subject = id?.sub || access?.["https://api.openai.com/auth"]?.chatgpt_user_id || access?.sub;
  if (!present(subject)) return fail("IDENTITY_UNKNOWN", "无法确认登录用户身份，请重新登录 Codex。");
  const claimedAccount = access?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (present(claimedAccount) && claimedAccount !== t.account_id) return fail("IDENTITY_CHANGED", "登录账户信息不一致，请重新登录 Codex。");
  return { guard, error: null, credentials: {
    key: digest(JSON.stringify(["chatgpt", subject, t.account_id])), accountId: t.account_id,
    token: t.access_token, guard,
  } };
}
