// Local-only authenticated HTTP comparison; this does not measure browser rendering.
import { writeFile } from 'node:fs/promises';
import { SYNC_HEADER, SYNC_VERSION } from '../modules/contracts/sync-version.js';
const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:18789').origin;
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('Local synthetic fixture only.');
let cookie = '';
async function call(path: string, method = 'GET') {
  const response = await fetch(origin + path, { method, headers: { Origin: origin,
    [SYNC_HEADER]: SYNC_VERSION, ...(cookie ? { Cookie: cookie } : {}) } });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const data = await response.json();
  if (!response.ok) throw new Error(`Fixture ${path}: ${response.status}`);
  return data;
}
await call('/api/test/version/start', 'POST');
await call('/api/test/version/match', 'POST');
const rows = [];
for (let round = 0; round < 7; round++) {
  for (const variant of round % 2 ? ['bootstrap', 'serial'] : ['serial', 'bootstrap']) {
    const start = performance.now();
    const identity = await call(variant === 'serial' ? '/api/v3/me' : '/api/v3/me?bootstrap=1');
    const compatibility = variant === 'serial' ? await call('/api/v3/compatibility') : identity.compatibility;
    if (!identity.user?.id || compatibility?.compatible !== true) throw new Error('Incomplete authenticated bootstrap');
    rows.push({ round, variant, ms: performance.now() - start, requestCount: variant === 'serial' ? 2 : 1 });
  }
}
const median = (variant: string) => rows.filter(row => row.variant === variant).map(row => row.ms).sort((a, b) => a - b)[3];
const result = { measuredAt: new Date().toISOString(), node: process.version, origin,
  method: 'Real local Workerd/D1 authenticated requests, same synthetic user; each me/compatibility HTTP request delayed 120 ms by fixture. AB/BA ordering, 7 pairs. No browser/production latency claim.',
  medianSerialMs: median('serial'), medianBootstrapMs: median('bootstrap'), rows };
await writeFile('artifacts/cloud-experience/gate/bootstrap-http.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ medianSerialMs: result.medianSerialMs, medianBootstrapMs: result.medianBootstrapMs, rows: rows.length }, null, 2));
