import type { IssueAction, IssueId } from '@podium/model'
import { machinePathKey, machinePathsEqual } from '@podium/model'
import type { IssueAccessIndex } from '../../issue-authz'
import type { GrantsRepository } from '../../store/grants'
import type { IssuesRepository } from '../../store/issues'
import type { ReposRepository } from '../../store/repos'
import { readIssue } from './issue-reader'
import { deepestOwner, soleOwner } from './folder-owner'

/** Issue authorization reads the committed IssueStore rows outside mutation
 * spans and live repository rows inside them; which issue owns a folder is one
 * indexed query (`folder-owner.ts`, POD-6155). */
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
      grants: (await this.grants.loadForResource('issue', row.id))
        .filter((edge) => covers(edge.verb))
        .map((edge) => edge.grantee),
    }
  }

  async getMeta(id: IssueId) {
    return await readIssue(this.issues, id)
  }

  /** Whether `cwd` is exactly some live issue's worktree. */
  async isIssueWorktree(cwd: string): Promise<boolean> {
    return (await this.issues.worktreeOwnerCandidates([cwd]))
      .some((row) => row.worktreePath !== null && machinePathsEqual(row.worktreePath, cwd))
  }

  async soleOwnerForCwd(cwd: string): Promise<IssueId | null> {
    const repoRoots = new Set((await this.repos.listRepoPaths()).map(machinePathKey))
    return soleOwner(await this.issues.worktreeOwnerCandidates([cwd]), cwd, repoRoots)
  }

  async issueForCwd(cwd: string): Promise<IssueId | null> {
    return deepestOwner(await this.issues.worktreeOwnerCandidates([cwd]), cwd)
  }

  /**
   * {@link issueForCwd} for many cwds in ONE indexed read of the candidate
   * issues (POD-5941, POD-6155): the host sample asks this for every live shell
   * every five seconds, so its cost must not follow the number of shells or of
   * issues.
   */
  async issuesForCwds(cwds: Iterable<string>): Promise<Map<string, IssueId | null>> {
    const owners = new Map<string, IssueId | null>()
    const unique = [...new Set(cwds)]
    if (unique.length === 0) return owners
    const rows = await this.issues.worktreeOwnerCandidates(unique)
    for (const cwd of unique) owners.set(cwd, deepestOwner(rows, cwd))
    return owners
  }
}
