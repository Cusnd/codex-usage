import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:net';
import { projectPath } from '../server/util.js';
import { defaultDataRoot, serviceGuardAddress } from '../server/platform.js';
import { macAutostart, launchAgentPlist } from '../server/mac-autostart.js';
import { resolveCodexCommand } from '../server/codex-command.js';

test('project paths follow their source platform, preserving POSIX case and roots', () => {
  for (const [input, expected] of [
    ['C:\\Work\\Demo\\', 'c:\\work\\demo'], ['C:/Work/../Demo', 'c:\\demo'],
    ['\\\\?\\C:\\Work', 'c:\\work'], ['\\\\?\\UNC\\Server\\Share\\Demo', '\\\\server\\share\\demo'],
    ['\\\\Server\\Share\\Demo\\', '\\\\server\\share\\demo'], ['C:\\', 'c:\\'],
    ['//Server/Share/Demo', '\\\\server\\share\\demo'],
    ['\\\\Server\\Share\\', '\\\\server\\share\\'], ['/', '/'],
    ['/Users/中文 空格/Project/../Demo/', '/Users/中文 空格/Demo'],
    ['/Users/A/file\\name', '/Users/A/file\\name'],
  ]) assert.equal(projectPath(input), expected, input);
  assert.notEqual(projectPath('/Users/A/Project'), projectPath('/Users/A/project'));
  assert.equal(projectPath(null), null);
});

test('platform data defaults and explicit overrides', () => {
  const home = path.resolve('fake-home');
  assert.equal(defaultDataRoot({}, 'darwin', home), path.join(home, 'Library/Application Support/CodexUsage'));
  assert.equal(defaultDataRoot({ LOCALAPPDATA: path.join(home, 'Local') }, 'win32', home), path.join(home, 'Local/CodexUsage'));
  assert.equal(defaultDataRoot({ CODEX_USAGE_DATA_DIR: 'custom' }, 'darwin', home), path.resolve('custom'));
});

test('data-directory aliases share a kernel guard; conflicts do not displace its owner', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lock-'));
  const first = createServer(socket => socket.destroy());
  const second = createServer();
  try {
    const data = path.join(root, 'data'); await mkdir(data);
    const alias = path.join(root, 'alias'); await symlink(data, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const address = serviceGuardAddress(data, 'darwin');
    assert.deepEqual(serviceGuardAddress(alias, 'darwin'), address);
    await new Promise<void>((resolve, reject) => { first.once('error', reject); first.listen(address, resolve); });
    await assert.rejects(new Promise<void>((resolve, reject) => { second.once('error', reject); second.listen(address, resolve); }), { code: 'EADDRINUSE' });
    assert.ok(first.listening);
    await new Promise<void>(resolve => first.close(() => resolve()));
    await new Promise<void>((resolve, reject) => { second.once('error', reject); second.listen(address, resolve); });
  } finally {
    if (first.listening) await new Promise<void>(resolve => first.close(() => resolve()));
    if (second.listening) await new Promise<void>(resolve => second.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('LaunchAgent registration preserves ownership and old configuration on validation failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-launch-中文 & 空格-'));
  const options = { directory: path.join(root, 'agents'), dataRoot: path.join(root, 'data'),
    node: '/node path/node', cli: '/cli <test>/"entry".mjs', port: 8765,
    env: { PATH: '/node path:/usr/bin', CODEX_HOME: '/Users/测试/.codex', CODEX_BIN: '/bin/it\'s codex' } };
  // Platform-independent ownership tests; actual plutil/launchd run in macOS package smoke.
  const registration = macAutostart(options, () => {});
  try {
    assert.equal(registration.status().enabled, false);
    assert.equal(registration.set(true).enabled, true);
    const original = await readFile(registration.file, 'utf8');
    assert.match(original, /&amp;/); assert.match(original, /&lt;test&gt;/); assert.match(original, /&quot;entry&quot;/); assert.match(original, /it&apos;s/);
    assert.match(original, /<key>KeepAlive<\/key><false\/>/);
    assert.match(original, /<key>AbandonProcessGroup<\/key><true\/>/);
    const different = macAutostart({ ...options, dataRoot: path.join(root, 'other') }, () => {});
    assert.equal(different.status().conflict, true);
    assert.throws(() => different.set(false), /unmanaged/);
    assert.throws(() => different.set(true), /unmanaged/);
    const broken = macAutostart(options, file => { if (file.endsWith('.tmp')) throw new Error('invalid plist'); });
    assert.throws(() => broken.set(true), /invalid plist/);
    assert.equal(await readFile(registration.file, 'utf8'), original);
    assert.equal(registration.set(false).enabled, false);
    await writeFile(registration.file, '<plist>foreign</plist>');
    assert.throws(() => registration.set(false), /unmanaged/);
    assert.equal(await readFile(registration.file, 'utf8'), '<plist>foreign</plist>');
    assert.ok(launchAgentPlist(options).includes('<key>RunAtLoad</key><true/>'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('macOS resolver handles executable permission, npm symlinks and invalid override', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-resolve-中文 空格-'));
  try {
    const native = path.join(root, 'codex'); await writeFile(native, '#!/bin/sh\nexit 0\n');
    await chmod(native, 0o600);
    await assert.rejects(resolveCodexCommand({ CODEX_BIN: native }, 'darwin'), /CODEX_BIN/);
    await chmod(native, 0o700);
    assert.equal((await resolveCodexCommand({ PATH: root }, 'darwin')).bin, await realpath(native));
    await assert.rejects(resolveCodexCommand({ CODEX_BIN: path.join(root, 'missing'), PATH: root }, 'darwin'), /CODEX_BIN/);
    const js = path.join(root, 'entry.js'); await writeFile(js, '');
    const shim = path.join(root, 'npm-codex'); await symlink(js, shim);
    assert.deepEqual(await resolveCodexCommand({ CODEX_BIN: shim }, 'darwin'), { bin: process.execPath, args: [await realpath(js)] });
    await assert.rejects(resolveCodexCommand({ CODEX_BIN: root }, 'darwin'), /CODEX_BIN/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
