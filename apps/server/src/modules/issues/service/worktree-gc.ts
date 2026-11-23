import type { IssueId, MachineId } from '@podium/model'
import { machinePathKey } from '@podium/model'
import type { WorktreeGcObservation } from '@podium/protocol'
import type { CommandPrincipal } from '../../../command-principal'
import { liveSessionsUsingWorktree } from '../../../issue-util'
import type { IssueRow } from '../../../store'
import type { IssueStore } from './core'
import { isIssueRefusal } from './refusal'

import { parseGitWorktreeList } from './worktree-safety'

const DAY_MS = 24 * 60 * 60 * 1000

type FreeWorktreeResult = {
  ok: boolean
  output: string
  worktreeFreed: boolean
}

type FreeWorktree = (id: string, principal: CommandPrincipal) => Promise<FreeWorktreeResult>
type ReleaseWorktreeResult = { freed: true } | { freed: false; reason?: string }

/**
 * Closed-worktree reclamation policy and its fail-safe release gates (POD-564).
 * Kept separate from the issue's interactive git workflow: this capability owns
 * janitor revalidation, candidate selection, and unattended-release refusal.
 */
export class IssueWorktreeGcModule {
  constructor(
    private readonly store: IssueStore,
    private readonly freeWorktreeKeepBranch: FreeWorktree,
  ) {}

  /**
   * Give a finished issue's disk back without force and only when no live
   * session occupies the path on its machine. The branch is always retained.
   */
  async releaseWorktreeIfIdle(
    id: string,
    principal: CommandPrincipal,
  ): Promise<ReleaseWorktreeResult> {
    const row = await this.store.rowOrThrow(id)
    const worktreePath = row.worktreePath
    if (!worktreePath) return { freed: false }
    let machineId: MachineId
    try {
      machineId = await this.store.resolveWorktreeMachine(row.machineId, row.repoPath)
    } catch (error) {
      if (!isIssueRefusal(error)) throw error
      return await this.refuseRelease(row, worktreePath, error.message)
    }
    const stillUsing = liveSessionsUsingWorktree(
      worktreePath,
      this.store.d.runningSessionFacts(),
      machineId,
    )
    if (stillUsing.length > 0) {
      return await this.refuseRelease(
        row,
        worktreePath,
        `${stillUsing.length} live session(s) still in ${worktreePath}`,
      )
    }
    const freed = await this.freeWorktreeKeepBranch(id, principal).catch((error: unknown) => {
      if (!isIssueRefusal(error)) throw error
      return { ok: false, output: error.message, worktreeFreed: false }
    })
    if (!freed.ok) return await this.refuseRelease(row, worktreePath, freed.output)
    return freed.worktreeFreed ? { freed: true } : { freed: false }
  }

  private isCandidate(row: IssueRow, nowMs: number, afterDays: number): boolean {
    if (!row.worktreePath || row.deletedAt || !this.store.isClosed(row)) return false
    const closedMs = Date.parse(row.closedAt ?? '')
    return Number.isFinite(closedMs) && closedMs <= nowMs - afterDays * DAY_MS
  }

  /** Reclaimable paths, oldest close first, shared by the panel and manual apply. */
  async listReclaimableWorktrees(nowMs: number = Date.now(), machineId?: MachineId) {
    const { afterDays } = (await this.store.d.getSettings()).worktreeGc
    const live = this.store.d.runningSessionFacts()
    const repoRows = await this.store.d.store.repos.listRepos(machineId)
    const discovered = new Map<
      string,
      {
        path: string
        branch: string | null
        headSha: string | null
        machineId: MachineId
        repoPath: string
        primary: boolean
      }
    >()
    const diagnostics: Array<{ repoPath: string; machineId: MachineId; reason: string }> = []

    await Promise.all(
      repoRows.map(async (repo) => {
        const result = await this.store.d.repoOp(
          'worktreeList',
          repo.path,
          undefined,
          repo.machineId,
        )
        if (!result.ok) {
          diagnostics.push({
            repoPath: repo.path,
            machineId: repo.machineId,
            reason: result.output,
          })
          return
        }
        const records = parseGitWorktreeList(result.output)
        for (const [index, record] of records.entries()) {
          const key = `${repo.machineId}\0${machinePathKey(record.path)}`
          if (discovered.has(key)) continue
          discovered.set(key, {
            path: record.path,
            branch: record.branch,
            headSha: record.head,
            machineId: repo.machineId,
            repoPath: repo.path,
            primary: index === 0,
          })
        }
      }),
    )

    // RESOLVED ONCE, UP FRONT, so every predicate below stays synchronous.
    // A row's machine is a durable read now, and `rowMachine` used to be called
    // from inside `.map` and `.filter`. An async callback there would put
    // promises in `claimed` (so no membership test could ever match, and claimed
    // worktrees would be swept as reclaimable) and would make the machine filter
    // compare a promise to an id — always unequal, dropping every candidate.
    //
    // Only issues with a worktree recorded (deleted ones included: their path is
    // still claimed) are read, in one SQL listing (POD-6194); they used to be
    // found by scanning the issue map, with a machine resolved for every issue.
    const withWorktrees = await this.store.deps.store.issues.listIssueRowsWhere({
      repo: false,
      live: false,
      hasWorktree: true,
      order: 'path-seq',
    })
    const machineByRow = new Map<IssueId, MachineId>()
    const unresolvedPaths = new Set<string>()
    let skippedUnresolvedMachines = 0
    for (const row of withWorktrees) {
      try {
        machineByRow.set(
          row.id,
          await this.store.resolveWorktreeMachine(row.machineId, row.repoPath),
        )
      } catch (error) {
        if (!isIssueRefusal(error)) throw error
        skippedUnresolvedMachines++
        if (row.worktreePath) unresolvedPaths.add(machinePathKey(row.worktreePath))
      }
    }
    const resolvedRows = withWorktrees.flatMap((row) => {
      const resolvedMachineId = machineByRow.get(row.id)
      return resolvedMachineId === undefined ? [] : [{ row, machineId: resolvedMachineId }]
    })
    const claimed = new Set<string>()
    for (const { row, machineId: resolvedMachineId } of resolvedRows) {
      if (!row.worktreePath) continue
      claimed.add(`${resolvedMachineId}\0${machinePathKey(row.worktreePath)}`)
    }
    const candidates = resolvedRows
      .filter(({ row }) => this.isCandidate(row, nowMs, afterDays))
      .filter((entry) => machineId === undefined || entry.machineId === machineId)
      .filter(
        ({ row, machineId: resolvedMachineId }) =>
          liveSessionsUsingWorktree(row.worktreePath, live, resolvedMachineId).length === 0,
      )
      .sort(
        (a, b) =>
          (a.row.closedAt ?? '').localeCompare(b.row.closedAt ?? '') ||
          a.row.id.localeCompare(b.row.id),
      )
      .map(({ row, machineId: resolvedMachineId }) => {
        const found = discovered.get(`${resolvedMachineId}\0${machinePathKey(row.worktreePath!)}`)
        return {
          issueId: row.id,
          title: row.title,
          worktreePath: row.worktreePath as string,
          closedAt: row.closedAt as string,
          machineId: resolvedMachineId,
          present: Boolean(found),
          protectedReason: found?.primary ? 'repository root' : null,
        }
      })

    const orphans = [...discovered.values()]
      .filter((entry) => !entry.primary)
      .filter((entry) => !unresolvedPaths.has(machinePathKey(entry.path)))
      .filter((entry) => !claimed.has(`${entry.machineId}\0${machinePathKey(entry.path)}`))
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(({ primary: _primary, ...entry }) => entry)
    const allWorktreePaths = [...discovered.values()].map((entry) => entry.path)
    const reclaimableDiskPaths = candidates
      .filter((candidate) => candidate.present && !candidate.protectedReason)
      .map((candidate) => candidate.worktreePath)

    return {
      candidates,
      orphans,
      diagnostics,
      allWorktreePaths,
      reclaimableDiskPaths,
      skippedUnresolvedMachines,
    }
  }

