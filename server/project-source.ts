import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { projectPath } from './util.js';
import { selectPrimaryRemote, sourceProjectId, type GitRemote, type PrimaryRemoteSelection, type SourceProjectKind } from '../shared/usage-domain/projects.js';

const exec = promisify(execFile);
export type CodexProjectMap = {
  database: string | null;
  schema: 'projects-roots-threads-v1' | null;
  projects: { id: string; name: string }[];
  roots: { projectId: string; position: number; path: string }[];
  threads: { id: string; projectId: string }[];
  projectlessThreadIds: string[];
  issues: { code: string; source: string }[];
};
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();

/** All statements against Codex-owned databases are read-only and explicitly name allowed fields. */
function readProjectDatabase(filename: string): Omit<CodexProjectMap, 'projectlessThreadIds' | 'issues'> | null {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=500; BEGIN');
    const schemas = [
      ['projects', ['id', 'name']], ['project_roots', ['project_id', 'position', 'path']], ['threads', ['id', 'project_id']],
    ] as const;
    for (const [table, wanted] of schemas) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
      if (!wanted.every(column => columns.includes(column))) return null;
    }
    const projects = db.prepare('SELECT id,name FROM projects ORDER BY id').all()
      .filter(row => nonempty(row.id) && typeof row.name === 'string').map(row => ({ id: String(row.id), name: String(row.name) }));
    const projectIds = new Set(projects.map(row => row.id));
    const roots = db.prepare('SELECT project_id,position,path FROM project_roots ORDER BY project_id,position,path').all()
      .filter(row => nonempty(row.project_id) && projectIds.has(row.project_id) && nonempty(row.path) && Number.isSafeInteger(row.position))
      .map(row => ({ projectId: String(row.project_id), position: Number(row.position), path: String(row.path) }));
    const threads = db.prepare('SELECT id,project_id FROM threads WHERE project_id IS NOT NULL ORDER BY id').all()
      .filter(row => nonempty(row.id) && nonempty(row.project_id) && projectIds.has(row.project_id))
      .map(row => ({ id: String(row.id), projectId: String(row.project_id) }));
    db.exec('COMMIT');
    return { database: filename, schema: 'projects-roots-threads-v1', projects, roots, threads };
  } finally { db.close(); }
}

export async function readCodexProjectMap(codexRoot: string): Promise<CodexProjectMap> {
  const result: CodexProjectMap = { database: null, schema: null, projects: [], roots: [], threads: [], projectlessThreadIds: [], issues: [] };
  let files: string[];
  try { files = (await readdir(codexRoot)).filter(name => /^state(?:_\d+)?\.sqlite$/.test(name)); }
  catch (error: any) { result.issues.push({ code: error.code === 'ENOENT' ? 'codex-root-unavailable' : 'codex-root-read-failed', source: codexRoot }); return result; }
  files.sort((a, b) => Number(/_(\d+)/.exec(b)?.[1] ?? 0) - Number(/_(\d+)/.exec(a)?.[1] ?? 0) || a.localeCompare(b));
  for (const file of files) {
    try {
      const data = readProjectDatabase(path.join(codexRoot, file));
      if (data) { Object.assign(result, data); break; }
      result.issues.push({ code: 'unsupported-project-schema', source: file });
    } catch { result.issues.push({ code: 'project-database-read-failed', source: file }); }
  }
  const globalPath = path.join(codexRoot, '.codex-global-state.json');
  try {
    const size = (await stat(globalPath)).size;
    if (size > 32 * 1024 * 1024) throw new Error('Global state exceeds read budget');
    const state = JSON.parse(await readFile(globalPath, 'utf8'));
    // This exact known list denotes independent conversations; onboarding flags do not.
    if (Array.isArray(state?.['projectless-thread-ids'])) result.projectlessThreadIds = [...new Set<string>(state['projectless-thread-ids'].filter(nonempty))].sort();
  } catch (error: any) { if (error.code !== 'ENOENT') result.issues.push({ code: 'projectless-state-read-failed', source: '.codex-global-state.json' }); }
  return result;
}

export type ProjectSourceProvenance = {
  method: 'git-filesystem' | 'app-thread' | 'app-root' | 'explicit-projectless' | 'persisted-evidence' | 'unresolved';
  availability: 'available' | 'unavailable' | 'foreign' | 'unknown';
  conflicts: string[];
  reason: string;
};
export type ResolvedProjectSource = {
  sourceProjectId: string | null;
  collectorId: string;
  kind: SourceProjectKind | 'unresolved';
  root: string | null;
  observedCwd: string | null;
  name: string | null;
  appProjectId: string | null;
  sessionId: string | null;
  git: { commonDirectory: string; primary: PrimaryRemoteSelection } | null;
  provenance: ProjectSourceProvenance;
};
export type GitProjectRead = (cwd: string, args: readonly string[]) => Promise<string>;
export type ProjectSourceOptions = {
  collectorId: string;
  codexRoot: string;
  projectMap?: CodexProjectMap;
  /** Persist these returned facts in the application's store; never in a Codex-owned database. */
  previous?: readonly ResolvedProjectSource[];
  runGit?: GitProjectRead;
  gitTimeoutMs?: number;
};

