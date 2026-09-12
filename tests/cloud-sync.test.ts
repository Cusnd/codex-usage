import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/db.js";
import { CloudSync, cloudSnapshot } from "../server/cloud-sync.js";
import type { LimitObservation } from "../server/refresh.js";
import { isCloudSnapshot, type CloudSnapshot } from "../shared/cloud.js";

const baseTime = Date.parse("2026-09-10T00:00:00.000Z");
function observation(patch: Partial<LimitObservation> = {}): LimitObservation {
  return {
    identityKey: "secret-raw-account@example.com",
    identityKnown: true,
    collectedAt: "2026-09-09T00:00:00.000Z",
    attemptedAt: "2026-09-09T00:00:00.000Z",
    provider: "app-server",
    refreshInterval: 300,
    errorCode: null,
    data: {
      accountId: "RAW-ACCOUNT-ID",
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
    },
    ...patch,
  };
}
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-cloud-test-"));
  const store = new Store(path.join(directory, "usage.sqlite"));
  let now = baseTime,
    reading = observation(),
    failUpload = false,
    failRevoke = false,
    throttle = false,
    uploads: CloudSnapshot[] = [],
    calls: string[] = [];
  const fetcher = (async (url: string | URL | Request, init: RequestInit) => {
    const route = new URL(String(url)).pathname;
    calls.push(init.method + " " + route);
    if (route.endsWith("/device-authorizations")) {
      if (init.method === "DELETE") {
        if (failRevoke) throw new Error("offline");
        return Response.json({ ok: true });
      }
      return Response.json(
        {
          requestId: "request-1",
          pollSecret: "p".repeat(43),
          userCode: "ABCD-2345",
          expiresAt: new Date(now + 600000).toISOString(),
        },
        { status: 201 },
      );
    }
    if (route.endsWith("/poll"))
      return Response.json({
        status: "approved",
        deviceId: "device-1",
        deviceName: "My laptop",
        userLogin: "tester",
      });
    if (route.endsWith("/device")) {
      if (failRevoke) throw new Error("offline");
      return Response.json({ ok: true });
    }
    assert.equal(route, "/api/v1/snapshot");
    if (failUpload) throw new Error("SENSITIVE-UPSTREAM-ERROR");
    if (throttle)
      return Response.json(
        { error: { code: "SYNC_RATE_LIMITED" } },
        { status: 429, headers: { "Retry-After": "120" } },
      );
    uploads.push(JSON.parse(String(init.body)));
    return Response.json({
      receivedAt: new Date(now).toISOString(),
      nextAllowedAt: new Date(now + 60000).toISOString(),
    });
  }) as typeof fetch;
  const options = {
    credentialFile: path.join(directory, "cloud-credentials.json"),
    fetch: fetcher,
    observation: async () => reading,
    refreshLimits: async () => {},
    now: () => now,
    random: () => 0.5,
  };
  let cloud = new CloudSync(store, options);
  return {
    store,
    options,
    get cloud() {
      return cloud;
    },
    get uploads() {
      return uploads;
    },
    get calls() {
      return calls;
    },
    advance: (ms: number) => {
      now += ms;
    },
    reading: (value: LimitObservation) => {
      reading = value;
    },
    fail: (value: boolean) => {
      failUpload = value;
    },
    failRevoke: (value: boolean) => {
      failRevoke = value;
    },
    throttle: (value: boolean) => {
      throttle = value;
    },
    bind: async () => {
      await cloud.connect("My laptop");
      await cloud.tick();
    },
    restart: async () => {
      await cloud.close();
      cloud = new CloudSync(store, options);
    },
    dispose: async () => {
      await cloud.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test("cloud payload enumerates quotas, preserves nulls and rejects extra sensitive fields", () => {
  const original = observation();
  (original.data as any).accessToken = "SENSITIVE-TOKEN";
  (original.data!.buckets[0] as any).email = "PRIVATE-EMAIL";
  const snapshot = cloudSnapshot(
    original,
    { salt: "s".repeat(43) },
    "device-1",
    1,
  );
  assert.ok(isCloudSnapshot(snapshot));
  assert.equal(snapshot.buckets[0].secondary, null);
  const encoded = JSON.stringify(snapshot);
  for (const secret of [
    "SENSITIVE-TOKEN",
    "PRIVATE-EMAIL",
    "RAW-ACCOUNT-ID",
    original.identityKey!,
  ])
    assert.ok(!encoded.includes(secret));
  assert.equal(isCloudSnapshot({ ...snapshot, accessToken: "no" }), false);
  assert.equal(
    isCloudSnapshot({
      ...snapshot,
      buckets: [{ ...snapshot.buckets[0], email: "no" }],
    }),
    false,
  );
  assert.equal(
    isCloudSnapshot({ ...snapshot, sequence: Number.MAX_SAFE_INTEGER + 1 }),
    false,
  );
});
test("sync is opt-in and local public state never returns bearer or salt", async () => {
  const f = fixture();
  try {
    await f.cloud.capture();
    await f.cloud.tick();
    assert.equal(f.calls.length, 0);
    assert.equal(f.cloud.status().enabled, false);
    await f.bind();
    const c = JSON.parse(readFileSync(f.options.credentialFile, "utf8"));
    assert.ok(!JSON.stringify(f.cloud.status()).includes(c.token));
    assert.ok(!JSON.stringify(f.cloud.status()).includes(c.salt));
    assert.ok(
      !String(f.store.one("SELECT value FROM cloud_sync")?.value).includes(
        c.token,
      ),
    );
  } finally {
    await f.dispose();
  }
});
test("rapid manual results coalesce, respect 60 seconds, and keep yesterday collectedAt", async () => {
  const f = fixture();
  try {
    await f.bind();
    assert.equal(f.uploads.length, 1);
    assert.equal(f.uploads[0].collectedAt, "2026-09-09T00:00:00.000Z");
    for (let i = 1; i <= 4; i++) {
      f.reading(
        observation({
          attemptedAt: new Date(baseTime + i * 1000).toISOString(),
        }),
      );
      await f.cloud.capture();
      await f.cloud.tick();
    }
    assert.equal(f.uploads.length, 1);
    assert.equal(f.cloud.status().pending, true);
    f.advance(59999);
    await f.cloud.tick();
    assert.equal(f.uploads.length, 1);
    f.advance(1);
    await f.cloud.tick();
    assert.equal(f.uploads.length, 2);
    assert.equal(f.uploads[1].attemptedAt, "2026-09-10T00:00:04.000Z");
    assert.equal(f.cloud.status().pending, false);
  } finally {
    await f.dispose();
  }
});
test("outbox survives restart, enforces Retry-After, and isolates sync errors", async () => {
  const f = fixture();
  try {
    f.fail(true);
    await f.bind();
    assert.equal(f.cloud.status().pending, true);
    assert.ok(!f.cloud.status().error?.includes("SENSITIVE"));
    await f.restart();
    f.advance(5000);
    f.fail(false);
    f.throttle(true);
    await f.cloud.tick();
    const next = Date.parse(f.cloud.status().nextUploadAt!);
    assert.ok(next >= baseTime + 125000);
    await f.restart();
    f.throttle(false);
    f.advance(119999);
    await f.cloud.tick();
    assert.equal(f.uploads.length, 0);
    f.advance(1);
    await f.cloud.tick();
    assert.equal(f.uploads.length, 1);
    assert.equal(f.uploads[0].collectedAt, "2026-09-09T00:00:00.000Z");
  } finally {
    await f.dispose();
  }
});
test("retry drops former account data when identity changes or becomes unknown", async () => {
  const f = fixture();
  try {
    f.fail(true);
    await f.bind();
    f.reading(
      observation({
        identityKey: "second-account",
        data: { accountId: "second", buckets: [] },
        collectedAt: "2026-09-10T00:00:01.000Z",
      }),
    );
    f.fail(false);
    f.advance(5000);
    await f.cloud.tick();
    assert.equal(f.uploads[0].buckets.length, 0);
    f.reading(
      observation({
        identityKnown: false,
        identityKey: null,
        data: null,
        errorCode: "IDENTITY_UNKNOWN",
      }),
    );
    await f.cloud.capture();
    f.advance(60000);
    await f.cloud.tick();
    assert.equal(f.uploads[1].accountRef, null);
    assert.equal(f.uploads[1].collectedAt, null);
    assert.deepEqual(f.uploads[1].buckets, []);
  } finally {
    await f.dispose();
  }
});
test("confirmed-account collection failure retains measured values with error status", () => {
  const snapshot = cloudSnapshot(
    observation({ errorCode: "HTTP_TIMEOUT" }),
    { salt: "s".repeat(43) },
    "device-1",
    2,
  );
  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.collectedAt, "2026-09-09T00:00:00.000Z");
  assert.equal(snapshot.buckets[0].primary?.remainingPercent, 75);
  assert.ok(isCloudSnapshot(snapshot));
});
test("pause keeps cloud snapshot, offline disconnect stops sends and resumes revocation after restart", async () => {
  const f = fixture();
  try {
    await f.bind();
    await f.cloud.setEnabled(false);
    f.advance(60000);
    await f.cloud.tick();
    assert.equal(f.uploads.length, 1);
    f.failRevoke(true);
    await f.cloud.disconnect();
    assert.equal(f.cloud.status().enabled, false);
    assert.equal(f.cloud.status().revokePending, true);
    await f.restart();
    f.advance(5000);
    f.failRevoke(false);
    await f.cloud.tick();
    assert.equal(f.cloud.status().connected, false);
    assert.equal(f.cloud.status().revokePending, false);
    assert.equal(f.uploads.length, 1);
  } finally {
    await f.dispose();
  }
});
test("disconnect cancels an unconfirmed request, including an approval race", async () => {
  const f = fixture();
  try {
    await f.cloud.connect();
    await f.cloud.disconnect();
    assert.ok(f.calls.includes("DELETE /api/v1/device-authorizations"));
    assert.ok(f.calls.includes("DELETE /api/v1/device"));
    assert.equal(f.cloud.status().binding, null);
  } finally {
    await f.dispose();
  }
});

test("expired binding revokes the proposed token after request cleanup, retaining it while offline", async () => {
  const f = fixture();
  try {
    await f.cloud.connect();
    f.advance(600001);
    await f.cloud.tick();
    assert.equal(f.cloud.status().revokePending, true);
    f.failRevoke(true);
    await f.cloud.tick();
    await f.restart();
    assert.equal(f.cloud.status().revokePending, true);
    await assert.rejects(f.cloud.connect(), /撤销/);
    f.failRevoke(false);
    f.advance(5000);
    await f.cloud.tick();
    assert.ok(f.calls.includes("DELETE /api/v1/device"));
    assert.equal(f.cloud.status().revokePending, false);
    assert.equal(f.cloud.status().connected, false);
  } finally { await f.dispose(); }
});
