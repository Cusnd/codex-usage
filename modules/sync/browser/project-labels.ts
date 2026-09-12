import type { SyncCut, SyncEntity } from '../../contracts/sync.js';

export type ProjectLabelView = {
  cut: SyncCut; lease_id: string;
  projects: { id: string; name: string | null }[];
  aliases: Record<string, string>;
  sources?: { id: string; logical_project_id?: string | null }[];
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function namesFromProjects(projects: ProjectLabelView['projects'], aliases: Record<string, string>, sources: ProjectLabelView['sources'] = []) {
  const names: Record<string, string> = Object.create(null), links: Record<string, string> = Object.create(null);
  for (const project of projects) if (typeof project.id === 'string' && project.id && (typeof project.name === 'string' || project.name === null)) names[project.id] = project.name?.trim() || '未命名项目';
  for (const [id, target] of Object.entries(aliases)) if (typeof target === 'string' && target) links[id] = target;
  for (const source of sources) if (typeof source.id === 'string' && typeof source.logical_project_id === 'string') links[source.id] = source.logical_project_id;
  for (const id of Object.keys(links)) {
    let target = id; const visited = new Set<string>();
    while (!Object.hasOwn(names, target) && Object.hasOwn(links, target) && !visited.has(target)) { visited.add(target); target = links[target]; }
    if (Object.hasOwn(names, target)) names[id] = names[target];
  }
  return names;
}
export function labelsFromEntities(entities: (SyncEntity | undefined)[]) {
  const projects: ProjectLabelView['projects'] = [], aliases: Record<string, string> = Object.create(null);
  for (const entity of entities) {
    const value = entity?.value; if (entity?.kind !== 'project' || !record(value)) continue;
    if (value.subtype === 'logical' && record(value.project) && typeof value.project.id === 'string' && (typeof value.project.name === 'string' || value.project.name === null)) {
      projects.push({ id: value.project.id, name: value.project.name });
    } else if (value.subtype === 'alias' && typeof value.id === 'string' && typeof value.target === 'string') aliases[value.id] = value.target;
  }
  return { names: namesFromProjects(projects, aliases), aliases };
}
/** Only documented project-bearing DTO fields participate; their values stay unchanged. */
export function referencedProjectIds(data: unknown, selected?: unknown): string[] {
  const ids = new Set<string>(); if (typeof selected === 'string' && selected) ids.add(selected);
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { for (const child of value) visit(child); return; }
    if (!record(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'project' && typeof child === 'string' && child) ids.add(child);
      else if (key === 'projects' && Array.isArray(child)) for (const id of child) if (typeof id === 'string' && id) ids.add(id);
      if (typeof child === 'object') visit(child);
    }
  };
  visit(data); return [...ids];
}
