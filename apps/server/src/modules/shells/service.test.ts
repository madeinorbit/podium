/**
 * DockShellService — returns-or-creates with claim-before-create (POD-4436).
 *
 * The load-bearing guard is the concurrency test: two overlapping `forWorktree`
 * calls must create exactly one shell. Two sequential calls pass against a
 * check-then-insert and prove nothing, so the stubbed create carries a delay
 * that forces the overlap — without the claim + lock, both calls spawn.
 */

import { asSessionId, asUserId, firstAdminMemberId, type SessionId, type UserId } from '@podium/model'
import { beforeEach, describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../../test-support/migrated-database'
import { createBunStoreExecutor } from '../../store/executor'
import { UserDockShellRepository } from '../../store/user-layout'
import { DockShellService, type DockShellSessionView } from './service'

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

  it('handleWorktreeFreed removes every user row and returns the sessions', async () => {
    const a = await service.forWorktree(ALICE, WT)
    const b = await service.forWorktree(BOB, `${WT}/`)
    const freed = await service.handleWorktreeFreed(WT)
    expect(new Set(freed)).toEqual(new Set([a.sessionId, b.sessionId]))
    expect(await service.get(ALICE, WT)).toBeUndefined()
    // The next open creates fresh.
    const again = await service.forWorktree(ALICE, WT)
    expect(again.created).toBe(true)
    expect(again.sessionId).not.toBe(a.sessionId)
  })
})

describe('DockShellService passthrough reads', () => {
  it('get and listForUser expose the mapping without creating', async () => {
    expect(await service.get(ALICE, WT)).toBeUndefined()
    const created = await service.forWorktree(ALICE, WT)
    expect(await service.get(ALICE, `${WT}/`)).toBe(created.sessionId)
    expect(await service.listForUser(ALICE)).toEqual({ [WT]: created.sessionId })
    expect(sessions.creates).toBe(1)
  })
})
