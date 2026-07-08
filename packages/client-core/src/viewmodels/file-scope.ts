export type FileScope =
  | { kind: 'session'; sessionId: string }
  | { kind: 'worktree'; machineId?: string; root: string }

/** Stable key for a scope — used in tab ids and mode-persistence keys. */
export function scopeKey(scope: FileScope): string {
  return scope.kind === 'session' ? `s:${scope.sessionId}` : `w:${scope.root}`
}

/** A file tab's id: unique per (scope, path). */
export function tabIdFor(scope: FileScope, path: string): string {
  return `file:${scopeKey(scope)}:${path}`
}
