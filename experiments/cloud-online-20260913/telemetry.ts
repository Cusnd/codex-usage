// Metadata-only instrumentation injected by the local fixture before the app.
export const telemetry = String.raw`(() => {
  const variant = window.__cloudOnlineVariant || 'candidate';
  const instrumentation = { scriptExecuted: true, startedAt: performance.now(), fetchInstalled: false, indexedDBHooks: {}, errors: [] };
  const run = crypto.randomUUID(), requests = [], indexedDBOperations = [], errors = [], milestones = {}, actions = [], summaryTransitions = [], leaseAliases = new Map();
  const indexedDBCounts = { total: 0, byOperation: {}, byStore: {}, omittedSamples: 0 };
  performance.setResourceTimingBufferSize(4000);
  const alias = id => id ? (leaseAliases.has(id) ? leaseAliases.get(id) : (leaseAliases.set(id, 'lease-' + (leaseAliases.size + 1)), leaseAliases.get(id))) : null;
  const originalFetchMethod = window.fetch, originalFetch = originalFetchMethod.bind(window);
  const redact = value => new URL(value, location.origin).pathname.replace(/\/sync\/read\/[^/]+\//, '/sync/read/:lease/').replace(/\/view\/[^/]+\/renew/, '/view/:lease/renew').replace(/\/devices\/[^/]+/, '/devices/:device');
  window.fetch = async function(input, init) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.origin);
    const path = redact(url.href);
    if (!path.startsWith('/api/v3/')) return originalFetch(input, init);
    const row = { path, method: init?.method || (input instanceof Request ? input.method : 'GET'), start: performance.now(), lease: alias(url.searchParams.get('lease_id')) };
    if (path === '/api/v3/view' && typeof init?.body === 'string') { try { row.deviceScopeCount = JSON.parse(init.body).device_ids?.length || 0; } catch {} }
    requests.push(row);
    try { const response = await originalFetch(input, init); row.status = response.status; row.end = row.headersEnd = performance.now();
      response.clone().arrayBuffer().then(bytes => { row.decodedResponseBytes = bytes.byteLength; row.bodyReadEnd = performance.now(); const data = JSON.parse(new TextDecoder().decode(bytes)); const cut = data?.cut || data?.meta?.cut; if (cut) row.cut = { commit_seq: cut.commit_seq, deletion_version: cut.deletion_version, organization_version: cut.organization_version, config_version: cut.config_version };
        const lease = data?.lease_id || data?.meta?.lease_id; if (lease) row.responseLease = alias(lease); }).catch(() => {});
      return response; }
    catch(error) { row.error = String(error); row.end = performance.now(); throw error; }
  };
  instrumentation.fetchInstalled = window.fetch !== originalFetchMethod;
  function instrument(target, method, describe) {
    const key = target.constructor.name + '.' + method;
    try { const original = target[method]; if (typeof original !== 'function') { instrumentation.indexedDBHooks[key] = false; return; }
      const wrapped = function(...args) { const details = describe(this, args); indexedDBCounts.total++; indexedDBCounts.byOperation[method] = (indexedDBCounts.byOperation[method] || 0) + 1;
        const store = (details.database || '') + '/' + (details.store || '') + '/' + method; indexedDBCounts.byStore[store] = (indexedDBCounts.byStore[store] || 0) + 1;
        if (indexedDBOperations.length < 250) indexedDBOperations.push({ at: performance.now(), operation: method, ...details }); else indexedDBCounts.omittedSamples++;
        return Reflect.apply(original, this, args); };
      target[method] = wrapped; instrumentation.indexedDBHooks[key] = target[method] === wrapped;
    } catch(error) { instrumentation.indexedDBHooks[key] = false; instrumentation.errors.push(key + ': ' + String(error)); }
  }
  instrument(IDBFactory.prototype, 'open', (_self, args) => ({ database: String(args[0]) }));
  instrument(IDBFactory.prototype, 'deleteDatabase', (_self, args) => ({ database: String(args[0]) }));
  instrument(IDBDatabase.prototype, 'transaction', (self, args) => ({ database: self.name, mode: args[1] || 'readonly', stores: args[0] }));
  for (const method of ['put', 'add', 'delete', 'clear']) instrument(IDBObjectStore.prototype, method, self => ({ database: self.transaction.db.name, store: self.name }));
  addEventListener('error', e => errors.push(String(e.message)));
  addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
  const snapshot = () => ({ run, variant, instrumentation, at: performance.now(), url: location.pathname + location.search, viewport: [innerWidth, innerHeight], requests, indexedDBOperations, indexedDBCounts, errors, milestones, actions, summaryTransitions,
    title: document.querySelector('h1')?.textContent, charts: document.querySelectorAll('.recharts-surface').length,
    resources: performance.getEntriesByType('resource').filter(row => !row.name.includes('/api/test/')).map(row => ({ path: redact(row.name), initiatorType: row.initiatorType,
      startTime: row.startTime, duration: row.duration, fetchStart: row.fetchStart, requestStart: row.requestStart, responseStart: row.responseStart, responseEnd: row.responseEnd,
      transferSize: row.transferSize, encodedBodySize: row.encodedBodySize, decodedBodySize: row.decodedBodySize, nextHopProtocol: row.nextHopProtocol })),
    navigation: performance.getEntriesByType('navigation').map(x => x.toJSON()) });
  window.__cloudOnline = { snapshot, report: async () => originalFetch('/api/test/online/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot()) }) };
  let timer;
  const changed = () => {
    if (!milestones.shell && document.querySelector('h1')) milestones.shell = performance.now();
    if (!milestones.chart && document.querySelector('.recharts-surface')) milestones.chart = performance.now();
    const summary = document.querySelector('.overview-local .metrics-total strong') || document.querySelector('.metrics-total strong');
    if (summary) { const text = summary.textContent.trim(), rect = summary.getBoundingClientRect(), style = getComputedStyle(summary);
      if (/\d/.test(text) && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && style.visibility !== 'hidden' && style.display !== 'none') {
        if (!milestones.summary) { milestones.summary = performance.now(); milestones.summaryText = text; }
        if (summaryTransitions.at(-1)?.text !== text) summaryTransitions.push({ at: performance.now(), text, path: location.pathname });
      }
    }
    clearTimeout(timer); timer = setTimeout(() => window.__cloudOnline.report().catch(() => {}), 1500);
  };
  new MutationObserver(changed).observe(document, { subtree: true, childList: true, characterData: true });
  document.addEventListener('click', event => { const el = event.target.closest?.('button,a'); if (el) actions.push({ at: performance.now(), text: el.textContent?.trim().slice(0, 150), href: el.getAttribute('href') }); }, true);
  addEventListener('pagehide', () => navigator.sendBeacon('/api/test/online/report', JSON.stringify(snapshot())));
  addEventListener('load', changed);
  // Periodic snapshots also capture requests/IDB work after the last DOM mutation.
  setInterval(() => window.__cloudOnline.report().catch(() => {}), 3000);
})();`;
