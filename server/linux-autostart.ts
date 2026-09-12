import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, mkdirSync, writeFileSync, renameSync, unlinkSync, symlinkSync, rmdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const linuxUnitName = 'codex-usage.service';
type Options = { directory: string; dataRoot: string; node: string; entry: string; port: number; env: NodeJS.ProcessEnv };
type Runner = (command: string, args: string[]) => void;
type Status = { supported: boolean; enabled: boolean; conflict?: boolean; reason?: string };
const marker = (root: string) => `# codex-usage-managed:${createHash('sha256').update(root).digest('hex')}`;
const quote = (value: string) => {
  if (value.includes('\0')) throw new Error('systemd values cannot contain NUL.');
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t').replaceAll('%', '%%');
  return '"' + escaped + '"';
};
const dataEnvironment = (root: string) => `Environment=${quote(`CODEX_USAGE_DATA_DIR=${root}`)}`;

export function linuxServiceUnit(options: Options) {
  for (const value of [options.directory, options.dataRoot, options.node, options.entry]) {
    if (!path.isAbsolute(value)) throw new Error('systemd service paths must be absolute.');
  }
  const env: Record<string, string> = {
    PATH: options.env.PATH || '/usr/local/bin:/usr/bin:/bin', PORT: String(options.port),
    CODEX_USAGE_DATA_DIR: options.dataRoot,
  };
  for (const key of ['CODEX_HOME', 'CODEX_BIN', 'CODEX_USAGE_STARTUP_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
    if (key.startsWith('XDG_') && options.env[key] && !path.isAbsolute(options.env[key]!)) continue;
    if (options.env[key]) env[key] = path.resolve(options.env[key]!);
  }
  // ':' disables command environment expansion, including argv[0]; '%' remains a specifier and is escaped above.
  return `${marker(options.dataRoot)}
[Unit]
Description=Codex Usage local dashboard

[Service]
Type=simple
ExecStart=:${[options.node, options.entry].map(quote).join(' ')}
${Object.entries(env).map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`).join('\n')}
Restart=no
TimeoutStopSec=45
UMask=0077
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}

// Like systemctl enable/disable, update the wants link and reload definitions only.
// Never start/stop a unit here: changing future login startup must not affect a live service.
// Keeping both files under directory also makes CODEX_USAGE_STARTUP_DIR fully isolated.
export function linuxAutostart(options: Options, run: Runner = (command, args) => {
  execFileSync(command, args, { env: options.env, timeout: 5000, stdio: 'pipe' });
}, uid = process.getuid?.()) {
  const file = path.join(options.directory, linuxUnitName);
  const link = path.join(options.directory, 'default.target.wants', linuxUnitName);
  const stat = (name: string) => {
    try { return lstatSync(name); } catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
  };
  const remove = (name: string) => { try { unlinkSync(name); } catch (error: any) { if (error.code !== 'ENOENT') throw error; } };
  function ownership() {
    const info = stat(file), enabledLink = stat(link);
    const ownedFile = info?.isFile() && readFileSync(file, 'utf8').split('\n').includes(marker(options.dataRoot))
      && readFileSync(file, 'utf8').split('\n').includes(dataEnvironment(options.dataRoot));
    const ownedLink = enabledLink?.isSymbolicLink() && path.resolve(path.dirname(link), readlinkSync(link)) === file;
    return { enabled: Boolean(ownedFile && ownedLink), conflict: Boolean((info && !ownedFile) || (enabledLink && (!ownedFile || !ownedLink))) };
  }
  function status(): Status {
    const registration = ownership();
    if (uid === 0) return { supported: false, ...registration, reason: 'Autostart requires a non-root systemd user session.' };
    try { run('systemctl', ['--user', 'show-environment']); }
    catch { return { supported: false, ...registration, reason: 'The systemd user manager is unavailable. Ordinary start still works; autostart requires a user login session.' }; }
    return { supported: true, ...registration };
  }
  function set(enabled: boolean) {
    const current = status();
    if (current.conflict) throw new Error('An unmanaged or different-data-directory Codex Usage systemd unit or startup link already exists.');
    if (!current.supported) throw new Error(current.reason);
    if (!enabled) {
      remove(link); remove(file);
      run('systemctl', ['--user', 'daemon-reload']);
      return status();
    }
    mkdirSync(options.dataRoot, { recursive: true, mode: 0o700 });
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    const temporaryDirectory = path.join(options.directory, `.codex-usage-${randomUUID()}`);
    mkdirSync(temporaryDirectory, { mode: 0o700 });
    const temporary = path.join(temporaryDirectory, linuxUnitName);
    try {
      writeFileSync(temporary, linuxServiceUnit(options), { flag: 'wx', mode: 0o600 });
      run('systemd-analyze', ['--user', 'verify', temporary]);
      if (ownership().conflict) throw new Error('systemd unit ownership changed during registration.');
      renameSync(temporary, file);
      mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
      if (!stat(link)) symlinkSync('../' + linuxUnitName, link);
      run('systemctl', ['--user', 'daemon-reload']);
    } finally { remove(temporary); rmdirSync(temporaryDirectory); }
    return status();
  }
  return { file, link, status, set };
}
