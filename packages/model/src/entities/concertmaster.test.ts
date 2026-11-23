import { describe, expect, it } from 'vitest'
import {
  compareConcertmasterEntries,
  concertmasterEntryId,
  concertmasterEntryRowId,
  concertmasterMessageIdOf,
  concertmasterResponseText,
  concertmasterUserEntryId,
  isConcertmasterResponseMessageId,
  parseConcertmasterEntryRowId,
} from './concertmaster'

describe('concertmaster entry ids', () => {
  const early = '2026-11-20T10:00:00.000Z'
  const late = '2026-11-20T10:00:01.000Z'

  it('sort in conversation order, whatever makes them unique', () => {
    const ids = [concertmasterEntryId(late, 'a'), concertmasterUserEntryId(early, 'msg_z')]
    expect([...ids].sort()).toEqual([ids[1], ids[0]])
    expect(
      compareConcertmasterEntries(
        { createdAt: early, entryId: ids[1]! },
        { createdAt: late, entryId: ids[0]! },
      ),
    ).toBeLessThan(0)
  })

  it('name the chat message a user entry records, and no other entry does', () => {
    expect(concertmasterMessageIdOf(concertmasterUserEntryId(early, 'msg_1_x'))).toBe('msg_1_x')
    expect(concertmasterMessageIdOf(concertmasterEntryId(early, 'ab12cd34'))).toBeUndefined()
    expect(concertmasterMessageIdOf('no-separator')).toBeUndefined()
  })

  it('derive one user entry id per message', () => {
    expect(concertmasterUserEntryId(early, 'm')).toBe(concertmasterUserEntryId(early, 'm'))
  })

  it('carry the session in the feed id and give it back', () => {
    const rowId = concertmasterEntryRowId('s1', concertmasterEntryId(early, 'a'))
    expect(parseConcertmasterEntryRowId(rowId)).toEqual({
      sessionId: 's1',
      entryId: concertmasterEntryId(early, 'a'),
    })
    expect(() => parseConcertmasterEntryRowId('only-one-part')).toThrow()
  })
})

describe('what the agent reads when an ask is settled', () => {
  const ask = { number: 3, body: 'Ship today?', askKind: 'decision' }

  it('names the ask and carries the words', () => {
    expect(concertmasterResponseText(ask, 'answered', 'Ship today')).toBe(
      'Answer to ask #3 (decision: "Ship today?"): Ship today',
    )
    expect(concertmasterResponseText({ ...ask, askKind: 'todo' }, 'done', undefined)).toBe(
      'Done: ask #3 (to-do: "Ship today?").',
    )
    expect(concertmasterResponseText(ask, 'dismissed', 'not now')).toContain('Reason: not now')
  })

  it('marks its message id so the conversation does not record it twice', () => {
    expect(isConcertmasterResponseMessageId('cmask:abc:1')).toBe(true)
    expect(isConcertmasterResponseMessageId('msg_abc')).toBe(false)
  })
})
