import { allIssueViewModels } from '../replica/issue-view-cache'
import type { IssueViewModel } from '../replica/issue-view-models'
// @vitest-environment happy-dom
// (the runtime resolves its router window from the DOM when none is given.)
/** Issue edits paint normalized rows and derived render models immediately,
 * survive offline reload, and retire only when their own truth arrives. */

import {
  asIssueId,
  asUserId,
  type IssueProjection,
  type IssueUserStateWire,
  issueUserStateRowId,
} from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import { asClientPrincipal } from '../principal'
import { createReplica, memoryStorage, type StorageApi } from '../replica/replica'
import type { SocketHub } from '../socket-transport'
import { placeholderProjection } from './optimism'
import { createClientRuntime } from './runtime'

const settle = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms))

class FakeHub {
  private handlers = new Map<string, Set<(...a: unknown[]) => void>>()
  on(kind: string, cb: (...a: unknown[]) => void): () => void {
    let set = this.handlers.get(kind)
    if (!set) {
      set = new Set()
      this.handlers.set(kind, set)
    }
    set.add(cb)
    return () => set.delete(cb)
  }
  connectionHealth() {
    return { status: 'down' as const, rttMs: null, since: 0 }
  }
  seedMetadata(): void {}
  connect(): void {}
  connectNow(): void {}
  dispose(): void {}
  setViewState(): void {}
  setVisible(): void {}
  sendSessionDraft(): void {}
  sendDraftEdit(): boolean {
    return true
  }
}

const POISON = (): Error =>
  Object.assign(new Error('refused'), { data: { code: 'BAD_REQUEST', httpStatus: 400 } })

/** Every issue command the outbox carries resolves unless a test says otherwise. */
// biome-ignore lint/suspicious/noExplicitAny: test fixture — shaped per-test, cast once at the boundary
function makeApi(): any {
  const ok = () => ({ mutate: vi.fn(async () => ({})) })
  return {
    sync: {
      changesSince: {
        query: async () => ({
          kind: 'snapshot',
          sessions: [],
          issues: [],
          conversations: [],
          diagnostics: [],
          cursor: 0,
        }),
      },
    },
    discovery: {
      refreshRepos: {
        mutate: vi.fn(async () => ({ repositories: [], diagnostics: [], machines: [] })),
      },
    },
    pins: {
      list: { query: async () => ({ panels: [], worktrees: [], repos: [] }) },
      set: { mutate: async () => ({ panels: [], worktrees: [], repos: [] }) },
    },
    superagent: {
      listThreads: { query: vi.fn(async () => [{ id: 'global', kind: 'global' as const }]) },
    },
    tabs: { listOrders: { query: async () => ({}) }, setOrder: { mutate: async () => ({}) } },
    settings: {
      get: {
        query: async () => ({
          sidebar: { repoSort: 'lastUsed', repoOrder: [], groupByRepo: false },
        }),
      },
      set: { mutate: async (s: unknown) => s },
    },
    sessions: { markRead: ok(), rename: ok() },
    issues: {
      markRead: ok(),
      markUnread: ok(),
      setTucked: ok(),
      update: ok(),
      archive: ok(),
      delete: ok(),
      close: ok(),
      defer: ok(),
      undefer: ok(),
      setLabels: ok(),
      setPlacement: ok(),
      restore: ok(),
    },
  }
}

const ME = 'operator'

function makeEngine(opts: { api?: unknown; storage?: StorageApi; principal?: string } = {}) {
  const errors: string[] = []
  const engine = createClientRuntime({
    principal: asClientPrincipal(asUserId(opts.principal ?? ME)),
    config: { httpOrigin: 'http://x', wsClientUrl: 'ws://x' },
    api: (opts.api ?? makeApi()) as PodiumClientApi,
    onFatalError: () => {},
    notices: { error: (m) => errors.push(m), info: () => {} },
    createReplicaFn: () => createReplica({ storage: opts.storage ?? memoryStorage() }),
    createHub: () => new FakeHub() as unknown as SocketHub,
    spawnConfirmGraceMs: 20,
  })
  return { engine, errors }
}

type Engine = ReturnType<typeof makeEngine>['engine']

