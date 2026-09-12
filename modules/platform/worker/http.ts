import { CLOUD_MAX_BODY_BYTES } from "../../contracts/cloud.js";
import { BUILD_HEADER, BUILD_VERSION, SYNC_HEADER, SYNC_VERSION } from '../../contracts/cloud-version.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public headers: Record<string, string> = {},
  ) {
    super(message);
  }
}
export const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      [BUILD_HEADER]: BUILD_VERSION,
      [SYNC_HEADER]: SYNC_VERSION,
      ...headers,
    },
  });
export const fail = (status: number, code: string, message: string): never => {
  throw new HttpError(status, code, message);
};
export function exactObject(
  body: unknown,
  names: string[],
): asserts body is Record<string, unknown> {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== names.length ||
    !names.every((k) => Object.hasOwn(body, k))
  )
    fail(400, "INVALID_INPUT", "请求格式不正确。");
}
export async function readJson(
  message: Request | Response,
  limit = CLOUD_MAX_BODY_BYTES,
): Promise<unknown> {
  const length = message.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit))
    fail(413, "BODY_TOO_LARGE", "请求数据过大。");
  const reader = message.body?.getReader();
  if (!reader) return fail(400, "INVALID_INPUT", "缺少请求内容。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        fail(413, "BODY_TOO_LARGE", "请求数据过大。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    return fail(400, "INVALID_INPUT", "请求不是有效的 JSON。");
  }
}
export function requireJson(request: Request) {
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  )
    fail(415, "JSON_REQUIRED", "请使用 JSON 请求。");
}
export function requireSameOrigin(request: Request, env: Env) {
  if (request.headers.get("origin") !== env.APP_ORIGIN)
    fail(403, "INVALID_ORIGIN", "请求来源不允许。");
}
export function token(bytes = 32) {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export async function sha256(value: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function challenge(verifier: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export function cookie(request: Request, name: string) {
  return (
    (request.headers.get("cookie") || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(name + "="))
      ?.slice(name.length + 1) || null
  );
}
export const setCookie = (name: string, value: string, seconds: number) =>
  `${name}=${value}; Path=/; Max-Age=${seconds}; Secure; HttpOnly; SameSite=Lax`;
export const SESSION_COOKIE = "__Host-cu_session";
export const STATE_COOKIE = "__Host-cu_oauth";
export function bearer(request: Request) {
  const result = request.headers
    .get("authorization")
    ?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  return result?.[1] || null;
}
export async function limitAuth(
  request: Request,
  env: Env,
  action: string,
  actor?: string,
) {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const key = `cloud-quota:${action}:${actor || ip}`;
  if (!(await env.AUTH_LIMITER.limit({ key })).success)
    throw new HttpError(429, "RATE_LIMITED", "请求较频繁，请稍后重试。", {
      "Retry-After": "60",
    });
}
