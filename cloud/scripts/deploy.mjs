import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
const cloud = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(cloud, '..');
const preview = process.argv.includes('--preview');
if (process.argv.includes('--backend-first')) throw new Error('Backend and browser assets must use the same build; --backend-first is retired.');
const prepareOnly = process.argv.includes('--prepare-only');
const deploymentInputs = ['cloud', 'shared', 'web', 'server', 'bin', 'scripts/build-version.mjs', 'vite.config.ts', 'tsconfig.json', 'tsconfig.server.json', 'package.json', 'package-lock.json'];
function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Cannot verify preview source: git ${args[0]} failed.`);
  return result.stdout.trim();
}
let previewRevision;
function verifyPreviewSource() {
  if (!preview) return;
  if (git(['branch', '--show-current']) !== 'preview') throw new Error('Preview deployment requires the preview branch.');
  if (git(['status', '--porcelain', '--untracked-files=all', '--', ...deploymentInputs]))
    throw new Error('Commit all cloud deployment inputs before deploying preview.');
  const revision = git(['rev-parse', 'HEAD']);
  if (previewRevision && previewRevision !== revision) throw new Error('Preview source changed during deployment.');
  if (git(['ls-remote', 'origin', 'refs/heads/preview']).split(/\s+/)[0] !== revision)
    throw new Error('Push this snapshot to origin/preview before deploying preview.');
  previewRevision = revision;
}
verifyPreviewSource();
const versionArgs = preview ? ['--tag', `preview-${previewRevision.slice(0, 12)}`, '--message', `preview source ${previewRevision}`] : [];
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
run(path.join(root, 'scripts/build-version.mjs'), [], root);
const expectedBuild = JSON.parse(readFileSync(path.join(root,'shared/build-version.ts'),'utf8').match(/export const BUILD_VERSION = ("[^"]+");/)?.[1] || 'null');
if (typeof expectedBuild !== 'string') throw new Error('Missing generated application build.');
run(path.join(cloud, 'node_modules/typescript/bin/tsc'), ['--noEmit', '--project', 'tsconfig.deploy.json']);
run(path.join(root, 'node_modules/vite/bin/vite.js'), ['build', '--mode', 'cloud'], root);
run(wrangler, ['deploy', '--dry-run', '--outdir', '.deploy/bundle', '--metafile', '.deploy/bundle-meta.json']);
const meta = JSON.parse(readFileSync(path.join(local, 'bundle-meta.json'), 'utf8'));
if (Object.keys(meta.inputs).some(file => /(?:^|\/)(?:server|showcase|test)\//.test(file.replaceAll('\\', '/')))) throw new Error('Private/test modules found in the Worker bundle.');
function files(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]); }
for (const file of files(path.join(cloud, 'build')).filter(file => /\.(js|html)$/.test(file))) {
  const text = readFileSync(file, 'utf8');
  if (/node:sqlite|SYNTHETIC-NEVER-UPLOAD|synthetic-account-private-id|CODEX_HOME|cloud-credentials\.json|synthetic-browser-user/.test(text)) throw new Error('Private/test data found in cloud assets.');
}
verifyPreviewSource();
if (prepareOnly) {
  console.log('Deployment preparation passed; no remote migrations or deployment performed.');
  process.exit(0);
}
const varsFile = path.join(cloud, '.dev.vars');
const secret = process.env.GITHUB_CLIENT_SECRET || (existsSync(varsFile) ? parseEnv(readFileSync(varsFile, 'utf8')).GITHUB_CLIENT_SECRET : undefined);
const secretFile = path.join(local, 'secrets.json');
try {
  if (secret) writeFileSync(secretFile, JSON.stringify({ GITHUB_CLIENT_SECRET: secret }), { mode: 0o600 });
  // Current initializer requires empty storage; existing current deployments use the D1 ledger.
  // Retired schemas must be reprovisioned explicitly; never reset remote data here.
  run(wrangler, ['d1', 'migrations', 'apply', 'DB', '--remote']);
  verifyPreviewSource();
  run(wrangler, ['deploy', ...versionArgs, ...(secret ? ['--secrets-file', secretFile] : [])]);
  let verified = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const health = await fetch(config.vars.APP_ORIGIN + '/api/health', { signal: AbortSignal.timeout(15000) });
      const result = await health.json();
      if (health.ok && result.ok && result.usageProtocol === 3 && result.loginConfigured && result.buildVersion === expectedBuild && health.headers.get('X-Codex-Usage-Build') === expectedBuild) { verified = true; break; }
    } catch { /* A newly created custom domain may still have negative DNS caches. */ }
    if (attempt < 5) {
      console.log('Worker deployed; retrying public health verification in 10 seconds.');
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
  if (!verified) throw new Error('Worker deployment completed, but public health verification failed. Check DNS propagation, HTTPS and /api/health before declaring the deployment ready.');
  console.log('Verified https://quota.esoren.com: D1 ready; GitHub login configured; deployed source build ' + expectedBuild);
} finally { if (existsSync(secretFile)) rmSync(secretFile); }
