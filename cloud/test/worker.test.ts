import {MatchingRequest} from './matching-build';
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import worker, { cleanup } from "../../apps/cloud/index.js";
import { SESSION_COOKIE, STATE_COOKIE, sha256, token } from "../../modules/platform/worker/http.js";
import type { CloudSnapshot } from "../../modules/contracts/cloud.js";

const origin = "https://quota.esoren.com";
type Actor = {
  id: string;
  session: string;
  deviceToken: string;
  deviceId: string;
};
async function actor(n = 1, device = true): Promise<Actor> {
  const id = crypto.randomUUID(),
    session = token(),
    deviceToken = token(),
    deviceId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO users(id,github_id,login,created_at) VALUES(?,?,?,?)",
  )
    .bind(id, String(n), "user" + n, Date.now())
    .run();
  await env.DB.prepare(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
  )
    .bind(await sha256(session), id, Date.now() + 86400000)
    .run();
  if (device)
    await env.DB.prepare(
      "INSERT INTO devices(user_id,id,name,token_hash,bound_at) VALUES(?,?,?,?,?)",
    )
      .bind(id, deviceId, "Laptop " + n, await sha256(deviceToken), Date.now())
      .run();
  return { id, session, deviceToken, deviceId };
}
function request(
  path: string,
  method = "GET",
  body?: unknown,
  auth?: Actor | string,
  headers: Record<string, string> = {},
) {
  return worker.fetch(
    new MatchingRequest(origin + path, {
      method,
      headers: {
        Origin: origin,
        "CF-Connecting-IP": "127.0.0." + (1 + Math.floor(Math.random() * 250)),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(typeof auth === "string"
          ? { Authorization: "Bearer " + auth }
          : auth
            ? { Cookie: SESSION_COOKIE + "=" + auth.session }
            : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );
}
async function pending(name = "New laptop") {
  const deviceToken = token();
  const response = await request("/api/v3/device-authorizations", "POST", {
    deviceName: name,
    tokenHash: await sha256(deviceToken),
  });
  expect(response.status).toBe(201);
  return {
    ...(await response.json<{
      requestId: string;
      userCode: string;
      pollSecret: string;
    }>()),
    deviceToken,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
});

it("expired bindings cannot be inspected, confirmed or polled", async () => {
  const a = await actor(1, false),
    p = await pending();
  await env.DB.prepare(
    "UPDATE device_authorizations SET expires_at=0 WHERE id=?",
  )
    .bind(p.requestId)
    .run();
  expect(
    (
      await request(
        "/api/v3/device-authorizations/inspect",
        "POST",
        { code: p.userCode },
        a,
      )
    ).status,
  ).toBe(410);
  expect(
    (
      await request(
        "/api/v3/device-authorizations/approve",
        "POST",
        { code: p.userCode, replaceDeviceId: null },
        a,
      )
    ).status,
  ).toBe(410);
  expect(
    (
      await request("/api/v3/device-authorizations/poll", "POST", {
        requestId: p.requestId,
        pollSecret: p.pollSecret,
      })
    ).status,
  ).toBe(410);
});
it("cancelling a pending request handles approval races without deleting a different device", async () => {
  const a = await actor(1, false),
    p = await pending();
  await request(
    "/api/v3/device-authorizations/approve",
    "POST",
    { code: p.userCode, replaceDeviceId: null },
    a,
  );
  expect(
    (
      await request("/api/v3/device-authorizations", "DELETE", {
        requestId: p.requestId,
        pollSecret: p.pollSecret,
      })
    ).status,
  ).toBe(200);
  const devices=await (await request('/api/v3/devices','GET',undefined,a)).json<any>();
  expect(devices.devices).toHaveLength(1);expect(devices.devices[0].revoked).toBe(true);
  expect(
    (
      await request(
        "/api/v3/device-authorizations/approve",
        "POST",
        { code: p.userCode, replaceDeviceId: null },
        a,
      )
    ).status,
  ).toBe(410);
});
it("OAuth uses state+PKCE, rejects forged state, requests minimal scope, and discards the GitHub token", async () => {
  const upstream = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      // Validate options in the real workerd Request implementation before
      // replacing only the upstream response with a fixture.
      const outbound = new MatchingRequest(String(input), init);
      expect(outbound.redirect).toBe("manual");
      if (input === "https://github.com/login/oauth/access_token") {
        expect(
          new URLSearchParams(String(init?.body)).get("code_verifier"),
        ).toHaveLength(43);
        return Response.json({ access_token: "SYNTHETIC-GITHUB-TOKEN" });
      }
      expect(input).toBe("https://api.github.com/user");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer SYNTHETIC-GITHUB-TOKEN",
      );
      return Response.json({
        id: 12345,
        login: "tester",
        email: "sensitive@example.com",
      });
    });
  const start = await request(
    "/auth/github?returnTo=" + encodeURIComponent("/bind?code=ABCD-2345"),
  );
  const redirect = new URL(start.headers.get("Location")!);
  const state = redirect.searchParams.get("state")!;
  expect(redirect.searchParams.get("scope")).toBe("");
  expect(redirect.searchParams.get("code_challenge_method")).toBe("S256");
  expect(redirect.searchParams.get("code_challenge")).toHaveLength(43);
  const attrs = start.headers.get("Set-Cookie")!;
  for (const attr of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/"])
    expect(attrs).toContain(attr);
  expect(
    (
      await request(
        "/auth/github/callback?state=" + state + "&code=good",
        "GET",
        undefined,
        undefined,
        { Cookie: STATE_COOKIE + "=" + token() },
      )
    ).status,
  ).toBe(400);
  const callback = () =>
    request(
      "/auth/github/callback?state=" + state + "&code=good",
      "GET",
      undefined,
      undefined,
      { Cookie: STATE_COOKIE + "=" + state },
    );
  const done = await callback();
  expect(done.status).toBe(302);
  expect(done.headers.get("Location")).toBe(origin + "/bind?code=ABCD-2345");
  expect(done.headers.get("Set-Cookie")).toContain("Max-Age=2592000");
  const rows = await env.DB.prepare("SELECT * FROM users").all();
  expect(JSON.stringify(rows)).not.toContain("SYNTHETIC-GITHUB-TOKEN");
  expect(JSON.stringify(rows)).not.toContain("sensitive@example.com");
  expect((await callback()).status).toBe(400);
  expect(upstream).toHaveBeenCalledTimes(2);
});
it.each(["redirect", "http-error", "network", "null", "invalid-json"])(
  "OAuth rejects an upstream %s without following redirects, leaking errors, or creating a session",
  async (failure) => {
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const outbound = new MatchingRequest(String(input), init);
      expect(outbound.redirect).toBe("manual");
      if (failure === "network") throw new TypeError("SYNTHETIC-PRIVATE-UPSTREAM-ERROR");
      if (failure === "redirect") return new Response(null, { status: 302, headers: { Location: "https://unexpected.example/receive" } });
      if (failure === "http-error") return new Response("SYNTHETIC-PRIVATE-UPSTREAM-ERROR", { status: 503 });
      if (failure === "null") return Response.json(null);
      return new Response("SYNTHETIC-PRIVATE-UPSTREAM-ERROR");
    });
    const start = await request("/auth/github");
    const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
    const response = await request(
      "/auth/github/callback?state=" + state + "&code=synthetic",
      "GET", undefined, undefined, { Cookie: STATE_COOKIE + "=" + state },
    );
    expect(response.status).toBe(502);
    const result = await response.text();
    expect(result).toContain("GITHUB_UNAVAILABLE");
    expect(result).not.toContain("SYNTHETIC-PRIVATE-UPSTREAM-ERROR");
    expect(response.headers.get("Set-Cookie")).toBe(null);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT * FROM sessions LIMIT 1").first()).toBe(null);
  },
);
it("cleanup removes expired sessions, OAuth states and pairing codes", async () => {
  const a = await actor(),
    p = await pending();
  await request("/auth/github");
  await cleanup(env, Date.now() + 172800000);
  expect((await request("/api/v3/me", "GET", undefined, a)).status).toBe(401);
  expect(
    (
      await request("/api/v3/device-authorizations/poll", "POST", {
        requestId: p.requestId,
        pollSecret: p.pollSecret,
      })
    ).status,
  ).toBe(410);
  expect(
    await env.DB.prepare("SELECT * FROM oauth_states LIMIT 1").first(),
  ).toBe(null);
  expect((await request('/api/v3/collector/handshake','POST',undefined,a.deviceToken)).status).toBe(200);
});
