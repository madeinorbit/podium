import { describe, expect, it } from 'vitest'
import { isForwardOnly } from '../state-machine'
import {
  isMessageOnItsWay,
  isMessagePending,
  MESSAGE_DELIVERY_STATUSES,
  MESSAGE_ON_ITS_WAY,
  MESSAGE_PENDING,
  MessageDelivery,
  MessageDeliveryStatus,
  MessageDeliveryStatusOnWire,
  MessageHeld,
} from './message-delivery'

/** The whole table of moves, written out (POD-4765, POD-4885). Not derived from
 *  the machine: a test that asked the table for its expectation could never
 *  fail. */
const MOVES: Record<MessageDeliveryStatus, readonly MessageDeliveryStatus[]> = {
  stored: [
    'dispatched',
    'reached-machine',
    'typing',
    'typed',
    'accepted',
    'confirmed',
    'cancelled',
    'failed',
    'expired',
  ],
  dispatched: [
    'reached-machine',
    'typing',
    'typed',
    'accepted',
    'confirmed',
    'cancelled',
    'failed',
    'unknown',
  ],
  'reached-machine': ['typing', 'typed', 'accepted', 'confirmed', 'cancelled', 'failed', 'unknown'],
  typing: ['typed', 'accepted', 'confirmed', 'failed', 'unknown'],
  typed: ['accepted', 'confirmed', 'failed', 'unknown'],
  accepted: ['confirmed', 'failed', 'unknown'],
  unknown: ['confirmed', 'failed', 'cancelled'],
  confirmed: [],
  cancelled: [],
  failed: [],
  expired: [],
}

describe('message delivery lifecycle', () => {
  it('allows exactly the listed moves and refuses every other pair', () => {
    expect(Object.keys(MOVES).sort()).toEqual([...MESSAGE_DELIVERY_STATUSES].sort())
    for (const from of MESSAGE_DELIVERY_STATUSES) {
      for (const to of MESSAGE_DELIVERY_STATUSES) {
        expect(MessageDelivery.canMove(from, to), `${from}→${to}`).toBe(MOVES[from].includes(to))
      }
    }
  })

  it('puts accepted between typed and confirmed, not final (POD-4885)', () => {
    const order = MESSAGE_DELIVERY_STATUSES
    expect(order.indexOf('accepted')).toBe(order.indexOf('typed') + 1)
    expect(order.indexOf('confirmed')).toBe(order.indexOf('accepted') + 1)
    expect(MessageDelivery.isTerminal('accepted')).toBe(false)
    expect(isMessagePending('accepted')).toBe(true)
    expect(isMessageOnItsWay('accepted')).toBe(true)
  })

  it('keeps failed final: a later match never makes it confirmed (decided 2026-09-29)', () => {
    expect(MessageDelivery.canMove('failed', 'confirmed')).toBe(false)
  })

  it('only moves forward', () => {
    expect(isForwardOnly(MessageDelivery)).toBe(true)
  })

  it('ends only in confirmed, cancelled, failed or expired', () => {
    expect([...MessageDelivery.terminal].sort()).toEqual([
      'cancelled',
      'confirmed',
      'expired',
      'failed',
    ])
    for (const status of MessageDelivery.terminal) expect(MessageDelivery.next(status)).toEqual([])
  })

  it('never lets a server timeout end a handed-on message: expiry only from stored', () => {
    expect(MessageDelivery.allowedFrom('expired')).toEqual(['stored'])
  })

  it('cannot cancel once typing has started', () => {
    expect([...MessageDelivery.allowedFrom('cancelled')].sort()).toEqual([
      'dispatched',
      'reached-machine',
      'stored',
      'unknown',
    ])
  })

  it('enters unknown only after the message was handed on', () => {
    expect([...MessageDelivery.allowedFrom('unknown')].sort()).toEqual(
      [...MESSAGE_ON_ITS_WAY].sort(),
    )
  })

  it('leaves unknown only by a report or a person: confirmed, failed or cancelled', () => {
    expect([...MessageDelivery.next('unknown')].sort()).toEqual([
      'cancelled',
      'confirmed',
      'failed',
    ])
  })

  it('classifies every status exactly once', () => {
    for (const status of MESSAGE_DELIVERY_STATUSES) {
      const onItsWay = isMessageOnItsWay(status)
      const pending = isMessagePending(status)
      expect(pending).toBe(MESSAGE_PENDING.includes(status))
      if (onItsWay) expect(pending).toBe(true)
    }
    expect([...MESSAGE_PENDING].sort()).toEqual(
      ['accepted', 'dispatched', 'reached-machine', 'stored', 'typed', 'typing', 'unknown'].sort(),
    )
  })

  it('parses exactly the declared statuses', () => {
    for (const status of MESSAGE_DELIVERY_STATUSES)
      expect(MessageDeliveryStatus.parse(status)).toBe(status)
    expect(MessageDeliveryStatus.safeParse('queued').success).toBe(false)
    expect(MessageDeliveryStatus.safeParse('delivered').success).toBe(false)
  })
})

describe('how an accepted message is held (POD-4885, spec §4 "two kinds")', () => {
  it('is held in memory or durably, nothing else', () => {
    expect(MessageHeld.options).toEqual(['memory', 'durable'])
    expect(MessageHeld.safeParse('disk').success).toBe(false)
  })
})

describe('a status on the wire, as a client reads it (POD-4885)', () => {
  it('reads every status this build knows as itself', () => {
    for (const status of MESSAGE_DELIVERY_STATUSES)
      expect(MessageDeliveryStatusOnWire.parse(status)).toBe(status)
  })

  it('reads a status a newer server added as still on its way (typed), never as a failure', () => {
    expect(MessageDeliveryStatusOnWire.parse('a-status-from-a-newer-server')).toBe('typed')
  })

  it('still refuses a value that is not a status at all', () => {
    expect(MessageDeliveryStatusOnWire.safeParse(3).success).toBe(false)
    expect(MessageDeliveryStatusOnWire.safeParse(undefined).success).toBe(false)
  })
})
