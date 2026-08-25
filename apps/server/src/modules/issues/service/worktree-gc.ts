import type { IssueId, MachineId } from '@podium/model'
import type { WorktreeGcObservation } from '@podium/protocol'
import type { CommandPrincipal } from '../../../command-principal'
import { liveSessionsUsingWorktree } from '../../../issue-util'
import type { IssueRow } from '../../../store'
import type { IssueStore } from './core'

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
   * session occupies the path. The branch is always retained.
   */
  async releaseWorktreeIfIdle(
    id: string,
    principal: CommandPrincipal,
  ): Promise<ReleaseWorktreeResult> {
    const row = this.store.rowOrThrow(id)
    const worktreePath = row.worktreePath
    if (!worktreePath) return { freed: false }
    const stillUsing = liveSessionsUsingWorktree(worktreePath, this.store.d.listSessions())
    if (stillUsing.length > 0) {
      return this.refuseRelease(
        row,
        worktreePath,
        `${stillUsing.length} live session(s) still in ${worktreePath}`,
      )
    }
    const freed = await this.freeWorktreeKeepBranch(id, principal)
    if (!freed.ok) return this.refuseRelease(row, worktreePath, freed.output)
    return freed.worktreeFreed ? { freed: true } : { freed: false }
  }

  private isCandidate(row: IssueRow, nowMs: number, afterDays: number): boolean {
    if (!row.worktreePath || row.deletedAt || !this.store.isClosed(row)) return false
    const closedMs = Date.parse(row.closedAt ?? '')
    return Number.isFinite(closedMs) && closedMs <= nowMs - afterDays * DAY_MS
  }

  /** Reclaimable paths, oldest close first, shared by the panel and manual apply. */
  async listReclaimableWorktrees(nowMs: number = Date.now(), machineId?: MachineId) {
    const { afterDays } = this.store.d.getSettings().worktreeGc
    const targetMachineId = machineId ?? this.store.d.store.hostMachineId
    const live = this.store.d.listSessions()
    const repoRows = this.store.d.store.repos.listRepos(targetMachineId)
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
          const key = `${repo.machineId}\0${record.path}`
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

    const rowMachine = (row: IssueRow): MachineId =>
      this.store.resolveWorktreeMachine(row.machineId, row.repoPath)
    const claimed = new Set(
      [...this.store.rows.values()]
        .filter((row) => row.worktreePath)
        .map((row) => `${rowMachine(row)}\0${row.worktreePath}`),
    )
    const candidates = [...this.store.rows.values()]
      .filter((row) => this.isCandidate(row, nowMs, afterDays))
      .filter((row) => rowMachine(row) === targetMachineId)
      .filter((row) => liveSessionsUsingWorktree(row.worktreePath, live).length === 0)
      .sort(
        (a, b) => (a.closedAt ?? '').localeCompare(b.closedAt ?? '') || a.id.localeCompare(b.id),
      )
      .map((row) => {
        const resolvedMachineId = rowMachine(row)
        const found = discovered.get(`${resolvedMachineId}\0${row.worktreePath}`)
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
      .filter((entry) => !claimed.has(`${entry.machineId}\0${entry.path}`))
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
    }
  }

  /** Apply the current proposal without enabling standing automatic consent. */
  async releaseReclaimableWorktrees(principal: CommandPrincipal, nowMs: number = Date.now()) {
    const freed: string[] = []
    const refused: Array<{ issueId: IssueId; reason: string }> = []
    const { candidates } = await this.listReclaimableWorktrees(nowMs)
    for (const candidate of candidates) {
      const result = await this.releaseWorktreeIfIdle(candidate.issueId, principal)
      if (result.freed) freed.push(candidate.issueId)
      else refused.push({ issueId: candidate.issueId, reason: result.reason ?? 'not released' })
    }
    return { freed, refused }
  }

  /**
   * Revalidate a janitor observation against live settings, row state, age, and
   * live path occupancy before proposing or releasing anything.
   */
  async tryObserved(observed: WorktreeGcObservation, nowMs: number, principal: CommandPrincipal) {
    const policy = this.store.d.getSettings().worktreeGc
    if (
      policy.mode === 'off' ||
      policy.mode !== observed.mode ||
      policy.afterDays !== observed.afterDays
    ) {
      return { outcome: 'precondition' as const }
    }
    const row = this.store.rows.get(observed.issueId)
    if (!row) return { outcome: 'precondition' as const }
    if (row.worktreePath !== observed.worktreePath) return { outcome: 'precondition' as const }
    if (row.stage !== observed.stage || (row.closedReason ?? null) !== observed.closedReason) {
      return { outcome: 'precondition' as const }
    }
    if ((row.closedAt ?? null) !== observed.closedAt) return { outcome: 'precondition' as const }
    if (row.deletedAt || !this.store.isClosed(row)) return { outcome: 'precondition' as const }
    if (!this.isCandidate(row, nowMs, policy.afterDays)) return { outcome: 'not-due' as const }
    if (liveSessionsUsingWorktree(row.worktreePath, this.store.d.listSessions()).length > 0) {
      return { outcome: 'precondition' as const }
    }
    if (observed.mode === 'propose') {
      this.store.emitEvent('issue.worktree_gc_proposed', row.id, {
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

  private refuseRelease(row: IssueRow, worktreePath: string, reason: string) {
    this.store.emitEvent('issue.worktree_free_refused', row.id, {
      seq: row.seq,
      worktreePath,
      reason,
    })
    return { freed: false as const, reason }
  }
}
