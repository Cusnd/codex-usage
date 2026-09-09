import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
export async function captureProcess(file, args, options = {}) {
  if (process.platform !== 'win32') {
    const pending = exec(file, args, options);
    pending.child.stdin.end();
    return pending;
  }
  // Detached descendants can retain Windows pipe handles after the launcher exits.
  // Files preserve complete output without making command completion wait for EOF.
  const directory = mkdtempSync(path.join(os.tmpdir(), 'codex-process-'));
  const output = path.join(directory, 'stdout'), errors = path.join(directory, 'stderr');
  const handles = [];
  try {
    handles.push(openSync(output, 'w'));
    handles.push(openSync(errors, 'w'));
    const child = spawn(file, args, { windowsHide: true, ...options, stdio: ['ignore', ...handles] });
    for (const fd of handles.splice(0)) closeSync(fd);
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const stdout = readFileSync(output, 'utf8'), stderr = readFileSync(errors, 'utf8');
    if (result.code !== 0 || child.killed) throw Object.assign(new Error(`Command failed: ${file} ${args.join(' ')}\n${stderr}`), {
      ...result, stdout, stderr, killed: child.killed,
    });
    return { stdout, stderr };
  } finally {
    for (const fd of handles) closeSync(fd);
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('codex-process-'));
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
