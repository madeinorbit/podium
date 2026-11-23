/**
 * DEVICE-MINTED IDS (ADR 12 D4, POD-6391): a record's id is its kind's prefix
 * plus a random UUID, minted on the device. The server accepts nothing else at a
 * create, and above all nothing that looks like a human ref.
 */

import { describe, expect, it } from 'vitest'
import { deviceIdSchema, mintDeviceId, NewIssueId, NewSessionId } from './device-id'

const UUID = '3b241101-e2bb-4255-8caf-4136c566a962'

describe('a device-minted id', () => {
  it('is the prefix and a random (v4) UUID', () => {
    expect(NewIssueId.safeParse(`iss_${UUID}`).success).toBe(true)
    expect(NewSessionId.safeParse(UUID).success).toBe(true)
  })

  it('round-trips what the mint makes', () => {
    expect(NewIssueId.safeParse(mintDeviceId('iss_')).success).toBe(true)
    expect(NewSessionId.safeParse(mintDeviceId('')).success).toBe(true)
  })

  it('refuses human refs and display numbers', () => {
    for (const ref of ['#12', 'POD-12', 'POD-6241', '12', 'iss_12']) {
      expect(NewIssueId.safeParse(ref).success, ref).toBe(false)
    }
  })

  it('refuses another prefix, no prefix, or a body that is not a v4 UUID', () => {
    for (const value of [
      UUID,
      `ses_${UUID}`,
      `iss_${UUID.toUpperCase()}`,
      `iss_${UUID}x`,
      ` iss_${UUID}`,
      // A v1 UUID: time-based, not random.
      'iss_3b241101-e2bb-1255-8caf-4136c566a962',
      'iss_not-a-uuid',
    ]) {
      expect(NewIssueId.safeParse(value).success, value).toBe(false)
    }
    expect(NewSessionId.safeParse(`iss_${UUID}`).success).toBe(false)
  })

  it('refuses a prefix that breaks the id prefix rule', () => {
    expect(() => deviceIdSchema('Iss_' as 'iss_')).toThrow(/prefix/)
    expect(() => deviceIdSchema('issue' as 'iss_')).toThrow(/prefix/)
  })
})
