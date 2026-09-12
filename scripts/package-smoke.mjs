import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { serviceGuardAddress } from '../dist/modules/platform/node/platform.js';
import { createHash } from 'node:crypto';
import { captureProcess as exec } from './capture-process.mjs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { linuxSystemdSmoke } from './linux-systemd-smoke.mjs';
const root = await mkdtemp(path.join(os.tmpdir(), 'codex-package-中文 空格-'));
const project = process.cwd();
const packageName = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')).name;
const portServer = createServer();
await new Promise(r => portServer.listen(0, '127.0.0.1', r));
const port = portServer.address().port;
await new Promise(r => portServer.close(r));
const env = { ...process.env, PORT: String(port), CODEX_USAGE_DATA_DIR: path.join(root, process.platform === 'linux' ? 'data % $ 中文' : 'data'), CODEX_HOME: path.join(root, 'codex'), CODEX_BIN: path.join(root, 'missing.exe'), CODEX_USAGE_STARTUP_DIR: path.join(root, 'Startup') };
const prefix = path.join(root, 'install');
// Exercise npm's generated shim using the selected Node runtime.
const inheritedPath = process.env.PATH ?? process.env.Path ?? '';
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
env[process.platform === 'win32' ? 'Path' : 'PATH'] = `${path.dirname(process.execPath)}${path.delimiter}${inheritedPath}`;
let cli;
const windows = process.platform === 'win32';
const shim = windows ? path.join(prefix, 'codex-usage.ps1') : path.join(prefix, 'bin/codex-usage');
let launchJob;
const install = async target => {
  const result = await exec(process.execPath, [process.env.npm_execpath, 'install', '-g', '--prefix', prefix, target], { cwd: root, env, windowsHide: true, timeout: 300000 });
  assert.ok(!/EBADENGINE/.test(result.stderr), result.stderr);
};
const run = async (...args) => {
  console.log('Checking:', args.join(' '));
  const result = await exec(windows ? 'powershell.exe' : shim, windows ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', shim, ...args] : args, { env, cwd: root, windowsHide: true, timeout: 45000 });
  return JSON.parse(result.stdout);
};
try {
  await mkdir(env.CODEX_HOME, { recursive: true });
  let tarball = process.env.CODEX_USAGE_TEST_PACKAGE || process.env.CODEX_USAGE_TEST_TARBALL;
  if (!tarball) {
    // The build is an explicit prerequisite; install and test that exact output without rebuilding it.
    const packed = await exec(process.execPath, [process.env.npm_execpath, 'pack', '--ignore-scripts', '--json', '--silent', '--pack-destination', root], { cwd: project, windowsHide: true });
    const manifest = JSON.parse(packed.stdout)[0];
    assert.ok(manifest.files.every(f => !/(^|\/)(data|output|node_modules|\.env)(\/|$)/.test(f.path)));
    tarball = path.join(root, manifest.filename);
  }
  await install(tarball);
  cli = path.join(prefix, ...(windows ? [] : ['lib']), 'node_modules', packageName, 'bin/codex-usage.mjs');
  // Inspect the complete installed tree, including nested and scoped dependencies.
  const browserOnly = new Set(['@fontsource-variable/inter', '@tanstack/react-query', 'lucide-react', 'react', 'react-dom', 'react-router-dom', 'recharts']);
  const inspectPackages = async directory => {
    const manifest = await readFile(path.join(directory, 'package.json'), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (manifest) assert.ok(!browserOnly.has(JSON.parse(manifest).name), `Browser-only package installed: ${directory}`);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await inspectPackages(path.join(directory, entry.name));
    }
  };
  await inspectPackages(path.join(prefix, ...(windows ? [] : ['lib']), 'node_modules'));
  assert.equal((await run('doctor', '--json')).node, process.version);
  assert.equal((await run('status', '--json')).running, false);
  if (process.platform === 'linux') {
    const fallbackHome = path.join(root, 'isolated-home');
    for (const xdg of ['', path.join(root, 'xdg-data')]) {
      const defaults = { ...env, HOME: fallbackHome, XDG_DATA_HOME: xdg };
      delete defaults.CODEX_USAGE_DATA_DIR;
      const doctor = JSON.parse((await exec(process.execPath, [cli, 'doctor', '--json'], { env: defaults })).stdout);
      assert.equal(doctor.dataRoot, path.join(xdg || path.join(fallbackHome, '.local/share'), 'CodexUsage'));
    }
    const noManager = { ...env, XDG_RUNTIME_DIR: path.join(root, 'no-user-runtime'), DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(root, 'no-user-bus')}` };
    assert.equal(JSON.parse((await exec(process.execPath, [cli, 'start', '--json'], { env: noManager })).stdout).running, true);
    const doctor = JSON.parse((await exec(process.execPath, [cli, 'doctor', '--json'], { env: noManager })).stdout);
    assert.equal(doctor.service, 'verified', 'ordinary background start does not require systemd');
    assert.equal(doctor.autostart.supported, false);
    await run('stop', '--json');
  }
  const both = await Promise.all([run('start', '--json'), run('start', '--json')]);
  assert.ok(both.every(x => x.running));
  const recordFile = path.join(env.CODEX_USAGE_DATA_DIR, 'instance.json');
  const record = JSON.parse(await readFile(recordFile, 'utf8'));
  await run('start', '--json');
  assert.equal(JSON.parse(await readFile(recordFile, 'utf8')).pid, record.pid);
  const base = `http://127.0.0.1:${port}`;
  if (process.platform === 'linux') {
    const headless = { ...env, DISPLAY: '', WAYLAND_DISPLAY: '', XDG_RUNTIME_DIR: path.join(root, 'no-user-runtime'), DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(root, 'no-user-bus')}` };
    await assert.rejects(exec(process.execPath, [cli, 'open', '--json'], { env: headless }), error => {
      assert.match(error.stderr, /No desktop session/);
      assert.ok(error.stderr.includes(base));
      assert.equal(JSON.parse(error.stdout).running, true);
      return true;
    });
    const doctor = JSON.parse((await exec(process.execPath, [cli, 'doctor', '--json'], { env: headless })).stdout);
    assert.equal(doctor.autostart.supported, false);
    assert.match(doctor.autostart.reason, /user manager is unavailable|non-root/);
    assert.equal(doctor.service, 'verified');
  }
  const page = await fetch(base).then(r => r.text());
  assert.ok(page.includes('<html'));
  assert.equal((await fetch(base + page.match(/src="([^"]+\.js)"/)[1])).status, 200);
  const checkAsset = async (url, mime) => {
    const response = await fetch(url);
    assert.equal(response.status, 200, url);
    assert.match(response.headers.get('content-type') ?? '', mime, url);
    const body = await response.text();
    assert.ok(body.length > 0, url);
    return body;
  };
  const styles = [...page.matchAll(/href="([^"]+\.css)"/g)];
  assert.ok(styles.length, 'production CSS exists');
  let fonts = 0;
  for (const [, href] of styles) {
    const url = new URL(href, base);
    const css = await checkAsset(url, /text\/css/);
    for (const [, font] of css.matchAll(/url\(["']?([^\s)"']+\.woff2)["']?\)/g)) {
      await checkAsset(new URL(font, url), /font\/woff2/);
      fonts++;
    }
  }
  assert.ok(fonts > 0, 'bundled font assets exist');
  const docsUrl = new URL('/docs/', base);
  const docs = await checkAsset(docsUrl, /text\/html/);
  const docAssets = [...docs.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)];
  assert.ok(docAssets.some(([, asset]) => asset.endsWith('.js')), 'Swagger JS exists');
  assert.ok(docAssets.some(([, asset]) => asset.endsWith('.css')), 'Swagger CSS exists');
  for (const [, asset] of docAssets) {
    await checkAsset(new URL(asset, docsUrl), asset.endsWith('.css') ? /text\/css/ : /javascript/);
  }
  assert.ok((await fetch(base + '/openapi.json').then(r => r.json())).openapi);
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
  if (process.platform === 'darwin') {
    assert.equal((await run('autostart', 'enable', '--json')).enabled, true);
    const plist = path.join(env.CODEX_USAGE_STARTUP_DIR, 'com.esoren.codex-usage.plist');
    await exec('/usr/bin/plutil', ['-lint', plist]);
    const parsed = JSON.parse((await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist])).stdout);
    assert.deepEqual(parsed.ProgramArguments, [process.execPath, await realpath(cli), 'start']);
    assert.equal(parsed.EnvironmentVariables.CODEX_HOME, env.CODEX_HOME);
    assert.equal(parsed.EnvironmentVariables.CODEX_BIN, env.CODEX_BIN);
    assert.equal(parsed.KeepAlive, false);
    // LaunchAgents belong to the login (GUI) domain, which exists on GitHub's Mac images.
    // Bootstrap a uniquely labelled copy; never change the real user's login item.
    const label = `com.esoren.codex-usage.test.${createHash('sha256').update(root).digest('hex').slice(0, 16)}`;
    const copy = path.join(root, 'test-launch.plist');
    await writeFile(copy, (await readFile(plist, 'utf8')).replace('com.esoren.codex-usage</string>', `${label}</string>`));
    const domain = `gui/${process.getuid()}`;
    await exec('/bin/launchctl', ['print', domain]);
    await run('stop', '--json');
    await exec('/bin/launchctl', ['bootstrap', domain, copy]);
    launchJob = `${domain}/${label}`;
    for (let i = 0; i < 60; i++) {
      if ((await run('doctor', '--json')).service === 'verified') break;
      await new Promise(r => setTimeout(r, 300));
    }
    assert.equal((await run('doctor', '--json')).service, 'verified');
    // Wait until the one-shot launcher exits, then prove its detached service survives.
    let exited = false;
    for (let i = 0; i < 60; i++) {
      const job = (await exec('/bin/launchctl', ['print', launchJob])).stdout;
      if (/last exit code = 0/.test(job) && !/\n\s*pid = \d+/.test(job)) { exited = true; break; }
      await new Promise(r => setTimeout(r, 300));
    }
    assert.ok(exited, 'one-shot launch job exited successfully');
    assert.equal((await run('doctor', '--json')).service, 'verified');
    const disabled = await fetch(base + '/api/system/autostart', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    assert.equal(disabled.status, 200);
    assert.equal((await run('doctor', '--json')).service, 'verified');
    await run('stop', '--json');
    await new Promise(r => setTimeout(r, 1500));
    assert.equal((await run('status', '--json')).running, false, 'launchd does not restart manually stopped service');
    await exec('/bin/launchctl', ['bootout', launchJob]); launchJob = undefined;
  }
  if (process.platform === 'linux') await linuxSystemdSmoke({ root, env, cli, run, base });
  await run('skill', 'install', '--json');
  assert.ok((await readFile(path.join(env.CODEX_HOME, 'skills/codex-usage/SKILL.md'), 'utf8')).includes('codex-usage'));
  await run('skill', 'uninstall', '--json');
  await run('stop', '--json');
  assert.equal((await run('status', '--json')).running, false);
  // Same installed version reinstalled as the upgrade path: data survives.
  const before = await readFile(path.join(env.CODEX_USAGE_DATA_DIR, 'usage.sqlite'));
  await install(tarball);
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
  // Abrupt death leaves an instance record, but the kernel must release the guard.
  await run('start', '--json');
  const crashed = JSON.parse(await readFile(recordFile, 'utf8'));
  process.kill(crashed.pid, 'SIGKILL');
  for (let i = 0; i < 100; i++) {
    try { process.kill(crashed.pid, 0); } catch { break; }
    await new Promise(r => setTimeout(r, 50));
  }
  await Promise.all([run('start', '--json'), run('start', '--json')]);
  assert.notEqual(JSON.parse(await readFile(recordFile, 'utf8')).pid, crashed.pid);
  await run('stop', '--json');
  if (process.platform === 'darwin' || process.platform === 'linux') {
    const lockOwner = createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => { lockOwner.once('error', reject); lockOwner.listen(serviceGuardAddress(env.CODEX_USAGE_DATA_DIR), resolve); });
    try { await assert.rejects(run('start', '--json')); assert.ok(lockOwner.listening); }
    finally { await new Promise(r => lockOwner.close(r)); }
  }
  // Occupied port is not silently changed and the foreign listener survives.
  const foreign = createServer(socket => socket.destroy());
  await new Promise(r => foreign.listen(port, '127.0.0.1', r));
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await assert.rejects(run('start', '--json'), error => Boolean(error.stderr?.includes('"code":"CLI_ERROR"')));
      assert.ok(foreign.listening);
    }
  }
  finally { await new Promise(r => foreign.close(r)); }
  console.log('PASS: package install, arbitrary cwd, concurrent/repeated start, API/assets, JSON, refresh, identity/version mismatch, same-origin startup, hidden launcher, Skill, reinstall/data preservation, migration, stale recovery, stop, port conflict.');
} catch (error) {
  const diagnostics = path.join(project, 'artifacts/ci-smoke');
  await mkdir(diagnostics, { recursive: true });
  await writeFile(path.join(diagnostics, 'failure.txt'), `${process.platform}/${process.arch} ${process.version}\n${error.stack || error}\n${error.stdout || ''}\n${error.stderr || ''}`);
  // Never collect instance.json, credentials or SQLite: only this test's synthetic service logs.
  for (const name of ['service.log', 'launcher.log', 'launcher-error.log']) {
    try { await writeFile(path.join(diagnostics, name), await readFile(path.join(env.CODEX_USAGE_DATA_DIR, name))); } catch {}
  }
  console.error('Package smoke failed:', error);
  throw error;
} finally {
  if (launchJob) await exec('/bin/launchctl', ['bootout', launchJob]).catch(() => {});
  if (cli) { try { await run('stop', '--json'); } catch {} }
  const resolved = path.resolve(root);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('codex-package-'));
  if (windows) {
    // Removing instance.json acknowledges shutdown before Windows necessarily releases
    // every process handle. Do not delete installed files while a test child can use them.
    // Match the unique directory name: Node resolves RUNNER~1 to its long path.
    const snapshot = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$deadline = [DateTime]::UtcNow.AddSeconds(15); do { $remaining = @(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:CODEX_USAGE_TEST_DIRECTORY_NAME) }); if ($remaining.Count -eq 0) { break }; Start-Sleep -Milliseconds 200 } while ([DateTime]::UtcNow -lt $deadline); $remaining | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"], { env: { ...env, CODEX_USAGE_TEST_DIRECTORY_NAME: path.basename(root) }, timeout: 20000 });
    assert.equal(snapshot.stdout.trim(), '', `Synthetic Node processes did not exit: ${snapshot.stdout}`);
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 });
}
