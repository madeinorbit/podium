import type { DurableIssueAccessIndex } from './access-index'
import { StaleIssueRevisionError } from '../../store/issue-revision'
import type { EventMap } from '../bus'
import type { IssueService } from './service'

type Adoption = Extract<EventMap['issue.sessionDerived'], { kind: 'adoptWorktree' }>
type Ports = Pick<DurableIssueAccessIndex, 'getMeta' | 'worktreePaths'> & Pick<IssueService, 'update'>

/** A session-created coordinator update can commit after adoption cuts its
 * draft. Re-evaluate adoption after that revision refusal; never replay an old
 * patch without checking whether the issue or workspace is still eligible. */
export async function adoptSessionWorktree(event: Adoption, ports: Ports): Promise<void> {
  const { message } = event
  if (message.kind !== 'worktree') return
  for (let attempt = 0; attempt < 3; attempt++) {
    const issue = await ports.getMeta(event.issueId)
    if (!issue || issue.archived || issue.worktreePath !== null) return
    if (message.repoRoot !== undefined && message.repoRoot !== issue.repoPath) return
    if ((await ports.worktreePaths()).includes(message.cwd)) return
    try {
      await ports.update(issue.id, {
        worktreePath: message.cwd,
        machineId: event.machineId,
        ...(message.branch ? { branch: message.branch } : {}),
      })
      return
    } catch (err) {
      if (!(err instanceof StaleIssueRevisionError) || err.issueId !== issue.id || attempt === 2) throw err
    }
  }
}
