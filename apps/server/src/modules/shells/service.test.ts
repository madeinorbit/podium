/**
 * DockShellService — returns-or-creates with claim-before-create (POD-4436).
 *
 * The load-bearing guard is the concurrency test: two overlapping `forWorktree`
 * calls must create exactly one shell. Two sequential calls pass against a
 * check-then-insert and prove nothing, so the stubbed create carries a delay
 * that forces the overlap — without the claim + lock, both calls spawn.
 */

import { asSessionId, asUserId, firstAdminMemberId, type SessionId, type UserId } from '@podium/model'
import { asIssueId, type IssueId } from '@podium/model'
import { beforeEach, describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../../test-support/migrated-database'
import { createBunStoreExecutor } from '../../store/executor'
import { UserDockShellRepository } from '../../store/user-layout'
import {
  DockShellService,
  type DockShellSessionView,
  resolveDockShellOwner,
  resolveSampledShellOwners,
  resolveShellOwningIssue,
} from './service'

const ALICE: UserId = firstAdminMemberId()
const BOB: UserId = asUserId('user:bob')
const WT = '/repo/.worktrees/a'

function liveShell(sessionId: SessionId): DockShellSessionView {
  return { sessionId, agentKind: 'shell', archived: false, status: 'live' }
}

interface StubSessions {
  rows: Map<SessionId, DockShellSessionView>
  creates: number
  archived: SessionId[]
  createDelayMs: number
  failNextCreate?: Error
  sessionById(sessionId: SessionId): Promise<DockShellSessionView | undefined>
  createShell(input: {
    sessionId: SessionId
    cwd: string
    ownerUserId: UserId
  }): Promise<{ sessionId: SessionId }>
  archiveSession(sessionId: SessionId): Promise<void>
}

function makeStub(opts: { createDelayMs?: number } = {}): StubSessions {
  const stub: StubSessions = {
    rows: new Map(),
    creates: 0,
    archived: [],
    createDelayMs: opts.createDelayMs ?? 0,
    async sessionById(sessionId) {
      return this.rows.get(sessionId)
    },
    async createShell(input) {
      this.creates += 1
      if (this.failNextCreate) {
        const error = this.failNextCreate
        this.failNextCreate = undefined
        throw error
      }
      if (this.createDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.createDelayMs))
      }
      this.rows.set(input.sessionId, liveShell(input.sessionId))
      return { sessionId: input.sessionId }
    },
    async archiveSession(sessionId) {
      this.archived.push(sessionId)
      const row = this.rows.get(sessionId)
      if (row) this.rows.set(sessionId, { ...row, archived: true })
    },
  }
  return stub
}

let shells: UserDockShellRepository
let sessions: StubSessions
let service: DockShellService

beforeEach(() => {
  const db = openMigratedTestDatabase()
  const stage = createBunStoreExecutor({ database: db }).queries
  if (!stage) throw new Error('the test database is not bun-backed')
  shells = new UserDockShellRepository(stage)
  sessions = makeStub()
  service = new DockShellService({ dockShells: shells, sessions })
})

