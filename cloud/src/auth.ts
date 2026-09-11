import {
  challenge,
  cookie,
  fail,
  HttpError,
  json,
  limitAuth,
  readJson,
  requireSameOrigin,
  SESSION_COOKIE,
  setCookie,
  sha256,
  STATE_COOKIE,
  token,
} from "./http";

export type User = { id: string; login: string; next_upload_at: number };
type GithubToken = { access_token?: unknown };
type GithubUser = { id?: unknown; login?: unknown };
const SESSION_SECONDS = 30 * 24 * 60 * 60;

export async function sessionUser(request: Request, env: Env): Promise<User> {
  const value = cookie(request, SESSION_COOKIE);
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value))
    return fail(401, "LOGIN_REQUIRED", "请先登录。");
  const user = await env.DB.prepare(
    "SELECT u.id,u.login,u.next_upload_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?",
  )
    .bind(await sha256(value), Date.now())
    .first<User>();
  return user || fail(401, "LOGIN_REQUIRED", "登录已过期，请重新登录。");
}
function returnPath(value: string | null) {
  if (value && /^\/bind\?code=[A-Z2-9-]{8,12}$/.test(value)) return value;
  return "/";
}
async function githubFetch(url: string, init: RequestInit): Promise<unknown> {
  try {
    const response = await fetch(url, {
      ...init,
      // workerd rejects redirect: "error". Manual mode prevents credentials
      // from following a redirect, which is rejected by the status check.
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("Upstream status rejected");
    const body = await readJson(response);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("Upstream response rejected");
    return body;
  } catch {
    throw new HttpError(
      502,
      "GITHUB_UNAVAILABLE",
      "GitHub 登录暂时不可用，请重新尝试。",
    );
  }
}
export async function authRoute(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response | null> {
  if (pathname === "/auth/github" && request.method === "GET") {
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET)
      return fail(
        503,
        "LOGIN_NOT_CONFIGURED",
        "云端登录正在配置，请稍后再试。",
      );
    await limitAuth(request, env, "login");
    const state = token(),
      verifier = token();
    await env.DB.prepare(
      "INSERT INTO oauth_states(state_hash,verifier,return_to,expires_at) VALUES(?,?,?,?)",
    )
      .bind(
        await sha256(state),
        verifier,
        returnPath(new URL(request.url).searchParams.get("returnTo")),
        Date.now() + 600000,
      )
      .run();
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      redirect_uri: `${env.APP_ORIGIN}/auth/github/callback`,
      state,
      code_challenge: await challenge(verifier),
      code_challenge_method: "S256",
      scope: "",
    }).toString();
    return new Response(null, {
      status: 302,
      headers: {
        Location: url.href,
        "Set-Cookie": setCookie(STATE_COOKIE, state, 600),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
  if (pathname === "/auth/github/callback" && request.method === "GET") {
    const params = new URL(request.url).searchParams;
    const state = params.get("state"),
      code = params.get("code"),
      browserState = cookie(request, STATE_COOKIE);
    if (
      !state ||
      !browserState ||
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      !/^[A-Za-z0-9_-]{43}$/.test(browserState) ||
      !crypto.subtle.timingSafeEqual(
        new TextEncoder().encode(state),
        new TextEncoder().encode(browserState),
      )
    )
      return fail(
        400,
        "INVALID_OAUTH_STATE",
        "登录请求已失效，请从登录按钮重新开始。",
      );
    const stored = await env.DB.prepare(
      "DELETE FROM oauth_states WHERE state_hash=? AND expires_at>? RETURNING verifier,return_to",
    )
      .bind(await sha256(state), Date.now())
      .first<{ verifier: string; return_to: string }>();
    if (!stored || !code || code.length > 1024 || params.has("error"))
      return fail(400, "INVALID_OAUTH_STATE", "登录未完成，请重新开始。");
    const credentials = (await githubFetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": "Codex-Usage",
        },
        body: new URLSearchParams({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: `${env.APP_ORIGIN}/auth/github/callback`,
          code_verifier: stored.verifier,
        }).toString(),
      },
    )) as GithubToken;
    if (
      typeof credentials.access_token !== "string" ||
      credentials.access_token.length > 1024
    )
      return fail(502, "GITHUB_UNAVAILABLE", "GitHub 未完成授权，请重新登录。");
    const profile = (await githubFetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Codex-Usage",
      },
    })) as GithubUser;
    if (
      !Number.isSafeInteger(profile.id) ||
      Number(profile.id) < 1 ||
      typeof profile.login !== "string" ||
      !/^[A-Za-z0-9-]{1,39}$/.test(profile.login)
    )
      return fail(
        502,
        "GITHUB_UNAVAILABLE",
        "GitHub 返回的身份无法确认，请重新登录。",
      );
    const user = await env.DB.prepare(
      "INSERT INTO users(id,github_id,login,created_at) VALUES(?,?,?,?) ON CONFLICT(github_id) DO UPDATE SET login=excluded.login RETURNING id",
    )
      .bind(crypto.randomUUID(), String(profile.id), profile.login, Date.now())
      .first<{ id: string }>();
    if (!user) throw new Error("User persistence failed");
    const session = token();
    await env.DB.prepare(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
    )
      .bind(await sha256(session), user.id, Date.now() + SESSION_SECONDS * 1000)
      .run();
    const headers = new Headers({
      Location: env.APP_ORIGIN + stored.return_to,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    headers.append(
      "Set-Cookie",
      setCookie(SESSION_COOKIE, session, SESSION_SECONDS),
    );
    headers.append("Set-Cookie", setCookie(STATE_COOKIE, "", 0));
    return new Response(null, { status: 302, headers });
  }
  if (pathname === "/auth/logout" && request.method === "POST") {
    requireSameOrigin(request, env);
    const session = cookie(request, SESSION_COOKIE);
    if (session)
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?")
        .bind(await sha256(session))
        .run();
    return json({ ok: true }, 200, {
      "Set-Cookie": setCookie(SESSION_COOKIE, "", 0),
    });
  }
  return null;
}
