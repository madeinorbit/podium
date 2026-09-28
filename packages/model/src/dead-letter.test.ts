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

  it('words never-live as the agent not accepting input, never a deadline [POD-4775]', () => {
    expect(deadLetterDeliveryLine('never-live')).toBe('not delivered · agent not accepting input')
    expect(deadLetterSenderGloss('never-live')).toContain('the agent was not accepting input')
    expect(deadLetterSenderGloss('never-live')).not.toMatch(/deadline|target (was )?gone/)
  })

  it('never claims a failed row was typed [POD-4775]', () => {
    // Typed-but-unproven is `unknown` now, never failed, so no failed gloss
    // may say it was typed.
    for (const cause of ['never-live', 'teardown', 'delivery-failed', null]) {
      expect(deadLetterSenderGloss(cause)).not.toMatch(/typed but/)
    }
  })

  it('keeps teardown worded as before', () => {
    expect(deadLetterDeliveryLine('teardown')).toBe('not delivered · session torn down')
    expect(deadLetterSenderGloss('teardown')).toContain('torn down')
  })
})
