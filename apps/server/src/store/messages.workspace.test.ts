/**
 * MAIL AND MESSAGING ARE A WORKSPACE'S (POD-6959 design 2.4, 2.5; task POD-7017).
 *
 * Two workspaces over one database of the run's engine (`openMessageStoreSlices`), each seeded through its own
 * repositories with its own sessions, messages, read receipts, wake cooldowns, chat topics,
 * chat attachments, Telegram bindings and notification facts.
 * Both workspaces hold the SAME ids and natural keys (POD-7025): the same sessions, messages,
 * issues, chat, thread, cooldown key, fact keys and people. Every key leads with workspace_id
 * (POD-7024), so the same id is two rows, told apart only by the workspace. The content
 * differs (message bodies, timestamps, which message a session read, the superagent thread,
 * a fact's source), so a read that crossed over would answer the other workspace's content.
 * Where a case needs an id the other workspace does not hold, it plants one only the other
 * holds (`only-<tag>…`).
 *
 * For every repository method of the group (messages, messaging topics, messaging session
 * attachments, Telegram bindings, notification facts):
 *   - a read answers only its own workspace's rows, including the reads no id narrows (the
 *     operator's mail, the queue, the chat feed, every binding, the expired facts);
 *   - an update, delete or upsert in one workspace leaves the other's rows unchanged, both for
 *     the ids the two share and for ids only the other holds, which must find nothing to change.
 */

import { asIssueId, asThreadId, asUserId } from '@podium/model'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  openMessageStoreSlices,
  type WorkspaceMessageSlice,
} from '../test-support/message-store-slice'
import {
  ALICE,
  AT,
  AT_OF,
  body,
  CHAT,
  COOLDOWN,
  EARLIER,
  fact,
  ITEM,
  iss,
  LATER,
  message,
  mid,
  NOW,
  onlyMessage,
  otherOf,
  plantOnlyMessage,
  receipt,
  rowsOf,
  scope,
  seed,
  seedMessages,
  sid,
  TABLES,
  TARGET,
  type Tag,
  THREAD,
  WS,
} from '../test-support/workspace-seeds/messages'

let opened: WorkspaceMessageSlice | undefined

afterEach(async () => {
  await opened?.close()
  opened = undefined
})

async function twoSeeded(): Promise<readonly [WorkspaceMessageSlice, WorkspaceMessageSlice]> {
  const stores = await openMessageStoreSlices([WS.a, WS.b])
  opened = stores[0]
  await seed(stores[0], 'a')
  await seed(stores[1], 'b')
  return stores
}

/** The sorted ids of `rows`, each held to its own workspace's body: the ids are the same in
 *  both workspaces, so the body is what tells a crossed-over row. */
function ids(rows: Iterable<{ id: string; body: string }>, tag: Tag): string[] {
  const list = [...rows]
  for (const row of list) expect(row.body, row.id).toBe(body(tag, row.id))
  return list.map((row) => row.id).sort()
}
const own = (...ns: number[]) => ns.map((n) => mid(n)).sort()
const sharedIds = [1, 2, 3, 4, 5].map((n) => mid(n))
/** No content of the other workspace anywhere in `value`. */
function onlyOwn(value: unknown, tag: Tag): void {
  const other = otherOf(tag)
  const text = JSON.stringify(value)
  expect(text).not.toMatch(
    new RegExp(`"${other} |\\b${other}-(thread-sa|source)|only-${other}|"${WS[other]}"`),
  )
  expect(text).not.toContain(AT_OF[other])
}

describe('the group writes every row under its own workspace', () => {
  it('seeds each table in both workspaces, each with only its own content', async () => {
    const [a] = await twoSeeded()
    for (const tag of ['a', 'b'] as const) {
      const rows = await rowsOf(a, tag)
      for (const table of TABLES) {
        expect({ table, rows: rows[table]!.length > 0 }).toEqual({ table, rows: true })
        onlyOwn(rows[table], tag)
      }
    }
  })
})

