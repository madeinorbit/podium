import { describe, expect, it } from 'vitest'
import { mailSendOutcomeText, pendingSendNote } from './commands'

// POD-4778: a sender does not have to poll. Every send still on its way says
// that a failure will be told to it, and where it stands meanwhile.
describe('issue mail send outcome', () => {
  it('a message on its way says a failure will be told', () => {
    expect(mailSendOutcomeText('POD-7', 'msg_1', 'queued')).toBe(
      'mail QUEUED for POD-7 (msg_1) — on its way, NOT yet confirmed; ' +
        "if it cannot be delivered you will be told at your next turn — 'podium mail status msg_1' shows where it is",
    )
    expect(mailSendOutcomeText('POD-7', 'msg_1', 'held')).toContain(pendingSendNote('msg_1'))
    expect(mailSendOutcomeText('POD-7', 'msg_1', 'spawning')).toContain(pendingSendNote('msg_1'))
  })

  it('an older server’s word reads as on its way, never as a finished send', () => {
    expect(mailSendOutcomeText('POD-7', 'msg_1', 'accepted')).toBe(
      mailSendOutcomeText('POD-7', 'msg_1', 'queued'),
    )
  })

  it('a confirmed message has nothing to wait for', () => {
    expect(mailSendOutcomeText('POD-7', 'msg_1', 'delivered')).toBe(
      'mail DELIVERED to POD-7 (msg_1) — confirmed in the recipient’s context',
    )
  })
})