/** Publish durable issue facts and this principal's personal markers. */
function publish(engine: Engine, rows: IssueViewModel[], userId = ME): void {
  engine.replica.batch(() => {
    engine.replica.applyChanges('issueProjections', rows.map(placeholderProjection), [])
    const upserts: IssueUserStateWire[] = []
    const removes: string[] = []
    for (const row of rows) {
      const state = userStateOf(row, userId)
      if (state.readAt === null && state.tuckedAt === null && !state.pinned) {
        removes.push(issueUserStateRowId(state.userId, state.entityId))
      } else upserts.push(state)
    }
    engine.replica.applyChanges('issueUserStates', upserts, removes)
  })
}

function userStateOf(row: IssueViewModel, userId = ME): IssueUserStateWire {
  return {
    userId: asUserId(userId),
    entityId: asIssueId(row.id),
    readAt: row.readAt ?? null,
    tuckedAt: row.tuckedAt ?? null,
    pinned: row.pinned === true,
  }
}

const ID = asIssueId('iss_1')
const T0 = '2026-07-01T00:00:00.000Z'

function baseIssue(over: Partial<IssueViewModel> = {}): IssueViewModel {
  return {
    id: ID,
    seq: 1,
    title: 'Before',
    description: 'old prose',
    stage: 'in_progress',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    blockedByNotes: [],
    priority: 2,
    type: 'task',
    pinned: false,
    needsHuman: false,
    labels: [],
    deps: [],
    dependents: [],
    comments: [],
    createdAt: T0,
    updatedAt: T0,
    archived: false,
    readAt: T0,
    intentOrigin: 'human',
    audience: 'human',
    isDraftVessel: false,
    ...over,
  } as unknown as IssueViewModel
}

const projectionOf = (engine: Engine): IssueProjection | undefined =>
  engine.getSnapshot().issueProjections.find((row) => row.id === ID)
const userRowOf = (engine: Engine, userId = ME): IssueUserStateWire | undefined =>
  engine.getSnapshot().issueUserStates.find((row) => row.entityId === ID && row.userId === userId)
const viewOf = (engine: Engine): IssueViewModel | undefined =>
  allIssueViewModels(engine.replica, engine.getSnapshot().issueProjections, engine.getSnapshot().issueUserStates).find((row) => row.id === ID)

interface Case {
  /** The edit, as the operator presses it. */
  press: (store: ReturnType<Engine['getSnapshot']>) => Promise<void>
  /** `api.issues.<command>` the outbox drains it through. */
  command: string
  /** Which normalized row the edit lands on. */
  home: 'issueProjections' | 'issueUserStates'
  /** Server truth before the press. */
  before?: Partial<IssueViewModel>
  /** The painted cell, read off the normalized row (projection or per-user). */
  cell: (row: Record<string, unknown> | undefined) => unknown
  /** The same fact, read through the render model. */
  viewCell: (row: IssueViewModel | undefined) => unknown
  /** True when a painted value is the edit's (clock-stamped cells vary). */
  painted: (value: unknown) => boolean
  /** Server truth after the command applied. */
  after: Partial<IssueViewModel>
}

const at = (key: string) => (row: Record<string, unknown> | undefined) => row?.[key]
const viewAt = (key: string) => (row: IssueViewModel | undefined) =>
  (row as unknown as Record<string, unknown> | undefined)?.[key]
const stamped = (value: unknown) => typeof value === 'string' && value !== T0
const is = (expected: unknown) => (value: unknown) =>
  JSON.stringify(value ?? null) === JSON.stringify(expected)

