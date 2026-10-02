// @vitest-environment happy-dom
// (the runtime resolves its router window from the DOM when none is given.)
/**
 * POD-4974 S3 — optimistic read and snooze edits on a session land on this
 * principal's PER-USER row (`sessionUserStates`), never on the shared session
 * row. The session view joins that row (`session-values.ts`), so every reader
 * sees the edit, and `unread` is derived from the painted cursor.
 *
 * Each overlay kind is driven through the real runtime at the four moments
 * the plan names: the PRESS paints the per-user row; a REFUSAL rolls it back;
 * resolution HOLDS until the per-user echo (a republished session row alone
 * does not settle it); and a persisted entry REPAINTS after a reload. The
 * per-user row is read the way the pool sidebar reads it: the replica's row
 * folded with the ledger's overlays for that row (`pendingOverlaysByRow`).
 *
 * The server is modelled the way it publishes since S1: one commit carries the
 * session row (whose legacy cells still hold the admin's values) and the
 * actor's per-user row, cleared cells written out rather than removed.
 */

import {
  asMutationId,
  asSessionId,
  asUserId,
  type SessionMeta,
  type SessionUserStateWire,
  sessionUserStateRowId,
} from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { OutboxEntry } from '../outbox'
import { asClientPrincipal } from '../principal'
import { createReplica, memoryStorage, type StorageApi } from '../replica/replica'
import type { SocketHub } from '../socket-transport'
import { foldRowOverlays, rowFingerprint } from './overlay'
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
    sessions: { markRead: ok(), markUnread: ok(), rename: ok() },
    snoozes: { set: ok(), clear: ok() },
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

const S = asSessionId('s1')
const T0 = '2026-07-01T00:00:00.000Z'
const ACTIVE = '2026-07-02T00:00:00.000Z'
const LATER = '2099-01-01T00:00:00.000Z'
/** The server's own clock when it applies the command. */
const SERVER_NOW = '2026-07-09T00:00:00.000Z'

/** The session row. Its legacy per-user cells are the ADMIN's values, which a
 *  per-user row overrides for whoever has one. */
function sessionRow(over: Partial<Record<string, unknown>> = {}): SessionMeta {
  return {
    sessionId: S,
    agentKind: 'claude-code',
    title: 's1',
    cwd: '/w',
    status: 'live',
    controllerId: 'c0',
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 1,
    createdAt: T0,
    lastActiveAt: ACTIVE,
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: true,
    ...over,
  } as unknown as SessionMeta
}

function userRow(over: Partial<SessionUserStateWire> = {}, userId = ME): SessionUserStateWire {
  return { userId: asUserId(userId), sessionId: S, readAt: null, ...over }
}

/** One server commit: the session row and, when given, the per-user row. */
function publish(
  engine: Engine,
  rows: { session?: SessionMeta; user?: SessionUserStateWire },
): void {
  engine.replica.batch(() => {
    if (rows.session) engine.replica.applyChanges('sessions', [rows.session], [])
    if (rows.user) engine.replica.applyChanges('sessionUserStates', [rows.user], [])
  })
}

/** This principal's per-user row as the per-row reader sees it: the replica's
 *  row folded with the ledger's pending overlays for it. */
function homeRow(engine: Engine, userId = ME): SessionUserStateWire | undefined {
  const truth = engine.replica
    .rows('sessionUserStates')
    .find((row) => row.userId === userId && row.sessionId === S)
  return foldRowOverlays(truth, engine.pendingOverlaysByRow('sessionUserStates').get(S) ?? [])
}

const viewOf = (engine: Engine) => engine.getSnapshot().sessions.find((s) => s.sessionId === S)

interface Case {
  press: (store: ReturnType<Engine['getSnapshot']>) => Promise<void>
  /** `api.<router>.<command>` the outbox drains it through. */
  router: 'sessions' | 'snoozes'
  command: string
  /** This principal's per-user row before the press. */
  before: SessionUserStateWire
  /** True when the per-user row shows the edit. */
  painted: (row: SessionUserStateWire | undefined) => boolean
  /** True when the joined session view shows the edit. */
  shown: (view: ReturnType<typeof viewOf>) => boolean
  /** The per-user row the server echoes after applying the command. */
  after: SessionUserStateWire
}

