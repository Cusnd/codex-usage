/** Project identity and organization. This module has no filesystem, database or clock dependency. */
export type SourceProjectKind = 'git' | 'app' | 'session';

/** An injective tuple encoding, rather than a lossy hash of a path or display name. */
export function sourceProjectId(collectorId: string, kind: SourceProjectKind, normalizedRoot: string | null, originalId: string | null = null): string {
  if (!collectorId || (!normalizedRoot && !originalId)) throw new Error('A project needs a collector and a root or original identity');
  return 'sp1:' + encodeURIComponent(JSON.stringify([collectorId, kind, normalizedRoot, originalId]));
}

export type RemoteIdentity = {
  key: string;
  host: string;
  port: number | null;
  repositoryPath: string;
  sanitizedUrl: string;
};

/** Normalize supported network remotes. Unknown/local transports supply no cross-device proof. */
export function normalizeRemote(value: string): RemoteIdentity | null {
  const raw = value.trim();
  if (!raw || /[\u0000-\u0020\u007f]/.test(raw) || /^[a-z]:/i.test(raw)) return null;
  let protocol: string, host: string, port: number | null, repositoryPath: string;
  if (raw.includes('://')) {
    const match = /^(https?|ssh|git):\/\/([^/]+)\/(.*)$/i.exec(raw);
    if (!match || /[?#]/.test(match[3])) return null;
    let url: URL;
    try { url = new URL(raw); } catch { return null; }
    protocol = url.protocol.slice(0, -1).toLowerCase();
    host = url.hostname.toLowerCase().replace(/\.$/, '');
    const defaults: Record<string, number> = { https: 443, http: 80, ssh: 22, git: 9418 };
    const parsedPort = url.port ? Number(url.port) : null;
    port = parsedPort === defaults[protocol] ? null : parsedPort;
    // Read the original path: URL would silently collapse dot segments first.
    repositoryPath = match[3];
  } else {
    const match = /^(?:[^@/:\\]+@)?(\[[^\]]+\]|[^@/:\\]+):(.+)$/.exec(raw);
    if (!match || /[?#]/.test(match[2])) return null;
    protocol = 'ssh'; host = match[1].toLowerCase().replace(/\.$/, ''); port = null;
    repositoryPath = match[2].replace(/^\//, '');
  }
  if (!host || host === '.' || /[\\@?#]/.test(host)) return null;
  try { host = new URL(`ssh://${host}`).hostname.toLowerCase().replace(/\.$/, ''); } catch { return null; }
  if (!repositoryPath || repositoryPath.startsWith('/') || repositoryPath.startsWith('~') || repositoryPath.includes('\\')) return null;
  // Do not turn distinct case-sensitive paths, encoded separators or internal slashes into one repo.
  if (repositoryPath.split('/').some(p => /^(?:\.|%2e){1,2}$/i.test(p))) return null;
  repositoryPath = repositoryPath.replace(/\/$/, '').replace(/\.git$/, '');
  if (!repositoryPath) return null;
  return {
    key: 'repo1:' + JSON.stringify([host, port, repositoryPath]), host, port, repositoryPath,
    sanitizedUrl: `${protocol}://${host}${port === null ? '' : ':' + port}/${repositoryPath}`,
  };
}

export type GitRemote = { name: string; urls: readonly string[] };
export type PrimaryRemoteSelection = {
  status: 'confirmed' | 'ambiguous' | 'unresolved';
  identity: RemoteIdentity | null;
  reason: string;
  candidates: { remote: string; identities: RemoteIdentity[]; unsupported: boolean }[];
};

export function selectPrimaryRemote(input: { remotes: readonly GitRemote[]; trackingRemote?: string | null; primaryRemote?: string | null }): PrimaryRemoteSelection {
  const candidates = [...input.remotes].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(remote => {
    const identities = new Map<string, RemoteIdentity>(); let unsupported = !remote.urls.length;
    for (const value of [...remote.urls].sort()) {
      const normalized = normalizeRemote(value);
      if (normalized) identities.set(normalized.key, normalized); else unsupported = true;
    }
    return { remote: remote.name, identities: [...identities.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0), unsupported };
  });
  const selected = (name: string) => candidates.find(c => c.remote === name);
  const identity = (name: string) => { const c = selected(name); return c && !c.unsupported && c.identities.length === 1 ? c.identities[0] : null; };
  const result = (status: PrimaryRemoteSelection['status'], reason: string, value: RemoteIdentity | null = null): PrimaryRemoteSelection => ({ status, reason, identity: value, candidates });
  if (input.primaryRemote) {
    const value = identity(input.primaryRemote);
    return value ? result('confirmed', 'explicit-primary-remote', value) : result('ambiguous', 'invalid-explicit-primary-remote');
  }
  const tracking = input.trackingRemote && input.trackingRemote !== '.' ? input.trackingRemote : null;
  if (selected('origin')) {
    const origin = identity('origin');
    if (!origin) return result('ambiguous', 'origin-has-no-unique-network-identity');
    if (tracking && tracking !== 'origin') {
      const tracked = identity(tracking);
      if (!tracked || tracked.key !== origin.key) return result('ambiguous', 'tracking-origin-conflict');
    }
    return result('confirmed', tracking && tracking !== 'origin' ? 'tracking-origin-agree' : 'origin', origin);
  }
  if (tracking) {
    const value = identity(tracking);
    return value ? result('confirmed', 'tracking-remote', value) : result('ambiguous', 'tracking-has-no-unique-network-identity');
  }
  if (candidates.length === 1) {
    const value = identity(candidates[0].remote);
    return value ? result('confirmed', 'sole-network-remote', value) : result('unresolved', 'unsupported-sole-remote');
  }
  return result(candidates.length ? 'ambiguous' : 'unresolved', candidates.length ? 'no-unique-primary-remote' : 'no-network-remote');
}

export function resolveProjectAlias(id: string, aliases: Readonly<Record<string, string>>): string {
  const seen = new Set<string>(); let current = id;
  while (Object.hasOwn(aliases, current) && aliases[current] !== current) {
    if (seen.has(current)) throw new Error('Project alias cycle');
    seen.add(current); current = aliases[current];
    if (!current) throw new Error('Invalid project alias');
  }
  return current;
}

export function normalizeProjectAliases(aliases: Readonly<Record<string, string>>, activeIds: Iterable<string> = []): Record<string, string> {
  const active = new Set(activeIds), filtered: Record<string, string> = Object.create(null), output: Record<string, string> = Object.create(null);
  for (const id of Object.keys(aliases).sort()) if (!active.has(id) && aliases[id] !== id) filtered[id] = aliases[id];
  for (const id of Object.keys(filtered)) output[id] = resolveProjectAlias(id, filtered);
  return output;
}

export type ProjectNode = { id: string; name?: string | null };
export type ProjectEdge = { a: string; b: string; reason: 'session' | 'primary-remote' | 'local-repository' | 'app-project' };
/** Every partition is an explicit human choice; automatic membership must never be persisted here. */
export type ManualProjectPartition = { id: string; members: readonly string[]; name?: string | null };
export type LogicalProject = { id: string; members: string[]; name: string | null; manual: boolean; anchorIds: string[]; reasons: ProjectEdge[] };
export type ProjectOrganization = {
  projects: LogicalProject[];
  membership: Record<string, string>;
  aliases: Record<string, string>;
  blockedEdges: ProjectEdge[];
};

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const defaultLogicalId = (sourceId: string) => 'lp1:' + encodeURIComponent(sourceId);

/** Recompute the affected full graph, not just the newest edge, so C can leave A when B arrives. */
export function organizeProjects(input: {
  sources: readonly ProjectNode[];
  edges: readonly ProjectEdge[];
  partitions?: readonly ManualProjectPartition[];
  names?: Readonly<Record<string, string>>;
  previous?: ProjectOrganization;
}): ProjectOrganization {
  const nodes = new Map<string, ProjectNode>();
  for (const node of input.sources) { if (!node.id || nodes.has(node.id)) throw new Error('Duplicate or empty source project'); nodes.set(node.id, node); }
  const ids = [...nodes.keys()].sort(), anchored = new Map<string, string>(), partitions = new Map<string, ManualProjectPartition>();
  for (const partition of input.partitions ?? []) {
    if (!partition.id || partitions.has(partition.id)) throw new Error('Duplicate or empty manual partition');
    partitions.set(partition.id, partition);
    for (const member of partition.members) {
      if (anchored.has(member) && anchored.get(member) !== partition.id) throw new Error('Source belongs to incompatible manual partitions');
      anchored.set(member, partition.id);
    }
  }
  const adjacency = new Map(ids.map(id => [id, new Set<string>()]));
  const edgeMap = new Map<string, ProjectEdge>();
  for (const edge of input.edges) {
    if (!nodes.has(edge.a) || !nodes.has(edge.b) || edge.a === edge.b) continue;
    const [a, b] = [edge.a, edge.b].sort();
    edgeMap.set(JSON.stringify([a, b, edge.reason]), { a, b, reason: edge.reason });
    adjacency.get(a)!.add(b); adjacency.get(b)!.add(a);
  }
  const edges = [...edgeMap.values()].sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  const blocks: { members: string[]; anchors: string[]; fixedId: string | null }[] = [];
  const fixed = new Map<string, { members: string[]; anchors: string[]; fixedId: string }>();
  for (const id of ids) if (anchored.has(id)) {
    const anchor = anchored.get(id)!;
    if (!fixed.has(anchor)) fixed.set(anchor, { members: [], anchors: [anchor], fixedId: anchor });
    fixed.get(anchor)!.members.push(id);
  }
  const visited = new Set<string>();
  for (const id of ids) {
    if (anchored.has(id) || visited.has(id)) continue;
    const stack = [id], members: string[] = [], anchors = new Set<string>(); visited.add(id);
    while (stack.length) {
      const current = stack.pop()!; members.push(current);
      for (const neighbor of adjacency.get(current)!) {
        const anchor = anchored.get(neighbor);
        if (anchor) anchors.add(anchor);
        else if (!visited.has(neighbor)) { visited.add(neighbor); stack.push(neighbor); }
      }
    }
    members.sort(); const reached = [...anchors].sort();
    if (reached.length === 1) fixed.get(reached[0])!.members.push(...members);
    else blocks.push({ members, anchors: reached, fixedId: null });
  }
  blocks.push(...fixed.values()); for (const block of blocks) block.members.sort();
  blocks.sort((a, b) => compare(a.members[0], b.members[0]));
  const blockOf = new Map<string, number>(); blocks.forEach((b, i) => b.members.forEach(m => blockOf.set(m, i)));
  // A previous ID survives on the component containing its smallest surviving member.
  const keeper = new Map<string, number>();
  for (const old of input.previous?.projects ?? []) {
    const surviving = old.members.filter(m => blockOf.has(m)).sort();
    if (surviving.length) keeper.set(old.id, blockOf.get(surviving[0])!);
  }
  const reserved = new Set(blocks.flatMap(b => b.fixedId ? [b.fixedId] : [])), used = new Set(reserved);
  const projects: LogicalProject[] = blocks.map(block => {
    // Arrival order must not select an automatic canonical ID. Old references remain valid via aliases.
    let id = block.fixedId ?? defaultLogicalId(block.members[0]);
    if (!block.fixedId && used.has(id)) { id = defaultLogicalId(block.members[0]); while (used.has(id)) id += ':split'; }
    used.add(id);
    const manualName = input.names?.[id] ?? partitions.get(id)?.name;
    const name = manualName?.trim() || block.members.map(m => nodes.get(m)?.name?.trim()).find(Boolean) || null;
    return { id, members: block.members, name, manual: !!block.fixedId, anchorIds: block.anchors, reasons: [] };
  });
  const membership: Record<string, string> = Object.create(null);
  for (const project of projects) for (const member of project.members) membership[member] = project.id;
  const byId = new Map(projects.map(p => [p.id, p])), blockedEdges: ProjectEdge[] = [];
  for (const edge of edges) {
    if (membership[edge.a] === membership[edge.b]) byId.get(membership[edge.a])!.reasons.push(edge);
    else blockedEdges.push(edge);
  }
  const aliases: Record<string, string> = Object.assign(Object.create(null), input.previous?.aliases ?? {});
  for (const [source, id] of Object.entries(membership)) if (defaultLogicalId(source) !== id) aliases[defaultLogicalId(source)] = id;
  for (const [old, index] of keeper) if (!used.has(old)) aliases[old] = projects[index].id;
  const normalizedAliases = normalizeProjectAliases(aliases, used);
  for (const project of projects) {
    const direct = input.names?.[project.id]?.trim() || partitions.get(project.id)?.name?.trim();
    const inherited = Object.keys(input.names ?? {}).sort().find(id => input.names![id]?.trim() && resolveProjectAlias(id, normalizedAliases) === project.id);
    project.name = direct || (inherited ? input.names![inherited].trim() : null) || project.name;
  }
  return { projects: projects.sort((a, b) => compare(a.id, b.id)), membership, aliases: normalizedAliases, blockedEdges };
}
