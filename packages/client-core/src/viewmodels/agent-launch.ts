/**
 * Put another agent on an issue.
 *
 * Surfaces used to pick `issues.start` vs `issues.addSession` from the replica's
 * `worktreePath`. That field can lag the server (a live checkout still painted
 * as unset), and `issues.start` is a silent no-op on an already-started issue —
 * the click disables its button, waits for a session that never arrives, and
 * looks like nothing happened. Navigating away refreshes the replica, so the
 * next click takes `addSession` and always works.
 *
 * `addSession` is the spawn. It rebuilds a freed worktree from the preserved
 * branch when it has to. `start` is only the never-started path, and the server
 * is the one that knows: addSession refuses with "issue not started".
 */

export type IssueAgentSpawnInput = { id: string; agentKind?: string }

/** True when addSession refused because the issue has never been started. */
export function isIssueNotStartedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /issue not started/i.test(message)
}

/** Spawn one more agent onto an issue, without guessing from client checkout state. */
export async function spawnIssueAgent<I extends IssueAgentSpawnInput>(
  issues: {
    addSession: { mutate: (input: I) => Promise<unknown> }
    start: { mutate: (input: I) => Promise<unknown> }
  },
  input: I,
): Promise<unknown> {
  try {
    return await issues.addSession.mutate(input)
  } catch (error) {
    if (!isIssueNotStartedError(error)) throw error
    return await issues.start.mutate(input)
  }
}