const stampedPast = (value: unknown) => typeof value === 'string' && value !== T0
const CASES: Record<string, Case> = {
  'mark read': {
    press: (s) => s.markSessionRead(S),
    router: 'sessions',
    command: 'markRead',
    before: userRow({ readAt: T0 }),
    painted: (row) => stampedPast(row?.readAt),
    shown: (view) => view?.unread === false && stampedPast(view.readAt),
    after: userRow({ readAt: SERVER_NOW }),
  },
  'mark unread': {
    press: (s) => s.markSessionUnread(S),
    router: 'sessions',
    command: 'markUnread',
    before: userRow({ readAt: SERVER_NOW }),
    painted: (row) => row !== undefined && row.readAt === null,
    shown: (view) => view?.unread === true && view.readAt === null,
    after: userRow({ readAt: null }),
  },
  'snooze until a time': {
    press: (s) => s.setSnooze(S, LATER),
    router: 'snoozes',
    command: 'set',
    before: userRow({ readAt: SERVER_NOW }),
    painted: (row) => row?.snoozedUntil === LATER,
    shown: (view) => view?.snoozedUntil === LATER,
    after: userRow({ readAt: SERVER_NOW, snoozedUntil: LATER }),
  },
  'snooze until the next message': {
    press: (s) => s.setSnooze(S, null),
    router: 'snoozes',
    command: 'set',
    before: userRow({ readAt: SERVER_NOW }),
    painted: (row) => row !== undefined && row.snoozedUntil === null,
    shown: (view) => view !== undefined && view.snoozedUntil === null,
    after: userRow({ readAt: SERVER_NOW, snoozedUntil: null }),
  },
  'clear snooze': {
    press: (s) => s.clearSnooze(S),
    router: 'snoozes',
    command: 'clear',
    before: userRow({ readAt: SERVER_NOW, snoozedUntil: LATER }),
    painted: (row) => row !== undefined && row.snoozedUntil === undefined,
    shown: (view) => view !== undefined && view.snoozedUntil === undefined,
    after: userRow({ readAt: SERVER_NOW }),
  },
}

afterEach(() => {
  vi.restoreAllMocks()
})

async function booted(api = makeApi(), storage?: StorageApi) {
  const made = makeEngine({ api, ...(storage ? { storage } : {}) })
  made.engine.start()
  await settle(40)
  return made
}

describe('optimistic session read and snooze edits land on the per-user row (POD-4974 S3)', () => {
  for (const [name, c] of Object.entries(CASES)) {
    describe(name, () => {
      it('the press paints the per-user row, the view joins it, and the session row is not a target', async () => {
        const api = makeApi()
        api[c.router][c.command].mutate = vi.fn(() => new Promise(() => {}))
        const { engine } = await booted(api)
        publish(engine, { session: sessionRow(), user: c.before })
        await settle()
        expect(c.painted(homeRow(engine))).toBe(false)
        expect(c.shown(viewOf(engine))).toBe(false)

        void c.press(engine.getSnapshot())
        // Synchronous with the press — nothing was awaited.
        expect(c.painted(homeRow(engine))).toBe(true)
        expect(c.shown(viewOf(engine))).toBe(true)
        expect(engine.pendingOverlaysByRow('sessions').has(S)).toBe(false)
        await settle()
        expect(c.painted(homeRow(engine))).toBe(true)
        expect(c.shown(viewOf(engine))).toBe(true)
        engine.dispose()
      })

      it('a refusal rolls the per-user row and the view back to server truth', async () => {
        const api = makeApi()
        let refuse!: () => void
        api[c.router][c.command].mutate = vi.fn(
          () =>
            new Promise((_, reject) => {
              refuse = () => reject(POISON())
            }),
        )
        const { engine } = await booted(api)
        publish(engine, { session: sessionRow(), user: c.before })
        await settle()

        const pressed = c.press(engine.getSnapshot()).catch(() => {})
        await settle()
        expect(c.painted(homeRow(engine))).toBe(true)
        refuse()
        await pressed
        await settle(60)
        expect(homeRow(engine)).toEqual(c.before)
        expect(c.shown(viewOf(engine))).toBe(false)
        expect(engine.outbox.awaiting()).toHaveLength(0)
        engine.dispose()
      })

      it('holds through resolution until the PER-USER echo, not the session row', async () => {
        const { engine } = await booted()
        publish(engine, { session: sessionRow(), user: c.before })
        await settle()
        await c.press(engine.getSnapshot())
        await settle()
        expect(engine.outbox.awaiting()).toHaveLength(1)
        expect(c.painted(homeRow(engine))).toBe(true)

        // The session row is republished (activity, the admin's legacy cells
        // unchanged): not this principal's state, so nothing settles.
        publish(engine, { session: sessionRow({ title: 'renamed elsewhere' }) })
        await settle()
        expect(engine.outbox.awaiting()).toHaveLength(1)
        expect(c.painted(homeRow(engine))).toBe(true)
        expect(c.shown(viewOf(engine))).toBe(true)

        publish(engine, { session: sessionRow({ title: 'renamed elsewhere' }), user: c.after })
        await settle()
        expect(engine.outbox.awaiting()).toHaveLength(0)
        expect(engine.pendingOverlaysByRow('sessionUserStates').has(S)).toBe(false)
        expect(homeRow(engine)).toEqual(c.after)
        expect(c.shown(viewOf(engine))).toBe(true)
        engine.dispose()
      })

      it('a queued entry survives a reload and paints the per-user row in the FIRST snapshot', async () => {
        const storage = memoryStorage()
        const api = makeApi()
        api[c.router][c.command].mutate = vi.fn(async () => {
          throw new Error('network down') // not a refusal: the entry stays queued
        })
        const first = await booted(api, storage)
        publish(first.engine, { session: sessionRow(), user: c.before })
        await settle()
        await c.press(first.engine.getSnapshot())
        await settle()
        expect(first.engine.outbox.size()).toBe(1)
        first.engine.dispose()

        const second = makeEngine({ api, storage })
        // Before start(): the hydrate-first snapshot already carries the paint.
        expect(c.painted(homeRow(second.engine))).toBe(true)
        expect(c.shown(viewOf(second.engine))).toBe(true)
        second.engine.dispose()
      })
    })
  }
})

