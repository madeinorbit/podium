import {
  asIssueId,
  asSessionId,
  type IssueProjection,
  type IssueWire,
  type SessionMeta,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { Store } from '../../../engine/types'
import { createReplica, memoryStorage } from '../../../replica/replica'
import { createSlicePublisher } from '../publish'
import { worklistSlice } from './published'

// ---------------------------------------------------------------------------
// POD-331 — THE SEAM THE PORT REPLACED, WHICH HAD NO COVERAGE OF ITS OWN.
//
// The worklist used to be derived inside each component, memoized over
// `[repos, sessions, pins, issues, now]` where `now` came from a per-component
// `useNow(60_000)` interval. The port replaced that with a published slice
// keyed on snapshot identity, and moved the clock into the snapshot as
// `Store.coarseNow`.
//
// POD-330's handover names this exact hazard: REPLACING A FRAGILE MECHANISM
// DOES NOT INHERIT ITS COVERAGE. Nothing in this repo tested that the sidebar
// re-derives when the clock advances — measured, not assumed: no test in
// apps/web/src/features/worklist or in this package referenced `useNow` or
// advanced timers against the derivation. So the property "a snooze lapses on
// screen without a server round-trip" was carried entirely by a mechanism
// nobody was checking, and its replacement would have started equally
// unchecked.
//
// These tests pin the property to the NEW mechanism, and they are what makes
// the obvious wrong implementation — reading `Date.now()` inside `derive`,
// which the publisher would then memoize against a clock that had moved —
// fail rather than pass quietly.
// ---------------------------------------------------------------------------

const NOON = Date.parse('2026-07-06T12:00:00.000Z')
const HOUR = 3_600_000

function session(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: asSessionId(id),
    agentKind: 'claude-code',
    title: id,
    cwd: '/repo',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: new Date(NOON - HOUR).toISOString(),
    origin: { kind: 'spawn' },
    archived: false,
    busy: false,
    readAt: null,
    unread: false,
    agentState: { phase: 'idle', idle: { kind: 'needs_input' } },
    ...over,
  } as unknown as SessionMeta
}

/**
 * A store snapshot carrying only what the worklist slice reads, at a given
 * coarse clock. Everything else on `Store` is irrelevant to this derivation —
 * which is itself worth pinning, since a slice that reached for more would stop
 * being a pure function of the fields named here.
 */
function storeAt(coarseNow: number, sessions: SessionMeta[]): Store {
  return {
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
    sessions,
    pins: { panels: [], worktrees: [], repos: [] },
    issues: [],
    coarseNow,
  } as unknown as Store
}

/** Sessions on the single repo's single worktree, in the order the slice put them. */
function orderOf(store: Store): string[] {
  const repo = worklistSlice.derive(store).sections.repos[0]
  return (repo?.worktrees[0]?.sessions ?? []).map((s) => String(s.sessionId))
}

describe('POD-331 published worklist slice — the clock is an INPUT, not an ambient read', () => {
  // `snoozed` is de-emphasised below `awake` while the snooze holds, and sorts
  // back above it once the deadline passes. Recency is identical between the
  // two, so ORDER here is a pure function of the clock and nothing else.
  const snoozeEnds = NOON + HOUR
  const sessions = [
    session('snoozed', {
      snoozedUntil: new Date(snoozeEnds).toISOString(),
      lastActiveAt: new Date(NOON).toISOString(),
    } as Partial<SessionMeta>),
    session('awake', { lastActiveAt: new Date(NOON - HOUR).toISOString() }),
  ]

  it('ranks a live snooze below an awake session', () => {
    expect(orderOf(storeAt(NOON, sessions))).toEqual(['awake', 'snoozed'])
  })

  it('LAPSES the snooze when only the clock has moved — no row changed', () => {
    // The SAME sessions array. Nothing about the world changed except the time,
    // which is exactly the case a snapshot-identity cache gets wrong if the
    // clock is read out of band instead of carried in the snapshot.
    expect(orderOf(storeAt(snoozeEnds + 1, sessions))).toEqual(['snoozed', 'awake'])
  })

  it('publishes the clock it derived against, so consumers cannot disagree with it', () => {
    // Consumers used to each run their own `useNow`, so a row and its timestamp
    // could be rendered against two different "now"s. They read this instead.
    expect(worklistSlice.derive(storeAt(NOON, sessions)).now).toBe(NOON)
  })
})

