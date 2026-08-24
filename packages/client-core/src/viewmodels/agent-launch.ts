/**
 * Spawn another agent onto an issue.
 *
 * `issues.start` is a silent no-op once the issue is live, so the client must
 * not guess from replica `worktreePath`. `addSession` is the spawn (and rebuilds
 * a freed checkout); `start` is only the never-started path, which the server
 * names with "issue not started".
 */

export type IssueAgentSpawnInput = { id: string; agentKind?: string }

/** True when addSession refused because the issue has never been started. */
export function isIssueNotStartedError(error: unknown): boolean {
  const parts = [String(error)]
  if (error instanceof Error) {
    parts.push(error.message)
    if (error.cause !== undefined) parts.push(String(error.cause))
  }
  return parts.some((part) => /issue not started/i.test(part))
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
