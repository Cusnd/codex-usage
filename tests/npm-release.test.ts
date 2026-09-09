import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Release helper is executable JavaScript without a declaration file.
import { releaseInfo } from '../scripts/npm-release.mjs';

function fixture(version: string) {
  return [{ name: '@esoren/codex-usage', version }, { name: '@esoren/codex-usage', version, packages: { '': { version } } }] as const;
}

test('release versions select their npm channel', () => {
  for (const [version, channel] of [['1.2.3', 'latest'], ['1.2.3-alpha.1', 'alpha'], ['1.2.3-beta.2', 'beta'], ['1.2.3-rc.3', 'next']]) {
    assert.equal(releaseInfo(`v${version}`, ...fixture(version)).channel, channel);
  }
});

test('release rejects unsupported labels and mismatched package versions', () => {
  for (const tag of ['v1.2.3-preview.1', 'v01.2.3', 'v1.2.3-rc.01', 'milestone/test', '1.2.3']) {
    assert.throws(() => releaseInfo(tag, ...fixture('1.2.3')));
  }
  assert.throws(() => releaseInfo('v1.2.4', ...fixture('1.2.3')));
  const [pkg, lock] = fixture('1.2.3');
  assert.throws(() => releaseInfo('v1.2.3', pkg, { ...lock, version: '1.2.2' }));
  assert.throws(() => releaseInfo('v1.2.3', pkg, { ...lock, packages: { '': { version: '1.2.2' } } }));
});
