import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { CloudUsageDataSource } from '../browser/data-source.js';
import { setupExperience, cut, identity } from './cloud-experience-browser-fixture.js';

const phase = process.argv[2] ?? 'replay', delayMs = Number(process.env.CLOUD_EXPERIENCE_RTT ?? 80), repeats = Number(process.env.CLOUD_EXPERIENCE_REPEATS ?? 3);
const root = 'artifacts/legacy-browser-mirror-20260913/browser'; mkdirSync(root, { recursive: true });
const samples: unknown[] = [];
for (let repeat = 0; repeat < repeats; repeat++) {
  const { controller, transport, cache } = await setupExperience(1000, true, delayMs);
  const start = performance.now(), work = controller.trigger('initial');
  const recent = await controller.view(), recentMs = performance.now() - start; await work;
  assert.ok(recent); assert.equal(recent.scope, 'recent'); assert.equal(controller.state().phase, 'full_ready');
  const stored = await cache.entities(controller.namespace, cut.dataset_epoch, transport.rows);
  assert.deepEqual(stored, transport.rows);
  samples.push({ repeat, operation: 'cold_recent_and_full', recentMs, fullMs: performance.now() - start, counts: { ...transport.counts }, maximumBodies: transport.maximumBodies });

  let requests = 0, projectRequests = 0;
  const source = new CloudUsageDataSource(controller, async <T>(url: string): Promise<T> => {
    if (url.startsWith('/api/v3/projects')) projectRequests++; else requests++;
    await transport.wait();
    return (url.startsWith('/api/v3/projects') ? { lease_id: new URL(url, identity.origin).searchParams.get('lease_id'), cut, projects: [{ id: 'project-one', name: 'Project one' }], aliases: {} }
      : { data: { project: 'project-one', totalTokens: '9007199254740993' }, meta: { source: 'cloud', updatedAt: null, timezone: 'UTC', warnings: [], cut } }) as T;
  }, () => true);
  let started = performance.now();
  const duplicates = await Promise.all(Array.from({ length: 6 }, () => source.query('local/summary', { model: 'fixture' })));
  duplicates.forEach(value => assert.deepEqual(value.data, duplicates[0].data));
  samples.push({ repeat, operation: 'same_query_fanout6', ms: performance.now() - started, requests, projectRequests });
  const lease = controller.state().activeLease!; transport.now = Date.parse(lease.expires_at) - 30_000;
  requests = 0; const renewBefore = transport.counts.renew; started = performance.now();
  await Promise.all(Array.from({ length: 6 }, (_, i) => source.query('local/summary', { model: `filter-${i}` })));
  samples.push({ repeat, operation: 'near_expiry_filters6', ms: performance.now() - started, requests, renewals: transport.counts.renew - renewBefore });
  transport.now = Date.parse(controller.state().activeLease!.expires_at) - 30_000; transport.invalid.add(lease.lease_id);
  const before = { ...transport.counts }; started = performance.now();
  const expired = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => source.query('local/summary', { model: `expired-${i}` })));
  const fulfilled = expired.filter(row => row.status === 'fulfilled');
  if (phase !== 'before') assert.equal(fulfilled.length, 6);
  samples.push({ repeat, operation: 'expired_lease_fanout6', ms: performance.now() - started, fulfilled: fulfilled.length,
    renewals: transport.counts.renew - before.renew, status: transport.counts.status - before.status, reads: transport.counts.read - before.read,
    errors: expired.filter(row => row.status === 'rejected').map(row => String((row as PromiseRejectedResult).reason)) });
  controller.dispose();
}
writeFileSync(`${root}/${phase}.json`, JSON.stringify({ node: process.version, phase, delayMs, repeats, samples }, null, 2));
console.log(JSON.stringify({ phase, delayMs, repeats, samples }, null, 2));
