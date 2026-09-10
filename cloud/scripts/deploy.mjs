import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
const cloud = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(cloud, '..');
const wrangler = path.join(cloud, 'node_modules/wrangler/bin/wrangler.js');
const config = JSON.parse(readFileSync(path.join(cloud, 'wrangler.jsonc'), 'utf8'));
if (config.name !== 'codex-usage-cloud' || config.main !== 'src/index.ts' || config.vars.APP_ORIGIN !== 'https://quota.esoren.com' || !config.vars.GITHUB_CLIENT_ID || config.d1_databases[0].database_id.startsWith('00000000'))
  throw new Error('Production Worker, origin, OAuth client and D1 must be configured before deployment.');
const local = path.join(cloud, '.deploy'); mkdirSync(local, { recursive: true, mode: 0o700 });
function run(script, args, cwd = cloud) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, stdio: 'inherit', windowsHide: true, env: { ...process.env, CI: 'true' } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed: ${path.basename(script)} ${args[0]}`);
}
run(path.join(cloud, 'node_modules/typescript/bin/tsc'), ['--noEmit']);
run(path.join(root, 'node_modules/vite/bin/vite.js'), ['build', '--mode', 'cloud'], root);
run(wrangler, ['deploy', '--dry-run', '--outdir', '.deploy/bundle', '--metafile', '.deploy/bundle-meta.json']);
const meta = JSON.parse(readFileSync(path.join(local, 'bundle-meta.json'), 'utf8'));
if (Object.keys(meta.inputs).some(file => /(?:^|\/)(?:server|showcase|test)\//.test(file.replaceAll('\\', '/')))) throw new Error('Private/test modules found in the Worker bundle.');
function files(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]); }
for (const file of files(path.join(cloud, 'build')).filter(file => /\.(js|html)$/.test(file))) {
  const text = readFileSync(file, 'utf8');
  if (/node:sqlite|SYNTHETIC-NEVER-UPLOAD|synthetic-account-private-id|CODEX_HOME|cloud-credentials\.json|synthetic-browser-user/.test(text)) throw new Error('Private/test data found in cloud assets.');
}
const varsFile = path.join(cloud, '.dev.vars');
const secret = process.env.GITHUB_CLIENT_SECRET || (existsSync(varsFile) ? parseEnv(readFileSync(varsFile, 'utf8')).GITHUB_CLIENT_SECRET : undefined);
const secretFile = path.join(local, 'secrets.json');
try {
  if (secret) writeFileSync(secretFile, JSON.stringify({ GITHUB_CLIENT_SECRET: secret }), { mode: 0o600 });
  // Incremental migrations preserve existing user data. Schema rollback requires a separate migration.
  run(wrangler, ['d1', 'migrations', 'apply', 'DB', '--remote']);
  run(wrangler, ['deploy', ...(secret ? ['--secrets-file', secretFile] : [])]);
  let verified = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const health = await fetch(config.vars.APP_ORIGIN + '/api/health', { signal: AbortSignal.timeout(15000) });
      const result = await health.json();
      if (health.ok && result.ok && result.loginConfigured) { verified = true; break; }
    } catch { /* A newly created custom domain may still have negative DNS caches. */ }
    if (attempt < 5) {
      console.log('Worker deployed; retrying public health verification in 10 seconds.');
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
  if (!verified) throw new Error('Worker deployment completed, but public health verification failed. Check DNS propagation, HTTPS and /api/health before declaring the deployment ready.');
  console.log('Verified https://quota.esoren.com: D1 ready; GitHub login configured.');
} finally { if (existsSync(secretFile)) rmSync(secretFile); }
