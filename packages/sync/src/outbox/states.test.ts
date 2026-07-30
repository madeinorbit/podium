import { describe, expect, it } from 'vitest'
import {
  applyOutboxTransition,
  isDrainable,
  isTerminalOutboxState,
  nextOutboxState,
  OUTBOX_STATES,
  OUTBOX_TRANSITION_TABLE,
  OUTBOX_TRANSITIONS,
  type OutboxState,
  TERMINAL_OUTBOX_STATES,
} from './states'

// ADR 3 D9 is the SOLE owner of this vocabulary. These tests exist so that a
// drift in the state set or the transition table is a failing assertion rather
// than a documentation review: the table IS the spec, and D9's invariants are
// checked against it structurally (the behavioural half lives in outbox.test.ts).

describe('D9 state vocabulary', () => {
  it('is exactly ADR 3 D9s eight states, in the ADRs order', () => {
    expect([...OUTBOX_STATES]).toEqual([
      'queued',
      'sending',
      'accepted',
      'applied',
      'rejected',
      'expired',
      'dead-letter',
      'cancelled',
    ])
  })

  it('mints no local state names and imports none from another vocabulary', () => {
    // `awaiting-truth` is the shipped interim outbox's overlay retention flag and
    // D9 explicitly makes it "a sub-stage of `applied`, not a separate security
    // state". The rest are informal names for these same states that must not
    // creep in as ninth and tenth members.
    for (const foreign of [
      'awaiting-truth',
      'enqueued',
      'in-flight',
      'acknowledged',
      'retrying',
      'dead-lettered',
      'poison',
      'evicted',
      'unauthorized',
    ]) {
      expect(OUTBOX_STATES as readonly string[]).not.toContain(foreign)
    }
  })

  it('marks the four states D9 sets in bold as terminal', () => {
    expect([...TERMINAL_OUTBOX_STATES]).toEqual(['rejected', 'expired', 'dead-letter', 'cancelled'])
    for (const state of OUTBOX_STATES) {
      expect(isTerminalOutboxState(state)).toBe(
        (TERMINAL_OUTBOX_STATES as readonly string[]).includes(state),
      )
    }
  })

  it('only drains queued entries', () => {
    for (const state of OUTBOX_STATES) expect(isDrainable(state)).toBe(state === 'queued')
  })
})

describe('D9 transition table', () => {
  it('covers every state and only declares transitions from the closed cause set', () => {
    expect(Object.keys(OUTBOX_TRANSITION_TABLE).sort()).toEqual([...OUTBOX_STATES].sort())
    for (const [state, edges] of Object.entries(OUTBOX_TRANSITION_TABLE)) {
      for (const [cause, target] of Object.entries(edges)) {
        expect(OUTBOX_TRANSITIONS as readonly string[]).toContain(cause)
        expect(OUTBOX_STATES as readonly string[]).toContain(target)
        expect(`${state} --${cause}--> ${target}`).toBeTruthy()
      }
    }
  })

  it('is the table ADR 3 D9 describes, cell for cell', () => {
    expect(OUTBOX_TRANSITION_TABLE).toEqual({
      queued: {
        'drain-started': 'sending',
        'aged-out': 'expired',
        'user-discarded': 'cancelled',
      },
      sending: {
        'transport-failed': 'queued',
        'authority-accepted': 'accepted',
        'authority-applied': 'applied',
        'authority-rejected': 'rejected',
        'aged-out': 'expired',
      },
      accepted: {
        'transport-failed': 'queued',
        'authority-applied': 'applied',
        'authority-rejected': 'rejected',
      },
      applied: {},
      rejected: { parked: 'dead-letter' },
      expired: { parked: 'dead-letter' },
      'dead-letter': { 'user-retried': 'queued', 'user-discarded': 'cancelled' },
      cancelled: {},
    })
  })

  it('reaches every one of the eight states from queued by legal transitions', () => {
    const seen = new Set<OutboxState>(['queued'])
    const frontier: OutboxState[] = ['queued']
    while (frontier.length > 0) {
      const state = frontier.pop() as OutboxState
      for (const cause of OUTBOX_TRANSITIONS) {
        const next = nextOutboxState(state, cause)
        if (next && !seen.has(next)) {
          seen.add(next)
          frontier.push(next)
        }
      }
    }
    expect([...seen].sort()).toEqual([...OUTBOX_STATES].sort())
  })

  it('invariant 4: a transport failure returns to queued and never rejects', () => {
    expect(nextOutboxState('sending', 'transport-failed')).toBe('queued')
    expect(nextOutboxState('accepted', 'transport-failed')).toBe('queued')
    // Nothing but a definitive authority verdict may produce `rejected`.
    for (const state of OUTBOX_STATES) {
      for (const cause of OUTBOX_TRANSITIONS) {
        if (nextOutboxState(state, cause) === 'rejected') expect(cause).toBe('authority-rejected')
      }
    }
  })

  it('invariant 2: rejected and expired lead nowhere but dead-letter', () => {
    for (const state of ['rejected', 'expired'] as const) {
      const targets = Object.values(OUTBOX_TRANSITION_TABLE[state])
      expect(targets).toEqual(['dead-letter'])
    }
  })

  it('invariant 3: dead-letter has a way out — retry and discard', () => {
    expect(OUTBOX_TRANSITION_TABLE['dead-letter']).toEqual({
      'user-retried': 'queued',
      'user-discarded': 'cancelled',
    })
  })

  it('invariant 1: nothing but a user action or an applied retirement ends an entry', () => {
    // `applied` and `cancelled` are the only states with no outgoing edge, and
    // they are exactly D9 invariant 1's two licences to make an entry gone: a
    // successful applied retirement after covering truth, and a user action.
    const sinks = OUTBOX_STATES.filter((s) => Object.keys(OUTBOX_TRANSITION_TABLE[s]).length === 0)
    expect([...sinks].sort()).toEqual(['applied', 'cancelled'])
    // And no cause anywhere silently bypasses the recovery surface: the only way
    // into `cancelled` is the user discarding.
    for (const state of OUTBOX_STATES) {
      for (const cause of OUTBOX_TRANSITIONS) {
        if (nextOutboxState(state, cause) === 'cancelled') expect(cause).toBe('user-discarded')
      }
    }
  })

  it('refuses an illegal transition instead of coercing the state', () => {
    expect(() => applyOutboxTransition('applied', 'authority-rejected')).toThrow(
      /illegal outbox transition: applied/,
    )
    expect(() => applyOutboxTransition('queued', 'authority-applied')).toThrow(/illegal/)
    expect(() => applyOutboxTransition('cancelled', 'user-retried')).toThrow(/illegal/)
    expect(applyOutboxTransition('queued', 'drain-started')).toBe('sending')
  })
})
