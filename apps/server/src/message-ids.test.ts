import { asSessionId, MessageId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { derivedMessageId, failureNoticeId, spawnPromptMessageId } from './message-ids'
import { noticeMessageId } from './steward'

// POD-4778: the ids the server mints for its own messages meet the one check
// every message id meets where a sender hands one in (POD-4763) — msg_ and a
// UUID — rather than widening it.
describe('server-derived message ids', () => {
  it('pass the boundary check for a message id', () => {
    for (const id of [
      failureNoticeId('msg_00000000-0000-4000-8000-000000000001'),
      spawnPromptMessageId(asSessionId('child')),
      derivedMessageId('anything at all'),
    ]) {
      expect(MessageId.safeParse(id).success, id).toBe(true)
    }
  })

  it('are the same on every attempt and differ between messages', () => {
    const a = 'msg_00000000-0000-4000-8000-000000000001'
    const b = 'msg_00000000-0000-4000-8000-000000000002'
    expect(failureNoticeId(a)).toBe(failureNoticeId(a))
    expect(failureNoticeId(a)).not.toBe(failureNoticeId(b))
    expect(spawnPromptMessageId(asSessionId('c1'))).not.toBe(spawnPromptMessageId(asSessionId('c2')))
    // A notice and a spawn prompt keyed by the same text are still two messages.
    expect(failureNoticeId('x')).not.toBe(spawnPromptMessageId(asSessionId('x')))
  })

  it("the steward's notice ids are unchanged by the shared derivation", () => {
    // Pinned from before the derivation moved here: a changed id would re-send
    // every steward notice already stored under the old one.
    expect(noticeMessageId('fact:1', asSessionId('s1'))).toBe('msg_cbdc6b42-3efb-525b-bea4-79bfad8369eb')
  })
})
