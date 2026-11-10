/**
 * NOTIFICATIONS REACH ONLY THEIR MEMBER (POD-6291, design gap 10).
 *
 * Alice (the first admin) and Bob each keep their own notification routing:
 * an ntfy topic, a Telegram binding. The routing is written through the real
 * `SettingsService` into the real settings repository, and `NotifyService` is
 * wired exactly as the relay wires it (`relay.ts`: `getSettings` resolves the
 * named member, else the first admin; the Telegram route is the member's own
 * binding). What a test then pushes is what production would push.
 */

import {
  type AgentRuntimeState,
  asSessionId,
  asUserId,
  firstAdminMemberId,
  type SessionId,
  type UserId,
} from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { EventBus } from '../bus'
import { SettingsService } from '../settings/service'
import { NotifyService, type SessionNoticeInfo } from './service'

const BOB = asUserId('mem_bob_notify')
const AT = '2026-11-04T09:00:00.000Z'

const blocked = (): AgentRuntimeState => ({
  phase: 'needs_user',
  since: AT,
  nativeSubagentCount: 0,
})
const info = (sessionId: SessionId, name: string): SessionNoticeInfo => ({
  sessionId,
  status: 'live',
  name,
  title: name,
  cwd: `/wt/${name}`,
  agentKind: 'claude-code',
})

interface Harness {
  store: SessionStore
  alice: UserId
  notify: NotifyService
  settings: SettingsService
  ntfy: Array<{ topic: string; title: string }>
  telegram: Array<{ ownerUserId: UserId; text: string }>
}

let h: Harness

/** Every session that holds a blocked state, with its owner, as the relay
 *  reads them from the database for a replay. */
let sessionStates: Array<{
  info: SessionNoticeInfo
  state: AgentRuntimeState
  ownerUserId: UserId
}> = []

beforeEach(async () => {
  const store = await openTestStore(':memory:')
  const alice = await firstAdminMemberId(store)
  await store.users.create(
    {
      id: BOB,
      displayName: 'Bob',
      email: 'bob@example.test',
      role: 'member',
      createdAt: AT,
      disabledAt: null,
    },
    'hash',
  )
  await store.secrets.set('notifications.telegramBotToken', 'bot-token', AT)
  const bus = new EventBus()
  const ntfy: Harness['ntfy'] = []
  const telegram: Harness['telegram'] = []
  // The relay's wiring (relay.ts, `new NotifyService`), with recording pushers.
  const notify = new NotifyService(
    {
      getSettings: async (ownerUserId?: UserId) =>
        await store.settings.getSettingsFor(ownerUserId ?? (await firstAdminMemberId(store))),
      telegramBotToken: async () =>
        await store.secrets.getOrEmpty('notifications.telegramBotToken'),
      telegramRouteAvailable: async (ownerUserId) =>
        (await store.telegramBindings.listForUser(ownerUserId)).length === 1,
      requestTelegram: async (request) => {
        telegram.push({ ownerUserId: request.ownerUserId, text: request.text })
      },
      appendEvent: () => {},
      now: () => Date.parse(AT),
      clients: () => [],
      sessionInfo: async (sessionId) =>
        sessionStates.find((s) => s.info.sessionId === sessionId)?.info,
      sessionStates: async () => sessionStates,
    },
    {
      ntfy: (topic, notice) => ntfy.push({ topic, title: notice.title }),
      telegram: () => {
        throw new Error('the relay routes Telegram per member, never through the blob')
      },
    },
    bus,
  )
  const settings = new SettingsService(store.settings, store.secrets, bus, {
    telegramBindings: { upsert: async () => {}, removeForUser: async () => {} },
    audit: { repo: { append: async () => {} }, now: () => AT },
    now: () => Date.parse(AT),
    modelProbe: { list: async () => [] } as never,
  })
  await settings.updatePreferences(alice, { 'notifications.ntfyTopic': 'alice-topic' })
  await settings.updatePreferences(BOB, { 'notifications.ntfyTopic': 'bob-topic' })
  ntfy.length = 0
  h = { store, alice, notify, settings, ntfy, telegram }
})

afterEach(async () => {
  sessionStates = []
  await h.store.close()
})

describe('a notice for Bob uses Bob’s routing, never Alice’s', () => {
  it('a subscription notice for Bob goes to Bob’s ntfy topic only', async () => {
    await h.notify.notifyExternal({ title: 'Podium: done', body: 'done fired' }, BOB)
    expect(h.ntfy).toEqual([{ topic: 'bob-topic', title: 'Podium: done' }])
  })

  it('Bob without a Telegram binding gets no Telegram notice, even when Alice has one', async () => {
    await h.store.telegramBindings.upsert({
      chatId: '4242',
      userId: h.alice,
      boundAt: AT,
      boundBy: { actor: { kind: 'user', id: h.alice }, onBehalfOf: h.alice },
    } as never)
    await h.notify.notifyExternal({ title: 'Podium: done', body: 'done fired' }, BOB)
    expect(h.telegram).toEqual([])
    await h.notify.notifyExternal({ title: 'Podium: done', body: 'done fired' }, h.alice)
    expect(h.telegram.map((t) => t.ownerUserId)).toEqual([h.alice])
  })
})

describe('a new target hears only about its own member’s sessions', () => {
  it('Alice entering a new ntfy topic replays her blocked sessions there, never Bob’s', async () => {
    sessionStates = [
      {
        info: info(asSessionId('alice-blocked'), 'alice-agent'),
        state: blocked(),
        ownerUserId: h.alice,
      },
      { info: info(asSessionId('bob-blocked'), 'bob-agent'), state: blocked(), ownerUserId: BOB },
    ]
    await h.settings.updatePreferences(h.alice, { 'notifications.ntfyTopic': 'alice-new-topic' })
    expect(h.ntfy.length).toBeGreaterThan(0)
    expect(h.ntfy.every((push) => push.topic === 'alice-new-topic')).toBe(true)
    expect(h.ntfy.some((push) => push.title.includes('alice-agent'))).toBe(true)
    expect(h.ntfy.some((push) => push.title.includes('bob-agent'))).toBe(false)
  })
})
