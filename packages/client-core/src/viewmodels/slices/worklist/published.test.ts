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
// POD-843 — unread is derived from projection + session, not IssueWire.
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

function projection(over: {
  id: string
  title: string
  readAt?: string | null
  updatedAt: string
}): IssueProjection {
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
    readAt: over.readAt,
  } as unknown as IssueProjection
}

function legacyIssue(id: string, title: string): IssueWire {
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
    readAt: READ_AT,
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
  replica.applySnapshot('sessions', [member])
  replica.applySnapshot('repos', [{ id: 'repo', path: '/repo', prefix: 'POD' } as never])
  return worklistSlice.derive({
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [{ path: '/repo' }] }],
    sessions: [member],
    pins: { panels: [], worktrees: [], repos: [] },
    issues: [legacyIssue(args.id, args.title)],
    issueProjections: [row],
    replica,
    coarseNow: NOON,
    selectedIssueId: null,
  } as unknown as Store)
}

function issueUnreadOf(slice: ReturnType<typeof worklistSlice.derive>, id: string): boolean | undefined {
  const row = slice.work.find((entry) => entry.kind === 'issue' && entry.issue.id === id)
  expect(row, `expected a worklist row for ${id}`).toBeDefined()
  return row && row.kind === 'issue' ? row.issue.unread : undefined
}

describe('POD-843 published worklist derives unread from projection + session', () => {
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
})