describe('the messages repository reads only its own workspace', () => {
  it('answers the reads by id and by principal with its own rows', async () => {
    const stores = await twoSeeded()
    for (const [store, tag] of [
      [stores[0], 'a'],
      [stores[1], 'b'],
    ] as const) {
      const m = store.messages
      expect((await m.getMessage(mid(1)))?.body).toBe(body(tag, mid(1)))
      expect(ids(await m.getMessages(sharedIds), tag)).toEqual(own(1, 2, 3, 4, 5))
      expect(ids(await m.getTranscriptAttachmentMessages(sid(1), [ITEM]), tag)).toEqual([mid(2)])
      expect(ids(await m.listMessagesFor({ kind: 'operator' }), tag)).toEqual([mid(5)])
      expect(ids(await m.listMessagesFor({ kind: 'issue', id: iss(1) }), tag)).toEqual([mid(1)])
      expect(ids(await m.pendingForSessionProof(sid(1), NOW), tag)).toEqual(own(2, 3))
      const proofs = await m.pendingForSessionsProof([sid(1), sid(2)], NOW)
      expect(ids(proofs.get(sid(1)) ?? [], tag)).toEqual(own(2, 3))
      expect(ids(await m.listLedger({ issueId: iss(1), sessionId: sid(1) }), tag)).toEqual(
        own(1, 2, 3, 4),
      )
      expect(await m.queuedPositionForSession(sid(1), mid(2))).toBe(1)
      expect(
        await m.pendingTargets([
          { kind: 'issue', id: iss(1) },
          { kind: 'issue', id: iss(2) },
        ]),
      ).toEqual([true, false])
      const pages = await m.pendingForPages([
        { to: { kind: 'issue', id: iss(1) } },
        { to: { kind: 'issue', id: iss(2) } },
      ])
      expect(pages.map((page) => ids(page, tag))).toEqual([[mid(1)], []])
      expect((await m.latestPendingOperatorForSession(sid(1)))?.body).toBe(body(tag, mid(2)))
    }
  })

  it('answers the counts and summaries with its own rows', async () => {
    const stores = await twoSeeded()
    await plantOnlyMessage(stores[0], 'a')
    await plantOnlyMessage(stores[1], 'b')
    const candidates = [...sharedIds, onlyMessage('a'), onlyMessage('b')]
    for (const [store, tag] of [
      [stores[0], 'a'],
      [stores[1], 'b'],
    ] as const) {
      const m = store.messages
      const other = otherOf(tag)
      const systemSender = { fromKind: 'system', fromIssue: null, fromSession: null }
      expect(await m.listPendingSenders({ kind: 'operator' })).toEqual([systemSender])
      expect(await m.pendingSummary({ kind: 'operator' })).toEqual({
        count: 1,
        senders: [systemSender],
      })
      expect(await m.countPending({ kind: 'operator' })).toBe(1)
      expect(await m.countPending({ kind: 'issue', id: iss(1) })).toBe(1)
      const queued = await m.listQueued()
      expect(ids(queued, tag)).toEqual(own(1, 2, 4, 5))
      expect(await m.countQueued()).toBe(queued.length)
      expect(ids(await m.listQueuedPage({ limit: 10 }), tag)).toEqual(own(1, 2, 4, 5))
      expect([...(await m.existingMessageIds(candidates))].sort()).toEqual(
        [...own(1, 2, 3, 4, 5), onlyMessage(tag)].sort(),
      )
      // Each workspace's s1 read a different message of the same ids.
      expect([...(await m.readReceipts(sid(1), [mid(1), mid(5)]))]).toEqual([receipt(tag)])
      expect([...(await m.selfSentIds(sid(1), candidates))].sort()).toEqual(
        [...own(1, 4), onlyMessage(tag)].sort(),
      )
      expect([...(await m.selfSentIds(sid(1), [onlyMessage(other)]))]).toEqual([])
      const fromS1 = { fromKind: 'agent', fromIssue: iss(2), fromSession: sid(1) }
      expect(await m.pendingSummaryForSession(iss(1), sid(2))).toEqual({
        count: 1,
        senders: [fromS1],
      })
      expect(await m.countPendingForSession(iss(1), sid(2))).toBe(1)
      expect(await m.listPendingSendersForSession(iss(1), sid(2))).toEqual([fromS1])
      expect(await m.alreadyCommunicated(iss(2), { kind: 'issue', id: iss(1) }, EARLIER)).toBe(true)
    }
  })

  it('answers the delivery, chat feed and cooldown reads with its own rows', async () => {
    const stores = await twoSeeded()
    for (const [store, tag] of [
      [stores[0], 'a'],
      [stores[1], 'b'],
    ] as const) {
      const m = store.messages
      expect(ids(await m.listOpenBoundTo([sid(1), sid(2)]), tag)).toEqual(own(2, 4))
      expect(ids(await m.listOpenChat(), tag)).toEqual([mid(2)])
      expect(ids(await m.confirmedChatWindow(10), tag)).toEqual([mid(3)])
      for (const liveness of ['live', 'any'] as const) {
        expect(ids(await m.confirmedChatTail(10, [sid(1)], liveness), tag)).toEqual([mid(3)])
      }
      expect(await m.getWakeCooldown(COOLDOWN)).toBe(AT_OF[tag])
      expect([...(await m.getWakeCooldowns([COOLDOWN]))]).toEqual([[COOLDOWN, AT_OF[tag]]])
      expect(ids(await m.pendingDeliveredToPage(sid(2)), tag)).toEqual([mid(4)])
      expect(ids(await m.listDeliveredUnacked(sid(1), NOW), tag)).toEqual([mid(3)])
      expect(ids(await m.listSettleNotifiable(sid(1), NOW), tag)).toEqual([mid(3)])
    }
  })
})

