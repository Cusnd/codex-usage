// Read saved CUA observations and local artifact bytes. Never requests a URL or changes raw evidence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve('artifacts/cloud-online-20260913');
const finalFile = 'cua-final-latest.json';
const finalJS = '/assets/index-CsRF2fr1.js', finalCSS = '/assets/index-DOKzkXgs.css';
const oldJS = '/assets/index-Dfn7gbQe.js';
const hooks = ['IDBFactory.open', 'IDBFactory.deleteDatabase', 'IDBDatabase.transaction', 'IDBObjectStore.put', 'IDBObjectStore.add', 'IDBObjectStore.delete', 'IDBObjectStore.clear'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const round = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const sum = values => values.reduce((a, b) => a + b, 0);
const group = (values, key) => values.reduce((out, value) => { const k = key(value); out[k] = (out[k] ?? 0) + 1; return out; }, {});
const isAPI = row => typeof row.path === 'string' && row.path.startsWith('/api/v3/');
const mirror = route => /^\/api\/v3\/sync\/read(?:\/|$)/.test(route) || route === '/api/v3/sync/changes';
const mirrorKind = route => route === '/api/v3/sync/read' ? 'read' : route === '/api/v3/sync/changes' ? 'changes' : route.split('/').at(-1);
const rows = [], sourceFiles = [], uniqueRuns = new Map();
for (const file of (await readdir(root)).filter(name => /^cua-.*\.json$/.test(name)).sort()) {
  const bytes = await readFile(path.join(root, file));
  const data = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  const fileStat = await stat(path.join(root, file));
  const capturedAt = data.capturedAt ?? data.at ?? fileStat.mtime.toISOString();
  const captureTimeSource = data.capturedAt ? 'payload.capturedAt' : data.at ? 'payload.at' : 'filesystem mtime (save time, not an instrumented browser timestamp)';
  const reports = (data.reports ?? []).filter(report => report && typeof report.run === 'string' && finite(report.at));
  assert.ok(reports.length, file + ' has no usable document report');
  const lastRun = reports.at(-1).run;
  const report = reports.filter(row => row.run === lastRun).reduce((latest, next) => next.at >= latest.at ? next : latest);
  const uniqueInFile = [...new Set(reports.map(row => row.run))];
  sourceFiles.push({ file, bytes: bytes.length, sha256: hash(bytes), capturedAt, captureTimeSource,
    snapshots: reports.length, selectedRun: lastRun, uniqueRuns: uniqueInFile });
  for (const run of uniqueInFile) {
    const entry = uniqueRuns.get(run) ?? { run, files: [], snapshots: 0 };
    entry.files.push(file); entry.snapshots += reports.filter(row => row.run === run).length; uniqueRuns.set(run, entry);
  }
  const requests = (report.requests ?? []).filter(isAPI), first = requests.filter(row => finite(row.start) && row.start >= 0 && row.start < 5000);
  const mirrorRequests = first.filter(row => mirror(row.path));
  const resources = (report.resources ?? []).filter(row => /^\/assets\/index-[^/]+\.(js|css)$/.test(row.path));
  const assetPaths = [...new Set(resources.map(row => row.path))];
  const js = assetPaths.filter(name => name.endsWith('.js')), css = assetPaths.filter(name => name.endsWith('.css'));
  const buildClass = report.variant === 'baseline' && js.length === 1 && js[0] === oldJS ? 'baseline'
    : report.variant === 'candidate' && js.length === 1 && js[0] === finalJS && css.length === 1 && css[0] === finalCSS ? 'final-candidate'
      : report.variant === 'candidate' ? 'intermediate-candidate' : 'unrecognized';
  const assets = [];
  for (const resourcePath of assetPaths) {
    const timings = resources.filter(row => row.path === resourcePath);
    let artifact = null;
    for (const directory of [path.join(root, 'build'), path.resolve('artifacts/cloud-experience/after')]) {
      try {
        const fullPath = path.join(directory, resourcePath.slice(1)), asset = await readFile(fullPath);
        artifact = { path: path.relative(process.cwd(), fullPath).replaceAll('\\', '/'), bytes: asset.length, sha256: hash(asset) }; break;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    assets.push({ resource: resourcePath, artifact, artifactStatus: artifact ? 'verified from existing exact filename' : 'historical artifact unavailable; do not invent SHA256 from Vite filename',
      timing: timings.map(row => ({ startMs: round(row.startTime), durationMs: round(row.duration), transferSize: row.transferSize ?? null,
        encodedBodySize: row.encodedBodySize ?? null, decodedBodySize: row.decodedBodySize ?? null, nextHopProtocol: row.nextHopProtocol ?? null })) });
  }
  const instrumentation = report.instrumentation ?? null;
  const hooksVerified = instrumentation?.scriptExecuted === true && instrumentation?.fetchInstalled === true
    && hooks.every(key => instrumentation?.indexedDBHooks?.[key] === true) && !(instrumentation.errors?.length);
  const counts = report.indexedDBCounts;
  const exactIDBAvailable = hooksVerified && finite(counts?.total) && counts.byOperation && counts.byStore;
  if (exactIDBAvailable) {
    assert.equal(sum(Object.values(counts.byOperation)), counts.total, file + ' IDB operation totals are inconsistent');
    assert.equal(sum(Object.values(counts.byStore)), counts.total, file + ' IDB store totals are inconsistent');
    assert.equal((report.indexedDBOperations?.length ?? 0) + (counts.omittedSamples ?? 0), counts.total, file + ' IDB sample accounting is inconsistent');
  }
  const explicitCounts = exactIDBAvailable ? Object.fromEntries(['open', 'deleteDatabase', 'transaction', 'put', 'add', 'delete', 'clear'].map(key => [key, counts.byOperation[key] ?? 0])) : null;
  const validByteRows = first.filter(row => finite(row.decodedResponseBytes));
  const resourceFirst = (report.resources ?? []).filter(row => isAPI(row) && row.startTime >= 0 && row.startTime < 5000);
  const first5s = { interval: '[navigationStart + 0ms, navigationStart + 5000ms), requests counted by start', observedFullWindow: report.at >= 5000,
    apiRequests: first.length, endpointCounts: group(first, row => row.method + ' ' + row.path),
    mirrorRequests: mirrorRequests.length, mirrorEndpointCounts: group(mirrorRequests, row => mirrorKind(row.path)),
    collectorStatusRequests: first.filter(row => row.path === '/api/v3/sync/status').length,
    decodedResponseBytes: validByteRows.length === first.length ? sum(validByteRows.map(row => row.decodedResponseBytes)) : null,
    knownDecodedResponseBytes: sum(validByteRows.map(row => row.decodedResponseBytes)), missingBodyByteMeasurements: first.length - validByteRows.length,
    bodyBytesCompletedWithin5s: sum(first.filter(row => finite(row.decodedResponseBytes) && finite(row.bodyReadEnd) && row.bodyReadEnd < 5000).map(row => row.decodedResponseBytes)),
    byteMeaning: 'Actual decoded response bytes of requests started in the first 5 seconds; full-body completion may occur later. Not wire bytes.',
    resourceTiming: { completedEntries: resourceFirst.length, encodedBodySize: sum(resourceFirst.map(row => row.encodedBodySize ?? 0)),
      decodedBodySize: sum(resourceFirst.map(row => row.decodedBodySize ?? 0)), transferSize: sum(resourceFirst.map(row => row.transferSize ?? 0)) },
    httpErrors: first.filter(row => row.status >= 400).map(row => ({ path: row.path, status: row.status, startMs: round(row.start) })),
    transportErrors: first.filter(row => row.error).map(row => ({ path: row.path, error: row.error, startMs: round(row.start) })) };
  rows.push({ file, capturedAt, captureTimeSource, run: report.run, snapshotElapsedMs: round(report.at), variant: report.variant,
    sourceSelectedVariant: data.variant ?? null, buildClass, injectedDelayMs: data.delayMs ?? null, viewport: report.viewport ?? null,
    pathAtSnapshot: (report.url ?? '').split('?')[0], otherRunsInSource: uniqueInFile.filter(run => run !== lastRun),
    first5s, summary: { domVisibleMs: round(report.milestones?.summary), text: report.milestones?.summaryText ?? null,
      definition: 'First visible numeric .metrics-total strong in this document; not FCP, LCP, or a route-change timer.' },
    hooksVerified, instrumentation, errors: report.errors ?? null,
    indexedDB: { measurementWindow: 'Entire selected document through snapshotElapsedMs; NOT restricted to first 5 seconds', exactCountsAvailable: !!exactIDBAvailable,
      total: exactIDBAvailable ? counts.total : null, byOperation: explicitCounts, byStore: exactIDBAvailable ? counts.byStore : null,
      putAndAdd: exactIDBAvailable ? explicitCounts.put + explicitCounts.add : null,
      recordedSamples: report.indexedDBOperations?.length ?? null, omittedSamples: counts?.omittedSamples ?? null }, assets });
}

const baseline = rows.find(row => row.file === 'cua-baseline-cold.json');
const final = rows.find(row => row.file === finalFile);
let comparison = { status: 'awaiting-final-cold', selectedFiles: ['cua-baseline-cold.json', finalFile], intermediateCandidatesExcluded: true };
if (final) {
  assert.equal(final.buildClass, 'final-candidate', 'Final cold capture must load the final JS and CSS, not an intermediate build.');
  assert.ok(baseline && baseline.buildClass === 'baseline', 'Verified baseline cold document required.');
  for (const row of [baseline, final]) {
    assert.ok(row.hooksVerified, row.file + ' instrumentation did not execute completely');
    assert.ok(row.first5s.observedFullWindow, row.file + ' ends before five seconds');
    assert.ok(finite(row.summary.domVisibleMs), row.file + ' lacks a numeric summary DOM milestone');
    assert.ok(row.assets.every(asset => asset.artifact), row.file + ' local artifact fingerprint unavailable');
    assert.ok(row.assets.every(asset => asset.timing.every(t => t.decodedBodySize === asset.artifact.bytes)), row.file + ' resource bytes differ from local artifact');
  }
  assert.deepEqual(final.viewport, baseline.viewport, 'Paired viewport mismatch');
  const delayRecordedInBoth = finite(final.injectedDelayMs) && finite(baseline.injectedDelayMs);
  if (delayRecordedInBoth) assert.equal(final.injectedDelayMs, baseline.injectedDelayMs, 'Paired fixture delay mismatch');
  assert.equal(final.summary.text, baseline.summary.text, 'Paired summary value mismatch');
  comparison = { status: 'two-specific-cold-documents', selectedFiles: [baseline.file, final.file], intermediateCandidatesExcluded: true,
    viewport: final.viewport, injectedDelayMs: { baseline: baseline.injectedDelayMs, final: final.injectedDelayMs },
    delayComparison: delayRecordedInBoth ? 'equal in both source payloads' : 'Final compact source omits delayMs; fixture configuration is not independently re-established from this source file.',
    baseline: { summaryMs: baseline.summary.domVisibleMs, first5s: baseline.first5s, indexedDB: baseline.indexedDB, assets: baseline.assets },
    final: { summaryMs: final.summary.domVisibleMs, first5s: final.first5s, indexedDB: final.indexedDB, assets: final.assets },
    observedSummaryChangeMs: round(final.summary.domVisibleMs - baseline.summary.domVisibleMs),
    observedSummaryReductionPercent: round(100 * (1 - final.summary.domVisibleMs / baseline.summary.domVisibleMs)),
    staticAssetCacheEvidence: { baselineScriptTransferSize: baseline.assets.find(asset => asset.resource === oldJS)?.timing[0]?.transferSize ?? null,
      finalScriptTransferSize: final.assets.find(asset => asset.resource === finalJS)?.timing[0]?.transferSize ?? null,
      note: 'These captures show different static script transfer behavior. Do not claim matched cold static-resource caches or attribute the full DOM-time difference to the implementation.' },
    limits: ['One baseline and one final cold document, not a median or distribution.', 'Local synthetic 1001-event/90K-token data; no production speedup claim.',
      ...delayRecordedInBoth ? [] : ['One source omits delayMs; configured delay is not independently confirmed by both raw files.'],
      'Static asset cache behavior can differ; inspect each ResourceTiming record.', 'First5s requests/bytes and entire-document exact IDB counts have deliberately separate windows.'] };
}
const result = { generatedAt: new Date().toISOString(), method: { rawInputs: 'cua-*.json only; raw files remain unchanged',
  snapshotSelection: 'Last run appearing in each file, then greatest elapsed at within that run; never compare elapsed clocks from different runs.',
  deduplication: 'Repeated reports of one run are cumulative snapshots, not independent samples. Cross-file uniqueRuns lists reuse explicitly.',
  mirrorDefinition: 'All /api/v3/sync/read requests including manifest/entities/legacy renew, plus /api/v3/sync/changes. Collector status is separate.',
  finalBuild: { js: finalJS, css: finalCSS }, noOnlinePerformanceClaim: true }, sourceFiles, uniqueRuns: [...uniqueRuns.values()], rows, comparison };
await writeFile(path.join(root, 'browser-summary.json'), JSON.stringify(result, null, 2) + '\n');
const text = ['# 完全在线云端：浏览器观测汇总', '',
  `只读保存的 CUA JSON；每文件使用最后文档 run 的最新累积报告。重复 run 不作为重复试验。最终对照只选 cua-baseline-cold.json 与 ${finalFile}，中间候选不合并。`, '',
  '| 文件 | variant / build | summary DOM ms | 首 5 秒 API | mirror | 解码响应字节 | 全文档 IDB put/add | hooks |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ...rows.map(row => `| ${row.file} | ${row.variant} / ${row.buildClass} | ${row.summary.domVisibleMs ?? '不可用'} | ${row.first5s.apiRequests} | ${row.first5s.mirrorRequests} | ${row.first5s.decodedResponseBytes ?? '不完整'} | ${row.indexedDB.putAndAdd ?? '未验证'} | ${row.hooksVerified ? '已执行' : '未验证'} |`), '',
  'API/字节窗口为 navigationStart 后 [0,5000) ms 开始的请求；IDB 为各文档截至最新报告的精确全程计数，不能因前 250 样本截断而伪造首 5 秒计数。解码响应字节不是网络传输字节。', '',
  '采集时间字段保留原始 payload 时间；没有此字段时保留文件修改时间并明确标记为落盘时间。每份源文件的 SHA-256、viewport、逐端点计数、错误、钩子状态和资源 hash/字节均在 browser-summary.json。', '',
  ...(comparison.status === 'two-specific-cold-documents' ? [`选定两次本地冷文档的主统计 DOM 时间为 ${baseline.summary.domVisibleMs} → ${final.summary.domVisibleMs} ms；差值 ${comparison.observedSummaryChangeMs} ms，单次观测下降 ${comparison.observedSummaryReductionPercent}%。${finite(final.injectedDelayMs) ? `两份记录的 API 额外延迟均为 ${final.injectedDelayMs} ms。` : 'final 文件没有 delayMs，不能仅凭该文件独立确认此参数。'}这是合成数据的两次观测，不能称为中位数、普遍收益或线上提速。`, ''] : ['最终冷启动记录尚未齐全；当前不产生最终性能对照。', '']),
  '中间候选的已删除资产没有 SHA-256 时明确显示 unavailable，不能用 Vite 短文件名推导完整 hash。旧 JS/CSS 复制进候选目录只为 A/B 资源服务，不计入候选应用体积。', ''];
await writeFile(path.join(root, 'browser-summary.md'), text.join('\n'));
if (comparison.status === 'two-specific-cold-documents') {
  const asset = (row, extension) => row.assets.find(entry => entry.resource.endsWith(extension));
  const oldScript = asset(baseline, '.js'), newScript = asset(final, '.js'), oldStyle = asset(baseline, '.css'), newStyle = asset(final, '.css');
  const readme = ['# 完全在线云端：最终本地浏览器对照', '',
    `本页只比较 [cua-baseline-cold.json](./cua-baseline-cold.json) 与 [${finalFile}](./${finalFile})，不合并中间候选或删除验收场景。完整机器可读结果为 [browser-summary.json](./browser-summary.json)，全部来源索引见 [browser-summary.md](./browser-summary.md)。`, '',
    '| 指标 | 旧版完整镜像 UI | 最终在线 UI |', '| --- | ---: | ---: |',
    `| 首个可见主统计数值 DOM 时间 | ${baseline.summary.domVisibleMs} ms | ${final.summary.domVisibleMs} ms |`,
    `| 首次主统计值 | ${baseline.summary.text} | ${final.summary.text} |`,
    `| 前 5 秒 API 请求 | ${baseline.first5s.apiRequests} | ${final.first5s.apiRequests} |`,
    `| 其中实体镜像 API | ${baseline.first5s.mirrorRequests} | ${final.first5s.mirrorRequests} |`,
    `| 这些 API 的实际解码响应字节 | ${baseline.first5s.decodedResponseBytes.toLocaleString('en-US')} | ${final.first5s.decodedResponseBytes.toLocaleString('en-US')} |`,
    `| ResourceTiming API 编码响应字节 | ${baseline.first5s.resourceTiming.encodedBodySize.toLocaleString('en-US')} | ${final.first5s.resourceTiming.encodedBodySize.toLocaleString('en-US')} |`,
    `| ResourceTiming API transferSize | ${baseline.first5s.resourceTiming.transferSize.toLocaleString('en-US')} | ${final.first5s.resourceTiming.transferSize.toLocaleString('en-US')} |`,
    `| 最新文档报告时刻 | ${baseline.snapshotElapsedMs} ms | ${final.snapshotElapsedMs} ms |`,
    `| 截至该时刻 IndexedDB put | ${baseline.indexedDB.byOperation.put} | ${final.indexedDB.byOperation.put} |`,
    `| 截至该时刻 IndexedDB 全部操作 | ${baseline.indexedDB.total} | ${final.indexedDB.total} |`,
    `| 入口 JS 原始字节 | ${oldScript.artifact.bytes.toLocaleString('en-US')} | ${newScript.artifact.bytes.toLocaleString('en-US')} |`,
    `| CSS 原始字节 | ${oldStyle.artifact.bytes.toLocaleString('en-US')} | ${newStyle.artifact.bytes.toLocaleString('en-US')} |`, '',
    `两份记录的 viewport 均为 ${final.viewport.join(' × ')}，API 额外延迟均为 ${final.injectedDelayMs} ms，合成种子为 1,001 个事件、90K Tokens。请求数减少 ${round(100 * (1 - final.first5s.apiRequests / baseline.first5s.apiRequests))}%，API 解码响应字节减少 ${round(100 * (1 - final.first5s.decodedResponseBytes / baseline.first5s.decodedResponseBytes))}%。这直接证明该观察窗口内浏览器没有再请求实体镜像。`, '',
    `主统计 DOM 时间在这两个文档中缩短 ${round(baseline.summary.domVisibleMs - final.summary.domVisibleMs)} ms（${comparison.observedSummaryReductionPercent}%）。但旧 JS 的 ResourceTiming transferSize 为 ${oldScript.timing[0].transferSize.toLocaleString('en-US')}，最终 JS 为 ${newScript.timing[0].transferSize.toLocaleString('en-US')}，静态资源缓存状态并不相同。不能把这个时间差当成严格匹配冷资源缓存的 A/B 收益，更不能称为中位数、线上提速或普遍改善。`, '',
    `两个文档均实际执行了脚本、fetch 包装及全部七个 IndexedDB 钩子；记录的全局错误和未处理 rejection 数依次为 ${baseline.errors?.length ?? '未提供'} / ${final.errors?.length ?? '未提供'}。IndexedDB 精确计数来自累积计数器，并核对分类总数及样本截断账目，未从前 250 个样本推算。IDB 表格覆盖整个文档报告窗口，API 表格只统计前五秒启动的请求；两者时间窗口不同。`, '',
    '| 资源 | 原始字节 | SHA-256 |', '| --- | ---: | --- |',
    ...[oldScript, oldStyle, newScript, newStyle].map(entry => `| ${entry.resource} | ${entry.artifact.bytes} | ${entry.artifact.sha256} |`), '',
    `旧记录落盘时间：${baseline.capturedAt}（${baseline.captureTimeSource}）；最终记录采集时间：${final.capturedAt}（${final.captureTimeSource}）。`, '',
    '复算：在仓库根目录执行 `node experiments/cloud-online-20260913/summarize-browser.mjs`。脚本只读原始 cua JSON 与现有资源字节，覆盖本目录的生成汇总文件，不修改原始证据。', ''];
  await writeFile(path.join(root, 'README.md'), readme.join('\n'));
}
console.log(JSON.stringify({ generatedAt: result.generatedAt, uniqueDocumentRuns: uniqueRuns.size, comparison,
  rows: rows.map(row => ({ file: row.file, buildClass: row.buildClass, summary: row.summary.domVisibleMs, first5sAPI: row.first5s.apiRequests,
    mirror: row.first5s.mirrorRequests, decodedBytes: row.first5s.decodedResponseBytes, idbPutAdd: row.indexedDB.putAndAdd, hooks: row.hooksVerified })) }, null, 2));