  /** Apply the current proposal without enabling standing automatic consent. */
  async releaseReclaimableWorktrees(principal: CommandPrincipal, nowMs: number = Date.now()) {
    const freed: string[] = []
    const refused: Array<{ issueId: IssueId; reason: string }> = []
    const { candidates, skippedUnresolvedMachines } = await this.listReclaimableWorktrees(nowMs)
    for (const candidate of candidates) {
      const result = await this.releaseWorktreeIfIdle(candidate.issueId, principal)
      if (result.freed) freed.push(candidate.issueId)
      else refused.push({ issueId: candidate.issueId, reason: result.reason ?? 'not released' })
    }
    return { freed, refused, skippedUnresolvedMachines }
  }

  /**
   * Revalidate a janitor observation against live settings, row state, age, and
   * live path occupancy before proposing or releasing anything.
   */
  async tryObserved(observed: WorktreeGcObservation, nowMs: number, principal: CommandPrincipal) {
    const policy = (await this.store.d.getSettings()).worktreeGc
    if (
      policy.mode === 'off' ||
      policy.mode !== observed.mode ||
      policy.afterDays !== observed.afterDays
    ) {
      return { outcome: 'precondition' as const }
    }
    // Revalidated against the row as stored now (POD-6194).
    const row = await this.store.liveRow(observed.issueId)
    if (!row) return { outcome: 'precondition' as const }
    if (row.worktreePath !== observed.worktreePath) return { outcome: 'precondition' as const }
    if (row.stage !== observed.stage || (row.closedReason ?? null) !== observed.closedReason) {
      return { outcome: 'precondition' as const }
    }
    if ((row.closedAt ?? null) !== observed.closedAt) return { outcome: 'precondition' as const }
    if (row.deletedAt || !this.store.isClosed(row)) return { outcome: 'precondition' as const }
    if (!this.isCandidate(row, nowMs, policy.afterDays)) return { outcome: 'not-due' as const }
    let machineId: MachineId
    try {
      machineId = await this.store.resolveWorktreeMachine(row.machineId, row.repoPath)
    } catch (error) {
      if (!isIssueRefusal(error)) throw error
      const result = await this.refuseRelease(row, observed.worktreePath, error.message)
      return { outcome: 'refused' as const, reason: result.reason }
    }
    if (
      liveSessionsUsingWorktree(row.worktreePath, this.store.d.runningSessionFacts(), machineId)
        .length > 0
    ) {
      return { outcome: 'precondition' as const }
    }
    if (observed.mode === 'propose') {
      await this.store.emitEvent('issue.worktree_gc_proposed', row.id, {
        seq: row.seq,
        worktreePath: observed.worktreePath,
        closedAt: observed.closedAt,
        afterDays: policy.afterDays,
      })
      return { outcome: 'proposed' as const }
    }
    const result = await this.releaseWorktreeIfIdle(row.id, principal)
    if (result.freed) return { outcome: 'freed' as const }
    return { outcome: 'refused' as const, reason: result.reason ?? 'not released' }
  }

  private async refuseRelease(row: IssueRow, worktreePath: string, reason: string) {
    await this.store.emitEvent('issue.worktree_free_refused', row.id, {
      seq: row.seq,
      worktreePath,
      reason,
    })
    return { freed: false as const, reason }
  }
}