describe('the messaging repositories read only their own workspace', () => {
  it('answers topic, attachment, binding and fact reads with its own rows', async () => {
    const stores = await twoSeeded()
    // A fact only each workspace holds.
    for (const [store, tag] of [
      [stores[0], 'a'],
      [stores[1], 'b'],
    ] as const) {
      await store.notificationFacts.claim({
        factKey: `only-${tag}:fact`,
        target: TARGET,
        source: null,
        issueId: null,
        createdAt: AT_OF[tag],
        expiresAt: LATER,
      })
    }
    for (const [store, tag] of [
      [stores[0], 'a'],
      [stores[1], 'b'],
    ] as const) {
      const other = otherOf(tag)
      const at = AT_OF[tag]
      const topics = store.messagingTopics
      const topic = {
        issueId: iss(1),
        chatId: CHAT,
        threadRef: THREAD,
        superagentThreadId: `${tag}-thread-sa`,
        updatedAt: at,
      }
      expect(await topics.listForChat(CHAT)).toEqual([topic])
      expect(await topics.getByIssue(CHAT, iss(1))).toEqual(topic)
      expect(await topics.getByThreadRef(CHAT, THREAD)).toEqual(topic)

      const attachments = store.messagingSessionAttachments
      const attachment = {
        chatId: CHAT,
        threadRef: '',
        userId: ALICE,
        sessionId: sid(1),
        attachedAt: at,
        relayedItemId: null,
      }
      expect(await attachments.get(CHAT, '')).toEqual(attachment)
      expect(await attachments.listForSession(sid(1))).toEqual([attachment])

      const bindings = store.telegramBindings
      const binding = {
        chatId: CHAT,
        userId: ALICE,
        boundAt: at,
        boundBy: { actor: { kind: 'user', id: ALICE }, onBehalfOf: null },
      }
      expect(await bindings.list()).toEqual([binding])
      expect(await bindings.listForUser(ALICE)).toEqual([binding])

      const facts = store.notificationFacts
      expect(await facts.hasActive(fact(1), TARGET, NOW)).toBe(true)
      expect(await facts.hasActive(`only-${tag}:fact`, TARGET, NOW)).toBe(true)
      expect(await facts.hasActive(`only-${other}:fact`, TARGET, NOW)).toBe(false)
    }
  })
})

