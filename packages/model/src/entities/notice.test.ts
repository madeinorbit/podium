import { describe, expect, it } from 'vitest'
import { asUserId } from '../ids'
import { ENTITY_KINDS } from '../ids/keys'
import {
  findMentions,
  isEventNoticeKind,
  NOTICE_KINDS,
  NoticeWire,
  noticeRowId,
  parseNoticeRowId,
} from './notice'

const alice = { id: asUserId('mem_alice'), displayName: 'Alice' }
const al = { id: asUserId('mem_al'), displayName: 'Al' }
const bob = { id: asUserId('mem_bob'), displayName: 'Bob Stone' }
const members = [al, alice, bob]

describe('notice record', () => {
  it('names the three kinds of this epic, and which are events', () => {
    expect(NOTICE_KINDS).toEqual(['mention', 'credential-attention', 'credential-shared'])
    expect(isEventNoticeKind('mention')).toBe(true)
    expect(isEventNoticeKind('credential-shared')).toBe(true)
    expect(isEventNoticeKind('credential-attention')).toBe(false)
  })

  it('can be about a credential', () => {
    expect(ENTITY_KINDS).toContain('credential')
  })

  it('round-trips its feed id, which names the recipient first', () => {
    const id = noticeRowId(asUserId('mem_alice'), 'ntc_1')
    expect(parseNoticeRowId(id)).toEqual({ userId: 'mem_alice', noticeId: 'ntc_1' })
    expect(() => parseNoticeRowId('ntc_1')).toThrow()
  })

  it('parses a wire row with an unknown kind, so an older client survives a newer server', () => {
    const row = NoticeWire.parse({
      noticeId: 'ntc_1',
      recipientUserId: 'mem_alice',
      kind: 'some-later-kind',
      subjectKind: 'issue',
      subjectId: 'iss_1',
      title: 'Bob mentioned you',
      createdAt: '2026-11-13T00:00:00.000Z',
    })
    expect(row.kind).toBe('some-later-kind')
    expect(row.readAt).toBeUndefined()
  })
})

describe('findMentions', () => {
  it('matches a display name after @, case-insensitively', () => {
    expect(findMentions('hey @alice, look', members)).toEqual(['mem_alice'])
  })

  it('takes the longest name, so @Alice is not @Al', () => {
    expect(findMentions('@Alice and @Al', members)).toEqual(['mem_alice', 'mem_al'])
  })

  it('matches a name with a space', () => {
    expect(findMentions('ping @Bob Stone please', members)).toEqual(['mem_bob'])
  })

  it('needs a word boundary after the name', () => {
    expect(findMentions('@Alfred is not here', members)).toEqual([])
  })

  it('ignores a name that is no member', () => {
    expect(findMentions('@Zed hi', members)).toEqual([])
  })

  it('ignores an e-mail address', () => {
    expect(findMentions('mail alice@alice.example', members)).toEqual([])
  })

  it('lists each member once', () => {
    expect(findMentions('@Alice @alice @ALICE', members)).toEqual(['mem_alice'])
  })

  it('mentions every member who carries an ambiguous name', () => {
    const twin = { id: asUserId('mem_alice2'), displayName: 'Alice' }
    expect(findMentions('@Alice', [...members, twin])).toEqual(['mem_alice', 'mem_alice2'])
  })
})
