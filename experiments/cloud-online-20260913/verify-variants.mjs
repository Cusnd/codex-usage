// HTTP verification only; does not launch/control a browser. Restores candidate.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Script } from 'node:vm';
const origin = 'http://127.0.0.1:18790';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const select = variant => fetch(origin + '/api/test/online/variant-' + variant, { method: 'POST', headers: { Origin: origin } });
const rows = [];
try {
  for (const variant of ['baseline', 'candidate']) {
    assert.equal((await select(variant)).status, 200);
    const response = await fetch(origin + '/'); assert.equal(response.status, 200);
    const html = await response.text(), resources = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]);
    const telemetryURL = '/__online-telemetry.js?variant=' + variant;
    assert.ok(resources.includes(telemetryURL));
    const csp = response.headers.get('Content-Security-Policy'); assert.match(csp, /script-src 'self'/); assert.ok(!csp.includes("script-src 'self' 'unsafe-inline'"));
    const telemetryResponse = await fetch(origin + telemetryURL); assert.equal(telemetryResponse.status, 200);
    const telemetry = await telemetryResponse.text(); new Script(telemetry); assert.ok(telemetry.includes('window.__cloudOnlineVariant=' + JSON.stringify(variant)));
    const script = resources.find(resource => /^\/assets\/index-.*\.js$/.test(resource)); assert.ok(script);
    if (variant === 'baseline') assert.equal(script, '/assets/index-Dfn7gbQe.js'); else assert.notEqual(script, '/assets/index-Dfn7gbQe.js');
    const assets = [];
    for (const resource of resources.filter(resource => resource.startsWith('/assets/'))) {
      const served = await fetch(origin + resource); assert.equal(served.status, 200);
      const bytes = new Uint8Array(await served.arrayBuffer());
      assert.equal(digest(bytes), digest(await readFile('artifacts/cloud-online-20260913/build' + resource)));
      assets.push({ resource, status: served.status, bytes: bytes.length, sha256: digest(bytes) });
    }
    rows.push({ variant, csp, script, telemetryResourceStatus: telemetryResponse.status, telemetrySyntaxValid: true, assets });
  }
} finally { await select('candidate'); }
const result = { at: new Date().toISOString(), kind: 'HTTP variant/resource verification; browser instrumentation execution still requires CUA', rows, restoredVariant: 'candidate' };
await writeFile('artifacts/cloud-online-20260913/variant-http.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
