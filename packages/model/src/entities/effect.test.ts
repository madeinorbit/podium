import { describe, expect, it } from 'vitest'
import { mintDeviceId } from '../ids/device-id'
import { isForwardOnly } from '../state-machine'
import {
  EFFECT_STATUSES,
  EffectGroup,
  EffectLifecycle,
  EffectRecordWire,
  type EffectStatus,
  EffectStatusOnWire,
  isEffectFinished,
  messageEffect,
  NewEffectId,
} from './effect'
import { MESSAGE_DELIVERY_STATUSES, MessageDelivery } from './message-delivery'

/** The whole table, written out: a test that asked the machine for its own
 *  expectation could never fail. */
const MOVES: Record<EffectStatus, readonly EffectStatus[]> = {
  pending: ['running', 'succeeded', 'failed', 'cancelled', 'expired'],
  running: ['succeeded', 'failed', 'cancelled', 'unknown'],
  unknown: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
  expired: [],
}

describe('the standard effect status (ADR 12 D5 E2)', () => {
  it('holds exactly the seven statuses, in the ADR order', () => {
    expect(EFFECT_STATUSES).toEqual([
      'pending',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'expired',
      'unknown',
    ])
  })

  it('allows exactly the moves in the table', () => {
    for (const from of EFFECT_STATUSES) {
      for (const to of EFFECT_STATUSES) {
        expect(EffectLifecycle.canMove(from, to), `${from} -> ${to}`).toBe(MOVES[from].includes(to))
      }
    }
  })

  it('only moves forward, and four statuses end it', () => {
    expect(isForwardOnly(EffectLifecycle)).toBe(true)
    expect(EFFECT_STATUSES.filter(isEffectFinished)).toEqual([
      'succeeded',
      'failed',
      'cancelled',
      'expired',
    ])
  })

  it('a running record can only be claimed from pending', () => {
    expect(EffectLifecycle.allowedFrom('running')).toEqual(['pending'])
    // An expiry or a pending cancel never races a claim into a run.
    expect(EffectLifecycle.allowedFrom('expired')).toEqual(['pending'])
  })

  it('reads a status this build does not know as unknown, claiming nothing', () => {
    expect(EffectStatusOnWire.parse('running')).toBe('running')
    expect(EffectStatusOnWire.parse('paused-by-a-newer-server')).toBe('unknown')
  })
})

describe('the effect group and record', () => {
  it('parses the smallest group: a pending effect with no attempt', () => {
    expect(EffectGroup.parse({ status: 'pending', attempts: 0 })).toEqual({
      status: 'pending',
      attempts: 0,
    })
  })

  it('parses a full record and keeps unknown keys out', () => {
    const id = mintDeviceId('eff_')
    const record = EffectRecordWire.parse({
      id,
      kind: 'issue.merge',
      target: { kind: 'issue', id: 'iss_1' },
      input: { strategy: 'ff' },
      cancelRequested: false,
      effect: {
        status: 'failed',
        error: { code: 'conflict', message: 'not a fast-forward' },
        deadline: '2026-11-04T10:10:00.000Z',
        attempts: 1,
        startedAt: '2026-11-04T10:00:01.000Z',
        finishedAt: '2026-11-04T10:00:03.000Z',
        stage: 'merging',
      },
      createdBy: 'usr_1',
      createdAt: '2026-11-04T10:00:00.000Z',
      updatedAt: '2026-11-04T10:00:03.000Z',
      revision: 3,
    })
    expect(record.effect.error?.code).toBe('conflict')
    expect(record.target).toEqual({ kind: 'issue', id: 'iss_1' })
  })

  it('a new effect id is eff_ and a random UUID (ADR 12 D4)', () => {
    expect(NewEffectId.safeParse(mintDeviceId('eff_')).success).toBe(true)
    expect(NewEffectId.safeParse('POD-6241').success).toBe(false)
    expect(NewEffectId.safeParse(mintDeviceId('iss_')).success).toBe(false)
  })
})

describe('chat messages conform (ADR 12 D5 E2)', () => {
  it('maps every delivery status, with the stage for the steps on the way', () => {
    expect(Object.fromEntries(MESSAGE_DELIVERY_STATUSES.map((s) => [s, messageEffect(s)]))).toEqual(
      {
        stored: { status: 'pending' },
        dispatched: { status: 'running', stage: 'dispatched' },
        'reached-machine': { status: 'running', stage: 'reached-machine' },
        typing: { status: 'running', stage: 'typing' },
        typed: { status: 'running', stage: 'typed' },
        accepted: { status: 'running', stage: 'accepted' },
        confirmed: { status: 'succeeded' },
        cancelled: { status: 'cancelled' },
        failed: { status: 'failed' },
        expired: { status: 'expired' },
        unknown: { status: 'unknown' },
      },
    )
  })

  it('a message has ended exactly when its effect has', () => {
    for (const status of MESSAGE_DELIVERY_STATUSES) {
      expect(isEffectFinished(messageEffect(status).status), status).toBe(
        MessageDelivery.isTerminal(status),
      )
    }
  })

  it('every chat move is a legal effect move or a stage change within running', () => {
    for (const from of MESSAGE_DELIVERY_STATUSES) {
      for (const to of MessageDelivery.next(from)) {
        const a = messageEffect(from).status
        const b = messageEffect(to).status
        if (a === b) expect(a, `${from} -> ${to}`).toBe('running')
        else expect(EffectLifecycle.canMove(a, b), `${from} -> ${to}`).toBe(true)
      }
    }
  })
})
