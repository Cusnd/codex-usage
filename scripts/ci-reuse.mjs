import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runners = ['windows-latest', 'macos-15', 'macos-15-intel'];
const nodes = ['22.13.0', '22.x', '24.0.0', '24.x', '26.0.0', '26.x'];
export const expectedJobs = runners.flatMap(runner => nodes.map(node => `${runner} / Node ${node}`));

// Require an actual matrix run, never another run that merely reused evidence.
export function validatesTree(jobs, tree) {
  const names = [...expectedJobs, `Validated tree ${tree}`];
  return names.every(name => {
    const matches = jobs.filter(job => job.name === name);
    return matches.length === 1 && matches[0].conclusion === 'success';
  });
}

export async function findValidation({ api, repository, tree, currentRun }) {
  assert.match(tree, /^[a-f0-9]{40}$/);
  const workflow = await api(`/repos/${repository}/actions/workflows/windows.yml`);
  // Bounded lookup. A manual run can refresh evidence if it falls outside this window.
  const { workflow_runs: runs } = await api(`/repos/${repository}/actions/workflows/${workflow.id}/runs?status=success&per_page=50`);
  for (const run of runs) {
    if (String(run.id) === String(currentRun) || run.workflow_id !== workflow.id
      || run.status !== 'completed' || run.conclusion !== 'success'
      || run.head_repository?.full_name !== repository
      || !['pull_request', 'workflow_dispatch'].includes(run.event)) continue;
    const { jobs } = await api(`/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
    if (validatesTree(jobs, tree)) return run.html_url;
  }
  return null;
}

async function main(mode) {
  assert.ok(['lookup', 'require'].includes(mode));
  const repository = process.env.GITHUB_REPOSITORY;
  assert.match(repository ?? '', /^[\w.-]+\/[\w.-]+$/);
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  const api = async endpoint => JSON.parse(execFileSync('gh', ['api', endpoint], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 5 * 1024 * 1024,
  }));
  // Manual dispatch deliberately runs the matrix, including when refreshing old evidence.
  const url = mode === 'lookup' && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    ? null : await findValidation({ api, repository, tree, currentRun: process.env.GITHUB_RUN_ID });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tree=${tree}\nreuse=${Boolean(url)}\n`);
  const message = url ? `Reusing 18-job validation for tree ${tree}: ${url}` : `No matching 18-job validation for tree ${tree}.`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  if (mode === 'require' && !url) {
    throw new Error('Release blocked: run Windows and macOS checks on this exact commit, then rerun the release. No package was uploaded.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv[2]);