// ---------------------------------------------------------------------------
// POD-843/POD-929 — unread is derived from projection content + the issue-row
// cursor + session activity, never from an IssueWire.unread paint.
//
// After unread left the wire, worklistSlice still built rows from store.issues.
// Surfaces that read `issue.unread` then treated every row as read. This pins
// the published slice to the same replica builder Flight Deck uses, starting
// from projection + session inputs — not an injected `unread` on a legacy
// fixture, which is what the sidebar surface tests still do.
// ---------------------------------------------------------------------------

const READ_AT = '2026-07-06T11:00:00.000Z'
const BEFORE_READ = '2026-07-06T10:00:00.000Z'
const AFTER_READ = '2026-07-06T12:00:00.000Z'

function projection(over: { id: string; title: string; updatedAt: string }): IssueProjection {
  return {
    id: over.id,
    seq: 1,
    title: over.title,
    description: { value: '' },
    stage: 'in_progress',
    updatedAt: over.updatedAt,
    createdAt: '2026-06-01T00:00:00.000Z',
    archived: false,
    priority: 2,
    type: 'task',
    intentOrigin: 'human',
    audience: 'human',
    isDraftVessel: false,
  } as unknown as IssueProjection
}

function legacyIssue(id: string, title: string, readAt: string | null = READ_AT): IssueWire {
  return {
    id,
    repoPath: '/repo',
    seq: 1,
    title,
    description: '',
    stage: 'in_progress',
    worktreePath: '/repo',
    branch: 'issue/1',
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    blockedByNotes: [],
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: BEFORE_READ,
    archived: false,
    needsHuman: false,
    origin: 'human',
    audience: 'human',
    draft: false,
    childCount: 0,
    childDoneCount: 0,
    priority: 2,
    type: 'task',
    pinned: false,
    labels: [],
    deps: [],
    dependents: [],
    comments: [],
    ready: true,
    blocked: false,
    deferred: false,
    readAt,
    // The bug: surfaces trusted this field. The slice must ignore it.
    unread: false,
  } as unknown as IssueWire
}

function worklistFromProjection(args: {
  id: string
  title: string
  readAt?: string | null
  updatedAt: string
  lastActiveAt: string
}): ReturnType<typeof worklistSlice.derive> {
  const row = projection(args)
  const member = session('s-live', {
    issueId: asIssueId(args.id),
    cwd: '/repo',
    lastActiveAt: args.lastActiveAt,
    unread: false,
    readAt: args.readAt ?? null,
  })
  const replica = createReplica({ storage: memoryStorage() })
  replica.applySnapshot('issueProjections', [row])
  replica.applySnapshot('issues', [legacyIssue(args.id, args.title, args.readAt ?? null)])
  replica.applySnapshot('sessions', [member])
  replica.applySnapshot('repos', [{ id: 'repo', path: '/repo', prefix: 'POD' } as never])
  return worklistSlice.derive({
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [{ path: '/repo' }] }],
    sessions: [member],
    pins: { panels: [], worktrees: [], repos: [] },
    issues: [legacyIssue(args.id, args.title, args.readAt ?? null)],
    issueProjections: [row],
    replica,
    coarseNow: NOON,
    selectedIssueId: null,
  } as unknown as Store)
}

function issueUnreadOf(
  slice: ReturnType<typeof worklistSlice.derive>,
  id: string,
): boolean | undefined {
  const row = slice.work.find((entry) => entry.kind === 'issue' && entry.issue.id === id)
  expect(row, `expected a worklist row for ${id}`).toBeDefined()
  return row && row.kind === 'issue' ? row.issue.unread : undefined
}

