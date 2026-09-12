import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, unlinkSync, renameSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const launchAgentLabel = 'com.esoren.codex-usage';
type Options = { directory: string; dataRoot: string; node: string; cli: string; port: number; env: NodeJS.ProcessEnv };
const xml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const string = (s: string) => `<string>${xml(s)}</string>`;
const marker = (root: string) => `<!-- codex-usage-managed:${createHash('sha256').update(root).digest('hex')} -->`;

export function launchAgentPlist(options: Options) {
  const env: Record<string, string> = { PATH: options.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    PORT: String(options.port), CODEX_USAGE_DATA_DIR: options.dataRoot };
  for (const key of ['CODEX_HOME', 'CODEX_BIN']) if (options.env[key]) env[key] = path.resolve(options.env[key]!);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
${marker(options.dataRoot)}
<plist version="1.0"><dict>
<key>Label</key>${string(launchAgentLabel)}
<key>ProgramArguments</key><array>${[options.node, options.cli, 'start'].map(string).join('')}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><false/>
<key>AbandonProcessGroup</key><true/>
<key>WorkingDirectory</key>${string(options.dataRoot)}
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key>${string(v)}`).join('')}</dict>
<key>StandardOutPath</key>${string(path.join(options.dataRoot, 'launcher.log'))}
<key>StandardErrorPath</key>${string(path.join(options.dataRoot, 'launcher-error.log'))}
</dict></plist>
`;
}

// Registration is for the next login. No bootstrap/bootout here: disabling must not stop the service.
export function macAutostart(options: Options, validate = (file: string) => {
  execFileSync('/usr/bin/plutil', ['-lint', file], { timeout: 15000, stdio: 'pipe' });
}) {
  const file = path.join(options.directory, `${launchAgentLabel}.plist`);
  function status() {
    let info;
    try { info = lstatSync(file); } catch (error: any) { if (error.code === 'ENOENT') return { supported: true, enabled: false }; throw error; }
    if (!info.isFile()) return { supported: true, enabled: false, conflict: true };
    const content = readFileSync(file, 'utf8');
    if (!content.includes(marker(options.dataRoot)) || !content.includes(`<key>Label</key>${string(launchAgentLabel)}`)
      || !content.includes(`<key>CODEX_USAGE_DATA_DIR</key>${string(options.dataRoot)}`)) {
      return { supported: true, enabled: false, conflict: true };
    }
    validate(file);
    return { supported: true, enabled: true, conflict: false };
  }
  function set(enabled: boolean) {
    if (status().conflict) throw new Error('An unmanaged or different-data-directory Codex Usage LaunchAgent already exists.');
    if (!enabled) { try { unlinkSync(file); } catch (error: any) { if (error.code !== 'ENOENT') throw error; } return status(); }
    mkdirSync(options.dataRoot, { recursive: true });
    mkdirSync(options.directory, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, launchAgentPlist(options), { flag: 'wx', mode: 0o600 });
      validate(temporary);
      if (status().conflict) throw new Error('LaunchAgent ownership changed during registration.');
      renameSync(temporary, file);
    } finally {
      try { unlinkSync(temporary); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    return status();
  }
  return { file, status, set };
}
