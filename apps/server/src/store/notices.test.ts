/**
 * NoticesRepository (POD-6881, spec §13): one open notice per person and key,
 * resolution by key, reads and marks scoped to the recipient, the cap on read
 * event notices, and the change-log commit every write runs as.
 */

import { asUserId, type UserId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { credentialStorageRows } from '../test-support/credential-storage-rows'
import { openTestStore } from '../test-support/open-test-store'
import type { NewNotice, NoticeRow, NoticesRepository } from './notices'

const ALICE: UserId = asUserId('mem_alice')
const BOB: UserId = asUserId('mem_bob')

let store: SessionStore
let notices: NoticesRepository
let captured: NoticeRow[][]
let seq = 0

const T = (n: number) => `2026-11-13T00:00:${String(n).padStart(2, '0')}.000Z`

function notice(over: Partial<NewNotice> = {}): NewNotice {
  seq += 1
  return {
    id: `ntc_${seq}`,
    recipientUserId: ALICE,
    kind: 'mention',
    subjectKind: 'issue',
    subjectId: 'iss_1',
    subjectAnchor: `cmt_${seq}`,
    title: `Bob mentioned you (${seq})`,
    body: 'hello',
    dedupeKey: `mention:cmt_${seq}:${ALICE}`,
    createdAt: T(seq),
    ...over,
  }
}

async function rowCount(): Promise<number> {
  return (await credentialStorageRows(store, 'notices')).length
}

beforeEach(async () => {
  seq = 0
  store = await openTestStore(':memory:')
  notices = store.notices
  captured = []
  // The change-log commit every write runs as (POD-6920), here recording the
  // rows each write returned; a write that changed nothing returns none.
  notices.setFeedCapture(async (write) => {
    const result = await write()
    const rows = result as readonly NoticeRow[]
    if (rows.length > 0) captured.push([...rows])
    return result
  })
})

afterEach(async () => await store.close())

describe('NoticesRepository', () => {
  it('keeps one open notice per person and key', async () => {
    const first = await notices.open(notice({ dedupeKey: 'credential-attention:cred_1' }))
    const second = await notices.open(
      notice({ dedupeKey: 'credential-attention:cred_1', title: 'again' }),
    )

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.notice.id).toBe(first.notice.id)
    expect(second.notice.title).toBe(first.notice.title)
    expect(await rowCount()).toBe(1)
    expect(captured).toHaveLength(1)
  })

  it('opens the same key separately for two people', async () => {
    await notices.open(notice({ dedupeKey: 'k' }))
    const bobs = await notices.open(notice({ dedupeKey: 'k', recipientUserId: BOB }))
    expect(bobs.created).toBe(true)
    expect(await rowCount()).toBe(2)
  })

  it('resolves every open notice of a key, then opens a new one for the next emit', async () => {
    await notices.open(notice({ dedupeKey: 'k' }))
    await notices.open(notice({ dedupeKey: 'k', recipientUserId: BOB }))

    const resolved = await notices.resolveByKey('k', T(50))
    expect(resolved.map((r) => r.recipientUserId).sort()).toEqual([ALICE, BOB])
    expect(resolved.every((r) => r.resolvedAt === T(50))).toBe(true)
    expect(await notices.countUnread(ALICE)).toBe(0)
    expect(await notices.listOpen(ALICE, { limit: 10 })).toEqual([])

    const again = await notices.open(notice({ dedupeKey: 'k' }))
    expect(again.created).toBe(true)
    expect(await rowCount()).toBe(3)
    expect(await notices.countUnread(ALICE)).toBe(1)
  })

  it('a resolve of a key with nothing open changes nothing and captures nothing', async () => {
    expect(await notices.resolveByKey('none', T(1))).toEqual([])
    expect(captured).toEqual([])
  })

  it('lists only the recipient’s open notices, newest first, in pages', async () => {
    const a1 = await notices.open(notice())
    const a2 = await notices.open(notice())
    await notices.open(notice({ recipientUserId: BOB }))
    const a3 = await notices.open(notice())

    const page1 = await notices.listOpen(ALICE, { limit: 2 })
    expect(page1.map((n) => n.id)).toEqual([a3.notice.id, a2.notice.id])
    const last = page1[1] as NoticeRow
    const page2 = await notices.listOpen(ALICE, {
      limit: 2,
      before: { createdAt: last.createdAt, id: last.id },
    })
    expect(page2.map((n) => n.id)).toEqual([a1.notice.id])
  })

  it('marks one notice read only for its recipient', async () => {
    const mine = await notices.open(notice())

    expect(await notices.markRead(BOB, mine.notice.id, T(40))).toBeNull()
    expect(await notices.countUnread(ALICE)).toBe(1)

    const read = await notices.markRead(ALICE, mine.notice.id, T(41))
    expect(read?.readAt).toBe(T(41))
    expect(await notices.countUnread(ALICE)).toBe(0)
    // Marking it again changes nothing.
    expect(await notices.markRead(ALICE, mine.notice.id, T(42))).toBeNull()
  })

  it('marks all of one person’s notices read and leaves the other person’s alone', async () => {
    await notices.open(notice())
    await notices.open(notice())
    await notices.open(notice({ recipientUserId: BOB }))

    const changed = await notices.markAllRead(ALICE, T(40))
    expect(changed).toHaveLength(2)
    expect(await notices.countUnread(ALICE)).toBe(0)
    expect(await notices.countUnread(BOB)).toBe(1)
  })

  it('resolves the oldest read event notices beyond the cap, never unread or condition ones', async () => {
    const old1 = await notices.open(notice())
    const old2 = await notices.open(notice())
    const recent = await notices.open(notice())
    const condition = await notices.open(
      notice({ kind: 'credential-attention', dedupeKey: 'credential-attention:cred_1' }),
    )
    const unread = await notices.open(notice())
    for (const n of [old1, old2, recent, condition]) {
      await notices.markRead(ALICE, n.notice.id, T(45))
    }

    const resolved = await notices.resolveReadEventsBeyond(ALICE, 1, T(50))
    expect(resolved.map((r) => r.id).sort()).toEqual([old1.notice.id, old2.notice.id].sort())
    const open = (await notices.listOpen(ALICE, { limit: 10 })).map((n) => n.id)
    expect(open).toEqual([unread.notice.id, condition.notice.id, recent.notice.id])
  })

  it('hands every changed row to the feed capture inside the write', async () => {
    const opened = await notices.open(notice())
    await notices.markRead(ALICE, opened.notice.id, T(40))
    await notices.resolveByKey(opened.notice.dedupeKey, T(41))

    expect(captured.map((rows) => rows.map((r) => [r.id, r.readAt, r.resolvedAt]))).toEqual([
      [[opened.notice.id, null, null]],
      [[opened.notice.id, T(40), null]],
      [[opened.notice.id, T(40), T(41)]],
    ])
  })

  it('a failing capture rolls the write back', async () => {
    notices.setFeedCapture(async (write) => {
      await write()
      throw new Error('feed down')
    })
    await expect(notices.open(notice())).rejects.toThrow('feed down')
    expect(await rowCount()).toBe(0)
  })
})
