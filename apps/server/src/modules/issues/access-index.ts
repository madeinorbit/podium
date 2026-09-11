import { readIssue, readIssueCwdRows } from '../world-index/issue-reader'
import { readResourceGrants } from '../world-index/grant-reader'
import type { IssueAction, IssueId } from '@podium/model'
import type { IssueAccessIndex } from '../../issue-authz'
import { isMemberCwd } from '../../issue-util'
import type { GrantsRepository } from '../../store/grants'
import type { IssuesRepository } from '../../store/issues'
import type { ReposRepository } from '../../store/repos'

/** Issue authorization reads the committed IssueStore rows outside mutation
 * spans and live repository rows inside them. Boot quarantine disables snapshot binding so cwd ambiguity and ownership
 * semantics remain identical for structurally corrupt rows. */
export class DurableIssueAccessIndex implements IssueAccessIndex {
  constructor(
    private readonly issues: IssuesRepository,
    private readonly grants: GrantsRepository,
    private readonly repos: ReposRepository,
  ) {}

  async has(id: IssueId): Promise<boolean> {
    return await readIssue(this.issues, id) !== null
  }

  async ancestorIds(id: IssueId): Promise<string[]> {
    const ancestors: string[] = []
    const seen = new Set<string>()
    let parent = (await readIssue(this.issues, id))?.parentId ?? null
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      ancestors.push(parent)
      parent = (await readIssue(this.issues, parent))?.parentId ?? null
    }
    return ancestors
  }

  async ownedTarget(id: IssueId, action: IssueAction) {
    const row = await readIssue(this.issues, id)
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
      grants: (await readResourceGrants(this.grants, 'issue', row.id))
        .filter((edge) => covers(edge.verb))
        .map((edge) => edge.grantee),
    }
  }

  async getMeta(id: IssueId) {
    return await readIssue(this.issues, id)
  }

  async worktreePaths(): Promise<string[]> {
    return (await readIssueCwdRows(this.issues))
      .filter((row) => !row.deletedAt && row.worktreePath)
      .map((row) => row.worktreePath as string)
  }

  async soleOwnerForCwd(cwd: string): Promise<IssueId | null> {
    const repoRoots = new Set(await this.repos.listRepoPaths())
    const owners = (await readIssueCwdRows(this.issues))
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

  async issueForCwd(cwd: string): Promise<IssueId | null> {
    let best: { id: IssueId; length: number } | undefined
    for (const row of await readIssueCwdRows(this.issues)) {
      if (row.deletedAt || !isMemberCwd(row.worktreePath, cwd)) continue
      const length = row.worktreePath?.length ?? 0
      if (!best || length > best.length) best = { id: row.id, length }
    }
    return best?.id ?? null
  }
}
