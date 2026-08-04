import type { IssueAction, IssueId } from '@podium/model'
import type { IssueAccessIndex } from '../../issue-authz'
import { isMemberCwd } from '../../issue-util'
import type { GrantsRepository } from '../../store/grants'
import type { IssuesRepository } from '../../store/issues'
import type { ReposRepository } from '../../store/repos'

/**
 * Live issue authorization facts for lower-layer consumers.
 *
 * The three cwd questions read `listIssueCwdRows()` rather than
 * `listIssueRows()` [POD-1653]: they only ever touch worktree/repo/deleted/
 * archived, and the full read materialized every issue row — JSON columns and
 * all — on a per-message path. Still one live read per call; just not the whole
 * table's payload.
 *
 * Reads the durable repositories on every call: no capability or delegation
 * snapshot survives until an outbox replay. The higher-level IssueService is
 * intentionally absent so sessions can be assembled before issue workflows.
 */
export class DurableIssueAccessIndex implements IssueAccessIndex {
  constructor(
    private readonly issues: IssuesRepository,
    private readonly grants: GrantsRepository,
    private readonly repos: ReposRepository,
  ) {}

  has(id: string): boolean {
    return this.issues.getIssue(id) !== null
  }

  ancestorIds(id: string): string[] {
    const ancestors: string[] = []
    const seen = new Set<string>()
    let parent = this.issues.getIssue(id)?.parentId ?? null
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      ancestors.push(parent)
      parent = this.issues.getIssue(parent)?.parentId ?? null
    }
    return ancestors
  }

  ownedTarget(id: string, action: IssueAction) {
    const row = this.issues.getIssue(id)
    if (!row) return undefined
    const covers = (verb: string): boolean =>
      action === 'read'
        ? verb === 'read' || verb === 'write' || verb === 'manage'
        : action === 'write'
          ? verb === 'write' || verb === 'manage'
          : verb === 'manage'
    return {
      kind: 'owned' as const,
      id: row.id,
      owner: row.ownerUserId ?? null,
      grants: this.grants
        .listForResource('issue', row.id)
        .filter((edge) => covers(edge.verb))
        .map((edge) => edge.grantee),
    }
  }

  getMeta(id: string) {
    return this.issues.getIssue(id)
  }

  worktreePaths(): string[] {
    return this.issues
      .listIssueCwdRows()
      .filter((row) => !row.deletedAt && row.worktreePath)
      .map((row) => row.worktreePath as string)
  }

  soleOwnerForCwd(cwd: string): IssueId | null {
    const repoRoots = new Set(this.repos.listRepoPaths())
    const owners = this.issues
      .listIssueCwdRows()
      .filter(
        (row) =>
          !row.deletedAt &&
          !row.archived &&
          row.worktreePath !== null &&
          !repoRoots.has(row.worktreePath) &&
          isMemberCwd(row.worktreePath, cwd),
      )
    const deepest = owners.reduce(
      (length, row) => Math.max(length, row.worktreePath?.length ?? 0),
      0,
    )
    const mostSpecific = owners.filter((row) => row.worktreePath?.length === deepest)
    return mostSpecific.length === 1 ? (mostSpecific[0]?.id ?? null) : null
  }

  issueForCwd(cwd: string): IssueId | null {
    let best: { id: IssueId; length: number } | undefined
    for (const row of this.issues.listIssueCwdRows()) {
      if (row.deletedAt || !isMemberCwd(row.worktreePath, cwd)) continue
      const length = row.worktreePath?.length ?? 0
      if (!best || length > best.length) best = { id: row.id, length }
    }
    return best?.id ?? null
  }
}
