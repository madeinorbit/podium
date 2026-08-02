import { asSessionId, type SessionMeta } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { Store } from '../../../engine/types'
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
