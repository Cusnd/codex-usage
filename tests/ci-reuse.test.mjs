import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expectedJobs, validatesTree, findValidation } from '../scripts/ci-reuse.mjs';

const tree = 'a'.repeat(40);
const complete = () => [...expectedJobs, `Validated tree ${tree}`].map(name => ({ name, conclusion: 'success' }));

test('only the matching tree with all 30 successful jobs is reusable', () => {
  assert.equal(expectedJobs.length, 30);
  assert.equal(validatesTree(complete(), tree), true);
  assert.equal(validatesTree(complete(), 'b'.repeat(40)), false);
  assert.equal(validatesTree(complete().slice(1), tree), false);
  for (const conclusion of ['failure', 'cancelled', 'skipped', null]) {
    const jobs = complete();
    jobs[4].conclusion = conclusion;
    assert.equal(validatesTree(jobs, tree), false);
  }
  assert.equal(validatesTree([{ name: `Validated tree ${tree}`, conclusion: 'success' }], tree), false);
  assert.equal(validatesTree([...complete(), complete()[0]], tree), false);
});

test('the CI matrix and reuse evidence have the same 30 required jobs; old 18-job success is insufficient', () => {
  const workflow = readFileSync(new URL('../.github/workflows/windows.yml', import.meta.url), 'utf8');
  const runners = [...workflow.matchAll(/runner: ([\w.-]+), platform:/g)].map(match => match[1]);
  const nodeLine = workflow.match(/node: \[([^\]]+)\]/)?.[1];
  assert.ok(nodeLine);
  const nodes = [...nodeLine.matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(runners.flatMap(runner => nodes.map(node => `${runner} / Node ${node}`)), expectedJobs);
  assert.equal(validatesTree(complete().filter(job => !job.name.startsWith('ubuntu-')), tree), false);
  for (const missing of expectedJobs) assert.equal(validatesTree(complete().filter(job => job.name !== missing), tree), false, missing);
});

test('lookup excludes other repositories, workflows, events and the current run', async () => {
  const repository = 'owner/repo';
  const valid = { id: 9, workflow_id: 10, head_repository: { full_name: repository }, event: 'pull_request', status: 'completed', conclusion: 'success', html_url: 'https://example.test/run/9' };
  const runs = [
    { ...valid, id: 1, head_repository: { full_name: 'fork/repo' } },
    { ...valid, id: 2, workflow_id: 11 },
    { ...valid, id: 3, conclusion: 'failure' },
    { ...valid, id: 4, event: 'push' },
    { ...valid, id: 5 },
    { ...valid, id: 6 },
    valid,
  ];
  const api = async endpoint => {
    if (endpoint.endsWith('windows.yml')) return { id: 10 };
    if (endpoint.includes('/workflows/10/runs?')) return { workflow_runs: runs };
    if (endpoint.includes('/runs/6/jobs?')) return { jobs: [] };
    assert.ok(endpoint.includes('/runs/9/jobs?'), endpoint);
    return { jobs: complete() };
  };
  assert.equal(await findValidation({ api, repository, tree, currentRun: 5 }), valid.html_url);
});

test('missing evidence is not success and API failures are not swallowed', async () => {
  const args = { repository: 'owner/repo', tree };
  assert.equal(await findValidation({ ...args, api: async endpoint => endpoint.endsWith('windows.yml') ? { id: 10 } : { workflow_runs: [] } }), null);
  await assert.rejects(findValidation({ ...args, api: async () => { throw new Error('API unavailable'); } }), /API unavailable/);
});
