import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { copyDirectory } from '../server/copy-directory.js';

test('Skill directory copy preserves nested files from a Unicode installation path', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-copy-中文 空格-'));
  try {
    const source = path.join(root, '安装目录', 'skills');
    const target = path.join(root, '用户目录', 'skills');
    mkdirSync(path.join(source, 'scripts'), { recursive: true });
    writeFileSync(path.join(source, 'SKILL.md'), '中文 Skill\n');
    writeFileSync(path.join(source, 'scripts', 'query.mjs'), 'console.log("query");\n');
    copyDirectory(source, target);
    for (const file of ['SKILL.md', 'scripts/query.mjs']) {
      assert.deepEqual(readFileSync(path.join(target, file)), readFileSync(path.join(source, file)));
    }
  } finally {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('codex-copy-'));
    rmSync(resolved, { recursive: true, force: true });
  }
});