describe("a write in one workspace leaves the other's rows unchanged", () => {
  /** Every move and stamp of the messages repository, at the ids `M` names. `miss` holds the
   *  answers to the ones a miss reports. */
  async function moves(slice: WorkspaceMessageSlice, M: (n: number) => string, miss: boolean) {
    const m = slice.messages
    const answer = async (value: Promise<boolean>) => {
      const got = await value
      if (miss) expect(got).toBe(false)
    }
    await m.markDispatched(scope, M(1), sid(1), AT)
    await m.markTyped(scope, M(1), sid(1), AT)
    await m.markAccepted(scope, M(2), sid(1), 'durable', AT)
    await m.markUnknown(scope, M(4), sid(2))
    await m.markDeliveryAbandoned(scope, M(4), sid(2), AT, 'teardown')
    await m.markDelivered(scope, M(2), sid(1), AT)
    await answer(m.nameTranscriptItem(scope, M(2), sid(1), { id: 'item-2' }))
    await answer(m.recordHarnessRef(scope, M(2), sid(1), [{ kind: 'codex-turn', id: 'turn-1' }]))
    await m.markCancelled(scope, M(1))
    await m.markTyping(scope, M(2))
    await answer(m.requestRetract(scope, M(1), AT))
    await m.markDeliveredByPull(scope, M(1), sid(1), AT)
    await m.markDeliveredByPull(scope, M(5), null, AT)
    await m.markRead(scope, M(3), sid(1), AT)
    await m.markDeadLetter(scope, M(1), AT)
    await m.markDeadLetter(scope, M(2), AT, 'delivery-failed')
    await answer(m.dismissNotice(scope, M(4), AT))
    await m.expireObserved(scope, {
      id: M(1),
      createdAt: '2026-11-17T10:01:00.000Z',
      lifecycle: 'wait',
      expiresAt: null,
    })
    await answer(m.markAcked(scope, M(3), 'ack'))
    await answer(m.markReminded(scope, M(3), AT))
  }

  it('message writes, of ids only the other holds and of the ids both hold', async () => {
    const [a, b] = await twoSeeded()
    // Messages only B holds, in the same states as the shared ones.
    await seedMessages(b, 'b', 'only-b-')
    const before = await rowsOf(a, 'b')
    const m = a.messages

    // Moves and stamps aimed at ids only B holds: nothing in A matches them.
    await moves(a, (n) => mid(n, 'only-b-'), true)
    expect(await rowsOf(a, 'b')).toEqual(before)

    // A's own writes, at the ids both hold.
    expect(await m.markAcked(scope, mid(3), 'a-ack')).toBe(true)
    expect(await m.markReminded(scope, mid(3), AT)).toBe(true)
    expect(
      await m.addMessage(scope, message('a', { id: mid(6), toKind: 'operator', toId: null })),
    ).toBe(true)
    await m.recordRead(mid(2), sid(1), AT)
    await m.recordWakeCooldown(COOLDOWN, NOW)
    await m.recordWakeCooldown('key-2', NOW)
    await moves(a, mid, false)

    expect(await rowsOf(a, 'b')).toEqual(before)
    // And A's own writes landed.
    // The moves took A's m1 out of `stored`, wherever their guards let the last one land.
    expect((await m.getMessage(mid(1)))?.deliveryStatus).not.toBe('stored')
    expect((await m.getMessage(mid(3)))?.ackedBy).toBe('a-ack')
    expect((await m.getMessage(mid(6)))?.id).toBe(mid(6))
    expect(await m.getWakeCooldown(COOLDOWN)).toBe(NOW)
    // B still reads all of its own rows of the same ids as they were.
    expect((await b.messages.getMessage(mid(1)))?.deliveryStatus).toBe('stored')
    expect((await b.messages.getMessage(mid(3)))?.ackedBy).toBeNull()
    expect(await b.messages.getMessage(mid(6))).toBeNull()
    expect(await b.messages.getWakeCooldown(COOLDOWN)).toBe(AT_OF.b)
  })

  it('messaging writes, of keys only the other holds and of the keys both hold', async () => {
    const [a, b] = await twoSeeded()
    // Keys only B holds: a chat with an attachment and a binding of a person only B holds, and
    // a fact of an issue only B holds.
    const ONLY_CHAT = 'only-b-chat'
    const ONLY_USER = asUserId('user:only-b')
    await b.messagingSessionAttachments.upsert({
      chatId: ONLY_CHAT,
      threadRef: '',
      userId: ONLY_USER,
      sessionId: sid(1),
      attachedAt: AT_OF.b,
      relayedItemId: null,
    })
    await b.telegramBindings.upsert({
      chatId: ONLY_CHAT,
      userId: ONLY_USER,
      boundAt: AT_OF.b,
      boundBy: { actor: { kind: 'user', id: ONLY_USER }, onBehalfOf: null },
    })
    await b.notificationFacts.claim({
      factKey: 'only-b:fact',
      target: TARGET,
      source: null,
      issueId: asIssueId('only-b'),
      createdAt: AT_OF.b,
      expiresAt: LATER,
    })
    const before = await rowsOf(a, 'b')

    // Deletes and updates aimed at keys only B holds: nothing in A matches them.
    await a.messagingSessionAttachments.markRelayed(ONLY_CHAT, '', sid(1), 'relayed')
    await a.messagingSessionAttachments.remove(ONLY_CHAT, '')
    await a.telegramBindings.remove(ONLY_CHAT)
    await a.telegramBindings.removeForUser(ONLY_USER)
    const facts = a.notificationFacts
    expect(await facts.retire('only-b:fact', TARGET, NOW)).toBe(false)
    expect(await facts.retireFactKey('only-b:fact', NOW)).toBe(0)
    expect(await facts.retireFactKeyPrefix('only-b:', NOW)).toBe(0)
    await facts.retireByIssue(asIssueId('only-b'))
    expect(await rowsOf(a, 'b')).toEqual(before)

    // A's own upserts, at the keys both hold.
    await a.messagingTopics.upsert({
      issueId: iss(1),
      chatId: CHAT,
      threadRef: 'thread-2',
      superagentThreadId: asThreadId('a-thread-sa'),
      updatedAt: NOW,
    })
    await a.messagingSessionAttachments.upsert({
      chatId: CHAT,
      threadRef: '',
      userId: ALICE,
      sessionId: sid(2),
      attachedAt: NOW,
      relayedItemId: null,
    })
    await a.telegramBindings.upsert({
      chatId: CHAT,
      userId: ALICE,
      boundAt: NOW,
      boundBy: { actor: { kind: 'user', id: ALICE }, onBehalfOf: null },
    })
    expect(
      await facts.claim({
        factKey: fact(3),
        target: TARGET,
        source: null,
        issueId: null,
        createdAt: AT,
        expiresAt: LATER,
      }),
    ).toBe(true)
    // Writes no id narrows: a prefix both workspaces' keys share (A's three live claims), and
    // the expiry sweep.
    expect(await facts.retireFactKeyPrefix('fact:', NOW)).toBe(3)
    await facts.retireExpired(LATER)

    expect(await rowsOf(a, 'b')).toEqual(before)
    // And A's own writes landed.
    expect((await a.messagingTopics.getByIssue(CHAT, iss(1)))?.threadRef).toBe('thread-2')
    expect((await a.messagingSessionAttachments.get(CHAT, ''))?.sessionId).toBe(sid(2))
    expect((await a.telegramBindings.list()).map((row) => row.boundAt)).toEqual([NOW])
    // A's live claims are retired, and its sweep deleted its expired one.
    const ownFacts = (await rowsOf(a, 'a')).notification_facts as {
      fact_key: string
      consumed_at: string | null
    }[]
    expect(ownFacts.map((row) => [row.fact_key, row.consumed_at])).toEqual([
      [fact(1), NOW],
      [fact(3), NOW],
    ])
    // B still reads all of its own rows of the same keys.
    expect(await b.notificationFacts.hasActive(fact(1), TARGET, NOW)).toBe(true)
    expect((await b.messagingTopics.getByIssue(CHAT, iss(1)))?.threadRef).toBe(THREAD)
    expect((await b.telegramBindings.list()).map((row) => row.chatId).sort()).toEqual([
      CHAT,
      ONLY_CHAT,
    ])
    expect((await b.messagingSessionAttachments.get(CHAT, ''))?.attachedAt).toBe(AT_OF.b)
  })

  it('A’s own deletes of the keys both hold take A’s rows and no others', async () => {
    const [a, b] = await twoSeeded()
    const before = await rowsOf(a, 'b')
    await a.messagingSessionAttachments.markRelayed(CHAT, '', sid(1), 'a-relayed')
    expect((await a.messagingSessionAttachments.get(CHAT, ''))?.relayedItemId).toBe('a-relayed')
    await a.messagingSessionAttachments.remove(CHAT, '')
    await a.telegramBindings.removeForUser(ALICE)
    await a.telegramBindings.remove(CHAT)
    const facts = a.notificationFacts
    expect(await facts.retire(fact(1), TARGET, NOW)).toBe(true)
    await facts.retireByIssue(iss(1))
    await facts.retireExpired(NOW)

    const own = await rowsOf(a, 'a')
    expect(own.messaging_session_attachments).toEqual([])
    expect(own.telegram_chat_bindings).toEqual([])
    expect(own.notification_facts).toEqual([])
    expect(await rowsOf(a, 'b')).toEqual(before)
    expect((await b.messagingSessionAttachments.get(CHAT, ''))?.relayedItemId).toBeNull()
    expect(await b.telegramBindings.listForUser(ALICE)).toHaveLength(1)
  })
})