/**
 * S3b — an entry an OLDER build left in the durable awaiting-truth stage. Its
 * baseline is a fingerprint of the SESSION row (the overlay's old target), and a
 * reloaded kernel-queue entry has no baseline at all. Both must repaint on the
 * per-user row and retire on its echo.
 */
describe('entries persisted before S3 still cover and retire after reload', () => {
  const legacyBaseline = rowFingerprint(sessionRow({ readAt: T0, unread: true }))
  const kinds: { kind: string; input: object; case: Case }[] = [
    { kind: 'sessionMarkRead', input: { sessionId: S }, case: CASES['mark read']! },
    { kind: 'sessionMarkUnread', input: { sessionId: S }, case: CASES['mark unread']! },
    {
      kind: 'snoozeSet',
      input: { sessionId: S, until: LATER },
      case: CASES['snooze until a time']!,
    },
    { kind: 'snoozeClear', input: { sessionId: S }, case: CASES['clear snooze']! },
  ]
  for (const { kind, input, case: c } of kinds) {
    for (const baseline of [legacyBaseline, undefined]) {
      it(`${kind}, baseline ${baseline === undefined ? 'absent' : 'a session-row fingerprint'}`, async () => {
        const storage = memoryStorage()
        // The server truth the older build last saw, already in the replica.
        const seed = createReplica({ storage })
        seed.applyChanges('sessions', [sessionRow()], [])
        seed.applyChanges('sessionUserStates', [c.before], [])
        const entry: OutboxEntry = {
          mutationId: asMutationId(`legacy-${kind}`),
          kind,
          input,
          queuedAt: Date.parse('2026-07-08T00:00:00.000Z'),
          ...(baseline === undefined ? {} : { baseline }),
          state: 'awaiting-truth',
          resolvedAt: Date.now(),
        }
        seed.outboxAwaitingStorage().save([entry])
        await settle()

        const { engine } = makeEngine({ storage })
        expect(engine.outbox.awaiting()).toHaveLength(1)
        expect(c.painted(homeRow(engine))).toBe(true)
        expect(c.shown(viewOf(engine))).toBe(true)

        engine.start()
        await settle(40)
        publish(engine, { session: sessionRow(), user: c.after })
        await settle()
        expect(engine.outbox.awaiting()).toHaveLength(0)
        expect(homeRow(engine)).toEqual(c.after)
        engine.dispose()
      })
    }
  }
})

