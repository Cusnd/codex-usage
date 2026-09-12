// Production-build smoke check with an empty home; never uses the user's Codex login.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createApp } from "../dist/apps/local/app.js";

const root = await mkdtemp(path.join(os.tmpdir(), "codex-smoke-中文 空格-"));
process.env.CODEX_BIN = path.join(root, "not-installed.exe");
const { app, refresh } = await createApp({ codexHome: root, database: path.join(root, "usage.sqlite") });
try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  await refresh.wait();
  const { port } = app.server.address();
  for (const route of ["/", "/api/status", "/api/local/summary", "/api/account/limits", "/api/account/usage", "/docs/", "/openapi.json"]) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`);
    assert.equal(response.status, 200, route);
    if (route === "/") {
      const html = await response.text();
      const asset = html.match(/src="([^"]+\.js)"/)?.[1];
      assert.ok(asset, "production JS asset exists");
      assert.equal((await fetch(`http://127.0.0.1:${port}${asset}`)).status, 200);
    }
  }
  assert.equal(refresh.status.local.error, null);
  assert.ok(refresh.status.accountLimits.error);
  assert.ok(refresh.status.accountHistory.error);
  console.log("PASS: production assets/API, empty home, missing CLI, independent account errors.");
} finally {
  await app.close();
  await rm(root, { recursive: true, force: true });
}
