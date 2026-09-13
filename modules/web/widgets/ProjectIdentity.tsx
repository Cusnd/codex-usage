import { CircleHelp, Folder, FolderGit2, MessageCircle } from 'lucide-react';
import { useProjectLabels } from '../runtime/context.js';

export function ProjectIcon({ id, kind: suppliedKind }: { id: string | null; kind?: 'git' | 'app' | 'session' | 'project' | 'unknown' }) {
  const { projectKind } = useProjectLabels();
  const kind = suppliedKind ?? projectKind(id);
  const label = kind === 'session' ? 'Projectless chat' : kind === 'git' ? 'Git project'
    : kind === 'app' ? 'App project' : kind === 'unknown' ? '归属待识别' : 'Project';
  const Icon = kind === 'session' ? MessageCircle : kind === 'git' ? FolderGit2 : kind === 'unknown' ? CircleHelp : Folder;
  return <span className="project-kind-icon" title={label} aria-label={label} role="img">
    <Icon size={16} strokeWidth={1.7} aria-hidden="true" />
  </span>;
}

export function ProjectIdentity({ id }: { id: string | null }) {
  const { projectName } = useProjectLabels();
  return <span className="project-identity"><ProjectIcon id={id} /><span>{projectName(id)}</span></span>;
}