describe('mark read paints at least the session activity (client clock behind the server)', () => {
  it('a press older than lastActiveAt still reads as read', async () => {
    const api = makeApi()
    api.sessions.markRead.mutate = vi.fn(() => new Promise(() => {}))
    const { engine } = await booted(api)
    // The server's clock is a day ahead of this client's.
    const ahead = new Date(Date.now() + 86_400_000).toISOString()
    publish(engine, { session: sessionRow({ lastActiveAt: ahead }), user: userRow() })
    await settle()
    expect(viewOf(engine)?.unread).toBe(true)

    void engine.getSnapshot().markSessionRead(S)
    expect(homeRow(engine)?.readAt).toBe(ahead)
    expect(viewOf(engine)?.unread).toBe(false)
    engine.dispose()
  })

  it('a press after the activity paints the press time', async () => {
    const api = makeApi()
    api.sessions.markRead.mutate = vi.fn(() => new Promise(() => {}))
    const { engine } = await booted(api)
    publish(engine, { session: sessionRow(), user: userRow() })
    await settle()
    const before = Date.now()
    void engine.getSnapshot().markSessionRead(S)
    const painted = Date.parse(homeRow(engine)?.readAt ?? '')
    expect(painted).toBeGreaterThanOrEqual(before)
    expect(viewOf(engine)?.unread).toBe(false)
    engine.dispose()
  })
})

describe('a server that sends no per-user row (older than S1)', () => {
  it("paints over the session row's own cells, and the legacy echo settles it", async () => {
    const { engine } = await booted()
    publish(engine, { session: sessionRow({ readAt: null, unread: true }) })
    await settle()
    expect(homeRow(engine)).toBeUndefined()
    expect(viewOf(engine)?.unread).toBe(true)

    await engine.getSnapshot().markSessionRead(S)
    await settle()
    expect(viewOf(engine)?.unread).toBe(false)
    expect(homeRow(engine)?.readAt).toEqual(expect.any(String))
    expect(engine.outbox.awaiting()).toHaveLength(1)

    // That server only ever republishes the session row.
    publish(engine, { session: sessionRow({ readAt: SERVER_NOW, unread: false }) })
    await settle()
    expect(engine.outbox.awaiting()).toHaveLength(0)
    expect(homeRow(engine)).toBeUndefined()
    expect(viewOf(engine)).toMatchObject({ readAt: SERVER_NOW, unread: false })
    engine.dispose()
  })

  it("a snooze keeps the session row's other cell (its read cursor)", async () => {
    const api = makeApi()
    api.snoozes.set.mutate = vi.fn(() => new Promise(() => {}))
    const { engine } = await booted(api)
    publish(engine, { session: sessionRow({ readAt: SERVER_NOW, unread: false }) })
    await settle()
    void engine.getSnapshot().setSnooze(S, LATER)
    expect(viewOf(engine)).toMatchObject({ snoozedUntil: LATER, readAt: SERVER_NOW, unread: false })
    engine.dispose()
  })
})

describe('evict is not "not loaded"', () => {
  it('a session that leaves the slice takes its per-user overlay with it', async () => {
    const { engine } = await booted()
    publish(engine, { session: sessionRow(), user: userRow() })
    await settle()
    await engine.getSnapshot().markSessionRead(S)
    await settle()
    expect(engine.outbox.awaiting()).toHaveLength(1)

    engine.replica.batch(() => {
      engine.replica.applyChanges('sessions', [], [S])
      engine.replica.applyChanges('sessionUserStates', [], [sessionUserStateRowId(asUserId(ME), S)])
    })
    await settle()
    expect(engine.outbox.awaiting()).toHaveLength(0)
    expect(engine.pendingOverlaysByRow('sessionUserStates').has(S)).toBe(false)
    expect(viewOf(engine)).toBeUndefined()
    engine.dispose()
  })
})

