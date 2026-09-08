// Export only the verified synthetic preview, never a running personal instance.
import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.CODEX_USAGE_PREVIEW_PORT || 8766);
assert(Number.isInteger(port) && port > 0 && port < 65536 && port !== 8765, 'Use the isolated preview port');
const origin = `http://127.0.0.1:${port}`;
async function read(route) {
  const response = await fetch(`${origin}/api/${route}`, { signal: AbortSignal.timeout(15000) });
  assert(response.ok, `Preview request failed: ${route}`);
  const body = await response.json();
  assert.equal(body.meta.exampleData, true, 'Refusing to export non-example data');
  return body.data;
}
const [summary, trend, breakdown, team] = await Promise.all([
  read('local/summary'), read('local/trend?bucket=day'),
  read('local/breakdown?groupBy=project'), read('local/threads/example-session-01/agents'),
]);
assert.equal(summary.totalTokens, '119210000');
assert.equal(summary.threadCount, 28);
assert.equal(summary.turnCount, 92);
assert.equal(team.team.totalTokens, '48600000');
assert.equal(BigInt(team.self.totalTokens) + BigInt(team.subagents.totalTokens), BigInt(team.team.totalTokens));
const allowedProjects = ['codex-usage', 'demo-api', 'sample-notes', 'playground'];
assert.deepEqual(breakdown.items.map((item) => item.label), allowedProjects);
const projects = [];
for (const project of breakdown.items) {
  const threads = await read(`local/threads?project=${encodeURIComponent(project.key)}&sort=tokens&limit=50`);
  assert(threads.items.every((thread) => /^example-session-\d{2}$/.test(thread.id)));
  projects.push({
    name: project.label, totalTokens: project.totalTokens,
    uncachedInputTokens: project.uncachedInputTokens,
    cachedInputTokens: project.cachedInputTokens, outputTokens: project.outputTokens,
    tasks: threads.items.map((thread, i) => ({
      title: project.label === 'codex-usage' ? thread.title : `${project.label === 'demo-api' ? 'API & documentation' : project.label === 'sample-notes' ? 'Learning notes' : 'Project experiment'} · ${i + 1}`,
      totalTokens: thread.totalTokens, turnCount: thread.turnCount,
    })),
  });
}
const data = {
  synthetic: true, timezone: 'America/New_York',
  summary: { totalTokens: summary.totalTokens, threadCount: summary.threadCount, turnCount: summary.turnCount },
  trend: trend.map((day) => ({ date: day.time, totalTokens: day.totalTokens })), projects,
  team: { self: team.self.totalTokens, subagents: team.subagents.totalTokens, total: team.team.totalTokens,
    agents: team.agents.map((agent) => ({ title: agent.title, depth: agent.depth, totalTokens: agent.usage.totalTokens })) },
};
assert(data.trend.every((day) => /^2026-09-0[2-8]$/.test(day.date)), 'Unexpected example dates');
const output = path.join(root, 'showcase/public');
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'data.json'), JSON.stringify(data, null, 2) + '\n');
for (const name of ['analysis.png', 'agent-team.png']) await copyFile(path.join(root, 'docs/images', name), path.join(output, name));
await copyFile(path.join(root, 'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'), path.join(output, 'inter-latin.woff2'));
await copyFile(path.join(root, 'node_modules/@fontsource-variable/inter/LICENSE'), path.join(output, 'font-license.txt'));
console.log('Showcase exported: synthetic data, two screenshots, and licensed local font.');