function within(root: string, value: string): boolean {
  const separator = root.includes('\\') ? '\\' : '/';
  return value === root || value.startsWith(root.endsWith(separator) ? root : root + separator);
}
function nativeAbsolute(value: string): boolean {
  return process.platform === 'win32' ? /^(?:[a-z]:[\\/]|\\\\)/i.test(value) : value.startsWith('/') && !/^\/\/[^/]+\/[^/]+/.test(value);
}
function directoryName(value: string): string { return value.includes('\\') ? path.win32.basename(value) : path.posix.basename(value); }

export class ProjectSourceResolver {
  private map: CodexProjectMap | null;
  private readonly resolved = new Map<string, ResolvedProjectSource>();
  private readonly previous = new Map<string, ResolvedProjectSource>();
  private readonly boundaries = new Map<string, string | null>();
  private readonly repositories = new Map<string, { root: string; evidence: NonNullable<ResolvedProjectSource['git']> }>();
  private readonly runGit: GitProjectRead;
  constructor(private readonly options: ProjectSourceOptions) {
    if (!options.collectorId) throw new Error('Project resolution needs a collector identity');
    this.map = options.projectMap ?? null;
    for (const value of options.previous ?? []) if (value.sourceProjectId) this.previous.set(value.sourceProjectId, value);
    this.runGit = options.runGit ?? (async (cwd, args) => {
      const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
      for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|CEILING_DIRECTORIES|CONFIG(?:_.*)?|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/.test(key)) delete env[key];
      const { stdout } = await exec('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: options.gitTimeoutMs ?? 1500, maxBuffer: 128 * 1024, env });
      return stdout;
    });
  }
  async refresh(): Promise<CodexProjectMap> {
    this.map = await readCodexProjectMap(this.options.codexRoot); this.invalidate(); return this.map;
  }
  invalidate(): void { this.resolved.clear(); this.boundaries.clear(); this.repositories.clear(); }
  private async gitBoundary(cwd: string): Promise<string | null> {
    let directory = path.resolve(cwd), marker: string | null = null; const visited: string[] = [];
    for (;;) {
      const key = projectPath(directory)!;
      if (this.boundaries.has(key)) { marker = this.boundaries.get(key)!; break; }
      visited.push(key);
      try { const info = await stat(path.join(directory, '.git')); if (info.isFile() || info.isDirectory()) { marker = directory; break; } }
      catch (error: any) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
      const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
    }
    for (const key of visited) this.boundaries.set(key, marker);
    return marker;
  }
  private async gitProject(marker: string): Promise<{ root: string; evidence: NonNullable<ResolvedProjectSource['git']> }> {
    const rootInfo = await this.runGit(marker, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
    const [root, common] = rootInfo.trim().split(/\r?\n/);
    if (!root || !common || !path.isAbsolute(root) || !path.isAbsolute(common)) throw new Error('Unsupported Git path response');
    let branch: string | null = null, tracking: string | null = null, rawRemotes = '';
    try { branch = (await this.runGit(marker, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim() || null; } catch (error: any) { if (error.code !== 1) throw error; }
    if (branch) try { tracking = (await this.runGit(marker, ['config', '--get', `branch.${branch}.remote`])).trim() || null; } catch (error: any) { if (error.code !== 1) throw error; }
    try { rawRemotes = await this.runGit(marker, ['config', '--null', '--get-regexp', '^remote\\..*\\.url$']); } catch (error: any) { if (error.code !== 1) throw error; }
    const remotes = new Map<string, string[]>();
    for (const entry of rawRemotes.split('\0').filter(Boolean)) {
      const split = entry.indexOf('\n'); if (split < 0) throw new Error('Unsupported Git config response');
      const name = /^remote\.(.+)\.url$/.exec(entry.slice(0, split))?.[1]; if (!name) continue;
      const urls = remotes.get(name) ?? []; urls.push(entry.slice(split + 1)); remotes.set(name, urls);
    }
    return { root: projectPath(root)!, evidence: { commonDirectory: projectPath(common)!, primary: selectPrimaryRemote({ remotes: [...remotes].map(([name, urls]): GitRemote => ({ name, urls })), trackingRemote: tracking }) } };
  }
  async resolve(input: { cwd?: string | null; threadId?: string | null }): Promise<ResolvedProjectSource> {
    const cwd = projectPath(input.cwd), threadId = input.threadId || null, key = JSON.stringify([cwd, threadId]);
    const cached = this.resolved.get(key); if (cached) return cached;
    this.map ??= await readCodexProjectMap(this.options.codexRoot);
    let availability: ProjectSourceProvenance['availability'] = cwd ? 'foreign' : 'unknown';
    const conflicts: string[] = [];
    const finish = (value: ResolvedProjectSource): ResolvedProjectSource => { this.resolved.set(key, value); if (value.sourceProjectId) this.previous.set(value.sourceProjectId, value); return value; };
    const base = { collectorId: this.options.collectorId, observedCwd: cwd, appProjectId: null, sessionId: threadId, git: null };
    if (cwd && nativeAbsolute(cwd)) {
      try { availability = (await stat(cwd)).isDirectory() ? 'available' : 'unavailable'; } catch { availability = 'unavailable'; }
      if (availability === 'available') try {
        const marker = await this.gitBoundary(cwd);
        if (marker) {
          const markerKey = projectPath(marker)!;
          let found = this.repositories.get(markerKey);
          if (!found) { found = await this.gitProject(marker); this.repositories.set(markerKey, found); }
          const { root, evidence } = found;
          if (evidence.primary.status === 'ambiguous') conflicts.push(evidence.primary.reason);
          return finish({ ...base, sourceProjectId: sourceProjectId(this.options.collectorId, 'git', root), kind: 'git', root, name: directoryName(root), git: evidence,
            provenance: { method: 'git-filesystem', availability, conflicts, reason: evidence.primary.reason } });
        }
      } catch { conflicts.push('git-read-failed'); }
    }
    // A missing historical directory does not erase facts previously obtained on this collector.
    if (cwd && (availability !== 'available' || conflicts.includes('git-read-failed'))) {
      const old = [...this.previous.values()].filter(p => p.collectorId === this.options.collectorId && p.root && within(p.root, cwd) && p.kind === 'git')
        .sort((a, b) => b.root!.length - a.root!.length)[0];
      if (old) return finish({ ...old, observedCwd: cwd, sessionId: threadId, provenance: { method: 'persisted-evidence', availability, conflicts: [...old.provenance.conflicts, ...conflicts], reason: 'historical-git-evidence' } });
    }
    const explicit = threadId ? this.map.threads.find(t => t.id === threadId) : null;
    const matching = cwd ? this.map.roots.map(root => ({ ...root, normalized: projectPath(root.path)! })).filter(root => within(root.normalized, cwd))
      .sort((a, b) => b.normalized.length - a.normalized.length || a.position - b.position || a.projectId.localeCompare(b.projectId)) : [];
    let appId = explicit?.projectId ?? null, method: 'app-thread' | 'app-root' = 'app-thread';
    const projectless = threadId !== null && this.map.projectlessThreadIds.includes(threadId);
    if (!appId && matching.length && !projectless) {
      const tied = matching.filter(root => root.normalized.length === matching[0].normalized.length);
      if (new Set(tied.map(root => root.projectId)).size === 1) { appId = matching[0].projectId; method = 'app-root'; }
      else conflicts.push('ambiguous-app-roots');
    }
    if (appId) {
      const app = this.map.projects.find(p => p.id === appId);
      if (app) {
        const matched = matching.find(r => r.projectId === appId), root = matched?.normalized ?? cwd;
        if (threadId && this.map.projectlessThreadIds.includes(threadId)) conflicts.push('projectless-project-conflict');
        return finish({ ...base, sourceProjectId: sourceProjectId(this.options.collectorId, 'app', root, appId), kind: 'app', root, name: app.name, appProjectId: appId,
          provenance: { method, availability, conflicts, reason: root ? 'saved-app-project' : 'app-project-without-root-selection' } });
      }
    }
    if (threadId && projectless) return finish({ ...base, sourceProjectId: sourceProjectId(this.options.collectorId, 'session', cwd, threadId), kind: 'session', root: cwd, name: null,
      provenance: { method: 'explicit-projectless', availability, conflicts, reason: 'known-projectless-thread-list' } });
    if (cwd && availability !== 'available') {
      const old = [...this.previous.values()].filter(p => p.collectorId === this.options.collectorId && p.root && within(p.root, cwd) && p.kind === 'app')
        .sort((a, b) => b.root!.length - a.root!.length)[0];
      if (old) return finish({ ...old, observedCwd: cwd, sessionId: threadId, provenance: { method: 'persisted-evidence', availability, conflicts: [...old.provenance.conflicts, ...conflicts], reason: 'historical-app-evidence' } });
    }
    return finish({ ...base, sourceProjectId: null, kind: 'unresolved', root: cwd, name: null,
      provenance: { method: 'unresolved', availability, conflicts, reason: conflicts.length ? conflicts[0] : 'no-git-app-or-explicit-session-evidence' } });
  }
}
