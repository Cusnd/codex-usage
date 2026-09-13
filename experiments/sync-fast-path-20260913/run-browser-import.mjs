import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import path from 'node:path';
const evidence = path.resolve('artifacts/sync-fast-path-20260913');
await mkdir(evidence, { recursive: true });
const script = path.join(evidence, 'browser-import.js');
await build({ entryPoints: ['experiments/sync-fast-path-20260913/browser-import.ts'], outfile: script, bundle: true, platform: 'browser', format: 'esm', target: 'es2022' });
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:18914');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'POST' && url.pathname === '/results') {
    let body = ''; for await (const part of req) { body += part; if (body.length > 2000000) { res.writeHead(413); res.end(); return; } }
    const report = JSON.parse(body);
    await writeFile(path.join(evidence, report.mode === 'shadow' ? 'browser-shadow-comparison.json' : 'browser-import.json'), JSON.stringify(report, null, 2));
    res.end('saved'); return;
  }
  if (url.pathname === '/browser-import.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(script)); return; }
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><title>云端下行接收端实验</title><script type="module" src="/browser-import.js"></script>'); return; }
  res.writeHead(404); res.end();
});
server.listen(18914, '127.0.0.1', async () => {
  await writeFile(path.join(evidence, 'browser-server.json'), JSON.stringify({ pid: process.pid, port: 18914, startedAt: new Date().toISOString() }));
  console.log('Local synthetic receiving-side experiment at http://127.0.0.1:18914/');
});
