import { artifactKind, artifactUrl, basename } from '@podium/client-core/viewmodels'
import type { IssuePanelArtifact, IssueWire } from '@podium/model'

export type IssueArtifactPreview = 'image' | 'video' | 'html' | 'markdown' | 'text' | 'file'

const TEXT_EXTS = new Set(['txt', 'json', 'ts', 'tsx', 'js', 'jsx', 'css', 'svg', 'log', 'csv'])

export function issueArtifactHref(
  issue: IssueWire,
  artifact: IssuePanelArtifact,
  httpOrigin: string,
): string | null {
  const root = issue.worktreePath ?? issue.repoPath
  return artifactUrl({
    httpOrigin,
    issueId: issue.id,
    artifact,
    ...(root ? { root } : {}),
    ...(issue.machineId ? { machineId: issue.machineId } : {}),
  })
}

export function issueArtifactPreview(path: string): IssueArtifactPreview {
  const kind = artifactKind(path)
  if (kind === 'image' || kind === 'video') return kind
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'file'
}

export function issueArtifactLabel(artifact: IssuePanelArtifact): string {
  return artifact.title ?? basename(artifact.entry ?? artifact.path)
}
