import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('CLI rejects unsupported runtimes before loading application code', () => {
  for (const version of ['20.20.0', '22.12.0', '23.11.0', '25.0.0', '27.0.0', '24.0.0-rc.1']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `Object.defineProperty(process.versions, 'node', {value: ${JSON.stringify(version)}}); await import('./bin/codex-usage.mjs');`], { encoding: 'utf8' });
    assert.equal(result.status, 1, version);
    assert.match(result.stderr, /requires Node\.js 22\.13\+/);
    assert.match(result.stderr, /current version:/);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_BUILTIN_MODULE/);
  }
});