describe('published worklist derives unread from one issue-row cursor', () => {
  it('a never-read issue is unread even when the legacy wire says otherwise', () => {
    const slice = worklistFromProjection({
      id: 'iss_new',
      title: 'Never read',
      readAt: null,
      updatedAt: BEFORE_READ,
      lastActiveAt: BEFORE_READ,
    })
    expect(issueUnreadOf(slice, 'iss_new')).toBe(true)
  })

  it('session activity after readAt flips the row unread without an IssueWire.unread', () => {
    const slice = worklistFromProjection({
      id: 'iss_active',
      title: 'New session activity',
      readAt: READ_AT,
      updatedAt: BEFORE_READ,
      lastActiveAt: AFTER_READ,
    })
    expect(issueUnreadOf(slice, 'iss_active')).toBe(true)
  })

  it('issue updatedAt after readAt is unread even with a quiet session', () => {
    const slice = worklistFromProjection({
      id: 'iss_touched',
      title: 'Issue edited',
      readAt: READ_AT,
      updatedAt: AFTER_READ,
      lastActiveAt: BEFORE_READ,
    })
    expect(issueUnreadOf(slice, 'iss_touched')).toBe(true)
  })

  it('a caught-up issue stays read', () => {
    const slice = worklistFromProjection({
      id: 'iss_seen',
      title: 'Caught up',
      readAt: READ_AT,
      updatedAt: BEFORE_READ,
      lastActiveAt: BEFORE_READ,
    })
    expect(issueUnreadOf(slice, 'iss_seen')).toBe(false)
  })

  it('the persisted issue-row cursor keeps the projection-derived model read', () => {
    const row = projection({
      id: 'iss_echo',
      title: 'Persist echo',
      updatedAt: BEFORE_READ,
    })
    expect(Object.hasOwn(row, 'readAt')).toBe(false)

    const member = session('s-echo', {
      issueId: asIssueId('iss_echo'),
      cwd: '/repo',
      lastActiveAt: BEFORE_READ,
      unread: false,
      readAt: READ_AT,
    })
    const replica = createReplica({ storage: memoryStorage() })
    replica.applySnapshot('issueProjections', [row])
    replica.applySnapshot('issues', [legacyIssue('iss_echo', 'Persist echo')])
    replica.applySnapshot('sessions', [member])
    replica.applySnapshot('repos', [{ id: 'repo', path: '/repo', prefix: 'POD' } as never])
    const slice = worklistSlice.derive({
      repos: [
        { path: '/repo', kind: 'repository', branch: 'main', worktrees: [{ path: '/repo' }] },
      ],
      sessions: [member],
      pins: { panels: [], worktrees: [], repos: [] },
      issues: [legacyIssue('iss_echo', 'Persist echo')],
      issueProjections: [row],
      replica,
      coarseNow: NOON,
      selectedIssueId: null,
    } as unknown as Store)
    expect(issueUnreadOf(slice, 'iss_echo')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// POD-1053 — the fan-out a one-field mutation forces.
//
// `derive` here is the largest projection on the client: sidebarSections +
// unifiedWorkList + splitPinnedWork + groupUnifiedWorkRows, over every issue and
// every session. POD-1052 measured it at ~26ms median at live cardinalities, and
// it ran TWICE per press — once for the optimistic paint, and again for the
// server echo that painted back exactly the values already on screen.
//
// The second one was pure waste, and `sourceEqual` naming `previous.issues`
// could not see it: the echo is a different array carrying the same visible
// values. Naming the DERIVED models instead does see it.
// ---------------------------------------------------------------------------

function tuckWorld(): {
  replica: ReturnType<typeof createReplica>
  storeWith: (issues: IssueWire[], projections: IssueProjection[]) => Store
} {
  const replica = createReplica({ storage: memoryStorage() })
  const projections = [
    projection({ id: 'iss_a', title: 'A', updatedAt: BEFORE_READ }),
    projection({ id: 'iss_b', title: 'B', updatedAt: BEFORE_READ }),
  ]
  const issues = [legacyIssue('iss_a', 'A'), legacyIssue('iss_b', 'B')]
  const member = session('s-live', {
    issueId: asIssueId('iss_a'),
    cwd: '/repo',
    lastActiveAt: BEFORE_READ,
  })
  replica.applySnapshot('issueProjections', projections)
  replica.applySnapshot('issues', issues)
  replica.applySnapshot('sessions', [member])
  replica.applySnapshot('repos', [{ id: 'repo', path: '/repo', prefix: 'POD' } as never])
  // Everything the guard names EXCEPT the issue rows is held at one identity, so
  // a re-derivation can only ever be about the issues.
  const repos = [
    { path: '/repo', kind: 'repository', branch: 'main', worktrees: [{ path: '/repo' }] },
  ]
  const machines: never[] = []
  const sessions = [member]
  const pins = { panels: [], worktrees: [], repos: [] }
  return {
    replica,
    storeWith: (rows, projectionRows) =>
      ({
        repos,
        machines,
        sessions,
        pins,
        issues: rows,
        issueProjections: projectionRows,
        replica,
        coarseNow: NOON,
        selectedIssueId: null,
      }) as unknown as Store,
  }
}

describe('POD-1053 published worklist re-derives on movement, not on array churn', () => {
  it('derives once for the press and NOT again for the echo that paints the same values', () => {
    const { replica, storeWith } = tuckWorld()
    let store = storeWith([...replica.rows('issues')], [...replica.rows('issueProjections')])
    const publisher = createSlicePublisher<Store>(() => store)

    publisher.read(worklistSlice)
    expect(publisher.derivations().worklist).toBe(1)

    // The press: the overlay fold hands the store a new array with one new row.
    const tuckedAt = '2026-07-06T12:30:00.000Z'
    const painted = store.issues.map((row) =>
      row.id === 'iss_a' ? ({ ...row, tuckedAt } as IssueWire) : row,
    )
    store = storeWith(painted, store.issueProjections as IssueProjection[])
    publisher.read(worklistSlice)
    expect(publisher.derivations().worklist).toBe(2)

    // The echo: server truth lands carrying what optimism already painted. New
    // replica rows, new store arrays — and nothing on screen may move.
    replica.applySnapshot(
      'issues',
      painted.map((row) => ({ ...row })),
    )
    store = storeWith([...replica.rows('issues')], [...replica.rows('issueProjections')])
    publisher.read(worklistSlice)
    expect(publisher.derivations().worklist).toBe(2)
  })

  it('still re-derives when a row genuinely moves', () => {
    const { replica, storeWith } = tuckWorld()
    let store = storeWith([...replica.rows('issues')], [...replica.rows('issueProjections')])
    const publisher = createSlicePublisher<Store>(() => store)
    publisher.read(worklistSlice)

    // The curation mirror paints the PROJECTION for a rename — the projection is
    // spread over the legacy supplement, so it is the half the model reads.
    store = storeWith(store.issues, [
      ...(store.issueProjections as IssueProjection[]).map((row) =>
        row.id === 'iss_a' ? ({ ...row, title: 'Renamed' } as IssueProjection) : row,
      ),
    ])
    publisher.read(worklistSlice)
    expect(publisher.derivations().worklist).toBe(2)
    expect(
      publisher
        .read(worklistSlice)
        .work.find((row) => row.kind === 'issue' && row.issue.id === 'iss_a'),
    ).toMatchObject({ issue: { title: 'Renamed' } })
  })

  it('re-derives when an issue leaves the principal slice with nothing else moving', () => {
    // The evict case `slices/publish.ts` exists to protect: a shrink that moves
    // no revision. A shorter model array is never an equal one.
    const { replica, storeWith } = tuckWorld()
    let store = storeWith([...replica.rows('issues')], [...replica.rows('issueProjections')])
    const publisher = createSlicePublisher<Store>(() => store)
    publisher.read(worklistSlice)

    store = storeWith(
      store.issues.filter((row) => row.id !== 'iss_b'),
      (store.issueProjections as IssueProjection[]).filter((row) => row.id !== 'iss_b'),
    )
    publisher.read(worklistSlice)
    expect(publisher.derivations().worklist).toBe(2)
    expect(
      publisher
        .read(worklistSlice)
        .work.some((row) => row.kind === 'issue' && row.issue.id === 'iss_b'),
    ).toBe(false)
  })
})
