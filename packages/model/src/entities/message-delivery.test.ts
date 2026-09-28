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
} from './message-delivery'

describe('message delivery lifecycle', () => {
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
    expect([...MESSAGE_PENDING].sort()).toEqual([
      'dispatched',
      'reached-machine',
      'stored',
      'typed',
      'typing',
      'unknown',
    ])
  })

  it('parses exactly the declared statuses', () => {
    for (const status of MESSAGE_DELIVERY_STATUSES)
      expect(MessageDeliveryStatus.parse(status)).toBe(status)
    expect(MessageDeliveryStatus.safeParse('queued').success).toBe(false)
    expect(MessageDeliveryStatus.safeParse('delivered').success).toBe(false)
  })
})
