import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readlink, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { linuxAutostart, linuxServiceUnit } from '../modules/platform/node/linux-autostart.js';

const optionsFor = (root: string) => ({ directory: path.join(root, 'units'), dataRoot: path.join(root, 'data % 中文'),
  node: path.join(root, 'node $test'), entry: path.join(root, '程序 %s', 'index.js'), port: 8765,
  env: { PATH: '/usr/bin:/custom path', CODEX_HOME: path.join(root, 'Codex %h'), SECRET_TOKEN: 'must-not-appear' } });

test('Linux unit uses a foreground entry and escapes specifiers, environment and command arguments', () => {
  const unit = linuxServiceUnit(optionsFor(path.resolve('linux test')));
  assert.match(unit, /Type=simple/);
  assert.match(unit, /Restart=no/);
  assert.match(unit, /ExecStart=:/); // Disable systemd environment expansion, retaining literal dollar signs.
  assert.match(unit, /node \$test/);
  assert.match(unit, /程序 %%s/);
  assert.match(unit, /data %% 中文/);
  assert.match(unit, /Codex %%h/);
  assert.doesNotMatch(unit, /SECRET_TOKEN|must-not-appear|index\.js" start|User=root/);
  assert.match(unit, /WantedBy=default.target/);
  assert.doesNotMatch(linuxServiceUnit({ ...optionsFor(path.resolve('test')), env: { XDG_CONFIG_HOME: 'relative' } }), /Environment="XDG_CONFIG_HOME=/);
  assert.throws(() => linuxServiceUnit({ ...optionsFor(path.resolve('test')), entry: 'relative.js' }), /must be absolute/);
});

test('Linux unavailable manager and root are reported without changing startup files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-systemd-unavailable-'));
  try {
    const options = optionsFor(root);
    const unavailable = linuxAutostart(options, () => { throw new Error('No user bus'); }, 1000);
    assert.equal(unavailable.status().supported, false);
    assert.match(unavailable.status().reason!, /Ordinary start still works/);
    assert.throws(() => unavailable.set(true), /manager is unavailable/);
    await assert.rejects(readFile(unavailable.file), { code: 'ENOENT' });
    const rootUser = linuxAutostart(options, () => { throw new Error('Must not invoke systemctl as root'); }, 0);
    assert.equal(rootUser.status().supported, false);
    assert.throws(() => rootUser.set(true), /non-root/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Linux registration preserves ownership and validation failures; enable/disable never start or stop', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-systemd-中文 % 空格-'));
  const options = optionsFor(root);
  const calls: string[][] = [];
  const run = (command: string, args: string[]) => { calls.push([command, ...args]); };
  const registration = linuxAutostart(options, run, 1000);
  try {
    assert.equal(registration.set(true).enabled, true);
    assert.equal(await readlink(registration.link), '../codex-usage.service');
    const original = await readFile(registration.file, 'utf8');
    const other = linuxAutostart({ ...options, dataRoot: path.join(root, 'other') }, run, 1000);
    assert.equal(other.status().conflict, true);
    assert.throws(() => other.set(false), /unmanaged/);
    assert.throws(() => other.set(true), /unmanaged/);
    const invalid = linuxAutostart(options, (command, args) => {
      if (command === 'systemd-analyze') throw new Error('invalid unit');
      run(command, args);
    }, 1000);
    assert.throws(() => invalid.set(true), /invalid unit/);
    assert.equal(await readFile(registration.file, 'utf8'), original);
    const upgraded = linuxAutostart({ ...options, node: path.join(root, 'new node') }, run, 1000);
    assert.equal(upgraded.set(true).enabled, true);
    assert.match(await readFile(registration.file, 'utf8'), /new node/);
    assert.equal(upgraded.set(false).enabled, false);
    assert.ok(calls.every(([command, ...args]) => command === 'systemd-analyze' || ['show-environment', 'daemon-reload'].includes(args[1])));
    assert.ok(calls.some(([command]) => command === 'systemd-analyze'));
    await writeFile(registration.file, '[Service]\nExecStart=/foreign\n');
    assert.throws(() => registration.set(true), /unmanaged/);
    assert.throws(() => registration.set(false), /unmanaged/);
    assert.equal(await readFile(registration.file, 'utf8'), '[Service]\nExecStart=/foreign\n');
    await rm(registration.file);
    await mkdir(path.dirname(registration.link), { recursive: true });
    await symlink('/foreign.service', registration.link);
    assert.throws(() => registration.set(false), /unmanaged/);
    assert.equal(await readlink(registration.link), '/foreign.service');
  } finally { await rm(root, { recursive: true, force: true }); }
});