describe('principal isolation of per-user session overlays', () => {
  it("paints only this principal's row, never another user's row for the same session", async () => {
    const api = makeApi()
    api.sessions.markUnread.mutate = vi.fn(() => new Promise(() => {}))
    api.snoozes.set.mutate = vi.fn(() => new Promise(() => {}))
    const { engine } = await booted(api)
    const theirs = userRow({ readAt: SERVER_NOW }, 'someone-else')
    publish(engine, { session: sessionRow(), user: userRow({ readAt: SERVER_NOW }) })
    engine.replica.applyChanges('sessionUserStates', [theirs], [])
    await settle()

    void engine.getSnapshot().markSessionUnread(S)
    void engine.getSnapshot().setSnooze(S, LATER)
    await settle()
    expect(homeRow(engine)).toMatchObject({ readAt: null, snoozedUntil: LATER })
    expect(homeRow(engine, 'someone-else')).toEqual(theirs)
    expect(viewOf(engine)).toMatchObject({ unread: true, snoozedUntil: LATER })
    engine.dispose()
  })

  it("another principal's runtime over the same rows paints nothing of this one's", async () => {
    const apiA = makeApi()
    apiA.snoozes.set.mutate = vi.fn(() => new Promise(() => {}))
    const a = makeEngine({ api: apiA, principal: 'alice' })
    const b = makeEngine({ api: makeApi(), principal: 'bob' })
    for (const { engine } of [a, b]) engine.start()
    await settle(40)
    for (const { engine } of [a, b]) {
      publish(engine, { session: sessionRow(), user: userRow({ readAt: SERVER_NOW }, 'alice') })
    }
    await settle()

    void a.engine.getSnapshot().setSnooze(S, LATER)
    await settle()
    expect(homeRow(a.engine, 'alice')?.snoozedUntil).toBe(LATER)
    expect(viewOf(a.engine)?.snoozedUntil).toBe(LATER)
    // Bob holds Alice's row as the server sent it, and his view is not hers.
    expect(homeRow(b.engine, 'alice')?.snoozedUntil).toBeUndefined()
    expect(b.engine.pendingOverlaysByRow('sessionUserStates').size).toBe(0)
    expect(viewOf(b.engine)?.snoozedUntil).toBeUndefined()
    a.engine.dispose()
    b.engine.dispose()
  })
})

describe('the spawn placeholder (S3c)', () => {
  const target = { path: '/w', repoPath: '/w' }

  it("inserts this principal's per-user row beside the placeholder session, read on arrival", async () => {
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
    const { engine } = await booted(api)
    const made = engine.getSnapshot().spawnDraftAgent({ target, agentKind: 'claude-code' })
    const pending = engine.pendingOverlaysByRow('sessionUserStates').get(made.sessionId) ?? []
    expect(foldRowOverlays(undefined, pending)).toMatchObject({
      userId: ME,
      sessionId: made.sessionId,
      readAt: expect.any(String),
    })
    const placeholder = engine.getSnapshot().sessions.find((s) => s.sessionId === made.sessionId)
    expect(placeholder).toMatchObject({ status: 'starting', unread: false, readAt: expect.any(String) })

    // An edit during the "Starting…" window shows on the placeholder too.
    api.snoozes.set.mutate = vi.fn(() => new Promise(() => {}))
    void engine.getSnapshot().setSnooze(made.sessionId, LATER)
    expect(
      engine.getSnapshot().sessions.find((s) => s.sessionId === made.sessionId)?.snoozedUntil,
    ).toBe(LATER)

    // The server row lands: the per-user placeholder retires with the session's.
    const row = sessionRow({ sessionId: made.sessionId, status: 'live' })
    publish(engine, { session: row })
    await settle()
    expect(engine.getSnapshot().pendingSpawnIds.has(made.sessionId)).toBe(false)
    expect(
      (engine.pendingOverlaysByRow('sessionUserStates').get(made.sessionId) ?? []).some(
        (o) => o.op === 'insert',
      ),
    ).toBe(false)
    release()
    engine.dispose()
  })

  it('a failed create takes the per-user placeholder away too', async () => {
    const api = makeApi()
    api.sessions.create = {
      mutate: vi.fn(async () => {
        throw new Error('spawn refused')
      }),
    }
    const { engine, errors } = await booted(api)
    const made = engine.getSnapshot().spawnDraftAgent({ target, agentKind: 'claude-code' })
    expect(await made.settled).toBe(false)
    expect(engine.pendingOverlaysByRow('sessionUserStates').has(made.sessionId)).toBe(false)
    expect(engine.getSnapshot().sessions.some((s) => s.sessionId === made.sessionId)).toBe(false)
    expect(errors.some((m) => m.includes('spawn refused'))).toBe(true)
    engine.dispose()
  })
})