describe('DockShellService.forWorktree', () => {
  it('creates once, then attaches sequential calls to the same row', async () => {
    const first = await service.forWorktree(ALICE, WT)
    expect(first.created).toBe(true)
    expect(sessions.creates).toBe(1)

    const second = await service.forWorktree(ALICE, WT)
    expect(second.created).toBe(false)
    expect(second.sessionId).toBe(first.sessionId)
    expect(sessions.creates).toBe(1)
  })

  it('concurrent calls create exactly one shell', async () => {
    sessions.createDelayMs = 25
    const [a, b] = await Promise.all([
      service.forWorktree(ALICE, WT),
      service.forWorktree(ALICE, WT),
    ])
    expect(a.sessionId).toBe(b.sessionId)
    expect(sessions.creates).toBe(1)
    expect(await shells.get(ALICE, WT)).toBe(a.sessionId)
  })

  it('trailing-slash spellings share one row and one shell', async () => {
    const a = await service.forWorktree(ALICE, `${WT}/`)
    const b = await service.forWorktree(ALICE, WT)
    expect(b.sessionId).toBe(a.sessionId)
    expect(sessions.creates).toBe(1)
  })

  it('different users get different shells for the same worktree', async () => {
    const a = await service.forWorktree(ALICE, WT)
    const b = await service.forWorktree(BOB, WT)
    expect(b.sessionId).not.toBe(a.sessionId)
    expect(sessions.creates).toBe(2)
  })

  it('a dead shell is archived and replaced', async () => {
    const first = await service.forWorktree(ALICE, WT)
    sessions.rows.set(first.sessionId, {
      sessionId: first.sessionId,
      agentKind: 'shell',
      archived: false,
      status: 'exited',
    })
    const second = await service.forWorktree(ALICE, WT)
    expect(second.created).toBe(true)
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(sessions.archived).toContain(first.sessionId)
    expect(await shells.get(ALICE, WT)).toBe(second.sessionId)
  })

  it('a missing session row is replaced without archiving', async () => {
    const first = await service.forWorktree(ALICE, WT)
    sessions.rows.delete(first.sessionId)
    const second = await service.forWorktree(ALICE, WT)
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(sessions.archived).not.toContain(first.sessionId)
  })

  it('a parked (hibernated) shell is returned in place, never replaced', async () => {
    const first = await service.forWorktree(ALICE, WT)
    sessions.rows.set(first.sessionId, {
      sessionId: first.sessionId,
      agentKind: 'shell',
      archived: false,
      status: 'hibernated',
    })
    const second = await service.forWorktree(ALICE, WT)
    expect(second.sessionId).toBe(first.sessionId)
    expect(second.created).toBe(false)
    expect(sessions.creates).toBe(1)
  })

  it('a failed create releases the claim so the next call retries', async () => {
    sessions.failNextCreate = new Error('spawn refused')
    await expect(service.forWorktree(ALICE, WT)).rejects.toThrow('spawn refused')
    expect(await shells.get(ALICE, WT)).toBeUndefined()
    const retry = await service.forWorktree(ALICE, WT)
    expect(retry.created).toBe(true)
    expect(await shells.get(ALICE, WT)).toBe(retry.sessionId)
  })

  it('refuses a relative path without creating', async () => {
    await expect(service.forWorktree(ALICE, 'relative/path')).rejects.toThrow(
      /not an absolute worktree path/,
    )
    expect(sessions.creates).toBe(0)
  })

  it('removing the worktree mapping lets the next open create fresh', async () => {
    const a = await service.forWorktree(ALICE, WT)
    const b = await service.forWorktree(BOB, `${WT}/`)
    const freed = await shells.removeByWorktree(WT)
    expect(new Set(freed)).toEqual(new Set([a.sessionId, b.sessionId]))
    expect(await shells.get(ALICE, WT)).toBeUndefined()
    // The next open creates fresh.
    const again = await service.forWorktree(ALICE, WT)
    expect(again.created).toBe(true)
    expect(again.sessionId).not.toBe(a.sessionId)
  })
})

