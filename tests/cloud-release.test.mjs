import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseInput, executeRelease, completedRun, githubRuntime } from '../scripts/cloud-release.mjs';
import { expectedJobs } from '../scripts/ci-reuse.mjs';

const source = 'a'.repeat(40);
const env = { GITHUB_REPOSITORY: 'Cusnd/codex-usage', GITHUB_REF: 'refs/heads/main', RELEASE_VERSION: '0.1.7', RELEASE_BRANCH: 'codex/release-0.1.7', RELEASE_SOURCE_SHA: source };
const input = releaseInput(env);

test('release requires an explicit version, task branch, full SHA and main entrypoint', () => {
  assert.equal(input.tag, 'v0.1.7');
  for (const patch of [
    { RELEASE_SOURCE_SHA: 'main' }, { RELEASE_BRANCH: 'develop' },
    { RELEASE_BRANCH: 'codex/../main' }, { RELEASE_VERSION: 'v0.1.7' },
    { GITHUB_REF: 'refs/heads/develop' }, { GITHUB_REPOSITORY: 'fork/repo' },
  ]) assert.throws(() => releaseInput({ ...env, ...patch }));
});

test('release waits for verified publication before synchronizing', async () => {
  const calls = [];
  let confirm;
  const published = new Promise(resolve => { confirm = resolve; });
  const io = { record: () => {} };
  for (const name of ['validate', 'integrate', 'mergeRelease', 'tag', 'sync']) {
    io[name] = async actual => { assert.equal(actual, input); calls.push(name); return { sha: source }; };
  }
  io.publish = async () => { calls.push('publish'); await published; return { url: 'verified' }; };
  const task = executeRelease(io, input);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['validate', 'integrate', 'mergeRelease', 'tag', 'publish']);
  confirm();
  await task;
  assert.equal(calls.at(-1), 'sync');
});

test('workflow failures preserve the failed stage and prevent later actions', async () => {
  for (const failing of ['integrate', 'mergeRelease', 'publish']) {
    const calls = [], records = [];
    const io = { record: (...args) => records.push(args) };
    for (const name of ['validate', 'integrate', 'mergeRelease', 'tag', 'publish', 'sync']) {
      io[name] = async () => { calls.push(name); if (name === failing) throw new Error('CI or workflow failed'); };
    }
    await assert.rejects(executeRelease(io, input), /failed/);
    assert.equal(calls.at(-1), failing);
    assert.equal(records.at(-1)[1], 'failed');
  }
});

test('queued runs are pending; failed, cancelled and timed-out runs are not success', () => {
  assert.equal(completedRun({ status: 'queued' }), null);
  for (const conclusion of ['failure', 'cancelled', 'timed_out']) {
    assert.throws(() => completedRun({ status: 'completed', conclusion, html_url: 'run-link' }), /run-link/);
  }
  assert.equal(completedRun({ status: 'completed', conclusion: 'success' }).conclusion, 'success');
});

function runtime(overrides) {
  return githubRuntime(input, { record: () => {}, run: () => { throw new Error('Unexpected command'); },
    until: async (_, label, check) => { const result = await check(); assert.ok(result, label); return result; }, ...overrides });
}

test('resuming a verified npm release does not dispatch or upload again', async () => {
  const job = { id: 5, head_sha: source, head_branch: input.tag, status: 'completed', conclusion: 'success', html_url: 'npm-run' };
  const io = runtime({ api: async (endpoint, method) => {
    assert.equal(method, undefined);
    return endpoint.includes('/workflows/') ? { workflow_runs: [job] } : job;
  } });
  assert.equal((await io.publish(input, { sha: source })).html_url, 'npm-run');
});

test('failed npm run is reported without blindly dispatching another upload', async () => {
  const job = { id: 5, head_sha: source, head_branch: input.tag, status: 'completed', conclusion: 'failure', html_url: 'failed-upload' };
  const io = runtime({ api: async (endpoint, method) => {
    assert.equal(method, undefined);
    return endpoint.includes('/workflows/') ? { workflow_runs: [job] } : job;
  } });
  await assert.rejects(io.publish(input, { sha: source }), /failed-upload/);
});

