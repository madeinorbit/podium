/**
 * THE ONE WAY IN (POD-6881, spec §13): `emitNotice` and `resolveNotices` over
 * the real store, with the push recorded. Acceptance 2 (one open notice per key,
 * a new one after resolving, the count) and 8 (push only for the kinds the
 * person switched on, the notice's own words only, nothing for a duplicate).
 */

import {
  asUserId,
  type NoticePushPreferences,
  NoticePushPreferences as NoticePushSchema,
  type UserId,
} from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import {
  bindNoticeService,
  type EmitNoticeInput,
  emitNotice,
  NOTICE_BODY_MAX,
  NoticeService,
  READ_EVENT_NOTICES_KEPT,
  resolveNotices,
} from './emit'

const ALICE: UserId = asUserId('mem_notice_alice')
const BOB: UserId = asUserId('mem_notice_bob')

let store: SessionStore
let service: NoticeService
let pushed: { user: UserId; message: Record<string, unknown> }[]
let prefs: Map<UserId, NoticePushPreferences>
let unbind: () => void
let clock = 0

const defaults = (): NoticePushPreferences => NoticePushSchema.parse({})

function mention(over: Partial<EmitNoticeInput> = {}): EmitNoticeInput {
  return {
    recipientUserId: ALICE,
    kind: 'mention',
    subject: { kind: 'issue', id: 'iss_1', anchor: 'cmt_1' },
    title: 'Bob mentioned you on POD-1: Fix the sign-in',
    body: '@Alice can you look?',
    dedupeKey: `mention:cmt_1:${ALICE}`,
    ...over,
  }
}

beforeEach(async () => {
  store = await openTestStore(':memory:')
  pushed = []
  prefs = new Map()
  service = new NoticeService({
    notices: store.notices,
    pushPreferences: async (user) => prefs.get(user) ?? defaults(),
    push: async (user, message) => {
      pushed.push({ user, message: { ...message } })
    },
    now: () => new Date(Date.UTC(2026, 10, 13, 0, 0, clock++)).toISOString(),
  })
  unbind = bindNoticeService(service)
})

afterEach(async () => {
  unbind()
  await store.close()
})

describe('emitNotice and resolveNotices (acceptance 2)', () => {
  it('the same dedupeKey twice while unresolved gives one notice', async () => {
    await emitNotice(mention())
    await emitNotice(mention({ title: 'a second wording' }))

    const open = await service.list(ALICE, {})
    expect(open).toHaveLength(1)
    expect(open[0]?.title).toBe('Bob mentioned you on POD-1: Fix the sign-in')
    expect(await service.unreadCount(ALICE)).toBe(1)
  })

  it('after resolveNotices a new emit gives a new notice, and resolving removes it from the count', async () => {
    const key = 'credential-attention:cred_1'
    const attention = mention({
      kind: 'credential-attention',
      subject: { kind: 'credential', id: 'cred_1' },
      title: 'Work key needs attention',
      body: 'Renew it or pick another.',
      dedupeKey: key,
    })
    await emitNotice(attention)
    expect(await service.unreadCount(ALICE)).toBe(1)

    await resolveNotices(key)
    expect(await service.unreadCount(ALICE)).toBe(0)
    expect(await service.list(ALICE, {})).toEqual([])

    await emitNotice(attention)
    const open = await service.list(ALICE, {})
    expect(open).toHaveLength(1)
    expect(await service.unreadCount(ALICE)).toBe(1)
  })

  it('stores a long body cut to the limit', async () => {
    await emitNotice(mention({ body: 'x'.repeat(NOTICE_BODY_MAX + 50) }))
    expect((await service.list(ALICE, {}))[0]?.body).toHaveLength(NOTICE_BODY_MAX)
  })
})

describe('reading and the cap', () => {
  it('marks one notice read only for its recipient', async () => {
    await emitNotice(mention())
    const [notice] = await service.list(ALICE, {})
    expect(await service.markRead(BOB, notice?.noticeId ?? '')).toBe(false)
    expect(await service.unreadCount(ALICE)).toBe(1)
    expect(await service.markRead(ALICE, notice?.noticeId ?? '')).toBe(true)
    expect(await service.unreadCount(ALICE)).toBe(0)
    expect((await service.list(ALICE, {}))[0]?.readAt).toBeDefined()
  })

  it('mark all read clears the count and leaves another person’s alone', async () => {
    await emitNotice(mention())
    await emitNotice(mention({ dedupeKey: 'mention:cmt_2:alice' }))
    await emitNotice(mention({ recipientUserId: BOB, dedupeKey: 'mention:cmt_1:bob' }))

    expect(await service.markAllRead(ALICE)).toBe(2)
    expect(await service.unreadCount(ALICE)).toBe(0)
    expect(await service.unreadCount(BOB)).toBe(1)
  })

  it('keeps at most the cap of read event notices', async () => {
    for (let i = 0; i < READ_EVENT_NOTICES_KEPT + 2; i++) {
      await emitNotice(mention({ dedupeKey: `mention:cmt_${i}:alice` }))
    }
    await service.markAllRead(ALICE)
    expect(await service.list(ALICE, { limit: 200 })).toHaveLength(READ_EVENT_NOTICES_KEPT)
  })
})

describe('push by kind (acceptance 8)', () => {
  it('pushes a mention and a credential needing attention by default, and not a share', async () => {
    await emitNotice(mention())
    await emitNotice(
      mention({
        kind: 'credential-attention',
        subject: { kind: 'credential', id: 'cred_1' },
        dedupeKey: 'credential-attention:cred_1',
        title: 'Work key needs attention',
      }),
    )
    await emitNotice(
      mention({
        kind: 'credential-shared',
        subject: { kind: 'credential', id: 'cred_2' },
        dedupeKey: `credential-shared:cred_2:${ALICE}`,
        title: 'Bob gave you use of “Team key”',
      }),
    )
    expect(pushed.map((p) => p.message.title)).toEqual([
      'Bob mentioned you on POD-1: Fix the sign-in',
      'Work key needs attention',
    ])
  })

  it('pushes nothing for a kind the person switched off, and a share once switched on', async () => {
    prefs.set(ALICE, { ...defaults(), mention: false, credentialShared: true })
    await emitNotice(mention())
    await emitNotice(
      mention({
        kind: 'credential-shared',
        subject: { kind: 'credential', id: 'cred_2' },
        dedupeKey: `credential-shared:cred_2:${ALICE}`,
        title: 'Bob gave you use of “Team key”',
      }),
    )
    expect(pushed.map((p) => p.message.title)).toEqual(['Bob gave you use of “Team key”'])
  })

  it('pushes to the recipient only, once, with the notice’s title and body and nothing else', async () => {
    await emitNotice(mention())
    await emitNotice(mention())
    expect(pushed).toEqual([
      {
        user: ALICE,
        message: {
          title: 'Bob mentioned you on POD-1: Fix the sign-in',
          body: '@Alice can you look?',
        },
      },
    ])
  })

  it('a failed push leaves the notice and does not fail the emit', async () => {
    const failing = new NoticeService({
      notices: store.notices,
      pushPreferences: async () => defaults(),
      push: async () => {
        throw new Error('ntfy down')
      },
    })
    await expect(failing.emitNotice(mention())).resolves.toBeUndefined()
    expect(await failing.unreadCount(ALICE)).toBe(1)
  })
})

describe('the binding', () => {
  it('emitNotice without a bound service is refused, never dropped silently', async () => {
    unbind()
    await expect(emitNotice(mention())).rejects.toThrow(/no notice service/)
    unbind = bindNoticeService(service)
  })
})
