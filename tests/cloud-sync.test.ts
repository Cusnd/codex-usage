import {versionedFetch} from './fixtures/versioned-fetch.js';
import {SYNC_VERSION} from '../modules/contracts/cloud-version.js';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../modules/storage/sqlite.js";
import { CloudSync } from "../modules/sync/upload/session.js";
import {cloudSnapshot} from '../modules/accounts/publisher.js';
import type { LimitObservation } from "../modules/accounts/refresh.js";
import { isCloudSnapshot, type CloudSnapshot } from "../modules/contracts/cloud.js";

const baseTime = Date.parse("2026-09-10T00:00:00.000Z");
function observation(patch: Partial<LimitObservation> = {}): LimitObservation {
  return {
    identityKey: "secret-raw-account@example.com",
    identityKnown: true,
    stableIdentity: "synthetic-stable-identity",
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
function fixture(serverBuild:()=>string|null=()=>SYNC_VERSION) {
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
    if(route==='/api/v3/collector/config')return Response.json({accountKey:'k'.repeat(43),paused:false});
    if(route==='/api/v3/collector/pause')return Response.json({ok:true});
    assert.equal(route,'/api/v3/accounts/observations');
    uploads.push(JSON.parse(String(init.body)).quota);
    return Response.json({acceptedSequence:uploads.at(-1)!.sequence});
  }) as typeof fetch;
  const uploader={status:()=>({error:null,collectedAt:null,uploadedAt:null,nextUploadAt:null,pendingBatches:0}),takeNextTickDelayMs:()=>1000,tick:async()=>{},cancel(){},unbind:async()=>{},close:async()=>{}} as unknown as import('../modules/sync/upload/uploader.js').V3Uploader;
  const options = {
    uploader,
    credentialFile: path.join(directory, "cloud-credentials.json"),
    fetch: versionedFetch(fetcher,serverBuild),
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
    "s".repeat(43),
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
test("confirmed-account collection failure retains measured values with error status", () => {
  const snapshot = cloudSnapshot(
    observation({ errorCode: "HTTP_TIMEOUT" }),
    "s".repeat(43),
    "device-1",
    2,
  );
  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.collectedAt, "2026-09-09T00:00:00.000Z");
  assert.equal(snapshot.buckets[0].primary?.remainingPercent, 75);
  assert.ok(isCloudSnapshot(snapshot));
});
test("disconnect cancels an unconfirmed request, including an approval race", async () => {
  const f = fixture();
  try {
    await f.cloud.connect();
    await f.cloud.disconnect();
    assert.ok(f.calls.includes("DELETE /api/v3/device-authorizations"));
    assert.ok(f.calls.includes("DELETE /api/v3/device"));
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
    assert.ok(f.calls.includes("DELETE /api/v3/device"));
    assert.equal(f.cloud.status().revokePending, false);
    assert.equal(f.cloud.status().connected, false);
  } finally { await f.dispose(); }
});


test('a version mismatch cannot prevent revoking a binding without sending statistics',async()=>{
  let build=SYNC_VERSION;const f=fixture(()=>build);
  try{
    await f.bind();const uploads=f.uploads.length;build='0.1.6+old-cloud';
    await f.cloud.disconnect();await f.cloud.tick();
    assert.equal(f.cloud.status().connected,false);assert.equal(f.cloud.status().revokePending,false);
    assert.equal(f.uploads.length,uploads);assert.ok(f.calls.includes('DELETE /api/v3/device'));
  }finally{await f.dispose();}
});