test('CI failure stops the real PR integration before the merge API', async () => {
  const base = 'b'.repeat(40), candidate = 'c'.repeat(40), tree = 'd'.repeat(40);
  const pull = { number: 1, state: 'open', merged: false, mergeable: true, head: { sha: source }, base: { ref: 'develop', sha: base }, html_url: 'task-pr' };
  const writes = [];
  let dispatched = false;
  const job = { id: 10, event: 'workflow_dispatch', display_title: `Release checks ${candidate}`, status: 'in_progress', html_url: 'ci-run' };
  const io = runtime({
    run: (command, args) => {
      assert.equal(command, 'git');
      if (args[0] === 'fetch') return '';
      if (args[0] === 'show') return JSON.stringify({ name: '@esoren/codex-usage', version: input.version, packages: { '': { version: input.version } } });
      assert.equal(args[0], 'rev-parse');
      return { FETCH_HEAD: candidate, [`${candidate}^1`]: base, [`${candidate}^2`]: source, [`${candidate}^{tree}`]: tree }[args[1]];
    },
    api: async (endpoint, method) => {
      if (method) { writes.push(endpoint); assert.ok(endpoint.endsWith('/dispatches')); dispatched = true; return null; }
      if (endpoint.includes('/pulls?')) return [pull];
      if (endpoint.endsWith('/pulls/1')) return pull;
      if (endpoint.includes('/git/ref/heads/')) return { object: { sha: source } };
      if (endpoint.endsWith('/workflows/windows.yml')) return { id: 2 };
      if (endpoint.includes('/workflows/2/runs?')) return { workflow_runs: [] };
      if (endpoint.includes('/workflows/windows.yml/runs?')) return { workflow_runs: dispatched ? [job] : [] };
      if (endpoint.endsWith('/runs/10')) return { ...job, status: 'completed', conclusion: 'failure' };
      throw new Error(endpoint);
    },
  });
  await assert.rejects(io.integrate(input), /ci-run/);
  assert.equal(writes.length, 1);
  assert.ok(writes[0].endsWith('/dispatches'));
});

test('tag recovery rejects another commit and never overwrites the tag', async () => {
  const commands = [];
  const io = runtime({ run: (_, args) => {
    commands.push(args);
    if (args[0] === 'show') return JSON.stringify({ name: '@esoren/codex-usage', version: input.version, packages: { '': { version: input.version } } });
    if (args[0] === 'ls-remote') return 'existing-tag';
    if (args[0] === 'rev-parse') return 'b'.repeat(40);
    return '';
  } });
  await assert.rejects(io.tag(input, { sha: source }), /different commit/);
  assert.ok(!commands.some(args => ['tag', 'push'].includes(args[0])));
});

test('successful exact-tree CI allows squash merge and verifies the resulting tree', async () => {
  const base = 'b'.repeat(40), candidate = 'c'.repeat(40), tree = 'd'.repeat(40), merged = 'e'.repeat(40);
  const pull = { number: 1, state: 'open', merged: false, mergeable: true, head: { sha: source }, base: { ref: 'develop', sha: base }, html_url: 'task-pr' };
  const writes = [];
  const io = runtime({
    run: (_, args) => {
      if (['fetch', 'merge-base'].includes(args[0])) return '';
      if (args[0] === 'show') return JSON.stringify({ name: '@esoren/codex-usage', version: input.version, packages: { '': { version: input.version } } });
      assert.equal(args[0], 'rev-parse');
      const values = { FETCH_HEAD: candidate, [`${candidate}^1`]: base, [`${candidate}^2`]: source, [`${candidate}^{tree}`]: tree, [`${merged}^{tree}`]: tree };
      assert.ok(args[1] in values, args[1]);
      return values[args[1]];
    },
    api: async (endpoint, method, body) => {
      if (method) {
        assert.ok(endpoint.endsWith('/pulls/1/merge'));
        assert.equal(body.sha, source);
        assert.equal(body.merge_method, 'squash');
        writes.push(endpoint);
        return { merged: true, sha: merged };
      }
      if (endpoint.includes('/pulls?')) return [pull];
      if (endpoint.endsWith('/pulls/1')) return pull;
      if (endpoint.includes('/git/ref/heads/')) return { object: { sha: endpoint.endsWith('/develop') ? base : source } };
      if (endpoint.endsWith('/workflows/windows.yml')) return { id: 2 };
      if (endpoint.includes('/workflows/2/runs?')) return { workflow_runs: [{ id: 10, workflow_id: 2, head_repository: { full_name: process.env.GITHUB_REPOSITORY }, event: 'pull_request', status: 'completed', conclusion: 'success', html_url: 'passed-ci' }] };
      if (endpoint.includes('/runs/10/jobs?')) return { jobs: [...expectedJobs, `Validated tree ${tree}`].map(name => ({ name, conclusion: 'success' })) };
      throw new Error(endpoint);
    },
  });
  assert.deepEqual(await io.integrate(input), { sha: merged, url: 'task-pr' });
  assert.equal(writes.length, 1);
});

test('recovery reuses a merged integration PR even after its branch was deleted', async () => {
  const pull = { number: 1, merged: true, head: { sha: source }, merge_commit_sha: 'b'.repeat(40), html_url: 'merged-pr' };
  const io = runtime({
    run: (_, args) => { assert.ok(['fetch', 'merge-base'].includes(args[0])); return ''; },
    api: async (endpoint, method) => {
      assert.equal(method, undefined);
      if (endpoint.includes('/pulls?')) return [pull];
      assert.ok(endpoint.endsWith('/pulls/1'));
      return pull;
    },
  });
  assert.equal((await io.integrate(input)).sha, pull.merge_commit_sha);
});

test('recovery leaves develop alone when it already contains the released main commit', async () => {
  let pushed = false;
  const io = runtime({ run: (_, args) => {
    if (args[0] === 'push') pushed = true;
    if (args[0] === 'rev-parse') return 'b'.repeat(40);
    if (args[0] === 'merge-base') return source;
    return '';
  } });
  await io.sync(input, { sha: source });
  assert.equal(pushed, false);
});
