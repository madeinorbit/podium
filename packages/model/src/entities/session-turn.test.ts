/**
 * THE TURN MARKER (POD-6397): which turn a session's state belongs to, so an
 * interrupt can name the turn it is for and never stop the next one.
 */

import { describe, expect, it } from 'vitest'
import { type AgentRuntimeState, hasTurnEnded, isTurnOpen, withTurnMarker } from './session'

const state = (
  phase: AgentRuntimeState['phase'],
  since: string,
  extra: Partial<AgentRuntimeState> = {},
): AgentRuntimeState => ({ phase, since, nativeSubagentCount: 0, ...extra })

const T0 = '2026-11-05T10:00:00.000Z'
const T1 = '2026-11-05T10:01:00.000Z'
const T2 = '2026-11-05T10:02:00.000Z'

describe('isTurnOpen', () => {
  it('working, a wait inside a turn and a compaction mid-turn are open; idle, errored and ended are not', () => {
    expect(isTurnOpen(state('working', T0))).toBe(true)
    expect(isTurnOpen(state('needs_user', T0))).toBe(true)
    expect(isTurnOpen(state('compacting', T0))).toBe(true)
    expect(isTurnOpen(state('compacting', T0, { compactingFrom: { phase: 'working' } }))).toBe(true)
    expect(isTurnOpen(state('compacting', T0, { compactingFrom: { phase: 'idle' } }))).toBe(false)
    expect(isTurnOpen(state('idle', T0))).toBe(false)
    expect(isTurnOpen(state('errored', T0))).toBe(false)
    expect(isTurnOpen(state('ended', T0))).toBe(false)
    expect(isTurnOpen(undefined)).toBe(false)
  })

  it('unknown reads as open: a lost channel never ends a turn nobody saw end', () => {
    expect(isTurnOpen(state('unknown', T0))).toBe(true)
  })
})

describe('withTurnMarker', () => {
  it('a turn opening is marked with its own since', () => {
    expect(withTurnMarker(state('idle', T0), state('working', T1)).turnStartedAt).toBe(T1)
    expect(withTurnMarker(undefined, state('working', T1)).turnStartedAt).toBe(T1)
    expect(withTurnMarker(state('unknown', T0), state('working', T1)).turnStartedAt).toBe(T1)
  })

  it('every later state of the turn, and the idle after it, keeps the marker', () => {
    const working = withTurnMarker(state('idle', T0), state('working', T1))
    const waiting = withTurnMarker(working, state('needs_user', T2))
    expect(waiting.turnStartedAt).toBe(T1)
    const idle = withTurnMarker(waiting, state('idle', T2))
    expect(idle.turnStartedAt).toBe(T1)
    expect(withTurnMarker(idle, state('working', T2)).turnStartedAt).toBe(T2)
  })

  it('a lost channel after a turn keeps its marker; working after it is the same turn', () => {
    const working = withTurnMarker(undefined, state('working', T0))
    const gap = withTurnMarker(working, state('unknown', T1))
    expect(gap.turnStartedAt).toBe(T0)
    expect(withTurnMarker(gap, state('working', T2)).turnStartedAt).toBe(T0)
  })

  it('an idle compaction opens no turn', () => {
    const idle = state('idle', T0, { turnStartedAt: T0 })
    const compacting = state('compacting', T1, { compactingFrom: { phase: 'idle' } })
    expect(withTurnMarker(idle, compacting).turnStartedAt).toBe(T0)
  })

  it('answers the same object when the marker is already right, and drops a stray one', () => {
    const next = state('working', T1, { turnStartedAt: T0 })
    expect(withTurnMarker(state('working', T0, { turnStartedAt: T0 }), next)).toBe(next)
    expect(withTurnMarker(undefined, state('idle', T1, { turnStartedAt: T0 }))).not.toHaveProperty(
      'turnStartedAt',
    )
  })
})

describe('hasTurnEnded', () => {
  it('a named turn has ended once a later turn opened, or no turn is open', () => {
    expect(hasTurnEnded(state('working', T0, { turnStartedAt: T0 }), T0)).toBe(false)
    expect(hasTurnEnded(state('working', T2, { turnStartedAt: T2 }), T0)).toBe(true)
    expect(hasTurnEnded(state('idle', T1, { turnStartedAt: T0 }), T0)).toBe(true)
  })

  it('no named turn means whatever turn runs now', () => {
    expect(hasTurnEnded(state('working', T0, { turnStartedAt: T0 }), undefined)).toBe(false)
    expect(hasTurnEnded(state('idle', T0), undefined)).toBe(true)
  })

  it('a state with no marker cannot tell turns apart: only an open turn counts', () => {
    expect(hasTurnEnded(state('working', T0), T0)).toBe(false)
  })
})