const CASES: Record<string, Case> = {
  'mark read': {
    press: (s) => s.markIssueRead(ID),
    command: 'markRead',
    home: 'issueUserStates',
    cell: at('readAt'),
    viewCell: viewAt('readAt'),
    painted: stamped,
    after: { readAt: '2026-07-09T00:00:00.000Z' },
  },
  'mark unread': {
    press: (s) => s.markIssueUnread(ID),
    command: 'markUnread',
    home: 'issueUserStates',
    // Unread on a row with no other marker: the server DELETES the row, so the
    // echo is an absent row — the "nothing set" the ledger folds absence as.
    cell: at('readAt'),
    viewCell: viewAt('readAt'),
    painted: is(null),
    after: { readAt: null },
  },
  tuck: {
    press: (s) => s.setIssueTucked(ID, true),
    command: 'setTucked',
    home: 'issueUserStates',
    cell: at('tuckedAt'),
    viewCell: viewAt('tuckedAt'),
    painted: stamped,
    after: { tuckedAt: '2026-07-09T00:00:00.000Z' },
  },
  pin: {
    press: (s) => s.updateIssue(ID, { pinned: true }),
    command: 'update',
    home: 'issueUserStates',
    cell: at('pinned'),
    viewCell: viewAt('pinned'),
    painted: is(true),
    after: { pinned: true },
  },
  rename: {
    press: (s) => s.updateIssue(ID, { title: 'After' }),
    command: 'update',
    home: 'issueProjections',
    cell: at('title'),
    viewCell: viewAt('title'),
    painted: is('After'),
    after: { title: 'After' },
  },
  'describe (a document on the normalized row)': {
    press: (s) => s.updateIssue(ID, { description: 'new prose' }),
    command: 'update',
    home: 'issueProjections',
    cell: (row) => (row?.description as { value?: string } | undefined)?.value,
    viewCell: viewAt('description'),
    painted: is('new prose'),
    after: { description: 'new prose' },
  },
  colour: {
    press: (s) => s.updateIssue(ID, { color: 'teal' }),
    command: 'update',
    home: 'issueProjections',
    cell: at('color'),
    viewCell: viewAt('color'),
    painted: is('teal'),
    after: { color: 'teal' },
  },
  archive: {
    press: (s) => s.archiveIssue(ID),
    command: 'archive',
    home: 'issueProjections',
    cell: at('archived'),
    viewCell: viewAt('archived'),
    painted: is(true),
    after: { archived: true },
  },
  delete: {
    press: (s) => s.deleteIssue(ID),
    command: 'delete',
    home: 'issueProjections',
    cell: at('deletedAt'),
    viewCell: viewAt('deletedAt'),
    painted: (v) => typeof v === 'string',
    after: { deletedAt: '2026-07-09T00:00:00.000Z' },
  },
  restore: {
    press: (s) => s.restoreIssue(ID),
    command: 'restore',
    home: 'issueProjections',
    before: { deletedAt: T0 },
    cell: at('deletedAt'),
    viewCell: viewAt('deletedAt'),
    painted: is(null),
    after: { deletedAt: undefined },
  },
  close: {
    press: (s) => s.closeIssue(ID, 'wontfix'),
    command: 'close',
    home: 'issueProjections',
    cell: (row) => [row?.stage, row?.closedReason],
    viewCell: (row) => [row?.stage, row?.closedReason],
    painted: is(['done', 'wontfix']),
    after: { stage: 'done', closedReason: 'wontfix' },
  },
  defer: {
    press: (s) => s.deferIssue(ID, '2099-01-01'),
    command: 'defer',
    home: 'issueProjections',
    cell: at('deferUntil'),
    viewCell: viewAt('deferUntil'),
    painted: is('2099-01-01'),
    after: { deferUntil: '2099-01-01' },
  },
  undefer: {
    press: (s) => s.undeferIssue(ID),
    command: 'undefer',
    home: 'issueProjections',
    before: { deferUntil: '2099-01-01' },
    cell: at('deferUntil'),
    viewCell: viewAt('deferUntil'),
    // Backdated, not cleared (issue #133).
    painted: (v) => typeof v === 'string' && Date.parse(v) < Date.now(),
    after: { deferUntil: '2020-01-01T00:00:00.000Z' },
  },
  labels: {
    press: (s) => s.setIssueLabels(ID, ['ui', 'bug']),
    command: 'setLabels',
    home: 'issueProjections',
    cell: at('labels'),
    viewCell: viewAt('labels'),
    painted: is(['bug', 'ui']),
    after: { labels: ['bug', 'ui'] },
  },
  placement: {
    press: (s) => s.setIssuePlacement(ID, 'mission', 'iss_origin'),
    command: 'setPlacement',
    home: 'issueProjections',
    cell: at('parentId'),
    viewCell: viewAt('parentId'),
    painted: is('iss_origin'),
    after: { parentId: asIssueId('iss_origin') },
  },
}

const homeRow = (engine: Engine, home: Case['home']): Record<string, unknown> | undefined =>
  (home === 'issueProjections' ? projectionOf(engine) : userRowOf(engine)) as
    | Record<string, unknown>
    | undefined

