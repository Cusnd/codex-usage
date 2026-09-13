import type { SyncEntity } from '../../modules/contracts/sync.js';
import { entityHash, verifyEntities } from '../legacy-browser-mirror-20260913/browser/verify.js';

// Receiving-side fixture only. It is deliberately separate from production cache
// stores and does not implement delta overlays, garbage collection or migration.
type Active = { key: string[]; version: number; activeGeneration: string };
type Generation = { key: string[]; expected: number; expectedCounts: Record<string, number>; written: number; counts: Record<string, number>; complete: boolean };
type Body = { namespace: string; generation: string; kind: SyncEntity['kind']; id: string; entity: SyncEntity };

const request = <T>(value: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error);
});
const completion = (tx: IDBTransaction) => {
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Shadow transaction aborted'));
  });
  // A request can reject before its transaction; observe both error channels.
  done.catch(() => {}); return done;
};
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const sameValue = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a), right = Object.keys(b);
  return left.length === right.length && left.every(key => Object.hasOwn(b, key) && sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
};

/** Import one complete snapshot into a fresh temporary IndexedDB, then delete it. */
export async function shadowImport(entities: SyncEntity[], round: number): Promise<Record<string, unknown>> {
  const name = 'codex-shadow-experiment-' + crypto.randomUUID();
  const namespace = JSON.stringify([location.origin, 'synthetic-shadow-import', []]);
  const previous = 'previous', generation = 'candidate';
  const activeKey = [namespace, 'active'], generationKey = [namespace, 'generation', generation];
  const expectedCounts: Record<string, number> = {};
  for (const entity of entities) expectedCounts[entity.kind] = (expectedCounts[entity.kind] ?? 0) + 1;
  const opening = indexedDB.open(name, 1);
  opening.onupgradeneeded = () => {
    const bodies = opening.result.createObjectStore('bodies', { keyPath: ['namespace', 'generation', 'kind', 'id'] });
    bodies.createIndex('generation', ['namespace', 'generation']);
    opening.result.createObjectStore('versions', { keyPath: 'key' });
  };
  const db = await request(opening);
  try {
    const oldValue = { oldGeneration: true, exactTokens: '9007199254740993' };
    const oldEntity: SyncEntity = { kind: 'event', id: 'previous-sentinel', revision: 1, hash: await entityHash(oldValue), value: oldValue };
    const init = db.transaction(['bodies', 'versions'], 'readwrite'), initialized = completion(init);
    init.objectStore('bodies').add({ namespace, generation: previous, kind: oldEntity.kind, id: oldEntity.id, entity: oldEntity } satisfies Body);
    init.objectStore('versions').add({ key: activeKey, version: 0, activeGeneration: previous } satisfies Active);
    init.objectStore('versions').add({ key: generationKey, expected: entities.length, expectedCounts, written: 0, counts: {}, complete: false } satisfies Generation);
    await initialized;

    const active = async () => {
      const tx = db.transaction('versions', 'readonly'), done = completion(tx);
      const value = await request(tx.objectStore('versions').get(activeKey)) as Active; await done; return value;
    };
    const oldStillReadable = async () => {
      const tx = db.transaction(['versions', 'bodies'], 'readonly'), done = completion(tx);
      const view = await request(tx.objectStore('versions').get(activeKey)) as Active;
      const body = await request(tx.objectStore('bodies').get([namespace, view.activeGeneration, oldEntity.kind, oldEntity.id])) as Body | undefined;
      await done; assert(view.activeGeneration === previous && body && sameValue(body.entity, oldEntity), 'Old generation became unreadable during construction');
    };
    const promote = async (expectedVersion: number): Promise<'switched' | 'incomplete' | 'conflict'> => {
      const tx = db.transaction('versions', 'readwrite'), done = completion(tx), store = tx.objectStore('versions');
      const [view, candidate] = await Promise.all([request(store.get(activeKey)) as Promise<Active>, request(store.get(generationKey)) as Promise<Generation>]);
      if (!candidate.complete) { await done; return 'incomplete'; }
      if (view.version !== expectedVersion) { await done; return 'conflict'; }
      store.put({ key: activeKey, version: expectedVersion + 1, activeGeneration: generation } satisfies Active);
      await done; return 'switched';
    };
    const guardChecks: string[] = [];
    let verifyMs = 0, stageMs = 0, promoteMs = 0, excludedChecksMs = 0, checkedDuringBuild = false;
    const seen = new Set<string>();
    const checkDuringBuild = async () => {
      const started = performance.now();
      await oldStillReadable();
      assert(await promote(0) === 'incomplete', 'Incomplete generation was promoted');
      assert((await active()).activeGeneration === previous, 'Rejected incomplete promotion changed the active pointer');
      guardChecks.push('Previous generation remains readable while candidate is staged', 'Incomplete candidate cannot switch active generation');
      excludedChecksMs += performance.now() - started; checkedDuringBuild = true;
    };

    const started = performance.now();
    for (let offset = 0; offset < entities.length; offset += 1000) {
      const batch = entities.slice(offset, offset + 1000);
      let clock = performance.now();
      await verifyEntities(batch); // The exact same production SHA-256 validation.
      for (const entity of batch) {
        const key = JSON.stringify([entity.kind, entity.id]);
        assert(!seen.has(key), 'Duplicate entity across snapshot chunks'); seen.add(key);
      }
      verifyMs += performance.now() - clock;

      clock = performance.now();
      const tx = db.transaction(['bodies', 'versions'], 'readwrite'), done = completion(tx);
      try {
        const versions = tx.objectStore('versions'), bodies = tx.objectStore('bodies');
        const candidate = await request(versions.get(generationKey)) as Generation;
        assert(!candidate.complete, 'Cannot append to sealed generation');
        for (const entity of batch) {
          // add rejects duplicates rather than silently overwriting a prior body.
          bodies.add({ namespace, generation, kind: entity.kind, id: entity.id, entity } satisfies Body);
          candidate.counts[entity.kind] = (candidate.counts[entity.kind] ?? 0) + 1;
        }
        candidate.written += batch.length; versions.put(candidate); await done;
      } catch (error) { try { tx.abort(); } catch {} await done.catch(() => {}); throw error; }
      stageMs += performance.now() - clock;
      if (!checkedDuringBuild) await checkDuringBuild();
    }
    if (!checkedDuringBuild) await checkDuringBuild();

    // Count validation and sealing are included in promotion time. No entity
    // bodies are copied here; the physical index and durable metadata must agree.
    let clock = performance.now();
    const seal = db.transaction(['bodies', 'versions'], 'readwrite'), sealed = completion(seal);
    try {
      const versions = seal.objectStore('versions');
      const [candidate, physicalCount] = await Promise.all([
        request(versions.get(generationKey)) as Promise<Generation>,
        request(seal.objectStore('bodies').index('generation').count(IDBKeyRange.only([namespace, generation]))),
      ]);
      assert(candidate.written === candidate.expected && physicalCount === candidate.expected && seen.size === candidate.expected && sameValue(candidate.counts, candidate.expectedCounts), 'Snapshot hash-verified count does not match expected complete set');
      candidate.complete = true; versions.put(candidate); await sealed;
    } catch (error) { try { seal.abort(); } catch {} await sealed.catch(() => {}); throw error; }
    promoteMs += performance.now() - clock;

    clock = performance.now();
    assert(await promote(-1) === 'conflict', 'Wrong CAS version was accepted');
    await oldStillReadable();
    guardChecks.push('CAS version mismatch cannot switch active generation');
    excludedChecksMs += performance.now() - clock;

    clock = performance.now();
    assert(await promote(0) === 'switched', 'Complete verified generation did not promote');
    promoteMs += performance.now() - clock;
    const totalMs = performance.now() - started - excludedChecksMs;

    // Full field-by-field readback, old-generation preservation and cleanup are
    // deliberately outside the import timing, as in the production-cache fixture.
    const view = await active();
    assert(view.activeGeneration === generation && view.version === 1, 'Active generation CAS result is incorrect');
    for (let offset = 0; offset < entities.length; offset += 1000) {
      const batch = entities.slice(offset, offset + 1000), tx = db.transaction('bodies', 'readonly'), done = completion(tx);
      const actual = await Promise.all(batch.map(entity => request(tx.objectStore('bodies').get([namespace, view.activeGeneration, entity.kind, entity.id])) as Promise<Body | undefined>));
      await done;
      actual.forEach((body, index) => assert(body && sameValue(body.entity, batch[index]), 'Complete shadow entity content differs'));
    }
    const oldTx = db.transaction('bodies', 'readonly'), oldDone = completion(oldTx);
    const retained = await request(oldTx.objectStore('bodies').get([namespace, previous, oldEntity.kind, oldEntity.id])) as Body | undefined;
    await oldDone; assert(retained && sameValue(retained.entity, oldEntity), 'Promotion unexpectedly removed the previous generation');
    guardChecks.push('Complete imported entities compare field-by-field including exact token strings', 'Promotion retains old generation without copying target bodies');
    return { round, variant: 'shadow-generation', batchSize: 1000, rows: entities.length, verifyMs, stageMs, promoteMs, totalMs,
      targetBodyWrites: entities.length, fullEntityEquality: true, previousGenerationRetained: true, activeGenerationSwitched: true,
      excludedChecksMs, checks: guardChecks, limitations: ['No network or snapshot generation included', 'No delta overlays, GC, multi-tab reset or production migration implemented'] };
  } finally {
    db.close();
    await request(indexedDB.deleteDatabase(name));
  }
}