describe('the in-flight claim window (review finding)', () => {
  const WINNER = asSessionId('44444444-4444-4444-8444-444444444444')

  it('a loser that re-reads before the winner creates replaces the row', async () => {
    // Two service instances over one store = two server processes: no shared
    // mutex, so the loser's re-read lands inside the winner's claim→create
    // window. The winner's ROW exists but its SESSION does not, the loser
    // reads that as dead and takes the replacement branch.
    const winnerClaimed = await shells.tryClaim(ALICE, WT, WINNER, new Date().toISOString())
    expect(winnerClaimed).toBe(true)

    const otherSessions = makeStub()
    const other = new DockShellService({ dockShells: shells, sessions: otherSessions })
    const loser = await other.forWorktree(ALICE, WT)

    expect(loser.created).toBe(true)
    expect(loser.sessionId).not.toBe(WINNER)
    expect(otherSessions.creates).toBe(1)
    expect(sessions.creates).toBe(0)
    expect(await shells.get(ALICE, WT)).toBe(loser.sessionId)

    // The winner finishing late does not move the mapping back: its session
    // is orphaned, the replacer's row stands. That is the documented cost of
    // leaving the cross-process window open.
    sessions.rows.set(WINNER, liveShell(WINNER))
    expect(await shells.get(ALICE, WT)).toBe(loser.sessionId)
  })
})

describe('resolveDockShellOwner (step 3)', () => {
  const SHELL = asSessionId('33333333-3333-4333-8333-333333333333')
  const ISSUE_A = asIssueId('iss_aaaaaaaaaaaaaaaaaaaaaaaaaa')
  const ISSUE_B = asIssueId('iss_bbbbbbbbbbbbbbbbbbbbbbbbbb')

  function ownerDeps(opts: {
    rows?: Array<{ userId: UserId; worktreeKey: string }>
    issueForKey?: IssueId | null
  } = {}) {
    return {
      worktreeForSession: async () => opts.rows ?? [],
      issueForCwd: async () => opts.issueForKey ?? null,
    }
  }

  const shell = (overrides: { issueId?: IssueId | null } = {}) => ({
    sessionId: SHELL,
    agentKind: 'shell' as const,
    ...(overrides.issueId ? { issueId: overrides.issueId } : {}),
  })

  it('a mapped shell resolves its worktree key and owning issue exactly', async () => {
    const owner = await resolveDockShellOwner(
      ownerDeps({ rows: [{ userId: ALICE, worktreeKey: WT }], issueForKey: ISSUE_A }),
      shell({ issueId: ISSUE_B }),
    )
    // The mapping wins over the bound issue: the key is exact, the binding
    // may be stale.
    expect(owner).toEqual({ worktreeKey: WT, issueId: ISSUE_A })
  })

  it('an unmapped shell answers undefined (caller keeps its old answer)', async () => {
    expect(await resolveDockShellOwner(ownerDeps(), shell({ issueId: ISSUE_B }))).toBeUndefined()
  })

  it('a non-shell never reads the mapping', async () => {
    let reads = 0
    const owner = await resolveDockShellOwner(
      {
        worktreeForSession: async () => {
          reads += 1
          return [{ userId: ALICE, worktreeKey: WT }]
        },
        issueForCwd: async () => ISSUE_A,
      },
      { sessionId: SHELL, agentKind: 'claude-code' },
    )
    expect(owner).toBeUndefined()
    expect(reads).toBe(0)
  })

  it('a mapped shell whose worktree has no issue falls back to its bound issue', async () => {
    const owner = await resolveDockShellOwner(
      ownerDeps({ rows: [{ userId: ALICE, worktreeKey: WT }], issueForKey: null }),
      shell({ issueId: ISSUE_B }),
    )
    expect(owner).toEqual({ worktreeKey: WT, issueId: ISSUE_B })
  })

  it('a mapped shell with no issue anywhere still names its worktree', async () => {
    const owner = await resolveDockShellOwner(
      ownerDeps({ rows: [{ userId: ALICE, worktreeKey: WT }], issueForKey: null }),
      shell(),
    )
    expect(owner).toEqual({ worktreeKey: WT })
  })
})

