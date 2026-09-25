import type { SessionMeta } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  deckFoldKey,
  flightDeckBranchFolded,
  flightDeckRosterFolded,
  migrateResolvedDeckFolds,
  readFlightDeckFolds,
  writeFlightDeckFolds,
} from './flight-deck-folds'
import type { FlightDeckRow } from './mission'

const row = (id: string, descendants: string[] = [], sessions: SessionMeta[] = [], closed = false) => ({
  issue: { id, stage: closed ? 'done' : 'in_progress' },
  descendantIds: descendants,
  sessions,
}) as FlightDeckRow

const session = (id: string, phase: string, status = 'live') => ({
  sessionId: id, status, archived: false, agentKind: 'codex',
  agentState: { phase, since: '2026-09-25T00:00:00Z', error: phase === 'errored' ? { class: 'network_error', retryable: false } : undefined },
}) as unknown as SessionMeta

describe('flight deck fold migration and defaults', () => {
  it('keeps unresolved legacy IDs until an unfiltered resolved topology is supplied', () => {
    const legacy = readFlightDeckFolds(JSON.stringify({ open: ['branch', 'idle', 'unknown'], closed: ['leaf'] }))
    const partial = [row('branch'), row('leaf')]
    const first = migrateResolvedDeckFolds(legacy, partial, new Set(['leaf']))
    expect(first.get('branch')).toBe('open')
    expect(first.get(deckFoldKey('roster', 'leaf'))).toBe('closed')
    expect(first.has('leaf')).toBe(false)
    const complete = migrateResolvedDeckFolds(first, [row('branch', ['child']), row('leaf'), row('idle')], new Set(['branch', 'leaf', 'idle']))
    expect(complete.get(deckFoldKey('branch', 'branch'))).toBe('open')
    expect(complete.get(deckFoldKey('roster', 'idle'))).toBe('open')
    expect(complete.get('unknown')).toBe('open')
    expect(complete.has('branch')).toBe(false)
    expect(flightDeckBranchFolded(row('branch', ['child']), readFlightDeckFolds(writeFlightDeckFolds(complete)))).toBe(false)
  })

  it('does not reinterpret a placed leaf fold after a later child arrives', () => {
    const legacy = readFlightDeckFolds(JSON.stringify(['leaf']))
    const migrated = migrateResolvedDeckFolds(legacy, [row('leaf')], new Set(['leaf']))
    expect(migrated.get(deckFoldKey('roster', 'leaf'))).toBe('closed')
    expect(migrated.has('leaf')).toBe(false)
    expect(flightDeckBranchFolded(row('leaf', ['later-child']), migrated)).toBe(false)
    expect(flightDeckRosterFolded(row('leaf', ['later-child']), migrated)).toBe(true)
  })

  it('can place a branch from a recorded child without declaring any leaf resolved', () => {
    const legacy = readFlightDeckFolds(JSON.stringify(['branch', 'unknown']))
    const next = migrateResolvedDeckFolds(legacy, [row('branch', ['child']), row('child')])
    expect(next.get(deckFoldKey('branch', 'branch'))).toBe('closed')
    expect(next.has('branch')).toBe(false)
    expect(next.get('unknown')).toBe('closed')
  })

  it('opens current exceptions by default while honoring explicit closure', () => {
    const closed = row('closed', [], [session('error', 'errored', 'hibernated')], true)
    const running = row('running', [], [session('work', 'working')])
    const offerWorking = row('offer-working', [], [{ ...session('work-offer', 'working'), offer: { message: 'Review', actions: [], createdAt: '2026-09-25T00:00:00Z' } } as SessionMeta])
    const asking = row('asking', [], [session('ask', 'needs_user')])
    expect(flightDeckRosterFolded(closed, new Map())).toBe(false)
    expect(flightDeckRosterFolded(running, new Map())).toBe(false)
    expect(flightDeckRosterFolded(offerWorking, new Map())).toBe(false)
    expect(flightDeckRosterFolded(asking, new Map())).toBe(false)
    expect(flightDeckRosterFolded(closed, new Map([[deckFoldKey('roster', 'closed'), 'closed']]))).toBe(true)
  })
})
