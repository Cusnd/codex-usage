import path from 'node:path';
import os from 'node:os';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ListenOptions } from 'node:net';

export function defaultDataRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  return path.resolve(env.CODEX_USAGE_DATA_DIR || (platform === 'darwin'
    ? path.join(home, 'Library/Application Support/CodexUsage')
    : path.join(env.LOCALAPPDATA || path.join(home, '.local/share'), 'CodexUsage')));
}

export function serviceGuardAddress(root: string, platform = process.platform): ListenOptions {
  // Resolve aliases before deriving the lock. Keep POSIX case, including on case-sensitive APFS.
  const actual = realpathSync.native(root);
  const hash = createHash('sha256').update(platform === 'win32' ? actual.toLowerCase() : actual).digest();
  if (platform === 'win32') return { path: '\\\\.\\pipe\\codex-usage-' + hash.toString('hex').slice(0, 32) };
  if (platform === 'darwin') return { host: '127.0.0.1', port: 49152 + hash.readUInt16BE(0) % 16384, exclusive: true };
  throw new Error('Managed service supports Windows x64 and macOS x64/arm64 only.');
}
