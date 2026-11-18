import type { IssuesRepository } from '../../store/issues'
import type { IssueAccessRow, IssueRow } from '../../store/types'

/**
 * ISSUE READS FOR CODE OUTSIDE THE ISSUE MODULE (feed visibility, session
 * projection and authorization, memory, cost, the relay).
 *
 * They ask the repository through its per-operation row loader (POD-6195): one
 * daemon frame or tRPC call reads each issue once, however many of these
 * readers ask (session authorization and the session projection both do), and
 * the loader's version moves on every issue write and commit, so a read after a
 * write sees it. They used to borrow IssueStore's in-memory map, which POD-6158
 * deleted.
 */

// The repository always has the loader; a narrowed port (a test's fake) may
// offer only the plain reads, which then answer.
type IssueReadPort = Pick<IssuesRepository, 'getIssue' | 'getIssues'> &
  Partial<Pick<IssuesRepository, 'loadIssue' | 'loadIssues' | 'loadIssueAccess'>>

export async function readIssue(repository: IssueReadPort, id: string): Promise<IssueRow | null> {
  return repository.loadIssue
    ? ((await repository.loadIssue(id)) ?? null)
    : await repository.getIssue(id)
}

export async function readIssues(
  repository: IssueReadPort,
  ids: readonly string[],
): Promise<Map<string, IssueRow>> {
  return repository.loadIssues ? await repository.loadIssues(ids) : await repository.getIssues(ids)
}

/**
 * What the sharing rules read of these issues (POD-7153): the execution
 * pointers and the checkout path, without the bodies. The same issues as
 * {@link readIssues} answers, so a decision over them is the same decision.
 */
export async function readIssueAccess(
  repository: IssueReadPort,
  ids: readonly string[],
): Promise<Map<string, IssueAccessRow>> {
  if (repository.loadIssueAccess) return await repository.loadIssueAccess(ids)
  const out = new Map<string, IssueAccessRow>()
  for (const [id, row] of await readIssues(repository, ids)) {
    out.set(id, {
      id: row.id,
      ownerUserId: row.ownerUserId,
      machineId: row.machineId,
      worktreePath: row.worktreePath,
      coordinatorSessionId: row.coordinatorSessionId,
      startedBySession: row.startedBySession,
      humanQuestionAskedBy: row.humanQuestionAskedBy,
    })
  }
  return out
}