afterEach(() => {
  vi.restoreAllMocks()
})

describe('optimistic issue edits land on the normalized rows (POD-4969)', () => {
  for (const [name, c] of Object.entries(CASES)) {
    describe(name, () => {
      it('paints normalized truth and the render model on the press', async () => {
        const api = makeApi()
        // Hold the command in flight: what shows is the overlay, not truth.
        api.issues[c.command].mutate = vi.fn(() => new Promise(() => {}))
        const { engine } = makeEngine({ api })
        engine.start()
        await settle(40)
        publish(engine, [baseIssue(c.before)])
        await settle()
        expect(c.painted(c.cell(homeRow(engine, c.home)))).toBe(false)

        void c.press(engine.getSnapshot())
        // Synchronous with the press — nothing was awaited.
        expect(c.painted(c.cell(homeRow(engine, c.home)))).toBe(true)
        expect(c.painted(c.viewCell(viewOf(engine)))).toBe(true)
        // It stays painted while the command is in flight.
        await settle()
        expect(c.painted(c.cell(homeRow(engine, c.home)))).toBe(true)
        expect(c.painted(c.viewCell(viewOf(engine)))).toBe(true)
        engine.dispose()
      })

      it('rolls both back to server truth when the server refuses', async () => {
        const api = makeApi()
        api.issues[c.command].mutate = vi.fn(async () => {
          throw POISON()
        })
        const { engine } = makeEngine({ api })
        engine.start()
        await settle(40)
        publish(engine, [baseIssue(c.before)])
        await settle()
        const truth = c.cell(homeRow(engine, c.home))
        const legacyTruth = c.viewCell(viewOf(engine))

        await c.press(engine.getSnapshot()).catch(() => {})
        await settle(60)
        expect(api.issues[c.command].mutate).toHaveBeenCalled()
        expect(c.cell(homeRow(engine, c.home))).toEqual(truth)
        expect(c.viewCell(viewOf(engine))).toEqual(legacyTruth)
        expect(engine.outbox.awaiting()).toHaveLength(0)
        engine.dispose()
      })

      it('holds through resolution and settles on the echo', async () => {
        const api = makeApi()
        const { engine } = makeEngine({ api })
        engine.start()
        await settle(40)
        publish(engine, [baseIssue(c.before)])
        await settle()

        await c.press(engine.getSnapshot())
        await settle()
        expect(api.issues[c.command].mutate).toHaveBeenCalledTimes(1)
        // Resolved, truth not landed: the overlay waits on the normalized row.
        expect(engine.outbox.awaiting()).toHaveLength(1)
        expect(c.painted(c.cell(homeRow(engine, c.home)))).toBe(true)
        expect(c.painted(c.viewCell(viewOf(engine)))).toBe(true)

        const echoed = baseIssue({ ...c.before, ...c.after })
        publish(engine, [echoed])
        await settle()
        expect(engine.outbox.awaiting()).toHaveLength(0)
        // Server truth shows, on both records.
        expect(c.cell(homeRow(engine, c.home))).toEqual(
          c.cell(
            (c.home === 'issueProjections'
              ? placeholderProjection(echoed)
              : userStateOf(echoed).readAt === null &&
                  userStateOf(echoed).tuckedAt === null &&
                  !userStateOf(echoed).pinned
                ? undefined
                : userStateOf(echoed)) as Record<string, unknown> | undefined,
          ),
        )
        expect(c.viewCell(viewOf(engine))).toEqual(c.viewCell(echoed))
        engine.dispose()
      })
    })
  }

  it('a mixed update holds until BOTH rows it landed on are covered', async () => {
    const api = makeApi()
    const { engine } = makeEngine({ api })
    engine.start()
    await settle(40)
    publish(engine, [baseIssue()])
    await settle()

    await engine.getSnapshot().updateIssue(ID, { title: 'After', pinned: true })
    await settle()
    expect(projectionOf(engine)?.title).toBe('After')
    expect(userRowOf(engine)?.pinned).toBe(true)
    expect(engine.outbox.awaiting()).toHaveLength(1)

    // Only the normalized issue row has caught up: the pin keeps painting and
    // the durable entry stays until its other half is covered too.
    engine.replica.applyChanges(
      'issueProjections',
      [placeholderProjection(baseIssue({ title: 'After' }))],
      [],
    )
    await settle()
    expect(userRowOf(engine)?.pinned).toBe(true)
    expect(viewOf(engine)?.pinned).toBe(true)
    expect(engine.outbox.awaiting()).toHaveLength(1)

    publish(engine, [baseIssue({ title: 'After', pinned: true })])
    await settle()
    expect(engine.outbox.awaiting()).toHaveLength(0)
    engine.dispose()
  })

  it('a personal-marker echo settles the edit without another issue publication', async () => {
    const { engine } = makeEngine()
    engine.start()
    await settle(40)
    publish(engine, [baseIssue({ readAt: null })])
    await settle()
    const projection = projectionOf(engine)
    await engine.getSnapshot().markIssueRead(ID)
    await settle()
    expect(viewOf(engine)?.readAt).toEqual(expect.any(String))
    expect(engine.outbox.awaiting()).toHaveLength(1)
    engine.replica.applyChanges('issueUserStates', [userStateOf(baseIssue({ readAt: '2026-07-09T00:00:00.000Z' }))], [])
    await settle()
    expect(viewOf(engine)?.readAt).toBe('2026-07-09T00:00:00.000Z')
    expect(projectionOf(engine)).toBe(projection)
    expect(engine.outbox.awaiting()).toHaveLength(0)
    engine.dispose()
  })

  it('a queued edit survives a reload and paints the normalized row in the FIRST snapshot', async () => {
    const storage = memoryStorage()
    const api = makeApi()
    api.issues.setTucked.mutate = vi.fn(async () => {
      throw new Error('network down') // not a refusal: the entry stays queued
    })
    const first = makeEngine({ api, storage })
    first.engine.start()
    await settle(40)
    publish(first.engine, [baseIssue()])
    await settle()
    await first.engine.getSnapshot().setIssueTucked(ID, true)
    await settle()
    expect(first.engine.outbox.size()).toBe(1)
    first.engine.dispose()

    const second = makeEngine({ api, storage })
    // Before start(): the hydrate-first snapshot already carries the paint.
    expect(userRowOf(second.engine)?.tuckedAt).toEqual(expect.any(String))
    expect(viewOf(second.engine)?.tuckedAt).toEqual(expect.any(String))
    second.engine.dispose()
  })

  it('an issue that leaves the slice takes its per-user overlay with it (evict is not "nothing set")', async () => {
    const api = makeApi()
    const { engine } = makeEngine({ api })
    engine.start()
    await settle(40)
    publish(engine, [baseIssue({ readAt: null })])
    await settle()
    await engine.getSnapshot().markIssueRead(ID)
    await settle()
    expect(engine.outbox.awaiting()).toHaveLength(1)
    expect(userRowOf(engine)?.readAt).toEqual(expect.any(String))

    // Evicted from this principal's view: every record of the issue leaves.
    engine.replica.batch(() => {
      engine.replica.applyChanges('issueProjections', [], [ID])
    })
    await settle()
    expect(engine.outbox.awaiting()).toHaveLength(0)
    expect(userRowOf(engine)).toBeUndefined()
    engine.dispose()
  })
})

