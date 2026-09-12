import path from 'node:path';
import os from 'node:os';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ListenOptions } from 'node:net';

export function defaultDataRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'linux') {
    if (env.CODEX_USAGE_DATA_DIR && !path.isAbsolute(env.CODEX_USAGE_DATA_DIR)) throw new Error('CODEX_USAGE_DATA_DIR must be absolute on Linux.');
    return env.CODEX_USAGE_DATA_DIR ? path.resolve(env.CODEX_USAGE_DATA_DIR)
      : path.join(xdgHome(env.XDG_DATA_HOME, path.join(home, '.local/share')), 'CodexUsage');
  }
  return path.resolve(env.CODEX_USAGE_DATA_DIR || (platform === 'darwin'
    ? path.join(home, 'Library/Application Support/CodexUsage')
    : path.join(env.LOCALAPPDATA || path.join(home, '.local/share'), 'CodexUsage')));
}

// The XDG specification requires relative values to be ignored.
export function xdgHome(value: string | undefined, fallback: string) {
  return value && path.isAbsolute(value) ? value : fallback;
}

export function supportedPlatform(platform = process.platform, arch = process.arch) {
  return (platform === 'win32' && arch === 'x64') || (['darwin', 'linux'].includes(platform) && ['x64', 'arm64'].includes(arch));
}

export function browserCommand(url: string, platform = process.platform, env = process.env) {
  if (platform === 'linux') {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) throw new Error('No desktop session (DISPLAY/WAYLAND_DISPLAY is unset)');
    return { command: 'xdg-open', args: [url], wait: true };
  }
  return platform === 'darwin' ? { command: '/usr/bin/open', args: [url], wait: true }
    : { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url], wait: false };
}

export function serviceGuardAddress(root: string, platform = process.platform): ListenOptions {
  // Resolve aliases before deriving the lock. Keep POSIX case, including on case-sensitive APFS.
  const actual = realpathSync.native(root);
  const hash = createHash('sha256').update(platform === 'win32' ? actual.toLowerCase() : actual).digest();
  if (platform === 'win32') return { path: '\\\\.\\pipe\\codex-usage-' + hash.toString('hex').slice(0, 32) };
  if (platform === 'darwin' || platform === 'linux') return { host: '127.0.0.1', port: 49152 + hash.readUInt16BE(0) % 16384, exclusive: true };
  throw new Error('Managed service supports Windows x64 and macOS/Linux x64/arm64 only.');
}
