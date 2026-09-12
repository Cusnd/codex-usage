import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readlink, symlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureProcess as exec } from './capture-process.mjs';

// The persistent Codex Usage registration stays under the smoke test's directory.
// A uniquely named runtime-only link exercises the real manager without enabling login startup.
export async function linuxSystemdSmoke({ root, env, cli, run, base }) {
  const registration = await run('autostart', 'status', '--json');
  if (!registration.supported) {
    assert.ok(registration.reason);
    await assert.rejects(run('autostart', 'enable', '--json'));
    console.log(`NOT VERIFIED: real systemd user lifecycle: ${registration.reason}`);
    return;
  }
  const ctl = (...args) => exec('systemctl', ['--user', ...args], { env, timeout: 15000 });
  assert.equal((await run('autostart', 'enable', '--json')).enabled, true);
  const file = path.join(env.CODEX_USAGE_STARTUP_DIR, 'codex-usage.service');
  assert.equal(await readlink(path.join(env.CODEX_USAGE_STARTUP_DIR, 'default.target.wants/codex-usage.service')), '../codex-usage.service');
  const unit = await readFile(file, 'utf8');
  assert.match(unit, /Type=simple/);
  assert.match(unit, /Restart=no/);
  assert.ok(unit.includes('dist/apps/local/index.js'));
  assert.ok(!unit.includes('codex-usage.mjs" start'));
  await exec('systemd-analyze', ['--user', 'verify', file], { env });
  const name = `codex-usage-test-${createHash('sha256').update(root).digest('hex').slice(0, 16)}.service`;
  const copy = path.join(root, name);
  // Exercise escaping with executable and entry paths, independently of npm's local-tarball URI parser.
  const node = path.join(root, 'node % $ 中文');
  const entry = path.join(root, 'entry % $ 中文.js');
  const serverDirectory = path.resolve(path.dirname(cli), '../dist/server');
  await symlink(process.execPath, node);
  await symlink(path.join(serverDirectory, 'index.js'), entry);
  const { linuxServiceUnit } = await import(pathToFileURL(path.join(serverDirectory, 'linux-autostart.js')).href);
  await writeFile(copy, linuxServiceUnit({ directory: env.CODEX_USAGE_STARTUP_DIR, dataRoot: env.CODEX_USAGE_DATA_DIR, node, entry, port: Number(env.PORT), env }));
  await exec('systemd-analyze', ['--user', 'verify', copy], { env });
  let linked = false;
  try {
    await run('stop', '--json');
    await ctl('link', '--runtime', copy); linked = true;
    await ctl('start', name);
    for (let i = 0; i < 60; i++) {
      if ((await run('doctor', '--json')).service === 'verified') break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal((await run('doctor', '--json')).service, 'verified');
    const instance = JSON.parse(await readFile(path.join(env.CODEX_USAGE_DATA_DIR, 'instance.json'), 'utf8'));
    const mainPid = Number((await ctl('show', name, '--property=MainPID', '--value')).stdout.trim());
    assert.equal(mainPid, instance.pid, 'systemd directly supervises the foreground service');
    const response = await fetch(base + '/api/system/autostart', {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    });
    assert.equal(response.status, 200);
    assert.equal((await run('autostart', 'status', '--json')).enabled, false);
    assert.equal((await run('doctor', '--json')).service, 'verified', 'disabling future autostart preserves the current service');
    await run('stop', '--json');
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal((await run('status', '--json')).running, false);
    assert.equal((await ctl('show', name, '--property=ActiveState', '--value')).stdout.trim(), 'inactive');
    console.log('PASS: systemd-analyze, runtime-only unit, foreground MainPID, autostart disable without stop, CLI stop without restart. Login/logout remains a desktop acceptance check.');
  } finally {
    if (linked) {
      await ctl('stop', name).catch(() => {});
      await ctl('disable', '--runtime', name);
      await ctl('daemon-reload');
    }
    await run('autostart', 'disable', '--json');
  }
}
