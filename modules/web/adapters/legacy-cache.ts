import { SYNC_VERSION } from '../../contracts/sync-version.js';

/** Retire only this application's offline data. Never open or rebuild a cache database. */
export async function removeLegacyCloudCache(factory = globalThis.indexedDB) {
  try { globalThis.localStorage?.removeItem('codex-usage:last-cloud-user:v3'); } catch { /* Storage can be disabled. */ }
  if (!factory) return;
  try {
    const names = typeof factory.databases === 'function' ? (await factory.databases()).map(db => db.name) : [`codex-usage-cloud-${SYNC_VERSION}`];
    for (const name of names) if (name?.startsWith('codex-usage-cloud-')) {
      const request = factory.deleteDatabase(name);
      request.onerror = () => {}; // An older tab must not prevent the online page from opening.
    }
  } catch { /* Online reads do not depend on storage availability. */ }
}
