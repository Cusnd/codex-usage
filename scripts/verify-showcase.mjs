import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../showcase/build/', import.meta.url));
const origin = new URL(process.argv[2] || 'https://codex-usage-showcase.sorenliu.workers.dev');
const hash = data => createHash('sha256').update(data).digest('hex');
const files = (await readdir(root,{recursive:true,withFileTypes:true})).filter(entry => entry.isFile() && entry.name !== '_headers');
for (const entry of files) {
  const absolute = path.join(entry.parentPath,entry.name);
  const relative = path.relative(root,absolute).replaceAll('\\','/');
  const response = await fetch(new URL(relative,origin),{signal:AbortSignal.timeout(20000)});
  assert.equal(response.status,200,relative);
  assert.equal(hash(Buffer.from(await response.arrayBuffer())),hash(await readFile(absolute)),`Asset mismatch: ${relative}`);
}
const html = await readFile(path.join(root,'index.html'),'utf8');
for (const route of ['/','/analysis','/threads','/threads/example-session-01','/settings']) {
  const response = await fetch(new URL(route,origin),{headers:{'Sec-Fetch-Mode':'navigate'},signal:AbortSignal.timeout(20000)});
  assert.equal(response.status,200,route);
  assert.equal(await response.text(),html,`SPA route: ${route}`);
  assert.match(response.headers.get('content-security-policy') || '',/connect-src 'self'/);
}
console.log(`PASS: ${files.length} public assets match local SHA-256, five SPA routes and same-origin connection policy verified.`);
