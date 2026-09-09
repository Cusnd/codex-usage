import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { captureProcess } from '../scripts/capture-process.mjs';

test('Windows command capture completes after a launcher exits with a detached child', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-capture-'));
  const launcher = path.join(root, 'launcher.mjs');
  await writeFile(launcher, `
    import { spawn } from 'node:child_process';
    import { openSync, closeSync, writeFileSync } from 'node:fs';
    const fd = openSync('background.log', 'a');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    writeFileSync(process.pid + '.pid', String(child.pid));
    child.unref();
    console.log('ready');
  `);
  const ps = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  try {
    const start = performance.now();
    const results = await Promise.all([1, 2].map(() => captureProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& ${ps(process.execPath)} ${ps(launcher)}; exit $LASTEXITCODE`], { cwd: root, windowsHide: true, timeout: 8000 })));
    assert.ok(results.every(result => result.stdout.trim() === 'ready'));
    assert.ok(performance.now() - start < 6500, 'must not wait for inherited pipes until the timeout');
  } finally {
    for (const file of await readdir(root)) if (file.endsWith('.pid')) {
      try { process.kill(Number(await readFile(path.join(root, file), 'utf8')), 'SIGKILL'); } catch {}
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
