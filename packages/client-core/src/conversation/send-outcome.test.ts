import { describe, expect, it } from 'vitest'
import { assertSendAccepted } from './send-outcome'

describe('assertSendAccepted', () => {
  it('passes through undefined / bare success / ok:true', () => {
    expect(() => assertSendAccepted(undefined)).not.toThrow()
    expect(() => assertSendAccepted(null)).not.toThrow()
    expect(() => assertSendAccepted({})).not.toThrow()
    expect(() => assertSendAccepted({ disposition: 'queued' })).not.toThrow()
    expect(() => assertSendAccepted({ ok: true, disposition: 'accepted' })).not.toThrow()
    expect(() => assertSendAccepted({ ok: true, disposition: 'delivered' })).not.toThrow()
  })

  it('throws BAD_REQUEST for ok:false so the outbox dead-letters instead of applying', () => {
    expect(() =>
      assertSendAccepted({
        ok: false,
        reason: 'dead-lettered: session no longer exists',
        disposition: 'dead_letter',
      }),
    ).toThrow(/dead-lettered/)
    try {
      assertSendAccepted({ ok: false, reason: 'gone', disposition: 'dead_letter' })
    } catch (error) {
      expect((error as { data?: { code?: string } }).data?.code).toBe('BAD_REQUEST')
    }
  })

  it('throws a generic refusal when reason is missing', () => {
    expect(() => assertSendAccepted({ ok: false })).toThrow(/send refused/)
  })
})
