import { mkdirSync, existsSync, readFileSync, copyFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { recentCalendarRange } from "../../modules/foundation/time-range.js";
import { dataRoot, packageRoot, version, port, base, instance, alive, control, delay, autostartStatus, setAutostart } from "../../modules/platform/node/runtime.js";
import { ensureService } from '../../modules/platform/node/service.js';
import { request } from './cli/request.js';
import { openBrowser } from '../../modules/platform/node/browser.js';
import { skill } from '../../modules/platform/node/skill-install.js';

async function main() {
  const argv = process.argv.slice(2);
  const command = argv.shift() || 'open';
  const flags: Record<string, string | boolean | string[]> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    if (flags[key] !== undefined && key !== 'unknowns') throw new Error(`Duplicate option: ${arg}`);
    if (['json', 'wait', 'help', 'no-open'].includes(key)) flags[key] = true;
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
      const value = argv[++i];
      flags[key] = key === 'unknowns' ? [...(flags[key] as string[] || []), value] : value;
    }
  }
  const output = (value: unknown) => console.log(JSON.stringify(value, null, flags.json ? undefined : 2));
  if (['--version', 'version'].includes(command)) return console.log(version);
  if (['--help', 'help'].includes(command) || flags.help) return console.log('codex-usage [open|start|stop|status|doctor|autostart enable/disable/status|skill install/uninstall|migrate --from FILE|refresh --source local/account/all --wait|summary|trend|breakdown|compare|threads|thread|turns|agents|limits|usage] [--days N] [--id ID] [--json]\ncodex-usage cloud connect [--name NAME] [--no-open] [--wait] [--json]\ncodex-usage cloud status|pause|resume|disconnect [--json]\nDefault: open local Web. Queries start the service without opening a browser. Set PORT/CODEX_USAGE_DATA_DIR explicitly for an isolated instance.');
  const filters = ['from', 'to', 'days', 'project', 'model', 'effort', 'threadId', 'thread-id', 'unknown', 'unknowns'];
  const paging = ['limit', 'offset'];
  const options: Record<string, string[]> = {
    open: [], start: [], stop: [], status: [], doctor: [], autostart: [], skill: [], migrate: ['from'], cloud: ['name', 'no-open', 'wait'],
    refresh: ['source', 'wait', 'timeout'], summary: filters, trend: [...filters, 'bucket'],
    breakdown: [...filters, ...paging, 'groupBy', 'group-by'],
    compare: [...filters, 'groupBy', 'group-by', 'baselineFrom', 'baseline-from', 'baselineTo', 'baseline-to'],
    threads: [...filters, ...paging, 'sort', 'q', 'cacheBelow', 'cache-below'],
    thread: ['id'], turns: [...filters, ...paging, 'id', 'sort', 'q', 'turnId', 'missingTurn'],
    agents: [...filters, 'id'], limits: [], usage: ['from', 'to'],
  };
  if (!options[command]) throw new Error('Unknown command. Run codex-usage --help.');
  for (const key of Object.keys(flags)) if (key !== 'json' && !options[command].includes(key)) throw new Error(`Option --${key} is not supported by ${command}.`);
  if (positional.length !== (['autostart', 'skill', 'cloud'].includes(command) ? 1 : 0)) throw new Error('Unexpected or missing command arguments. Run codex-usage --help.');
  if (command === 'cloud') {
    const action = positional[0];
    if (!['connect', 'status', 'pause', 'resume', 'disconnect'].includes(action)) throw new Error('Use cloud connect|status|pause|resume|disconnect.');
    if (action !== 'connect' && Object.keys(flags).some(key => key !== 'json')) throw new Error('Only cloud connect accepts --name, --no-open, and --wait.');
    if (!process.env.CODEX_USAGE_URL) await ensureService();
    let result = action === 'connect' ? await request('cloud/connect', typeof flags.name === 'string' ? { deviceName: flags.name } : {})
      : action === 'disconnect' ? await request('cloud/connection', undefined, 'DELETE')
      : ['pause', 'resume'].includes(action) ? await request('cloud/settings', { enabled: action === 'resume' }, 'PATCH') : await request('cloud/status');
    if (action === 'connect' && result.data.binding && !flags['no-open'] && !flags.json) {
      const url = new URL(result.data.binding.verificationUrl);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Invalid cloud verification URL.');
      try { await openBrowser(url.href); }
      catch (error) { console.error(`Browser could not be opened: ${(error as Error).message}. Open ${url.href} to finish binding.`); }
    }
    if (action === 'connect' && flags.wait && result.data.binding) {
      console.error(`Confirm code ${result.data.binding.userCode} at ${result.data.binding.verificationUrl}`);
      const expires = Date.parse(result.data.binding.expiresAt);
      while (result.data.binding && Date.now() < expires) { await delay(2000); result = await request('cloud/status'); }
      if (!result.data.connected) process.exitCode = 1;
    }
    return output(result);
  }
  if (command === 'autostart') return output(positional[0] === 'status' ? autostartStatus() : ['enable', 'disable'].includes(positional[0]) ? setAutostart(positional[0] === 'enable') : (() => { throw new Error('Use autostart enable|disable|status'); })());
  if (command === 'skill') return output(skill(positional[0]));
  if (command === 'doctor') {
    const record = instance(); let verified = false;
    if (record) { try { await control(record); verified = true; } catch {} }
    return output({ version, node: process.version, platform: process.platform, architecture: process.arch, dataRoot, webAssets: existsSync(path.join(packageRoot, 'dist/web/index.html')), port, domainCompatible: port === 8765, service: verified ? 'verified' : record ? 'unverified' : 'stopped', autostart: autostartStatus() });
  }
  if (command === 'stop') {
    const record = instance();
    if (!record || !alive(record.pid)) return output({ running: false });
    await control(record, 'stop');
    for (let i = 0; i < 150; i++) { if (!instance() || instance()?.token !== record.token) return output({ running: false }); await delay(200); }
    throw new Error('Shutdown is still in progress. Retry status; no process was force-killed.');
  }
  if (command === 'status') {
    if (process.env.CODEX_USAGE_URL) return output(await request('status'));
    const record = instance();
    if (!record || !alive(record.pid)) return output({ running: false });
    await control(record);
    if (record.port !== port) throw new Error(`Set PORT=${record.port} to query this instance.`);
    return output(await request('status'));
  }
  if (command === 'migrate') {
    if (instance() && alive(instance()!.pid)) throw new Error('Stop this service before migration.');
    if (typeof flags.from !== 'string') throw new Error('Use migrate --from ABSOLUTE_DATABASE_FILE after stopping the old service.');
    const source = path.resolve(flags.from), target = path.join(dataRoot, 'usage.sqlite');
    if (existsSync(target)) throw new Error('Destination database already exists; it will not be overwritten.');
    if (existsSync(source + '-wal') || existsSync(source + '-shm')) throw new Error('Source has SQLite sidecars. Cleanly stop the old service before copying.');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(source, { readOnly: true });
    try { if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('Source integrity check failed.'); db.prepare('SELECT value FROM settings WHERE id=1').get(); } finally { db.close(); }
    mkdirSync(dataRoot, { recursive: true }); copyFileSync(source, target, 1);
    const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
    if (hash(source) !== hash(target)) { unlinkSync(target); throw new Error('Copy checksum mismatch.'); }
    return output({ migrated: true, sourcePreserved: true, sha256: hash(target) });
  }
  const routes: Record<string, string> = { summary: 'local/summary', trend: 'local/trend', breakdown: 'local/breakdown', compare: 'local/compare', threads: 'local/threads', thread: 'local/threads/', turns: 'local/turns', agents: 'local/threads/', limits: 'account/limits', usage: 'account/usage' };
  if (!['open', 'start', 'refresh', ...Object.keys(routes)].includes(command)) throw new Error('Unknown command. Run codex-usage --help.');
  if (!process.env.CODEX_USAGE_URL || command === 'open' || command === 'start') await ensureService();
  if (command === 'start' || command === 'open') {
    if (port !== 8765) console.error('Custom port: usage.esoren.com still redirects to port 8765.');
    if (command === 'open') {
      try {
        await openBrowser(base);
      } catch (error) {
        console.error(`Browser could not be opened: ${(error as Error).message}. Open ${base} manually; the service is running.`);
        process.exitCode = 1;
      }
    }
    return output({ running: true, url: base, version });
  }
  if (command === 'refresh') {
    const source = String(flags.source || 'local');
    const timeout = Number(flags.timeout || 300);
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 3600) throw new Error('--timeout must be 1–3600 seconds.');
    let result = await request('refresh', { source });
    if (flags.wait) {
      const keys = source === 'all' ? ['local', 'accountLimits', 'accountHistory'] : source === 'account' ? ['accountLimits', 'accountHistory'] : [source];
      const until = Date.now() + timeout * 1000;
      while (keys.some(key => result.data[key]?.running)) {
        if (Date.now() > until) throw new Error('Refresh timed out; import may continue. Inspect status.');
        await delay(300); result = await request('status');
      }
      if (keys.some(key => result.data[key]?.error)) process.exitCode = 1;
    }
    return output(result);
  }
  let route = routes[command];
  if (['thread', 'agents'].includes(command) && !flags.id) throw new Error('--id is required.');
  if (command === 'thread' || command === 'agents') route += encodeURIComponent(String(flags.id)) + (command === 'agents' ? '/agents' : '');
  if (command === 'turns' && flags.id) route = `local/threads/${encodeURIComponent(String(flags.id))}/turns`;
  if (flags.days) {
    if (command === 'usage') throw new Error('Account daily buckets require explicit --from/--to dates.');
    if (flags.from || flags.to) throw new Error('Choose --days or explicit --from/--to.');
    const days = Number(flags.days);
    if (!Number.isInteger(days) || days < 1 || days > 3660) throw new Error('--days must be 1–3660.');
    const settings = await request('settings');
    Object.assign(flags, recentCalendarRange(days, settings.data.timezone));
  }
  const params = new URLSearchParams();
  const aliases: Record<string, string> = { 'group-by': 'groupBy', 'cache-below': 'cacheBelow', 'thread-id': 'threadId', 'baseline-from': 'baselineFrom', 'baseline-to': 'baselineTo' };
  for (const [key, value] of Object.entries(flags)) if (!['json', 'days', 'id'].includes(key)) {
    if (Array.isArray(value)) value.forEach(entry => params.append(aliases[key] || key, entry));
    else params.set(aliases[key] || key, String(value));
  }
  if (command === 'breakdown' && !params.has('groupBy')) params.set('groupBy', 'project');
  const query = Object.fromEntries([...new Set(params.keys())].map(key => [key, params.getAll(key).length > 1 ? params.getAll(key) : params.get(key)]));
  output({ query, ...await request(route + (params.size ? '?' + params : '')) });
}

main().catch(error => { console.error(JSON.stringify({ error: { code: 'CLI_ERROR', message: error instanceof Error ? error.message : String(error) } })); process.exitCode = 1; });