describe('the spawn placeholder (POD-4969)', () => {
  const target = { path: '/w', repoPath: '/w' }

  it("inserts only the normalized row and this principal's markers", async () => {
    const api = makeApi()
    let release!: () => void
    api.sessions.create = {
      mutate: vi.fn(
        () =>
          new Promise<void>((r) => {
            release = r
          }),
      ),
    }
    const { engine } = makeEngine({ api })
    engine.start()
    await settle(40)

    const made = engine.getSnapshot().spawnDraftAgent({ target, agentKind: 'claude-code' })
    const projection = engine.getSnapshot().issueProjections.find((row) => row.id === made.issueId)
    expect(projection).toMatchObject({
      id: made.issueId,
      isDraftVessel: true,
      description: { value: '' },
    })
    expect(engine.getSnapshot().issueUserStates).toContainEqual(
      expect.objectContaining({ userId: ME, entityId: made.issueId, readAt: expect.any(String) }),
    )
    expect(allIssueViewModels(engine.replica, engine.getSnapshot().issueProjections, engine.getSnapshot().issueUserStates).some((row) => row.id === made.issueId)).toBe(true)

    // Truth for the issue lands: no duplicate row, and the per-user placeholder
    // retires with the issue's (the server writes no marker on create).
    if (projection === undefined) throw new Error('missing placeholder')
    engine.replica.batch(() => {
      engine.replica.applyChanges('issueProjections', [{ ...projection, seq: 7 }], [])
    })
    await settle()
    expect(engine.getSnapshot().issueProjections.filter((row) => row.id === made.issueId)).toEqual([
      expect.objectContaining({ seq: 7 }),
    ])
    expect(engine.getSnapshot().issueUserStates.some((row) => row.entityId === made.issueId)).toBe(
      false,
    )
    release()
    engine.dispose()
  })

  it('a failed create takes the normalized placeholder and its markers away too', async () => {
    const api = makeApi()
    api.sessions.create = {
      mutate: vi.fn(async () => {
        throw new Error('spawn refused')
      }),
    }
    const { engine, errors } = makeEngine({ api })
    engine.start()
    await settle(40)
    const made = engine.getSnapshot().spawnDraftAgent({ target, agentKind: 'claude-code' })
    expect(await made.settled).toBe(false)
    expect(engine.getSnapshot().issueProjections.some((row) => row.id === made.issueId)).toBe(false)
    expect(engine.getSnapshot().issueUserStates.some((row) => row.entityId === made.issueId)).toBe(
      false,
    )
    expect(allIssueViewModels(engine.replica, engine.getSnapshot().issueProjections, engine.getSnapshot().issueUserStates).some((row) => row.id === made.issueId)).toBe(false)
    expect(errors.some((m) => m.includes('spawn refused'))).toBe(true)
    engine.dispose()
  })
})

