import assert from 'node:assert/strict';
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function releaseInfo(tag, pkg, lock) {
  const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(alpha|beta|rc)\.(?:0|[1-9]\d*))?)$/.exec(tag ?? '');
  assert.ok(match, 'Expected vX.Y.Z or vX.Y.Z-{alpha,beta,rc}.N');
  const version = match[1];
  assert.equal(pkg.version, version, 'Tag and package version differ');
  assert.equal(lock.version, version, 'Lockfile version differs');
  assert.equal(lock.packages?.['']?.version, version, 'Lockfile root version differs');
  assert.equal(lock.name, pkg.name, 'Lockfile package name differs');
  return { name: pkg.name, version, channel: { alpha: 'alpha', beta: 'beta', rc: 'next' }[match[2]] ?? 'latest' };
}

const json = async filename => JSON.parse(await readFile(filename, 'utf8'));
async function validate() {
  assert.equal(process.env.GITHUB_REF_TYPE, 'tag', 'Release must run from a tag');
  const info = releaseInfo(process.env.GITHUB_REF_NAME, await json('package.json'), await json('package-lock.json'));
  execFileSync('git', ['fetch', 'origin', 'main'], { stdio: 'inherit' });
  execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD']);
  console.log(JSON.stringify(info));
  return info;
}

function npm(args) {
  // Resolve npm's JavaScript entrypoint so arguments never pass through cmd.exe.
  const prefix = execFileSync('where.exe', ['npm.cmd'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  const cli = path.join(path.dirname(prefix), 'node_modules/npm/bin/npm-cli.js');
  return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
}

async function registry(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  assert.ok(response.ok, `npm registry returned ${response.status}`);
  return response.json();
}

async function main(command) {
  const info = await validate();
  if (command === 'validate') return;
  const directory = path.resolve('release-artifacts/npm');
  const record = path.join(directory, 'release.json');
  if (command === 'pack') {
    await mkdir(directory, { recursive: true });
    const [packed] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', directory]));
    assert.ok(packed.files.every(f => !/(^|\/)(data|output|node_modules|\.env)(\/|$)/.test(f.path)), 'Unexpected private files in package');
    const tarball = path.join(directory, packed.filename);
    const integrity = `sha512-${createHash('sha512').update(await readFile(tarball)).digest('base64')}`;
    assert.equal(integrity, packed.integrity);
    await writeFile(record, JSON.stringify({ ...info, tarball, integrity }, null, 2));
    if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `CODEX_USAGE_TEST_TARBALL=${tarball}\n`);
    console.log(tarball);
    console.log(JSON.stringify({ ...info, integrity, source: process.env.GITHUB_SHA }));
    return;
  }
  assert.equal(command, 'publish');
  const packed = await json(record);
  for (const key of ['name', 'version', 'channel']) assert.equal(packed[key], info[key]);
  assert.equal(`sha512-${createHash('sha512').update(await readFile(packed.tarball)).digest('base64')}`, packed.integrity);
  let publishError;
  try {
    console.log(npm(['publish', packed.tarball, '--access', 'public', '--tag', info.channel, '--registry', 'https://registry.npmjs.org']));
  } catch (error) {
    publishError = error;
    console.error('npm publish reported an error; checking the registry before reporting the outcome.');
  }
  let verificationError;
  // npm scans accepted uploads before they become available; this can exceed 15 minutes.
  const verificationDeadline = Date.now() + 20 * 60 * 1000;
  while (true) {
    try {
      const base = `https://registry.npmjs.org/${encodeURIComponent(info.name)}`;
      const version = await registry(`${base}/${encodeURIComponent(info.version)}`);
      const tags = await registry(`https://registry.npmjs.org/-/package/${encodeURIComponent(info.name)}/dist-tags`);
      assert.equal(version.version, info.version);
      assert.equal(version.dist?.integrity, packed.integrity, 'Published package integrity differs');
      assert.equal(tags[info.channel], info.version, 'npm channel differs');
      const summary = `### npm release\n\n- Package: ${info.name}@${info.version}\n- Channel: ${info.channel}\n- Integrity: ${packed.integrity}\n- Source: ${process.env.GITHUB_SHA}\n- Result: ${publishError ? 'publish command failed, but registry content and channel match exactly' : 'published and verified'}\n`;
      console.log(summary);
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
      return;
    } catch (error) { verificationError = error; }
    if (Date.now() >= verificationDeadline) break;
    console.log('Waiting for npm availability and matching version, integrity, and channel...');
    await new Promise(resolve => setTimeout(resolve, 30000));
  }
  throw new AggregateError([publishError, verificationError].filter(Boolean), 'npm release could not be verified');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv[2]);
}
