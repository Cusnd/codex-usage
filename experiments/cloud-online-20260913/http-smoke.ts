// Fixture sanity only. Browser acceptance is performed separately with CUA.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { SYNC_HEADER, SYNC_VERSION } from '../../modules/contracts/cloud-version.js';
const origin = 'http://127.0.0.1:18790';
let cookie = '';
const checks: string[] = [];
async function call(path: string, method = 'GET', body?: unknown, status: number | number[] = 200) {
  const response = await fetch(origin + path, { method, headers: { Origin: origin, Cookie: cookie, [SYNC_HEADER]: SYNC_VERSION,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (response.headers.has('Set-Cookie')) cookie = response.headers.get('Set-Cookie')!.split(';')[0];
  const data = await response.json() as any;
  assert.ok((Array.isArray(status) ? status : [status]).includes(response.status), path + ': status ' + response.status + ': ' + JSON.stringify(data)); return data;
}
const seed = await call('/api/test/online/' + (process.argv[2] === '1000' ? 'seed-1000' : 'seed'), 'POST');
assert.equal(seed.totalTokens, 90000); checks.push('real two-device synthetic ingest');
const view = await call('/api/v3/view', 'POST', {}, 201);
assert.deepEqual(Object.keys(view).sort(), ['cut', 'expires_at', 'lease_id', 'settings', 'user_id']);
const summary = (lease: string, expectedStatus = 200) => call('/api/v3/usage/local/summary?lease_id=' + encodeURIComponent(lease), 'GET', undefined, expectedStatus);
assert.equal((await summary(view.lease_id)).data.totalTokens, '90000');
checks.push('page view lightweight shape and all-device exact total');
const devices = (await call('/api/v3/devices')).devices as { id: string; name: string }[];
const b = devices.find(row => row.name.includes('设备 B'))!; assert.ok(b);
const scoped = await call('/api/v3/view', 'POST', { device_ids: [b.id] }, 201);
assert.equal((await summary(scoped.lease_id)).data.totalTokens, '18000'); checks.push('device scope exact total');
assert.equal((await call('/api/v3/accounts')).accounts[0].quota.buckets[0].primary.usedPercent, 25); checks.push('real synthetic quota endpoint');
await call('/api/test/online/advance', 'POST');
assert.equal((await summary(view.lease_id)).data.totalTokens, '90000');
const renewed = await call('/api/v3/view/' + encodeURIComponent(view.lease_id) + '/renew', 'POST');
assert.deepEqual(renewed.cut, view.cut);
const fresh = await call('/api/v3/view', 'POST', {}, 201);
assert.equal((await summary(fresh.lease_id)).data.totalTokens, '99000'); checks.push('new cut advances while existing/renewed view stays fixed');
await call('/api/test/online/fail-view', 'POST');
await call('/api/v3/view', 'POST', {}, 503);
await call('/api/test/online/recover', 'POST'); checks.push('controllable API 503 and recovery');
const deleted = await call('/api/test/online/delete-b', 'POST', undefined, [200, 202]); assert.ok(['deleted', 'deleting'].includes(deleted.status));
await summary(fresh.lease_id, 409);
if (deleted.status === 'deleting') {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await call('/api/v3/sync/status')).mode === 'ready') { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.ok(ready, 'bounded asynchronous deletion completed');
}
const afterDeletion = await call('/api/v3/view', 'POST', {}, 201);
assert.equal((await summary(afterDeletion.lease_id)).data.totalTokens, '72000'); checks.push('real deletion rejects old cut and removes B');
await call('/api/test/online/expire', 'POST');
await call('/api/v3/me?bootstrap=1', 'GET', undefined, 401); checks.push('real session revocation');
await mkdir('artifacts/cloud-online-20260913', { recursive: true });
const result = { at: new Date().toISOString(), kind: 'HTTP fixture sanity, not browser acceptance or performance benchmark', seedEvents: seed.tokenEventCount, checks };
await writeFile('artifacts/cloud-online-20260913/http-smoke' + (process.argv[2] === '1000' ? '-1000' : '') + '.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
