import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { releaseInfo } from './npm-release.mjs';
import { findValidation } from './ci-reuse.mjs';

export function releaseInput(env) {
  assert.equal(env.GITHUB_REPOSITORY, 'Cusnd/codex-usage');
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Start the release workflow on main');
  assert.match(env.RELEASE_SOURCE_SHA ?? '', /^[a-f0-9]{40}$/);
  assert.match(env.RELEASE_BRANCH ?? '', /^codex\/[\w./-]+$/);
  assert.ok(!env.RELEASE_BRANCH.includes('..'));
  const version = env.RELEASE_VERSION;
  releaseInfo(`v${version}`, { version }, { version, packages: { '': { version } } });
  return { version, branch: env.RELEASE_BRANCH, source: env.RELEASE_SOURCE_SHA, tag: `v${version}` };
}

// Keeping the sequence injectable allows failure/recovery tests without GitHub writes.
export async function executeRelease(io, input) {
  let stage = 'Validate source';
  const step = async (name, action) => {
    stage = name;
    io.record(name, 'started');
    const result = await action();
    io.record(name, 'completed', result);
    return result;
  };
  try {
    await step(stage, () => io.validate(input));
    const integration = await step('Integrate into develop', () => io.integrate(input));
    const release = await step('Merge release into main', () => io.mergeRelease(input, integration));
    await step('Create version tag', () => io.tag(input, release));
    const publication = await step('Publish and verify npm', () => io.publish(input, release));
    await step('Synchronize develop', () => io.sync(input, release));
    io.record('Release complete', 'completed', publication);
  } catch (error) {
    io.record(stage, 'failed', { error: error.message });
    throw error;
  }
}

export function completedRun(run) {
  if (!run || run.status !== 'completed') return null;
  assert.equal(run.conclusion, 'success', `Workflow ${run.conclusion}: ${run.html_url}`);
  return run;
}

