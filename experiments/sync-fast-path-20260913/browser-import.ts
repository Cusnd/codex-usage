import { IndexedDbCloudCache, emptyState, namespaceOf, type ReadLease } from '../legacy-browser-mirror-20260913/browser/cache.js';
import { entityHash, verifyEntities } from '../legacy-browser-mirror-20260913/browser/verify.js';
import type { SyncEntity } from '../../modules/contracts/sync.js';
import { shadowImport } from './browser-shadow.js';

// A local-only receiving-side experiment. No application routes or production state.
const shadowMode = new URLSearchParams(location.search).get('mode') === 'shadow';
const button = document.createElement('button'); button.textContent = shadowMode ? '运行 25k 原子代次对照' : '运行 25k 实体接收端实验';
const out = document.createElement('pre'); document.body.append(button, out);
const report = { browser: navigator.userAgent, mode: shadowMode ? 'shadow' : 'batching', rows: 25000, payload: 'deterministic structured tokens plus 512 hex characters per event',
  networkIncluded: false, samples: [] as Record<string, unknown>[], checks: [] as string[], complete: false, error: '' };
const render = () => { out.textContent = JSON.stringify(report, null, 2); };
render();
button.onclick = async () => {
  button.disabled = true;
  try {
    const entities: SyncEntity[] = [];
    let random = 0x172913ab;
    const next = () => { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return (random >>> 0).toString(16).padStart(8, '0'); };
    for (let i = 0; i < report.rows; i++) {
      const value = { event_id: `event-${i}`, thread_id: `thread-${i % 250}`, project_id: `project-${i % 25}`,
        model: ['gpt-5.5', 'gpt-6-astra', 'gpt-5.6-sol'][i % 3], at: `2026-09-${String(i % 12 + 1).padStart(2, '0')}T12:00:00Z`,
        input_tokens: String(9007199254741001n + BigInt(i)), output_tokens: String(i * 17), metadata: Array.from({ length: 64 }, next).join('') };
      entities.push({ kind: 'event', id: String(i).padStart(6, '0'), revision: 1, hash: await entityHash(value), value });
    }
    const cut = { dataset_epoch: 'synthetic-fast-path', commit_seq: 1, deletion_version: 0, organization_version: 0, config_version: 0 };
    const lease: ReadLease = { lease_id: 'synthetic', scope: 'full', cut, total_entities: entities.length,
      expected_entities: [{ kind: 'event', count: entities.length }], expires_at: new Date(Date.now() + 3600000).toISOString() };
    // AB/BA/AB. All source generation, correctness readback and cleanup stay outside the timed interval.
    for (const [round, order] of [[1, [100, 1000]], [2, [1000, 100]], [3, [100, 1000]]] as const) {
      for (const batchSize of order) {
        if (shadowMode && batchSize === 1000) { report.samples.push(await shadowImport(entities, round)); render(); continue; }
        const name = 'codex-sync-experiment-' + crypto.randomUUID();
        const namespace = namespaceOf({ origin: location.origin, userId: 'synthetic-import', deviceIds: [] });
        const cache = new IndexedDbCloudCache(indexedDB, name);
        let state = emptyState(namespace);
        await cache.state(namespace);
        let verifyMs = 0, stageMs = 0;
        const start = performance.now();
        for (let offset = 0; offset < entities.length; offset += batchSize) {
          const batch = entities.slice(offset, offset + batchSize);
          let clock = performance.now(); await verifyEntities(batch); verifyMs += performance.now() - clock;
          clock = performance.now();
          state = await cache.write(state, { state, stages: batch.map(entity => ({ type: 'entity', run: lease.lease_id,
            entry: { kind: entity.kind, id: entity.id, revision: entity.revision, hash: entity.hash }, entity })) });
          stageMs += performance.now() - clock;
        }
        const promoteStart = performance.now();
        state = await cache.write(state, { state: { ...state, activeLease: lease, phase: 'full_ready', appliedCommitSeq: 1 },
          finalizeBaseline: lease.lease_id, clearStages: [lease.lease_id] });
        const promoteMs = performance.now() - promoteStart, totalMs = performance.now() - start;
        for (let offset = 0; offset < entities.length; offset += 1000) {
          const expected = entities.slice(offset, offset + 1000), actual = await cache.entities(namespace, cut.dataset_epoch, expected);
          if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Complete entity content differs');
        }
        if ((await cache.stages(namespace, lease.lease_id)).length || state.phase !== 'full_ready') throw new Error('Incomplete promotion');
        cache.close();
        await new Promise<void>((resolve, reject) => { const req = indexedDB.deleteDatabase(name); req.onsuccess = () => resolve(); req.onerror = () => reject(req.error); });
        report.samples.push({ round, variant: 'current-cache', batchSize, verifyMs, stageMs, promoteMs, totalMs, fullEntityEquality: true, stageCleared: true }); render();
      }
    }
    let rejected = false;
    try { await verifyEntities([{ ...entities[0], value: { corrupted: true } }]); } catch { rejected = true; }
    if (!rejected) throw new Error('Corrupted entity was not rejected');
    report.checks.push('All six imports preserve every value including exact decimal big integers', shadowMode ? 'Shadow generations switched only after complete verification; current-cache staging cleared' : 'All six staging areas cleared after atomic promotion', 'Corrupt content hash rejected');
    report.complete = true;
  } catch (error) { report.error = String(error); }
  render(); await fetch('/results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
};
