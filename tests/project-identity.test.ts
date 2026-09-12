import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRemote, selectPrimaryRemote, sourceProjectId, normalizeProjectAliases, resolveProjectAlias, organizeProjects, type ProjectEdge } from '../shared/usage-domain/projects.js';

test('source project identity keeps collector, original project and normalized root separate', () => {
  const base = sourceProjectId('A', 'app', '/work/repo', 'saved');
  assert.equal(base, sourceProjectId('A', 'app', '/work/repo', 'saved'));
  for (const changed of [sourceProjectId('B', 'app', '/work/repo', 'saved'), sourceProjectId('A', 'app', '/work/moved', 'saved'), sourceProjectId('A', 'app', '/work/repo', 'other')]) assert.notEqual(base, changed);
  assert.notEqual(sourceProjectId('a:b', 'session', null, 'c'), sourceProjectId('a', 'session', null, 'b:c'));
});

test('network repository normalization removes credentials and conventional transport differences', () => {
  const values = ['https://secret:PRIVATE_PASSWORD@GitHub.COM:443/Owner/Repo.git', 'ssh://git@github.com:22/Owner/Repo.git', 'git@github.com:Owner/Repo.git'];
  const normalized = values.map(v => normalizeRemote(v)!);
  assert.equal(new Set(normalized.map(v => v.key)).size, 1);
  assert.equal(normalized[0].repositoryPath, 'Owner/Repo');
  assert.ok(!JSON.stringify(normalized).includes('PRIVATE_PASSWORD'));
  assert.ok(!JSON.stringify(normalized).includes('secret'));
  assert.equal(normalizeRemote('ssh://git@[2001:db8::1]:2222/owner/repo.git')!.port, 2222);
});

test('normalization does not fold repository case, custom ports, encoded paths or unrelated repo names', () => {
  const values = ['https://host/Owner/Repo.git', 'https://host/owner/Repo.git', 'https://host/Owner/Other.git', 'https://host:8443/Owner/Repo.git', 'https://host/Owner%2FRepo.git', 'https://host/Owner//Repo.git'];
  assert.equal(new Set(values.map(value => normalizeRemote(value)!.key)).size, values.length);
  for (const value of ['file:///work/repo', '/work/repo', 'C:\\work\\repo', '../repo', 'https://host/a/../repo', 'https://host/a/%2E%2e/repo', 'https://host/repo?token=secret', 'host#other:repo', 'git@host:~/repo']) assert.equal(normalizeRemote(value), null, value);
});

test('fork tracking upstream conflicts with origin and cannot become a cross-repository edge', () => {
  const remotes = [{ name: 'origin', urls: ['git@host:my/fork.git'] }, { name: 'upstream', urls: ['https://host/upstream/repo.git'] }];
  const result = selectPrimaryRemote({ remotes, trackingRemote: 'upstream' });
  assert.equal(result.status, 'ambiguous'); assert.equal(result.identity, null); assert.equal(result.reason, 'tracking-origin-conflict');
  assert.equal(selectPrimaryRemote({ remotes, trackingRemote: 'origin' }).identity!.repositoryPath, 'my/fork');
  assert.equal(selectPrimaryRemote({ remotes, trackingRemote: 'upstream', primaryRemote: 'origin' }).reason, 'explicit-primary-remote');
  assert.deepEqual(result, selectPrimaryRemote({ remotes: remotes.toReversed(), trackingRemote: 'upstream' }));
});

test('a single primary identity is required and agreeing tracking transports are safe', () => {
  assert.equal(selectPrimaryRemote({ remotes: [{ name: 'origin', urls: ['https://host/a.git', 'https://host/b.git'] }] }).status, 'ambiguous');
  assert.equal(selectPrimaryRemote({ remotes: [{ name: 'fork', urls: ['https://host/a.git'] }, { name: 'upstream', urls: ['https://host/a.git'] }] }).status, 'ambiguous');
  const result = selectPrimaryRemote({ remotes: [{ name: 'origin', urls: ['https://host/a.git'] }, { name: 'working', urls: ['git@host:a.git'] }], trackingRemote: 'working' });
  assert.equal(result.status, 'confirmed'); assert.equal(result.reason, 'tracking-origin-agree');
  assert.equal(selectPrimaryRemote({ remotes: [] }).status, 'unresolved');
});

test('aliases flatten transitively, reject cycles, and permit revived split IDs', () => {
  const normalized = normalizeProjectAliases({ old: 'middle', middle: 'current', current: 'current' });
  assert.equal(normalized.old, 'current'); assert.equal(resolveProjectAlias('old', normalized), 'current');
  assert.throws(() => normalizeProjectAliases({ a: 'b', b: 'a' }), /cycle/);
  assert.equal(resolveProjectAlias('a', normalizeProjectAliases({ a: 'b' }, ['a', 'b'])), 'a');
  const special = Object.assign(Object.create(null), { ['__proto__']: 'actual' });
  assert.equal(resolveProjectAlias('__proto__', normalizeProjectAliases(special)), 'actual');
});

const sources = ['A', 'B', 'C', 'D', 'E'].map(id => ({ id, name: 'Name ' + id }));
const edge = (a: string, b: string): ProjectEdge => ({ a, b, reason: 'session' });
const partitions = [{ id: 'manual-A', members: ['A'], name: 'Pinned A' }, { id: 'manual-B', members: ['B'] }];