export function githubRuntime(input, overrides = {}) {
  const repository = process.env.GITHUB_REPOSITORY;
  const base = `/repos/${repository}`;
  const run = overrides.run ?? ((command, args, stdin) => execFileSync(command, args, {
    encoding: 'utf8', input: stdin, timeout: 60000, maxBuffer: 10 * 1024 * 1024,
  }).trim());
  const git = (...args) => run('git', args);
  const api = overrides.api ?? (async (endpoint, method, body) => JSON.parse(run('gh', ['api', endpoint,
    ...(method ? ['--method', method, '--input', '-'] : [])], method ? JSON.stringify(body ?? {}) : undefined) || 'null'));
  const progress = { ...input, run: process.env.GITHUB_RUN_ID, stages: [] };
  const record = overrides.record ?? ((stage, status, details) => {
    progress.stages.push({ stage, status, details, at: new Date().toISOString() });
    mkdirSync('release-artifacts', { recursive: true });
    writeFileSync('release-artifacts/cloud-release.json', JSON.stringify(progress, null, 2));
    const message = `**${stage}: ${status}**${details ? `\n\n${JSON.stringify(details)}` : ''}\n\n`;
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, message);
  });
  const until = overrides.until ?? (async (minutes, label, check) => {
    const deadline = Date.now() + minutes * 60000;
    do {
      const value = await check();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 30000));
    } while (Date.now() < deadline);
    throw new Error(`Timed out: ${label}`);
  });
  const fetchBranches = () => git('fetch', 'origin', 'main', 'develop');
  const sha = ref => git('rev-parse', ref);
  const tree = ref => sha(`${ref}^{tree}`);
  const checkVersion = ref => {
    const read = file => JSON.parse(git('show', `${ref}:${file}`));
    const info = releaseInfo(input.tag, read('package.json'), read('package-lock.json'));
    assert.equal(info.name, '@esoren/codex-usage');
  };
  const branchHead = async branch => (await api(`${base}/git/ref/heads/${branch}`)).object.sha;
  const runs = async workflow => (await api(`${base}/actions/workflows/${workflow}/runs?per_page=100`)).workflow_runs;
  const dispatch = async (workflow, ref, inputs = {}) => api(`${base}/actions/workflows/${workflow}/dispatches`, 'POST', { ref, inputs });
  const evidence = targetTree => findValidation({ api, repository, tree: targetTree, currentRun: process.env.GITHUB_RUN_ID });
  const ensureCI = async commit => {
    const targetTree = tree(commit);
    const existing = await evidence(targetTree);
    if (existing) return record('CI', 'reused', { commit, tree: targetTree, url: existing });
    const title = `Release checks ${commit}`;
    let job = (await runs('windows.yml')).find(r => r.event === 'workflow_dispatch' && r.display_title === title && r.status !== 'completed');
    if (!job) {
      const ids = new Set((await runs('windows.yml')).map(r => r.id));
      await dispatch('windows.yml', 'main', { revision: commit });
      job = await until(5, 'CI startup', async () => (await runs('windows.yml')).find(r => !ids.has(r.id) && r.display_title === title && r.event === 'workflow_dispatch'));
    }
    record('CI', 'running', { commit, url: job.html_url });
    await until(50, 'platform checks', async () => completedRun(await api(`${base}/actions/runs/${job.id}`)));
    assert.ok(await evidence(targetTree), 'CI did not validate the expected release tree');
  };
  const pulls = async (branch, target) => api(`${base}/pulls?state=all&head=Cusnd:${encodeURIComponent(branch)}&base=${target}&per_page=100`);
  const detail = number => api(`${base}/pulls/${number}`);
  const merge = async (pull, method) => {
    pull = await detail(pull.number);
    if (pull.merged) return { sha: pull.merge_commit_sha, url: pull.html_url };
    assert.equal(pull.state, 'open', `PR is closed: ${pull.html_url}`);
    pull = await until(5, 'PR mergeability', async () => {
      const current = await detail(pull.number);
      return current.mergeable === null ? null : current;
    });
    assert.equal(pull.mergeable, true, `PR has conflicts: ${pull.html_url}`);
    const head = pull.head.sha, target = pull.base.ref, baseSha = pull.base.sha;
    git('fetch', 'origin', `refs/pull/${pull.number}/merge`);
    const candidate = sha('FETCH_HEAD');
    assert.equal(sha(`${candidate}^1`), baseSha, 'PR base changed');
    assert.equal(sha(`${candidate}^2`), head, 'PR head changed');
    checkVersion(candidate);
    await ensureCI(candidate);
    assert.equal(await branchHead(target), baseSha, `${target} changed during CI; rerun to validate its new merge`);
    const result = await api(`${base}/pulls/${pull.number}/merge`, 'PUT', {
      sha: head, merge_method: method, ...(method === 'squash' ? { commit_title: `release: prepare ${input.version}` } : {}),
    });
    assert.equal(result.merged, true, `PR merge failed: ${pull.html_url}: ${result.message}`);
    fetchBranches();
    assert.equal(tree(result.sha), tree(candidate), 'Merged content differs from validated content');
    return { sha: result.sha, url: pull.html_url };
  };
  const marker = `<!-- cloud-release:${input.version}:${input.source} -->`;
  return {
    record,
    async validate() {
      git('check-ref-format', '--branch', input.branch);
      git('fetch', 'origin', input.source);
      checkVersion(input.source);
      record('Source', 'verified', { sha: input.source, version: input.version, branch: input.branch });
    },
    async integrate() {
      const list = await pulls(input.branch, 'develop');
      const match = list.find(p => p.head.sha === input.source);
      assert.ok(match, 'Create the task PR to develop for the supplied source SHA before starting');
      const pull = await detail(match.number);
      if (!pull.merged) assert.equal(await branchHead(input.branch), input.source, 'Task branch moved beyond the authorized source');
      const result = await merge(pull, 'squash');
      fetchBranches();
      git('merge-base', '--is-ancestor', result.sha, 'origin/develop');
      return result;
    },
    async mergeRelease(_, integration) {
      let pull = (await pulls('develop', 'main')).find(p => p.body?.includes(marker));
      if (!pull) {
        const open = (await pulls('develop', 'main')).find(p => p.state === 'open');
        assert.ok(!open, `Another develop → main PR is open: ${open?.html_url}`);
        assert.equal(await branchHead('develop'), integration.sha, 'develop advanced beyond this release');
        pull = await api(`${base}/pulls`, 'POST', {
          head: 'develop', base: 'main', title: `Release ${input.version}`,
          body: `${marker}\n\nRelease ${input.version} from ${input.source}.\n\nIntegration: ${integration.url}\n\nThe cloud workflow validates the exact merge tree before merging and verifies the published npm archive.`,
        });
      }
      pull = await detail(pull.number);
      if (!pull.merged) assert.equal(pull.head.sha, integration.sha, 'Release PR includes newer develop content');
      return merge(pull, 'merge');
    },
    async tag(_, release) {
      fetchBranches();
      git('merge-base', '--is-ancestor', release.sha, 'origin/main');
      checkVersion(release.sha);
      const existing = git('ls-remote', 'origin', `refs/tags/${input.tag}`);
      if (existing) {
        git('fetch', 'origin', `refs/tags/${input.tag}`);
        assert.equal(sha('FETCH_HEAD^{commit}'), release.sha, 'Version tag points to a different commit');
      } else {
        assert.equal(sha('origin/main'), release.sha, 'main advanced before tagging');
        await ensureCI(release.sha);
        git('config', 'user.name', 'github-actions[bot]');
        git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
        git('tag', '-a', input.tag, release.sha, '-m', `Release ${input.version}`);
        git('push', 'origin', `refs/tags/${input.tag}`);
      }
      return { tag: input.tag, sha: release.sha };
    },
    async publish(_, release) {
      let job = (await runs('publish.yml')).find(r => r.head_sha === release.sha && r.head_branch === input.tag);
      if (!job) {
        assert.equal(await branchHead('main'), release.sha, 'main advanced before publishing');
        await dispatch('publish.yml', input.tag);
        job = await until(5, 'npm workflow startup', async () => (await runs('publish.yml')).find(r => r.head_sha === release.sha && r.head_branch === input.tag));
      }
      record('npm workflow', 'observed', { url: job.html_url });
      // A failed upload may already exist on npm. Recover that run explicitly, not by blind republishing.
      return until(45, 'npm publication and registry verification', async () => completedRun(await api(`${base}/actions/runs/${job.id}`)));
    },
    async sync(_, release) {
      fetchBranches();
      git('merge-base', '--is-ancestor', release.sha, 'origin/main');
      const develop = sha('origin/develop');
      if (git('merge-base', develop, release.sha) === release.sha) return { sha: develop };
      git('merge-base', '--is-ancestor', develop, release.sha);
      git('push', 'origin', `${release.sha}:refs/heads/develop`);
      assert.equal(await branchHead('develop'), release.sha, 'develop synchronization not confirmed');
      return { sha: release.sha };
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = releaseInput(process.env);
  await executeRelease(githubRuntime(input), input);
}
