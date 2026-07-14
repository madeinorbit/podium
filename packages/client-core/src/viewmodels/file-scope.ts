export type FileScope =
  | { kind: 'session'; sessionId: string }
  | { kind: 'worktree'; machineId?: string; root: string }
  /** A permanent issue-artifact snapshot ([spec:SP-0fc9] #441) — paths are
   *  relative to the artifact dir; served from the server-local store. */
  | { kind: 'artifact'; issueId: string; artifactId: string }

/** Stable key for a scope — used in tab ids and mode-persistence keys. */
export function scopeKey(scope: FileScope): string {
  if (scope.kind === 'session') return `s:${scope.sessionId}`
  if (scope.kind === 'artifact') return `a:${scope.issueId}:${scope.artifactId}`
  return `w:${scope.root}`
}

/** A file tab's id: unique per (scope, path). */
export function tabIdFor(scope: FileScope, path: string): string {
  return `file:${scopeKey(scope)}:${path}`
}
