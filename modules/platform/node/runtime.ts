import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { defaultDataRoot, xdgHome } from './platform.js';
import { macAutostart } from './mac-autostart.js';
import { linuxAutostart } from './linux-autostart.js';

function findPackageRoot(start: string): string {
  let current = start;
  while (true) {
    const candidate = path.join(current, 'package.json');
    if (existsSync(candidate) && JSON.parse(readFileSync(candidate, 'utf8')).name === '@esoren/codex-usage') return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Cannot locate the codex-usage package root.');
    current = parent;
  }
}
export const packageRoot = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
export const version: string = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
export const dataRoot = defaultDataRoot();
export const port = Number(process.env.PORT || 8765);
export const base = `http://127.0.0.1:${port}`;
export const instanceFile = path.join(dataRoot, 'instance.json');
export type Instance = { pid: number; token: string; version: string; port: number };
export function instance(): Instance | null {
  try { return JSON.parse(readFileSync(instanceFile, 'utf8')); } catch { return null; }
}
export function alive(pid: number) { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; } }
export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function control(record: Instance, action = 'identity') {
  if (action === 'stop') await control(record, 'identity');
  const controller = new AbortController();
  // AbortSignal.timeout is unref'ed. A short-lived CLI must stay alive while
  // a disconnected control request is pending, even after detaching its child.
  const deadline = setTimeout(() => controller.abort(new Error('Service control timed out.')), 2000);
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/_control/${action}`, {
      method: 'POST', headers: { Authorization: `Bearer ${record.token}` }, signal: controller.signal,
    });
    if (!response.ok) throw new Error('Service identity could not be verified. No process was stopped.');
    const body = await response.json() as any;
    if (body.pid !== record.pid || body.version !== record.version) throw new Error('Service identity mismatch.');
    return body;
  } finally { clearTimeout(deadline); }
}
function powershell(script: string) {
  const prelude = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ";
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(prelude + script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error: any) {
    throw new Error('Windows startup operation failed: ' + String(error.stderr || error.code || 'unknown error').slice(0, 600));
  }
}
const ps = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const macStartup = () => macAutostart({
  directory: process.env.CODEX_USAGE_STARTUP_DIR || path.join(os.homedir(), 'Library/LaunchAgents'),
  dataRoot, node: process.execPath, cli: path.join(packageRoot, 'bin/codex-usage.mjs'), port, env: process.env,
});
const linuxStartup = () => linuxAutostart({
  directory: process.env.CODEX_USAGE_STARTUP_DIR || path.join(xdgHome(process.env.XDG_CONFIG_HOME, path.join(os.homedir(), '.config')), 'systemd/user'),
  dataRoot, node: process.execPath, entry: path.join(packageRoot, 'dist/apps/local/index.js'), port, env: process.env,
});
function startupPath() {
  if (process.platform !== 'win32') throw new Error('Autostart is supported on Windows only.');
  return path.join(process.env.CODEX_USAGE_STARTUP_DIR || path.join(process.env.APPDATA!, 'Microsoft/Windows/Start Menu/Programs/Startup'), 'Codex Usage.lnk');
}
export function autostartStatus() {
  if (process.platform === 'linux') return linuxStartup().status();
  if (process.platform === 'darwin') return macStartup().status();
  if (process.platform !== 'win32') return { supported: false, enabled: false };
  const shortcut = startupPath();
  if (!existsSync(shortcut)) return { supported: true, enabled: false };
  const target = powershell(`. ${ps(path.join(packageRoot, 'scripts/shell-link.ps1'))}; [CodexUsage.StartupLink]::ReadArguments(${ps(shortcut)})`);
  return { supported: true, enabled: target.includes(path.join(dataRoot, 'launch.ps1')), conflict: !target.includes(path.join(dataRoot, 'launch.ps1')) };
}
export function setAutostart(enabled: boolean) {
  if (process.platform === 'linux') return linuxStartup().set(enabled);
  if (process.platform === 'darwin') return macStartup().set(enabled);
  const shortcut = startupPath();
  if (autostartStatus().conflict) throw new Error('An unmanaged Codex Usage startup shortcut already exists.');
  if (!enabled) { if (existsSync(shortcut)) unlinkSync(shortcut); return autostartStatus(); }
  mkdirSync(dataRoot, { recursive: true }); mkdirSync(path.dirname(shortcut), { recursive: true });
  const launcher = path.join(dataRoot, 'launch.ps1');
  const env = ['CODEX_USAGE_DATA_DIR', 'CODEX_HOME', 'CODEX_BIN'].map(key => process.env[key] ? `$env:${key}=${ps(process.env[key]!)}\n` : '').join('');
  const cliArgument = '"' + path.join(packageRoot, 'bin/codex-usage.mjs') + '" start';
  writeFileSync(launcher, `\ufeff${env}$env:CODEX_USAGE_DATA_DIR=${ps(dataRoot)}\n$env:PORT=${ps(String(port))}\nStart-Process -FilePath ${ps(process.execPath)} -ArgumentList ${ps(cliArgument)} -WindowStyle Hidden -RedirectStandardOutput ${ps(path.join(dataRoot, 'launcher.log'))} -RedirectStandardError ${ps(path.join(dataRoot, 'launcher-error.log'))}\n`, 'utf8');
  const args = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${launcher}"`;
  powershell(`. ${ps(path.join(packageRoot, 'scripts/shell-link.ps1'))}; [CodexUsage.StartupLink]::Save(${ps(shortcut)}, ${ps(path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'))}, ${ps(args)}, ${ps(dataRoot)})`);
  const result = autostartStatus();
  if (!result.enabled) throw new Error('Startup registration did not persist.');
  return result;
}
