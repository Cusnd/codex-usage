// Query-observer benchmark; browser mounting/route acceptance is a separate CUA check.
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { SYNC_VERSION, type CloudCompatibility } from '../modules/contracts/cloud-version.js';

const label = process.argv[2] ?? 'before';
if (!['before', 'after'].includes(label)) throw new Error('Use before or after.');
const evidence = 'artifacts/cloud-experience/gate';
const source = await readFile('modules/web/shell/cloud-gate.tsx', 'utf8');
if (label === 'before' && !source.includes('&&!version.error&&!blocked')) throw new Error('Baseline predicate changed.');
const policyModule = label === 'after' ? await import('../modules/web/shell/cloud-version-session.js') : null;
const compatible: CloudCompatibility = { requiredVersion: SYNC_VERSION, browserVersion: SYNC_VERSION, compatible: true,
  devices: [{ id: 'synthetic-device', name: 'Synthetic', syncVersion: SYNC_VERSION, compatible: true }] };
const rows = [];
for (let round = 0; round < 7; round++) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, networkMode: 'always' } } });
  const started = performance.now(), trace: { event: string; atMs: number }[] = [];
  const mark = (event: string) => trace.push({ event, atMs: performance.now() - started });
  const session = policyModule ? new policyModule.CloudVersionSession() : null;
  let fail = false;
  const me = new QueryObserver(client, { queryKey: ['me'], queryFn: async () => {
    mark('me:start'); await delay(40); mark('me:end'); return { user: { id: 'synthetic-user' } };
  } });
  const offMe = me.subscribe(() => {});
  await me.refetch();
  const version = new QueryObserver(client, { queryKey: ['version', me.getCurrentResult().data!.user.id], queryFn: async () => {
    const ticket = session?.begin();
    if (fail) {
      const error = Object.assign(new TypeError('Synthetic offline fetch'), { code: 'CLOUD_NETWORK_ERROR' });
      session?.fail(ticket!, error); throw error;
    }
    mark('compatibility:start'); await delay(60); mark('compatibility:end');
    session?.succeed(ticket!, compatible); return compatible;
  } });
  const offVersion = version.subscribe(() => {});
  await version.refetch();
  const visible = () => session ? session.state.allowed : !!version.getCurrentResult().data?.compatible && !version.getCurrentResult().error;
  const readyMs = performance.now() - started, beforeFailure = visible();
  // Trigger the same query operation as the 15-second interval without sleeping 15 seconds.
  fail = true; await version.refetch();
  rows.push({ round, readyMs, trace, beforeFailure, afterTransientFailure: visible(),
    cachedCompatibilityRetained: !!version.getCurrentResult().data?.compatible });
  offMe(); offVersion(); client.clear();
}
const median = [...rows].sort((a, b) => a.readyMs - b.readyMs)[Math.floor(rows.length / 2)].readyMs;
const result = { label, measuredAt: new Date().toISOString(), node: process.version,
  gateSourceSha256: createHash('sha256').update(source).digest('hex'), method: {
    kind: 'Real TanStack QueryObserver with controlled request delays; no browser rendering or actual network',
    meDelayMs: 40, compatibilityDelayMs: 60, rounds: rows.length,
    transientFailure: 'Manual refetch corresponding to production 15000 ms poll; poll waiting time is not simulated wall time',
  }, medianReadyMs: median, rows };
await mkdir(evidence, { recursive: true });
await writeFile(`${evidence}/${label}.json`, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ label, medianReadyMs: median, rows: rows.length,
  transientContentPreserved: rows.every(row => row.afterTransientFailure) }, null, 2));
