// The uuid a Podium message is typed into Claude under (POD-4836): derived
// from the message id alone, so every attempt at the same message names the
// same history entry.

import { describe, expect, it } from 'vitest'
import { claudeUserMessageUuid } from './message-uuid.js'

describe('the uuid a message is recorded under', () => {
  it('is the uuid inside a msg_<uuid> id', () => {
    expect(claudeUserMessageUuid('msg_0190f2a4-7c1e-7d3a-9b5e-2f6c8d4a1e70')).toBe(
      '0190f2a4-7c1e-7d3a-9b5e-2f6c8d4a1e70',
    )
    // The CLI keeps the uuid as written; one spelling per message.
    expect(claudeUserMessageUuid('msg_0190F2A4-7C1E-7D3A-9B5E-2F6C8D4A1E70')).toBe(
      '0190f2a4-7c1e-7d3a-9b5e-2f6c8d4a1e70',
    )
  })

  it('is a name-based (v5) uuid of any other id, under the one Podium namespace', () => {
    // Expected values computed independently: Python's uuid.uuid5 with the
    // namespace ee7e95f7-1bbc-4891-a7d6-c03a59a7afcd.
    expect(claudeUserMessageUuid('notice:POD-4720:mail:7')).toBe(
      '419b4e99-edd7-51fc-aa7f-cc0e93a66a13',
    )
    expect(claudeUserMessageUuid('msg_not-a-uuid')).toBe('737cdda5-2b10-5168-96ad-df81cf7fb31d')
    // Something after the uuid makes it another id, not that uuid.
    expect(claudeUserMessageUuid('MSG_0190F2A4-7C1E-7D3A-9B5E-2F6C8D4A1E70x')).toBe(
      'a0883de1-6825-572c-b6ad-0be7fb72a2ec',
    )
  })

  it('is the same on every call, and differs between messages', () => {
    const first = claudeUserMessageUuid('notice:a')
    expect(claudeUserMessageUuid('notice:a')).toBe(first)
    expect(claudeUserMessageUuid('notice:b')).not.toBe(first)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