describe('principal isolation of per-user overlays (POD-4969)', () => {
  it("paints only this principal's row, never another user's row for the same issue", async () => {
    const api = makeApi()
    api.issues.setTucked.mutate = vi.fn(() => new Promise(() => {}))
    api.issues.markRead.mutate = vi.fn(() => new Promise(() => {}))
    const { engine } = makeEngine({ api })
    engine.start()
    await settle(40)
    publish(engine, [baseIssue({ readAt: null })])
    // A row that is not this principal's, for the same issue.
    const theirs = userStateOf(baseIssue({ readAt: T0 }), 'someone-else')
    engine.replica.applyChanges('issueUserStates', [theirs], [])
    await settle()
    const before = engine.getSnapshot().issueUserStates.find((row) => row.userId === 'someone-else')

    void engine.getSnapshot().setIssueTucked(ID, true)
    void engine.getSnapshot().markIssueRead(ID)
    await settle()
    const mine = userRowOf(engine)
    expect(mine?.tuckedAt).toEqual(expect.any(String))
    expect(mine?.readAt).toEqual(expect.any(String))
    const after = engine.getSnapshot().issueUserStates.find((row) => row.userId === 'someone-else')
    // Untouched: the same object, the same cells.
    expect(after).toBe(before)
    expect(after).toMatchObject(theirs)
    expect(engine.getSnapshot().issueUserStates.filter((row) => row.entityId === ID)).toHaveLength(
      2,
    )
    engine.dispose()
  })

  it("another principal's runtime over the same rows paints nothing of this one's", async () => {
    const apiA = makeApi()
    apiA.issues.setTucked.mutate = vi.fn(() => new Promise(() => {}))
    const a = makeEngine({ api: apiA, principal: 'alice' })
    const b = makeEngine({ api: makeApi(), principal: 'bob' })
    for (const { engine } of [a, b]) {
      engine.start()
    }
    await settle(40)
    for (const { engine } of [a, b]) publish(engine, [baseIssue({ readAt: null })], 'alice')
    await settle()

    void a.engine.getSnapshot().setIssueTucked(ID, true)
    await settle()
    expect(userRowOf(a.engine, 'alice')?.tuckedAt).toEqual(expect.any(String))
    // Bob's view of Alice's row is whatever the server says, and Bob has no row.
    expect(b.engine.getSnapshot().issueUserStates.filter((row) => row.entityId === ID)).toEqual([])
    expect(allIssueViewModels(b.engine.replica, b.engine.getSnapshot().issueProjections, b.engine.getSnapshot().issueUserStates).find((row) => row.id === ID)?.tuckedAt ?? null).toBeNull()
    a.engine.dispose()
    b.engine.dispose()
  })
})
