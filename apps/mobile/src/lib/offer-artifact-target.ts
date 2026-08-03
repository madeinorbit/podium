import { artifactKind, artifactUrl, basename } from '@podium/client-core/viewmodels/dock-panel'
import type { IssuePanelArtifact, IssueWire } from '@podium/protocol'

/** Resolve one offer artifact exactly once for both its thumbnail and tap target. */
export function offerArtifactTarget(args: {
  httpOrigin: string
  issue: IssueWire
  artifact: IssuePanelArtifact
}) {
  const { httpOrigin, issue, artifact } = args
  const root = issue.worktreePath ?? issue.repoPath
  const kind = artifactKind(artifact.entry ?? artifact.path)
  const uri = artifactUrl({
    httpOrigin,
    issueId: issue.id,
    artifact,
    ...(root ? { root } : {}),
    ...(issue.machineId ? { machineId: issue.machineId } : {}),
  })

  return {
    kind,
    label: artifact.title ?? basename(artifact.path),
    uri,
    previewable: kind === 'image' && uri !== null,
  }
}