describe('resolveSampledShellOwners (POD-4627: one host sample, many shells)', () => {
  // A sample holds EVERY stored session — boot installs all rows, hibernated
  // and exited ones included — and the reaper reads only the live ones.
  // Per-shell reads of the mapping were one statement per shell per call,
  // ~5,000 a sample on a real 1,000-shell database.
  const ISSUE_OPEN = asIssueId('iss_aaaaaaaaaaaaaaaaaaaaaaaaaa')
  const ISSUE_BOUND = asIssueId('iss_bbbbbbbbbbbbbbbbbbbbbbbbbb')
  const shellId = (i: number) => asSessionId(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)

  async function seed(live: number, dormant: number) {
    const db = openMigratedTestDatabase()
    const stage = createBunStoreExecutor({ database: db }).queries
    if (!stage) throw new Error('the test database is not bun-backed')
    const repo = new UserDockShellRepository(stage)
    const sessions: Array<{ sessionId: SessionId; agentKind: string; status: string; issueId?: IssueId }> = []
    for (let i = 0; i < live + dormant; i += 1) {
      const sessionId = shellId(i)
      // Every third shell is mapped to a worktree an issue owns, every third
      // bound-only, the rest neither — all three precedence arms per sample.
      if (i % 3 === 0) await repo.set(ALICE, `/repo/.worktrees/owned-${i}`, sessionId, '2026-09-23T00:00:00.000Z')
      if (i % 3 === 1) await repo.set(ALICE, `/repo/.worktrees/orphan-${i}`, sessionId, '2026-09-23T00:00:00.000Z')
      sessions.push({
        sessionId,
        agentKind: 'shell',
        status: i < live ? 'live' : i % 2 === 0 ? 'hibernated' : 'exited',
        ...(i % 3 !== 2 ? { issueId: ISSUE_BOUND } : {}),
      })
    }
    sessions.push({ sessionId: shellId(9_999), agentKind: 'claude-code', status: 'live', issueId: ISSUE_BOUND })
    let reads = 0
    const readIds: SessionId[] = []
    const issueForCwd = async (cwd: string) => (cwd.includes('/owned-') ? ISSUE_OPEN : null)
    // Both store shapes counted, so the per-shell arm and the batched arm are
    // measured by the same instrument.
    const deps = {
      worktreeForSession: async (id: SessionId) => {
        reads += 1
        readIds.push(id)
        return await repo.worktreeForSession(id)
      },
      worktreesForSessions: async (ids: readonly SessionId[]) => {
        reads += 1
        readIds.push(...ids)
        return await repo.worktreesForSessions(ids)
      },
      issueForCwd,
    }
    const reference = { worktreeForSession: (id: SessionId) => repo.worktreeForSession(id), issueForCwd }
    return { deps, sessions, reference, reads: () => reads, readIds: () => readIds }
  }

  it.each([10, 400])('reads the mapping a constant number of times for %i live shells', async (live) => {
    const world = await seed(live, 3 * live)
    await resolveSampledShellOwners(world.deps, world.sessions)
    expect(world.reads()).toBe(1)
  })

  it('never reads a hibernated or exited shell', async () => {
    const world = await seed(5, 20)
    await resolveSampledShellOwners(world.deps, world.sessions)
    const live = new Set(world.sessions.filter((s) => s.status === 'live').map((s) => s.sessionId))
    expect(world.readIds().filter((id) => !live.has(id))).toEqual([])
  })

  it('answers every live shell exactly as the one resolver does', async () => {
    const world = await seed(30, 30)
    const owners = await resolveSampledShellOwners(world.deps, world.sessions)
    const expected = new Map<SessionId, IssueId>()
    for (const s of world.sessions) {
      if (s.agentKind !== 'shell' || s.status !== 'live') continue
      const owner = await resolveShellOwningIssue(world.reference, s)
      if (owner) expected.set(s.sessionId, owner)
    }
    expect(owners).toEqual(expected)
    // All three arms appear: mapped-and-owned, mapped-orphan (bound
    // fallback), and unmapped-unbound (absent).
    expect([...owners.values()]).toContain(ISSUE_OPEN)
    expect([...owners.values()]).toContain(ISSUE_BOUND)
    expect(owners.size).toBeLessThan(30)
  })
})
