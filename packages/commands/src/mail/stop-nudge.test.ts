import { describe, expect, it } from 'vitest'
import { isMailNudge, mailAckNudge, mailUnreadNudge } from './stop-nudge'

describe('mail stop nudges', () => {
  it('recognises both nudges it builds', () => {
    expect(isMailNudge(mailUnreadNudge(1, []))).toBe(true)
    expect(isMailNudge(mailUnreadNudge(3, ['issue:#27', 'issue:#4']))).toBe(true)
    expect(isMailNudge(mailAckNudge([{ id: 'msg_1', from: 'issue:POD-1' }]))).toBe(true)
  })

  it('does not match other hook output', () => {
    expect(isMailNudge('write EPIPE')).toBe(false)
    expect(isMailNudge('You have 2 failing tests; fix them before stopping.')).toBe(false)
  })
})
