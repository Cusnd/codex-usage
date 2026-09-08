import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), 'codex-package-中文 空格-'));
const project = process.cwd();
const portServer = createServer();
await new Promise(r => portServer.listen(0, '127.0.0.1', r));
const port = portServer.address().port;
await new Promise(r => portServer.close(r));
const env = { ...process.env, PORT: String(port), CODEX_USAGE_DATA_DIR: path.join(root, 'data'), CODEX_HOME: path.join(root, 'codex'), CODEX_BIN: path.join(root, 'missing.exe'), CODEX_USAGE_STARTUP_DIR: path.join(root, 'Startup') };
const prefix = path.join(root, 'install');
let cli;
const run = async (...args) => {
  console.log('Checking:', args.join(' '));
  const result = await exec(process.execPath, [cli, ...args], { env, cwd: root, windowsHide: true, timeout: 45000 });
  return JSON.parse(result.stdout);
};
try {
  await mkdir(env.CODEX_HOME, { recursive: true });
  let tarball = process.env.CODEX_USAGE_TEST_TARBALL;
  if (!tarball) {
    const packed = await exec(process.execPath, [process.env.npm_execpath, 'pack', '--json', '--pack-destination', root], { cwd: project, windowsHide: true });
    const manifest = JSON.parse(packed.stdout)[0];
    assert.ok(manifest.files.every(f => !/(^|\/)(data|output|node_modules|\.env)(\/|$)/.test(f.path)));
    tarball = path.join(root, manifest.filename);
  }
  await exec(process.execPath, [process.env.npm_execpath, 'install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: root, windowsHide: true, timeout: 300000 });
  cli = path.join(prefix, 'node_modules/codex-detailed-usage/bin/codex-usage.mjs');
  assert.equal((await run('status', '--json')).running, false);
  const both = await Promise.all([run('start', '--json'), run('start', '--json')]);
  assert.ok(both.every(x => x.running));
  const recordFile = path.join(env.CODEX_USAGE_DATA_DIR, 'instance.json');
  const record = JSON.parse(await readFile(recordFile, 'utf8'));
  await run('start', '--json');
  assert.equal(JSON.parse(await readFile(recordFile, 'utf8')).pid, record.pid);
  const base = `http://127.0.0.1:${port}`;
  const page = await fetch(base).then(r => r.text());
  assert.ok(page.includes('<html'));
  assert.equal((await fetch(base + page.match(/src="([^"]+\.js)"/)[1])).status, 200);
  assert.equal((await run('summary', '--days', '7', '--json')).meta.source, 'local');
  await run('refresh', '--source', 'local', '--wait', '--json');
  assert.equal((await fetch(base + '/_control/stop', { method: 'POST' })).status, 403);
  await writeFile(recordFile, JSON.stringify({ ...record, token: 'wrong' }));
  await assert.rejects(run('stop', '--json'));
  await writeFile(recordFile, JSON.stringify(record));
  assert.equal((await fetch(base + '/api/status')).status, 200);
  await writeFile(recordFile, JSON.stringify({ ...record, version: '99.0.0' }));
  await assert.rejects(run('start', '--json'));
  await assert.rejects(run('stop', '--json'));
  await writeFile(recordFile, JSON.stringify(record));
  await assert.rejects(run('refresh', '--source', 'local', '--wait', '--timeout', '0', '--json'));
  assert.equal((await fetch(base + '/api/system/autostart', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) })).status, 403);
  if (process.platform === 'win32') {
    assert.equal((await run('autostart', 'enable', '--json')).enabled, true);
    const response = await fetch(base + '/api/system/autostart', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    assert.equal(response.status, 200);
    assert.equal((await run('autostart', 'status', '--json')).enabled, false);
    await run('autostart', 'enable', '--json');
    await run('stop', '--json');
    await new Promise((resolve, reject) => {
      const launcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(env.CODEX_USAGE_DATA_DIR, 'launch.ps1')], { env, cwd: root, windowsHide: true, stdio: 'ignore' });
      launcher.on('error', reject);
      launcher.on('exit', code => code === 0 ? resolve() : reject(new Error(`Launcher exited ${code}`)));
    });
    for (let i = 0; i < 30; i++) {
      if ((await run('doctor', '--json')).service === 'verified') break;
      await new Promise(r => setTimeout(r, 300));
    }
    assert.equal((await run('doctor', '--json')).service, 'verified');
    await run('autostart', 'disable', '--json');
  }
  await run('skill', 'install', '--json');
  assert.ok((await readFile(path.join(env.CODEX_HOME, 'skills/codex-usage/SKILL.md'), 'utf8')).includes('codex-usage'));
  await run('skill', 'uninstall', '--json');
  await run('stop', '--json');
  assert.equal((await run('status', '--json')).running, false);
  // Same installed version reinstalled as the upgrade path: data survives.
  const before = await readFile(path.join(env.CODEX_USAGE_DATA_DIR, 'usage.sqlite'));
  await exec(process.execPath, [process.env.npm_execpath, 'install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: root, windowsHide: true, timeout: 300000 });
  assert.deepEqual(await readFile(path.join(env.CODEX_USAGE_DATA_DIR, 'usage.sqlite')), before);
  const migrationEnv = { ...env, CODEX_USAGE_DATA_DIR: path.join(root, 'migrated') };
  const migrationArgs = [cli, 'migrate', '--from', path.join(env.CODEX_USAGE_DATA_DIR, 'usage.sqlite'), '--json'];
  const migrated = await exec(process.execPath, migrationArgs, { env: migrationEnv, cwd: root, windowsHide: true });
  assert.equal(JSON.parse(migrated.stdout).sourcePreserved, true);
  assert.deepEqual(await readFile(path.join(migrationEnv.CODEX_USAGE_DATA_DIR, 'usage.sqlite')), before);
  await assert.rejects(exec(process.execPath, migrationArgs, { env: migrationEnv, cwd: root, windowsHide: true }));
  await writeFile(recordFile, JSON.stringify({ pid: 2147483000, token: 'stale', version: '0.1.0', port }));
  await Promise.all([run('start', '--json'), run('start', '--json')]);
  await run('stop', '--json');
  // Occupied port is not silently changed and the foreign listener survives.
  const foreign = createServer(socket => socket.destroy());
  await new Promise(r => foreign.listen(port, '127.0.0.1', r));
  try { await assert.rejects(run('start', '--json')); assert.ok(foreign.listening); }
  finally { await new Promise(r => foreign.close(r)); }
  console.log('PASS: package install, arbitrary cwd, concurrent/repeated start, API/assets, JSON, refresh, identity/version mismatch, same-origin startup, hidden launcher, Skill, reinstall/data preservation, migration, stale recovery, stop, port conflict.');
} finally {
  if (cli) { try { await run('stop', '--json'); } catch {} }
  const resolved = path.resolve(root);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('codex-package-'));
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 });
}
