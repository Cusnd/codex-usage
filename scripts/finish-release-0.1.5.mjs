// One-shot continuation of the user's explicitly authorized 0.1.5 release.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { findValidation } from './ci-reuse.mjs';

const repository = process.env.GITHUB_REPOSITORY;
assert.equal(repository, 'Cusnd/codex-usage');
const branch = 'codex/release-0.1.5', tag = 'v0.1.5';
assert.equal(process.env.GITHUB_REF_NAME, branch);
assert.equal(JSON.parse(readFileSync('package.json')).version, '0.1.5');
const run = (name, args, input) => execFileSync(name, args, { encoding: 'utf8', input, timeout: 60000, maxBuffer: 8 * 1024 * 1024 }).trim();
const git = (...args) => run('git', args);
const api = async (endpoint, method, body) => JSON.parse(run('gh', ['api', endpoint, ...(method ? ['--method', method, '--input', '-'] : [])], body ? JSON.stringify(body) : undefined) || 'null');
const base = `/repos/${repository}`;
const head = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
const initial = 'f2bc748';
const summary = text => { console.log(text); appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n\n'); };
const pause = () => new Promise(resolve => setTimeout(resolve, 30000));
const until = async (minutes, check, label) => {
  const deadline = Date.now() + minutes * 60000;
  do { const value = await check(); if (value) return value; await pause(); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
};
const pull = await until(5, async () => (await api(`${base}/pulls?state=open&head=Cusnd:${encodeURIComponent(branch)}&base=develop`))[0], 'integration PR');
assert.equal(pull.head.sha, head);
const evidence = await until(45, async () => {
  const runs = await api(`${base}/actions/workflows/windows.yml/runs?head_sha=${head}&per_page=10`);
  if (runs.workflow_runs.some(r => r.status === 'completed' && ['failure', 'cancelled', 'timed_out'].includes(r.conclusion)))
    throw new Error('Compatibility checks failed. No merge or publication performed.');
  return findValidation({ api, repository, tree, currentRun: process.env.GITHUB_RUN_ID });
}, '18-job exact-tree validation');
summary(`Validated source ${head}, tree ${tree}: ${evidence}`);
const develop = await api(`${base}/git/ref/heads/develop`);
assert.ok(develop.object.sha.startsWith(initial), 'develop changed; requires a new integration review');
await api(`${base}/pulls/${pull.number}/merge`, 'PUT', { sha: head, merge_method: 'squash', commit_title: 'release: prepare 0.1.5' }).then(r => assert.equal(r.merged, true));
git('fetch', 'origin', 'develop', 'main');
assert.equal(git('rev-parse', 'origin/develop^{tree}'), tree, 'integration changed the validated tree');
assert.ok(git('rev-parse', 'origin/main').startsWith(initial), 'main changed; stop before release merge');
const release = await api(`${base}/pulls`, 'POST', {
  head: 'develop', base: 'main', title: 'Release 0.1.5: interaction motion and smaller installs',
  body: `Adds interruptible UI motion, fixes range-switch flicker and tooltip entry, and removes bundled browser libraries from runtime installation.\n\nAll 18 platform/runtime checks passed for the exact release tree: ${evidence}.`,
});
const developHead = git('rev-parse', 'origin/develop');
await api(`${base}/pulls/${release.number}/merge`, 'PUT', { sha: developHead, merge_method: 'merge' }).then(r => assert.equal(r.merged, true));
git('fetch', 'origin', 'main');
assert.equal(git('rev-parse', 'origin/main^{tree}'), tree);
git('config', 'user.name', 'github-actions[bot]');
git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
git('tag', '-a', tag, 'origin/main', '-m', 'Release 0.1.5');
git('push', 'origin', tag);
// GITHUB_TOKEN tag pushes do not recursively start workflows. Dispatch explicitly on the tag;
// publish.yml still enforces tag/version, main ancestry, exact-tree checks, package smoke and OIDC.
run('gh', ['workflow', 'run', 'publish.yml', '--ref', tag]);
summary(`Merged ${pull.html_url} and ${release.html_url}; dispatched ${tag} publication.`);
const publication = await until(40, async () => {
  const { workflow_runs } = await api(`${base}/actions/workflows/publish.yml/runs?event=workflow_dispatch&per_page=20`);
  const latest = workflow_runs.find(r => r.head_branch === tag);
  if (!latest || latest.status !== 'completed') return null;
  assert.equal(latest.conclusion, 'success', `Publication failed: ${latest.html_url}`);
  return latest;
}, 'npm publication and registry integrity verification');
git('fetch', 'origin', 'develop', 'main');
assert.equal(git('rev-parse', 'origin/develop'), developHead, 'develop advanced; leaving synchronization for review');
git('merge-base', '--is-ancestor', 'origin/develop', 'origin/main');
git('push', 'origin', 'refs/remotes/origin/main:refs/heads/develop');
summary(`Published and registry-verified @esoren/codex-usage@0.1.5; main synchronized to develop. ${publication.html_url}`);
