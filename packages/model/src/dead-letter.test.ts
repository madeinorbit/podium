import { describe, expect, it } from 'vitest'
import { deadLetterDeliveryLine, deadLetterSenderGloss } from './dead-letter'

describe('shared dead-letter wording [POD-4704]', () => {
  it('says delivery failed, never target gone, for an injected-but-unconfirmed row', () => {
    expect(deadLetterDeliveryLine('delivery-failed')).toBe('not delivered · delivery failed')
    expect(deadLetterDeliveryLine('delivery-failed')).not.toContain('target gone')
    expect(deadLetterSenderGloss('delivery-failed')).toContain('delivery failed')
    expect(deadLetterSenderGloss('delivery-failed')).not.toMatch(/target (was )?gone/)
  })

  it('keeps target gone only for a target that is really gone (no cause)', () => {
    expect(deadLetterDeliveryLine(null)).toBe('dead-lettered · target gone')
    expect(deadLetterDeliveryLine(undefined)).toBe('dead-lettered · target gone')
    expect(deadLetterSenderGloss(null)).toContain('target was gone')
    expect(deadLetterSenderGloss(undefined)).toContain('target was gone')
  })

  it('keeps the drain arms worded as before', () => {
    expect(deadLetterDeliveryLine('never-live')).toBe(
      'not delivered · session never became ready',
    )
    expect(deadLetterDeliveryLine('teardown')).toBe('not delivered · session torn down')
    expect(deadLetterSenderGloss('never-live')).toContain('never became ready')
    expect(deadLetterSenderGloss('teardown')).toContain('torn down')
  })
})
