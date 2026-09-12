import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { ProjectSourceResolver, readCodexProjectMap, type CodexProjectMap } from '../server/project-source.js';
import { projectPath } from '../server/util.js';

const empty = (): CodexProjectMap => ({ database: null, schema: null, projects: [], roots: [], threads: [], projectlessThreadIds: [], issues: [] });
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-project-source-'));
  try { await run(root); }
  finally {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert.ok(path.basename(resolved).startsWith('codex-project-source-'));
    await rm(resolved, { recursive: true, force: true });
  }
}

test('Codex adapter probes schema versions and exposes only project fields without altering the source', () => fixture(async root => {
  const dbFile = path.join(root, 'state_72.sqlite'), db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE projects(id TEXT,name TEXT,metadata TEXT); CREATE TABLE project_roots(project_id TEXT,position INTEGER,path TEXT);
    CREATE TABLE threads(id TEXT,project_id TEXT,first_user_message TEXT);
    INSERT INTO projects VALUES('app','Saved','PRIVATE_PROJECT_METADATA');
    INSERT INTO project_roots VALUES('app',0,'/work/demo');
    INSERT INTO threads VALUES('thread','app','PRIVATE_CHAT_MARKER');`); db.close();
  const newer = new DatabaseSync(path.join(root, 'state_73.sqlite')); newer.exec('CREATE TABLE threads(id TEXT,title TEXT)'); newer.close();
  const global = path.join(root, '.codex-global-state.json');
  await writeFile(global, JSON.stringify({ 'projectless-thread-ids': ['independent'], 'electron-persisted-atom-state': { 'electron:onboarding-projectless-completed': true, preview: 'PRIVATE_CHAT_MARKER' }, 'thread-projectless-output-directories': { independent: 'PRIVATE_OUTPUT_DIRECTORY' } }));
  const hash = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
  const before = [await hash(dbFile), await hash(global)], result = await readCodexProjectMap(root);
  assert.equal(result.database, dbFile); assert.equal(result.schema, 'projects-roots-threads-v1');
  assert.deepEqual(result.threads, [{ id: 'thread', projectId: 'app' }]); assert.deepEqual(result.projectlessThreadIds, ['independent']);
  assert.equal(result.issues[0].code, 'unsupported-project-schema'); assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  assert.deepEqual([await hash(dbFile), await hash(global)], before);
}));

test('App thread mapping disambiguates roots and changing a path creates a distinct source project', () => fixture(async root => {
  const one = path.join(root, 'one'), two = path.join(root, 'two'); await mkdir(one); await mkdir(two);
  const map = empty(); map.projects = [{ id: 'app', name: 'Saved' }, { id: 'other', name: 'Other' }];
  map.roots = [{ projectId: 'app', position: 0, path: one }, { projectId: 'other', position: 0, path: one }];
  map.threads = [{ id: 'thread', projectId: 'app' }];
  const resolver = new ProjectSourceResolver({ collectorId: 'A', codexRoot: root, projectMap: map });
  const ambiguous = await resolver.resolve({ cwd: one }); assert.equal(ambiguous.kind, 'unresolved'); assert.ok(ambiguous.provenance.conflicts.includes('ambiguous-app-roots'));
  const a = await resolver.resolve({ cwd: one, threadId: 'thread' }), b = await resolver.resolve({ cwd: two, threadId: 'thread' });
  assert.equal(a.kind, 'app'); assert.equal(a.appProjectId, 'app'); assert.equal(a.provenance.method, 'app-thread'); assert.notEqual(a.sourceProjectId, b.sourceProjectId);
  const restarted = new ProjectSourceResolver({ collectorId: 'A', codexRoot: root, projectMap: map });
  assert.equal((await restarted.resolve({ cwd: one, threadId: 'thread' })).sourceProjectId, a.sourceProjectId);
}));

test('absence of App mapping is unresolved; an explicit projectless list supplies session evidence', () => fixture(async root => {
  const map = empty(); map.projectlessThreadIds = ['independent'];
  map.projects = [{ id: 'app', name: 'Saved' }]; map.roots = [{ projectId: 'app', position: 0, path: root }];
  const resolver = new ProjectSourceResolver({ collectorId: 'A', codexRoot: root, projectMap: map });
  const missing = await resolver.resolve({ threadId: 'unknown' }); assert.equal(missing.kind, 'unresolved'); assert.equal(missing.sourceProjectId, null);
  const independent = await resolver.resolve({ cwd: root, threadId: 'independent' }); assert.equal(independent.kind, 'session'); assert.equal(independent.sessionId, 'independent');
  assert.equal(independent.provenance.method, 'explicit-projectless');
}));

test('real Git reads retain fork ambiguity, remove credentials and cache repository evidence', () => fixture(async root => {
  const repo = path.join(root, 'repo'), nested = path.join(repo, 'nested'); await mkdir(repo); await mkdir(nested);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--initial-branch=main'); git('remote', 'add', 'origin', 'https://user:PRIVATE_REMOTE_PASSWORD@host/mine/fork.git');
  git('remote', 'add', 'upstream', 'git@host:upstream/repo.git'); git('config', 'branch.main.remote', 'upstream');
  const resolver = new ProjectSourceResolver({ collectorId: 'A', codexRoot: root, projectMap: empty() });
  const result = await resolver.resolve({ cwd: nested, threadId: 'one' });
  assert.equal(result.kind, 'git'); assert.equal(result.git!.primary.status, 'ambiguous'); assert.equal(result.git!.primary.identity, null);
  assert.ok(result.provenance.conflicts.includes('tracking-origin-conflict')); assert.ok(!JSON.stringify(result).includes('PRIVATE_REMOTE_PASSWORD'));
  assert.equal(result.root, projectPath(await realpath(repo)));
  git('config', 'branch.main.remote', 'origin');
  const cached = await resolver.resolve({ cwd: repo, threadId: 'two' }); assert.equal(cached.sourceProjectId, result.sourceProjectId); assert.equal(cached.git!.primary.status, 'ambiguous');
  resolver.invalidate(); const current = await resolver.resolve({ cwd: repo, threadId: 'two' }); assert.equal(current.git!.primary.status, 'confirmed');
}));

test('two worktree roots sharing common-dir are different sources with reusable repository evidence', () => fixture(async root => {
  const common = path.join(root, 'common.git'), a = path.join(root, 'a'), b = path.join(root, 'b'); await mkdir(a); await mkdir(b); await mkdir(common);
  await writeFile(path.join(a, '.git'), 'gitdir: ../common.git'); await writeFile(path.join(b, '.git'), 'gitdir: ../common.git');
  const calls: string[][] = [];
  const resolver = new ProjectSourceResolver({ collectorId: 'A', codexRoot: root, projectMap: empty(), runGit: async (cwd, args) => {
    calls.push([...args]);
    if (args[0] === 'rev-parse') return `${cwd}\n${common}\n`;
    if (args[0] === 'symbolic-ref') return 'main\n';
    if (args[1] === '--get') return 'origin\n';
    return 'remote.origin.url\ngit@host:owner/repo.git\0';
  } });
  const first = await resolver.resolve({ cwd: a, threadId: 'first' }), second = await resolver.resolve({ cwd: b, threadId: 'second' });
  assert.notEqual(first.sourceProjectId, second.sourceProjectId); assert.equal(first.git!.commonDirectory, second.git!.commonDirectory);
  assert.equal(first.git!.primary.identity!.key, second.git!.primary.identity!.key);
  assert.ok(calls.every(args => ['rev-parse', 'symbolic-ref', 'config'].includes(args[0])));
  const count = calls.length; await resolver.resolve({ cwd: a, threadId: 'third' }); assert.equal(calls.length, count);
}));

test('unavailable historical paths reuse persisted evidence only from the same collector', () => fixture(async root => {
  const repo = path.join(root, 'repo'); await mkdir(repo); await mkdir(path.join(repo, '.git'));
  const resolver = new ProjectSourceResolver({ collectorId: 'A', codexRoot: root, projectMap: empty(), runGit: async (cwd, args) => {
    if (args[0] === 'rev-parse') return `${cwd}\n${path.join(cwd, '.git')}\n`;
    if (args[0] === 'symbolic-ref') return 'main\n';
    if (args[1] === '--get') return 'origin\n';
    return 'remote.origin.url\nhttps://host/owner/repo.git\0';
  } });
  const original = await resolver.resolve({ cwd: repo });
  const checked = path.resolve(repo); assert.ok(checked.startsWith(path.resolve(root) + path.sep)); await rm(checked, { recursive: true });
  const restored = new ProjectSourceResolver({ collectorId: 'A', codexRoot: root, projectMap: empty(), previous: [original] });
  const result = await restored.resolve({ cwd: repo }); assert.equal(result.sourceProjectId, original.sourceProjectId); assert.equal(result.provenance.method, 'persisted-evidence'); assert.equal(result.provenance.availability, 'unavailable');
  const other = new ProjectSourceResolver({ collectorId: 'B', codexRoot: root, projectMap: empty(), previous: [original] });
  assert.equal((await other.resolve({ cwd: repo })).kind, 'unresolved');
}));

test('foreign paths never launch Git and failures remain visible in provenance', () => fixture(async root => {
  let calls = 0;
  const resolver = new ProjectSourceResolver({ collectorId: 'A', codexRoot: root, projectMap: empty(), runGit: async () => { calls++; throw new Error('PRIVATE_STDERR'); } });
  const foreign = process.platform === 'win32' ? '/Users/Someone/Repo' : 'C:\\Users\\Someone\\Repo';
  const first = await resolver.resolve({ cwd: foreign }); assert.equal(first.provenance.availability, 'foreign'); assert.equal(calls, 0);
  const repo = path.join(root, 'repo'); await mkdir(repo); await mkdir(path.join(repo, '.git'));
  const failure = await resolver.resolve({ cwd: repo }); assert.equal(failure.kind, 'unresolved'); assert.ok(failure.provenance.conflicts.includes('git-read-failed')); assert.ok(!JSON.stringify(failure).includes('PRIVATE_STDERR'));
}));