test('each single anchor can accept C while a bridge to incompatible anchors remains independent', () => {
  const a = organizeProjects({ sources, partitions, edges: [edge('A', 'C')] });
  const b = organizeProjects({ sources, partitions, edges: [edge('B', 'C')] });
  assert.equal(a.membership.C, a.membership.A); assert.equal(b.membership.C, b.membership.B);
  const both = organizeProjects({ sources, partitions, edges: [edge('A', 'C'), edge('B', 'C')] });
  assert.notEqual(both.membership.C, both.membership.A); assert.notEqual(both.membership.C, both.membership.B);
  assert.notEqual(both.membership.A, both.membership.B); assert.equal(both.blockedEdges.length, 2);
  assert.deepEqual(both.projects.find(p => p.members.includes('C'))!.anchorIds, ['manual-A', 'manual-B']);
});

test('late bridge evidence unassigns C, traverses all unanchored nodes, and is independent of upload order', () => {
  const edges = [edge('A', 'C'), edge('C', 'D'), edge('D', 'B')];
  const before = organizeProjects({ sources, partitions, edges: edges.slice(0, 2) });
  assert.equal(before.membership.D, before.membership.A);
  const after = organizeProjects({ sources, partitions, edges, previous: before });
  const reverseBefore = organizeProjects({ sources, partitions, edges: edges.slice(1) });
  const reverse = organizeProjects({ sources: sources.toReversed(), partitions: partitions.toReversed(), edges: edges.toReversed(), previous: reverseBefore });
  assert.deepEqual(after, reverse);
  assert.equal(after.membership.C, after.membership.D); assert.notEqual(after.membership.C, after.membership.A);
  const undone = organizeProjects({ sources, partitions, edges: edges.slice(0, 2), previous: after });
  assert.equal(undone.membership.D, undone.membership.A); assert.notEqual(undone.membership.A, undone.membership.B);
});

test('explicit manual merge overrides a prior split only when its current persisted rule changes', () => {
  const prior = organizeProjects({ sources, partitions, edges: [edge('A', 'C'), edge('B', 'C')] });
  const merged = organizeProjects({ sources, partitions: [{ id: 'manual-A', members: ['A', 'B'], name: 'Together' }], edges: [edge('A', 'C'), edge('B', 'C')], previous: prior });
  assert.equal(merged.membership.A, merged.membership.B); assert.equal(merged.membership.C, merged.membership.A);
  assert.equal(merged.aliases['manual-B'], 'manual-A'); assert.equal(merged.projects.find(p => p.id === 'manual-A')!.name, 'Together');
  const split = organizeProjects({ sources, partitions, edges: [edge('A', 'C'), edge('B', 'C')], previous: merged });
  assert.notEqual(split.membership.A, split.membership.B); assert.equal(split.membership.B, 'manual-B');
  assert.equal(resolveProjectAlias('manual-B', split.aliases), 'manual-B');
});

test('automatic merges keep a stable prior ID and aliases; removal splits without duplicate IDs', () => {
  const standalone = organizeProjects({ sources, edges: [] });
  const merged = organizeProjects({ sources, edges: [edge('A', 'B'), edge('B', 'C')], previous: standalone });
  assert.equal(merged.membership.A, standalone.membership.A);
  assert.equal(resolveProjectAlias(standalone.membership.C, merged.aliases), merged.membership.A);
  const split = organizeProjects({ sources, edges: [edge('B', 'C')], previous: merged });
  assert.equal(split.membership.A, standalone.membership.A); assert.notEqual(split.membership.B, split.membership.A);
  assert.equal(split.membership.C, split.membership.B); assert.equal(new Set(split.projects.map(p => p.id)).size, split.projects.length);
  assert.equal(resolveProjectAlias(split.membership.B, split.aliases), split.membership.B);
});

test('source arrival order gives the same automatic canonical and retains earlier references', () => {
  const first = organizeProjects({ sources: [{ id: 'B' }], edges: [] });
  const after = organizeProjects({ sources: [{ id: 'A' }, { id: 'B' }], edges: [edge('A', 'B')], previous: first });
  const together = organizeProjects({ sources: [{ id: 'A' }, { id: 'B' }], edges: [edge('A', 'B')] });
  assert.deepEqual(after, together);
  assert.equal(resolveProjectAlias(first.membership.B, after.aliases), after.membership.B);
  const renamed = organizeProjects({ sources: [{ id: 'A' }, { id: 'B' }], edges: [edge('A', 'B')], previous: first, names: { [first.membership.B]: 'My saved name' } });
  assert.equal(renamed.projects[0].name, 'My saved name');
  const direct = organizeProjects({ sources, partitions, edges: [edge('A', 'B'), edge('A', 'C')] });
  assert.notEqual(direct.membership.A, direct.membership.B); assert.equal(direct.membership.A, direct.membership.C);
});

test('human names precede deterministic source names and manual membership is validated', () => {
  const group = organizeProjects({ sources: sources.toReversed(), partitions, names: { 'manual-A': 'User title' }, edges: [edge('A', 'C')] });
  assert.equal(group.projects.find(p => p.id === 'manual-A')!.name, 'User title');
  const auto = organizeProjects({ sources: sources.toReversed(), edges: [edge('A', 'C')] });
  assert.equal(auto.projects.find(p => p.members.includes('C'))!.name, 'Name A');
  assert.throws(() => organizeProjects({ sources, edges: [], partitions: [{ id: 'one', members: ['A'] }, { id: 'two', members: ['A'] }] }), /incompatible/);
});
