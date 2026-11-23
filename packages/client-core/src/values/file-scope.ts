import type { ArtifactId, IssueId, MachineId, SessionId } from '@podium/model'
export type FileScope =
  | { kind: 'session'; sessionId: SessionId }
  | { kind: 'worktree'; machineId?: MachineId; root: string }
  /** A permanent issue-artifact snapshot (#441) — paths are
   *  relative to the artifact dir; served from the server-local store. */
  | { kind: 'artifact'; issueId: IssueId; artifactId: ArtifactId }

/** Stable key for a scope — used in tab ids and mode-persistence keys. */
export function scopeKey(scope: FileScope): string {
  if (scope.kind === 'session') return `s:${scope.sessionId}`
  if (scope.kind === 'artifact') return `a:${scope.issueId}:${scope.artifactId}`
  // Unspecified routing has its own identity; it must never adopt a machine's buffer.
  return `w:${encodeURIComponent(scope.machineId ?? '')}:${scope.root}`
}

/** A file tab's id: unique per (scope, path). */
export function tabIdFor(scope: FileScope, path: string): string {
  return `file:${scopeKey(scope)}:${path}`
}

// LEGACY(remove-after: 2027-05): pre-machine worktree tab IDs for inheriting saved presentation choices.
export function legacyWorktreeTabId(scope: FileScope, path: string): string | undefined {
  return scope.kind === 'worktree' ? `file:w:${scope.root}:${path}` : undefined
}