/**
 * THE SAME ID UPSERTED FIRST IN THE OTHER WORKSPACE (POD-7024): every ON CONFLICT target leads with workspace_id,
 * so an upsert in A of an id B already holds makes A its own row, B's row stays byte for byte
 * as it was, and A's second upsert of the id updates A's row only.
 */
describe('the same id in both workspaces, upserted through the repository (POD-7024)', () => {
  it("makes a second row, leaves the other workspace's as it was, and updates only its own", async () => {
    const SAME = 'same-chat'
    const rowsIn = async (store: WorkspaceMessageSlice, tag: Tag) =>
      await store.all<Record<string, unknown>>(
        sql`SELECT * FROM telegram_chat_bindings WHERE workspace_id = ${WS[tag]} AND chat_id = ${SAME}`,
      )
    const [a, b] = await twoSeeded()
    const bind = async (store: WorkspaceMessageSlice, boundAt: string) =>
      await store.telegramBindings.upsert({
        chatId: SAME,
        userId: ALICE,
        boundAt,
        boundBy: { actor: { kind: 'user', id: ALICE }, onBehalfOf: null },
      })
    await bind(b, AT)
    const before = await rowsIn(b, 'b')
    expect(before).toHaveLength(1)
    await bind(a, AT)
    expect(await rowsIn(a, 'a')).toHaveLength(1)
    expect(await rowsIn(b, 'b')).toEqual(before)
    await bind(a, LATER)
    expect(await rowsIn(a, 'a')).toHaveLength(1)
    expect((await a.telegramBindings.list()).find((row) => row.chatId === SAME)?.boundAt).toBe(
      LATER,
    )
    expect((await b.telegramBindings.list()).find((row) => row.chatId === SAME)?.boundAt).toBe(AT)
    expect(await rowsIn(b, 'b')).toEqual(before)
  })
})
