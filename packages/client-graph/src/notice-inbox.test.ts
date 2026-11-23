/**
 * The inbox reads the tray and the phone share (POD-6881): newest first, the
 * unread count, a notice leaving the pool, and where opening one goes.
 */

import { asUserId, type NoticeWire, noticeRowId } from '@podium/model'
import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { here } from './lookup'
import { inboxNoticeIds, noticeDestination, unreadNoticeCount } from './notice-inbox'
import { MobxPool } from './pool'

const ME = asUserId('mem_me')

const notice = (noticeId: string, patch: Partial<NoticeWire> = {}) => {
  const value: NoticeWire = {
    noticeId,
    recipientUserId: ME,
    kind: 'mention',
    subjectKind: 'issue',
    subjectId: 'iss_1',
    subjectAnchor: `cmt_${noticeId}`,
    title: `Bob mentioned you (${noticeId})`,
    createdAt: '2026-11-13T00:00:00.000Z',
    ...patch,
  }
  const id = noticeRowId(ME, noticeId)
  return { kind: 'inboxNotice' as const, id, value: { ...value, id } as never }
}

const newPool = () =>
  new MobxPool({ selectedIssueId: null, coarseNow: Date.parse('2026-11-13') }, undefined, {
    load: () => undefined,
    schedule: () => () => {},
  })

it('lists my notices newest first and counts the unread ones', () => {
  const pool = newPool()
  try {
    pool.apply({
      type: 'replace',
      rows: [
        notice('a', { createdAt: '2026-11-13T00:00:01.000Z' }),
        notice('b', { createdAt: '2026-11-13T00:00:03.000Z', readAt: '2026-11-13T00:00:04.000Z' }),
        notice('c', { createdAt: '2026-11-13T00:00:02.000Z' }),
      ],
    })
    expect(inboxNoticeIds(pool)).toEqual(['b', 'c', 'a'].map((n) => noticeRowId(ME, n)))
    expect(unreadNoticeCount(pool)).toBe(2)
    const model = here(pool.model('inboxNotice', noticeRowId(ME, 'b')))
    expect(model?.unread).toBe(false)
    expect(model?.title).toBe('Bob mentioned you (b)')
  } finally {
    pool.dispose()
  }
})

it('moves the count when a notice is read or leaves', () => {
  const pool = newPool()
  const seen: number[] = []
  const stop = autorun(() => {
    seen.push(unreadNoticeCount(pool))
  })
  try {
    pool.apply({ type: 'replace', rows: [notice('a'), notice('b')] })
    pool.apply({
      type: 'update',
      rows: [notice('a', { readAt: '2026-11-13T00:01:00.000Z' })],
    })
    pool.apply({ type: 'update', rows: [{ ...notice('b'), value: undefined as never }] })
    expect(seen).toEqual([0, 2, 1, 0])
    expect(inboxNoticeIds(pool)).toEqual([noticeRowId(ME, 'a')])
  } finally {
    stop()
    pool.dispose()
  }
})

it('opens a mention at its comment, a session, a credential, and nothing for an unknown subject', () => {
  expect(
    noticeDestination({ subjectKind: 'issue', subjectId: 'iss_1', subjectAnchor: 'cmt_1' }),
  ).toEqual({
    kind: 'issue',
    issueId: 'iss_1',
    commentId: 'cmt_1',
  })
  expect(noticeDestination({ subjectKind: 'session', subjectId: 'sess_1' })).toEqual({
    kind: 'session',
    sessionId: 'sess_1',
  })
  expect(noticeDestination({ subjectKind: 'credential', subjectId: 'cred_1' })).toEqual({
    kind: 'credential',
    credentialId: 'cred_1',
  })
  expect(noticeDestination({ subjectKind: 'later-kind', subjectId: 'x' })).toEqual({ kind: 'none' })
})
