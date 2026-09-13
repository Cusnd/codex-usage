// Preserve comparable production bundles and their static entry dependency graph.
// Usage: node scripts/browser-performance-build.mjs before|after
import { build } from 'vite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const label = process.argv[2];
if (!/^[a-z][a-z0-9-]*$/.test(label ?? '')) throw new Error('Provide a safe evidence label.');
const evidence = path.resolve('artifacts/performance-current/browser', label);
const reports = [];
for (const mode of ['production', 'cloud', 'showcase']) {
  const start = performance.now();
  let report;
  await build({ mode, build: { outDir: path.join(evidence, mode), emptyOutDir: true }, plugins: [{
    name: 'measure-production-bundle',
    generateBundle(_options, bundle) {
      const files = Object.values(bundle).map(chunk => {
        const data = Buffer.from(chunk.type === 'chunk' ? chunk.code : chunk.source);
        return { file: chunk.fileName, rawBytes: data.length, gzipBytes: gzipSync(data).length,
          ...(chunk.type === 'chunk' ? { entry: chunk.isEntry, imports: chunk.imports, dynamicImports: chunk.dynamicImports,
            modules: Object.entries(chunk.modules).map(([id, value]) => ({ id: path.relative(process.cwd(), id).replaceAll('\\', '/'), renderedBytes: value.renderedLength })) } : {}) };
      });
      const initial = new Set();
      const visit = name => { if (initial.has(name)) return; initial.add(name); for (const dependency of files.find(x => x.file === name)?.imports ?? []) visit(dependency); };
      for (const file of files.filter(x => x.entry)) visit(file.file);
      const initialJs = files.filter(x => initial.has(x.file) && x.file.endsWith('.js'));
      report = { mode, initialJs: { files: initialJs.map(x => x.file), rawBytes: initialJs.reduce((n,x) => n+x.rawBytes,0), gzipBytes: initialJs.reduce((n,x) => n+x.gzipBytes,0) }, files };
    },
  }] });
  // Vite's preload helper runs after generateBundle hooks; measure the final disk bytes.
  for (const file of report.files) {
    const data = await readFile(path.join(evidence, mode, file.file));
    file.rawBytes = data.length; file.gzipBytes = gzipSync(data).length;
  }
  const initialFiles = report.files.filter(file => report.initialJs.files.includes(file.file));
  report.initialJs.rawBytes = initialFiles.reduce((n,file) => n + file.rawBytes, 0);
  report.initialJs.gzipBytes = initialFiles.reduce((n,file) => n + file.gzipBytes, 0);
  reports.push({ ...report, buildMs: performance.now() - start });
}
await mkdir(evidence, { recursive: true });
await writeFile(path.join(evidence, 'bundle-report.json'), JSON.stringify({ measuredAt: new Date().toISOString(), head: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), node: process.version, label, reports }, null, 2)+'\n');
console.log(JSON.stringify(reports.map(({ mode, initialJs, buildMs }) => ({ mode, initialJs, buildMs })), null, 2));
