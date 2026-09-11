import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import worker, { cleanup } from "../src/index";
import { SESSION_COOKIE, STATE_COOKIE, sha256, token } from "../src/http";
import type { CloudSnapshot } from "../../shared/cloud";

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
    new Request(origin + path, {
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
function snapshot(a: Actor, sequence = 1): CloudSnapshot {
  return {
    schemaVersion: 1,
    deviceId: a.deviceId,
    sequence,
    accountRef: "a".repeat(64),
    collectedAt: "2026-09-09T00:00:00.000Z",
    attemptedAt: "2026-09-09T00:00:00.000Z",
    provider: "app-server",
    refreshInterval: 300,
    status: "ok",
    errorCode: null,
    buckets: [
      {
        id: "codex",
        name: "Codex",
        primary: {
          usedPercent: 25,
          remainingPercent: 75,
          windowDurationMins: 300,
          resetsAt: "2026-09-09T05:00:00.000Z",
        },
        secondary: null,
      },
    ],
  };
}
const upload = (a: Actor, sequence = 1) =>
  request("/api/v1/snapshot", "PUT", snapshot(a, sequence), a.deviceToken);
async function pending(name = "New laptop") {
  const deviceToken = token();
  const response = await request("/api/v1/device-authorizations", "POST", {
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

it("requires the appropriate session/device authentication and never leaks between users", async () => {
  const a = await actor(1),
    b = await actor(2);
  expect((await upload(a)).status).toBe(200);
  expect((await request("/api/v1/quota")).status).toBe(401);
  expect(
    (await request("/api/v1/quota", "GET", undefined, a.deviceToken)).status,
  ).toBe(401);
  expect(
    (await request("/api/v1/snapshot", "PUT", snapshot(a), a)).status,
  ).toBe(401);
  const other = await request(
    "/api/v1/quota?userId=" + a.id,
    "GET",
    undefined,
    b,
  );
  expect(await other.json()).toEqual({ snapshot: null, receivedAt: null });
  expect(other.headers.get("Cache-Control")).toBe("no-store");
  expect(
    (await request("/api/v1/snapshot", "PUT", snapshot(a, 2), b.deviceToken))
      .status,
  ).toBe(400);
});
it("D1 serializes concurrent new versions and preserves the actual collection time", async () => {
  const a = await actor();
  const responses = await Promise.all([upload(a, 1), upload(a, 2)]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 429]);
  const rejected = responses.find((r) => r.status === 429)!;
  expect(Number(rejected.headers.get("Retry-After"))).toBeGreaterThan(0);
  const quota = await (
    await request("/api/v1/quota", "GET", undefined, a)
  ).json<{ snapshot: CloudSnapshot; receivedAt: string }>();
  expect(quota.snapshot.collectedAt).toBe("2026-09-09T00:00:00.000Z");
  expect(quota.receivedAt).not.toBe(quota.snapshot.collectedAt);
});
it("acknowledges exact retry without rewriting time, rejects old or changed equal versions", async () => {
  const a = await actor();
  const initial = await (await upload(a, 2)).json();
  expect(await (await upload(a, 2)).json()).toEqual(initial);
  expect((await upload(a, 1)).status).toBe(409);
  expect(
    (
      await request(
        "/api/v1/snapshot",
        "PUT",
        { ...snapshot(a, 2), buckets: [] },
        a.deviceToken,
      )
    ).status,
  ).toBe(409);
  expect((await upload(a, 3)).status).toBe(429);
  await env.DB.prepare("UPDATE users SET next_upload_at=0 WHERE id=?")
    .bind(a.id)
    .run();
  expect((await upload(a, 3)).status).toBe(200);
  expect((await upload(a, 2)).status).toBe(409);
});
it("rejects extra fields, invalid/null semantics, unknown fields in quota windows and oversized bodies", async () => {
  const a = await actor();
  const s = snapshot(a);
  for (const body of [
    { ...s, access_token: "synthetic-secret" },
    { ...s, accountRef: "raw-email@example.com" },
    { ...s, status: "identity_unknown" },
    {
      ...s,
      buckets: [
        {
          ...s.buckets[0],
          primary: { ...s.buckets[0].primary, credentials: "secret" },
        },
      ],
    },
  ])
    expect(
      (await request("/api/v1/snapshot", "PUT", body, a.deviceToken)).status,
    ).toBe(400);
  expect(
    (
      await request(
        "/api/v1/snapshot",
        "PUT",
        { ...s, padding: "x".repeat(70000) },
        a.deviceToken,
      )
    ).status,
  ).toBe(413);
  const q = await request("/api/v1/quota", "GET", undefined, a);
  expect((await q.json<{ snapshot: unknown }>()).snapshot).toBe(null);
});
it("preserves unknown percentages and clears quota values when identity is unknown", async () => {
  const a = await actor();
  const s = snapshot(a);
  s.buckets[0].primary = {
    usedPercent: null,
    remainingPercent: null,
    windowDurationMins: null,
    resetsAt: null,
  };
  expect(
    (await request("/api/v1/snapshot", "PUT", s, a.deviceToken)).status,
  ).toBe(200);
  const q = await (
    await request("/api/v1/quota", "GET", undefined, a)
  ).json<{ snapshot: CloudSnapshot }>();
  expect(q.snapshot.buckets[0].primary?.remainingPercent).toBe(null);
  await env.DB.prepare("UPDATE users SET next_upload_at=0 WHERE id=?")
    .bind(a.id)
    .run();
  expect(
    (
      await request(
        "/api/v1/snapshot",
        "PUT",
        {
          ...s,
          sequence: 2,
          accountRef: null,
          collectedAt: null,
          provider: null,
          status: "identity_unknown",
          errorCode: "IDENTITY_UNKNOWN",
          buckets: [],
        },
        a.deviceToken,
      )
    ).status,
  ).toBe(200);
});
it("binding approval is single-use and cannot clear snapshots on a repeated confirmation", async () => {
  const a = await actor(1, false),
    p = await pending();
  const info = await (
    await request(
      "/api/v1/device-authorizations/inspect",
      "POST",
      { code: p.userCode },
      a,
    )
  ).json<any>();
  expect(info.deviceName).toBe("New laptop");
  const approve = () =>
    request(
      "/api/v1/device-authorizations/approve",
      "POST",
      { code: p.userCode, replaceDeviceId: null },
      a,
    );
  expect((await approve()).status).toBe(200);
  const poll = await (
    await request("/api/v1/device-authorizations/poll", "POST", {
      requestId: p.requestId,
      pollSecret: p.pollSecret,
    })
  ).json<any>();
  const bound = { ...a, deviceId: poll.deviceId, deviceToken: p.deviceToken };
  expect((await upload(bound)).status).toBe(200);
  expect((await approve()).status).toBe(409);
  expect(
    (await (await request("/api/v1/quota", "GET", undefined, a)).json<any>())
      .snapshot,
  ).not.toBe(null);
  expect(
    (
      await request("/api/v1/device-authorizations/poll", "POST", {
        requestId: p.requestId,
        pollSecret: p.pollSecret,
      })
    ).status,
  ).toBe(200);
});
it("replacement checks the displayed old device and enforces cooldown across devices", async () => {
  const a = await actor();
  expect((await upload(a)).status).toBe(200);
  const p = await pending();
  expect(
    (
      await request(
        "/api/v1/device-authorizations/approve",
        "POST",
        { code: p.userCode, replaceDeviceId: null },
        a,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await request(
        "/api/v1/device-authorizations/approve",
        "POST",
        { code: p.userCode, replaceDeviceId: a.deviceId },
        a,
      )
    ).status,
  ).toBe(200);
  expect((await upload(a, 2)).status).toBe(401);
  expect(
    (await (await request("/api/v1/quota", "GET", undefined, a)).json<any>())
      .snapshot,
  ).toBe(null);
  const poll = await (
    await request("/api/v1/device-authorizations/poll", "POST", {
      requestId: p.requestId,
      pollSecret: p.pollSecret,
    })
  ).json<any>();
  expect(
    (
      await upload({
        ...a,
        deviceId: poll.deviceId,
        deviceToken: p.deviceToken,
      })
    ).status,
  ).toBe(429);
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
        "/api/v1/device-authorizations/inspect",
        "POST",
        { code: p.userCode },
        a,
      )
    ).status,
  ).toBe(410);
  expect(
    (
      await request(
        "/api/v1/device-authorizations/approve",
        "POST",
        { code: p.userCode, replaceDeviceId: null },
        a,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await request("/api/v1/device-authorizations/poll", "POST", {
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
    "/api/v1/device-authorizations/approve",
    "POST",
    { code: p.userCode, replaceDeviceId: null },
    a,
  );
  expect(
    (
      await request("/api/v1/device-authorizations", "DELETE", {
        requestId: p.requestId,
        pollSecret: p.pollSecret,
      })
    ).status,
  ).toBe(200);
  expect(
    (await (await request("/api/v1/device", "GET", undefined, a)).json<any>())
      .device,
  ).toBe(null);
  expect(
    (
      await request(
        "/api/v1/device-authorizations/approve",
        "POST",
        { code: p.userCode, replaceDeviceId: null },
        a,
      )
    ).status,
  ).toBe(409);
});
it("revocation removes snapshot/device atomically and a user cannot revoke another user", async () => {
  const a = await actor(1),
    b = await actor(2);
  await upload(a);
  await upload(b);
  expect((await request("/api/v1/device", "DELETE", undefined, a)).status).toBe(
    200,
  );
  expect((await upload(a, 2)).status).toBe(401);
  expect(
    (await (await request("/api/v1/quota", "GET", undefined, a)).json<any>())
      .snapshot,
  ).toBe(null);
  expect(
    (await (await request("/api/v1/quota", "GET", undefined, b)).json<any>())
      .snapshot,
  ).not.toBe(null);
});
it("same-origin protection rejects browser mutations and session deletion cascades only its user data", async () => {
  const a = await actor(1),
    b = await actor(2);
  await upload(a);
  expect(
    (
      await request("/api/v1/me", "DELETE", undefined, a, {
        Origin: "https://evil.example",
      })
    ).status,
  ).toBe(403);
  expect((await request("/api/v1/me", "DELETE", undefined, a)).status).toBe(
    200,
  );
  expect((await request("/api/v1/me", "GET", undefined, a)).status).toBe(401);
  expect((await upload(a, 2)).status).toBe(401);
  expect((await request("/api/v1/me", "GET", undefined, b)).status).toBe(200);
  expect(
    await env.DB.prepare("SELECT * FROM quota_snapshots WHERE user_id=?")
      .bind(a.id)
      .first(),
  ).toBe(null);
});
it("logout only invalidates the current browser session and keeps device sync active", async () => {
  const a = await actor();
  const response = await request("/auth/logout", "POST", undefined, a);
  expect(response.status).toBe(200);
  expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  expect((await request("/api/v1/me", "GET", undefined, a)).status).toBe(401);
  expect((await upload(a)).status).toBe(200);
});
it("OAuth uses state+PKCE, rejects forged state, requests minimal scope, and discards the GitHub token", async () => {
  const upstream = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      // Validate options in the real workerd Request implementation before
      // replacing only the upstream response with a fixture.
      const outbound = new Request(String(input), init);
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
      const outbound = new Request(String(input), init);
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
  expect((await request("/api/v1/me", "GET", undefined, a)).status).toBe(401);
  expect(
    (
      await request("/api/v1/device-authorizations/poll", "POST", {
        requestId: p.requestId,
        pollSecret: p.pollSecret,
      })
    ).status,
  ).toBe(410);
  expect(
    await env.DB.prepare("SELECT * FROM oauth_states LIMIT 1").first(),
  ).toBe(null);
  expect((await upload(a)).status).toBe(200);
});
