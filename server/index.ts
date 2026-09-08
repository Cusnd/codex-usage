import { createApp } from './app.js';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { dataRoot, port, version, instanceFile, instance, alive } from './runtime.js';

mkdirSync(dataRoot, { recursive: true });
if (process.platform !== 'win32') throw new Error('Managed service startup currently supports Windows only.');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535.');
// An OS-owned named pipe serializes all starters and is released even after a crash.
// Unlike a PID-only lock, stale-file recovery cannot delete a new starter's lock.
const guard = createServer(socket => socket.destroy());
const pipe = '\\\\.\\pipe\\codex-usage-' + createHash('sha256').update(dataRoot.toLowerCase()).digest('hex').slice(0, 32);
try {
  await new Promise<void>((resolve, reject) => { guard.once('error', reject); guard.listen(pipe, resolve); });
} catch {
  console.error('Service is already starting/running for this data directory.'); process.exit(1);
}
const old = instance();
if (old && alive(old.pid)) { guard.close(); console.error('A live instance record exists; verify or stop it before starting.'); process.exit(1); }
const token = randomBytes(32).toString('hex');
writeFileSync(instanceFile, JSON.stringify({ pid: process.pid, token, version, port }), { mode: 0o600 });
let app: Awaited<ReturnType<typeof createApp>>['app'] | undefined;
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  try { await app?.close(); } finally {
    if (instance()?.token === token) unlinkSync(instanceFile);
    await new Promise<void>(resolve => guard.close(() => resolve()));
  }
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
try {
  ({ app } = await createApp({ logger: false, managed: { token, version, shutdown } }));
  await app.listen({ host: '127.0.0.1', port });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Service failed.');
  await shutdown(); process.exitCode = 1;
}
