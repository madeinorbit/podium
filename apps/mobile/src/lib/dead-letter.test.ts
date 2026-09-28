import { describe, expect, it } from 'vitest'
import { deadLetteredOperatorMessages } from './dead-letter'

function row(over: Record<string, unknown> = {}) {
  return {
    from: 'operator',
    to: 'session:s1',
    status: 'dead_letter',
    id: 'm1',
    body: 'hello',
    createdAt: '2026-09-13T18:00:00.000Z',
    ...over,
  }
}

describe('mobile dead-lettered operator messages [POD-4704]', () => {
  it('says delivery failed, never target gone, for an unconfirmed send', () => {
    const [message] = deadLetteredOperatorMessages(
      [row({ deliveryDeferredReason: 'delivery-failed', deliveredTo: 's1' })],
      's1',
    )
    expect(message?.failure).toBe('not delivered · delivery failed')
    expect(message?.failure).not.toContain('target gone')
  })

  it('keeps target gone only for a target that is really gone', () => {
    const [message] = deadLetteredOperatorMessages([row({})], 's1')
    expect(message?.failure).toBe('dead-lettered · target gone')
  })

  it('ignores non-operator and non-dead-letter rows', () => {
    expect(deadLetteredOperatorMessages([], 's1')).toEqual([])
    expect(
      deadLetteredOperatorMessages(
        [row({ from: 'agent' }), row({ status: 'queued' }), row({ to: 'session:s2' })],
        's1',
      ),
    ).toEqual([])
  })
})
