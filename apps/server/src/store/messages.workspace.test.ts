/**
 * MAIL AND MESSAGING ARE A WORKSPACE'S (POD-6959 design 2.4, 2.5; task POD-7017).
 *
 * Two workspaces over one database of the run's engine (`openMessageStoreSlices`), each seeded through its own
 * repositories with its own sessions, messages, read receipts, wake cooldowns, chat topics,
 * chat attachments, Telegram bindings and notification facts. The ids and names differ between
 * the workspaces: until the key migration (C1, POD-7024) no unique constraint includes
 * `workspace_id`, so the same id in both would collide on the old key.
 *
 * For every repository method of the group (messages, messaging topics, messaging session
 * attachments, Telegram bindings, notification facts):
 *   - a read answers only its own workspace's rows, including the reads no id narrows (the
 *     operator's mail, the queue, the chat feed, every binding, the expired facts);
 *   - an update, delete or upsert in one workspace leaves the other's rows unchanged, including
 *     a write in A addressed at B's own ids, which must find nothing to change.
 */

import {
  asIssueId,
  asMachineId,
  asSessionId,
  asThreadId,
  asUserId,
  type IssueId,
  type SessionId,
  type UserId,
} from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  openMessageStoreSlices,
  type WorkspaceMessageSlice,
} from '../test-support/message-store-slice'
import type { MessageRow, SessionRow } from './types'

type Tag = 'a' | 'b'
const WS: Record<Tag, string> = { a: 'ws_a', b: 'ws_b' }
const AT = '2026-11-17T10:00:00.000Z'
const NOW = '2026-11-17T12:00:00.000Z'
const EARLIER = '2026-11-01T00:00:00.000Z'
const LATER = '2099-01-01T00:00:00.000Z'
const scope = fixtureWriteScope()

const otherOf = (tag: Tag): Tag => (tag === 'a' ? 'b' : 'a')
const alice = (tag: Tag): UserId => asUserId(`user:${tag}-alice`)
const sid = (tag: Tag, n: number): SessionId => asSessionId(`${tag}-s${n}`)
const iss = (tag: Tag, n: number): IssueId => asIssueId(`${tag}-iss-${n}`)
const mid = (tag: Tag, n: number): string => `${tag}-m${n}`
const item = (tag: Tag): string => `${tag}-item`
const chat = (tag: Tag): string => `${tag}-chat`
const cooldown = (tag: Tag): string => `${tag}-key`
const fact = (tag: Tag, n: number): string => `fact:${tag}:${n}`
const target = (tag: Tag): string => `${tag}-target`

let opened: WorkspaceMessageSlice | undefined

afterEach(async () => {
  await opened?.close()
  opened = undefined
})

/** The tables this group owns, read raw per workspace, for "unchanged" comparisons. */
const TABLES = [
  'messages',
  'message_reads',
  'message_wake_cooldowns',
  'messaging_issue_topics',
  'messaging_session_attachments',
  'telegram_chat_bindings',
  'notification_facts',
] as const

/**
 * One workspace's rows of every table, each table's rows as a set (sorted by their
 * text): Postgres has no rowid to read them in insertion order by.
 */
async function rowsOf(store: WorkspaceMessageSlice, tag: Tag): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {}
  for (const table of TABLES) {
    const rows = await store.all<Record<string, unknown>>(
      sql`SELECT * FROM ${sql.identifier(table)} WHERE workspace_id = ${WS[tag]}`,
    )
    out[table] = rows
      .map((row) => ({ row, text: JSON.stringify(row) }))
      .sort((x, y) => (x.text < y.text ? -1 : x.text > y.text ? 1 : 0))
      .map(({ row }) => row)
  }
  return out
}

function session(tag: Tag, n: number): SessionRow {
  return {
    id: sid(tag, n),
    ownerUserId: alice(tag),
    agentKind: 'codex',
    cwd: `/repo-${tag}/w${n}`,
    title: `${tag} session ${n}`,
    name: null,
    nameSource: null,
    originKind: 'spawn',
    conversationId: null,
    resumeKind: 'codex',
    resumeValue: `${tag}-resume-${n}`,
    status: 'live',
    exitCode: null,
    spawnFailure: null,
    durableLabel: `podium-${tag}-${n}`,
    createdAt: `2026-11-0${n}T00:00:00.000Z`,
    lastActiveAt: `2026-11-0${n}T00:00:00.000Z`,
    geometry: { cols: 120, rows: 40 },
    archived: false,
    workState: null,
    machineId: asMachineId(`${tag}-machine`),
    lastOutputAt: null,
    lastInputAt: null,
    lastResumedAt: null,
    spawnedBy: null,
    headless: false,
    issueId: null,
    refIssueId: null,
    refLetter: null,
    refDraft: null,
    stoppedAt: null,
    stopReason: null,
    workflowRunId: null,
    workflowStepId: null,
    agentProfileId: null,
    deletedAt: null,
    deletionSource: null,
    deletedByIssueId: null,
  }
}

function message(input: Omit<Partial<MessageRow>, 'id'> & { id: string }): MessageRow {
  return {
    threadId: asThreadId(input.id),
    inReplyTo: null,
    fromKind: 'agent',
    fromSession: null,
    fromIssue: null,
    toKind: 'issue',
    toId: null,
    kind: 'message',
    urgency: 'fyi',
    lifecycle: 'wait',
    body: input.id,
    expiresAt: null,
    createdAt: AT,
    deliveryStatus: 'stored',
    deliveredAt: null,
    deliveredTo: null,
    readAt: null,
    injectedAt: null,
    deadLetteredAt: null,
    ackedBy: null,
    hop: 0,
    clampedFrom: null,
    remindedAt: null,
    factKey: null,
    factTarget: null,
    expectsResponse: false,
    ...input,
  } as MessageRow
}

/**
 * One workspace's rows, written through its own repositories. Messages:
 *   m1 s1 (for issue 2) to issue 1, stored;          m2 operator to s1, stored, with attachments;
 *   m3 operator to s1, confirmed into s1, owes a reply; m4 s1 to s2, dispatched toward s2;
 *   m5 system to the operator, stored.
 * Plus s1's receipt of m1, a wake cooldown, a chat topic, a chat attachment, a Telegram binding,
 * and two notification facts (one live, one expired).
 */
async function seed(store: WorkspaceMessageSlice, tag: Tag): Promise<void> {
  await store.sessions.upsertSessions(scope, [session(tag, 1), session(tag, 2)])
  const m = store.messages
  await m.addMessage(
    scope,
    message({
      id: mid(tag, 1),
      fromSession: sid(tag, 1),
      fromIssue: iss(tag, 2),
      toKind: 'issue',
      toId: iss(tag, 1),
      createdAt: '2026-11-17T10:01:00.000Z',
    }),
  )
  await m.addMessage(
    scope,
    message({
      id: mid(tag, 2),
      fromKind: 'operator',
      toKind: 'session',
      toId: sid(tag, 1),
      createdAt: '2026-11-17T10:02:00.000Z',
    }),
  )
  await m.addMessage(
    scope,
    message({
      id: mid(tag, 3),
      fromKind: 'operator',
      toKind: 'session',
      toId: sid(tag, 1),
      expectsResponse: true,
      createdAt: '2026-11-17T10:03:00.000Z',
    }),
  )
  await m.addMessage(
    scope,
    message({
      id: mid(tag, 4),
      fromSession: sid(tag, 1),
      toKind: 'session',
      toId: sid(tag, 2),
      createdAt: '2026-11-17T10:04:00.000Z',
    }),
  )
  await m.addMessage(
    scope,
    message({
      id: mid(tag, 5),
      fromKind: 'system',
      toKind: 'operator',
      toId: null,
      createdAt: '2026-11-17T10:05:00.000Z',
    }),
  )
  // Statuses and stamps the reads need, set directly: these tests are about which workspace a
  // read or write reaches, not how a row got where it is.
  await store.run(
    sql`UPDATE messages SET attachments_json = '[]', transcript_item_id = ${item(tag)} WHERE workspace_id = ${WS[tag]} AND id = ${mid(tag, 2)}`,
  )
  await store.run(
    sql`UPDATE messages SET delivery_status = 'confirmed', delivered_to = ${sid(tag, 1)}, delivered_at = ${AT} WHERE workspace_id = ${WS[tag]} AND id = ${mid(tag, 3)}`,
  )
  await store.run(
    sql`UPDATE messages SET delivery_status = 'dispatched', delivered_to = ${sid(tag, 2)}, injected_at = ${AT} WHERE workspace_id = ${WS[tag]} AND id = ${mid(tag, 4)}`,
  )
  await m.recordRead(mid(tag, 1), sid(tag, 1), AT)
  await m.recordWakeCooldown(cooldown(tag), AT)

  await store.messagingTopics.upsert({
    issueId: iss(tag, 1),
    chatId: chat(tag),
    threadRef: `${tag}-thread`,
    superagentThreadId: asThreadId(`${tag}-thread-sa`),
    updatedAt: AT,
  })
  await store.messagingSessionAttachments.upsert({
    chatId: chat(tag),
    threadRef: '',
    userId: alice(tag),
    sessionId: sid(tag, 1),
    attachedAt: AT,
    relayedItemId: null,
  })
  await store.telegramBindings.upsert({
    chatId: chat(tag),
    userId: alice(tag),
    boundAt: AT,
    boundBy: { actor: { kind: 'user', id: alice(tag) }, onBehalfOf: null },
  })
  const facts = store.notificationFacts
  await facts.claim({
    factKey: fact(tag, 1),
    target: target(tag),
    source: `${tag}-source`,
    issueId: iss(tag, 1),
    createdAt: AT,
    expiresAt: LATER,
  })
  await facts.claim({
    factKey: fact(tag, 2),
    target: target(tag),
    source: null,
    issueId: null,
    createdAt: EARLIER,
    expiresAt: EARLIER,
  })
}

async function twoSeeded(): Promise<readonly [WorkspaceMessageSlice, WorkspaceMessageSlice]> {
  const stores = await openMessageStoreSlices([WS.a, WS.b])
  opened = stores[0]
  await seed(stores[0], 'a')
  await seed(stores[1], 'b')
  return stores
}

const ids = (rows: Iterable<{ id: string }>) => [...rows].map((row) => row.id).sort()
const allMessageIds = [1, 2, 3, 4, 5].flatMap((n) => [mid('a', n), mid('b', n)])
const ownMessages = (tag: Tag, ...ns: number[]) => ns.map((n) => mid(tag, n)).sort()

/** Every string in `value` that names a seeded thing starts with the workspace's tag. */
function onlyOwn(value: unknown, tag: Tag): void {
  const other = otherOf(tag)
  const text = JSON.stringify(value)
  expect(text).not.toMatch(
    new RegExp(
      `\\b${other}-(m\\d|s\\d|iss-|item|chat|key|alice|thread|source|target)|fact:${other}:`,
    ),
  )
}

describe('the group writes every row under its own workspace', () => {
  it('seeds each table in both workspaces, each with only its own names', async () => {
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
      const other = otherOf(tag)
      expect((await m.getMessage(mid(tag, 1)))?.id).toBe(mid(tag, 1))
      expect(await m.getMessage(mid(other, 1))).toBeNull()
      expect(ids(await m.getMessages(allMessageIds))).toEqual(ownMessages(tag, 1, 2, 3, 4, 5))
      expect(ids(await m.getTranscriptAttachmentMessages(sid(tag, 1), [item(tag)]))).toEqual([
        mid(tag, 2),
      ])
      expect(await m.getTranscriptAttachmentMessages(sid(other, 1), [item(other)])).toEqual([])
      expect(ids(await m.listMessagesFor({ kind: 'operator' }))).toEqual([mid(tag, 5)])
      expect(ids(await m.listMessagesFor({ kind: 'issue', id: iss(tag, 1) }))).toEqual([
        mid(tag, 1),
      ])
      expect(await m.listMessagesFor({ kind: 'issue', id: iss(other, 1) })).toEqual([])
      expect(ids(await m.pendingForSessionProof(sid(tag, 1), NOW))).toEqual(ownMessages(tag, 2, 3))
      expect(await m.pendingForSessionProof(sid(other, 1), NOW)).toEqual([])
      expect(ids(await m.listLedger({ issueId: iss(tag, 1), sessionId: sid(tag, 1) }))).toEqual(
        ownMessages(tag, 1, 2, 3, 4),
      )
      expect(await m.listLedger({ issueId: iss(other, 1), sessionId: sid(other, 1) })).toEqual([])
      expect(await m.queuedPositionForSession(sid(tag, 1), mid(tag, 2))).toBe(1)
      expect(await m.queuedPositionForSession(sid(other, 1), mid(other, 2))).toBeUndefined()
      expect(
        await m.pendingTargets([
          { kind: 'issue', id: iss(tag, 1) },
          { kind: 'issue', id: iss(other, 1) },
        ]),
      ).toEqual([true, false])
      const pages = await m.pendingForPages([
        { to: { kind: 'issue', id: iss(tag, 1) } },
        { to: { kind: 'issue', id: iss(other, 1) } },
      ])
      expect(pages.map(ids)).toEqual([[mid(tag, 1)], []])
      expect((await m.latestPendingOperatorForSession(sid(tag, 1)))?.id).toBe(mid(tag, 2))
      expect(await m.latestPendingOperatorForSession(sid(other, 1))).toBeUndefined()
    }
  })

  it('answers the counts and summaries with its own rows', async () => {
    const stores = await twoSeeded()
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
      expect(await m.countPending({ kind: 'issue', id: iss(other, 1) })).toBe(0)
      const queued = await m.listQueued()
      expect(ids(queued)).toEqual(ownMessages(tag, 1, 2, 4, 5))
      expect(await m.countQueued()).toBe(queued.length)
      expect(ids(await m.listQueuedPage({ limit: 10 }))).toEqual(ownMessages(tag, 1, 2, 4, 5))
      expect([...(await m.existingMessageIds(allMessageIds))].sort()).toEqual(
        ownMessages(tag, 1, 2, 3, 4, 5),
      )
      expect([...(await m.readReceipts(sid(tag, 1), [mid(tag, 1), mid(other, 1)]))]).toEqual([
        mid(tag, 1),
      ])
      expect([...(await m.readReceipts(sid(other, 1), [mid(other, 1)]))]).toEqual([])
      expect([...(await m.selfSentIds(sid(tag, 1), allMessageIds))].sort()).toEqual(
        ownMessages(tag, 1, 4),
      )
      expect([...(await m.selfSentIds(sid(other, 1), allMessageIds))]).toEqual([])
      const fromS1 = { fromKind: 'agent', fromIssue: iss(tag, 2), fromSession: sid(tag, 1) }
      expect(await m.pendingSummaryForSession(iss(tag, 1), sid(tag, 2))).toEqual({
        count: 1,
        senders: [fromS1],
      })
      expect(await m.pendingSummaryForSession(iss(other, 1), sid(other, 2))).toEqual({
        count: 0,
        senders: [],
      })
      expect(await m.countPendingForSession(iss(tag, 1), sid(tag, 2))).toBe(1)
      expect(await m.countPendingForSession(iss(other, 1), sid(other, 2))).toBe(0)
      expect(await m.listPendingSendersForSession(iss(tag, 1), sid(tag, 2))).toEqual([fromS1])
      expect(await m.listPendingSendersForSession(iss(other, 1), sid(other, 2))).toEqual([])
      expect(
        await m.alreadyCommunicated(iss(tag, 2), { kind: 'issue', id: iss(tag, 1) }, EARLIER),
      ).toBe(true)
      expect(
        await m.alreadyCommunicated(iss(other, 2), { kind: 'issue', id: iss(other, 1) }, EARLIER),
      ).toBe(false)
    }
  })

  it('answers the delivery, chat feed and cooldown reads with its own rows', async () => {
    const stores = await twoSeeded()
    for (const [store, tag] of [
      [stores[0], 'a'],
      [stores[1], 'b'],
    ] as const) {
      const m = store.messages
      const other = otherOf(tag)
      expect(ids(await m.listOpenBoundTo([sid(tag, 1), sid(tag, 2)]))).toEqual(
        ownMessages(tag, 2, 4),
      )
      expect(await m.listOpenBoundTo([sid(other, 1), sid(other, 2)], iss(other, 1))).toEqual([])
      expect(ids(await m.listOpenChat())).toEqual([mid(tag, 2)])
      expect(ids(await m.confirmedChatWindow(10))).toEqual([mid(tag, 3)])
      for (const liveness of ['live', 'any'] as const) {
        expect(ids(await m.confirmedChatTail(10, [sid(tag, 1), sid(other, 1)], liveness))).toEqual([
          mid(tag, 3),
        ])
      }
      expect(await m.getWakeCooldown(cooldown(tag))).toBe(AT)
      expect(await m.getWakeCooldown(cooldown(other))).toBeNull()
      expect([...(await m.getWakeCooldowns([cooldown(tag), cooldown(other)]))]).toEqual([
        [cooldown(tag), AT],
      ])
      expect(ids(await m.pendingDeliveredToPage(sid(tag, 2)))).toEqual([mid(tag, 4)])
      expect(await m.pendingDeliveredToPage(sid(other, 2))).toEqual([])
      expect(ids(await m.listDeliveredUnacked(sid(tag, 1), NOW))).toEqual([mid(tag, 3)])
      expect(await m.listDeliveredUnacked(sid(other, 1), NOW)).toEqual([])
      expect(ids(await m.listSettleNotifiable(sid(tag, 1), NOW))).toEqual([mid(tag, 3)])
      expect(await m.listSettleNotifiable(sid(other, 1), NOW)).toEqual([])
    }
  })
})

describe('the messaging repositories read only their own workspace', () => {
  it('answers topic, attachment, binding and fact reads with its own rows', async () => {
    const stores = await twoSeeded()
    for (const [store, tag] of [
      [stores[0], 'a'],
      [stores[1], 'b'],
    ] as const) {
      const other = otherOf(tag)
      const topics = store.messagingTopics
      const topic = {
        issueId: iss(tag, 1),
        chatId: chat(tag),
        threadRef: `${tag}-thread`,
        superagentThreadId: `${tag}-thread-sa`,
        updatedAt: AT,
      }
      expect(await topics.listForChat(chat(tag))).toEqual([topic])
      expect(await topics.listForChat(chat(other))).toEqual([])
      expect(await topics.getByIssue(chat(tag), iss(tag, 1))).toEqual(topic)
      expect(await topics.getByIssue(chat(other), iss(other, 1))).toBeUndefined()
      expect(await topics.getByThreadRef(chat(tag), `${tag}-thread`)).toEqual(topic)
      expect(await topics.getByThreadRef(chat(other), `${other}-thread`)).toBeUndefined()

      const attachments = store.messagingSessionAttachments
      const attachment = {
        chatId: chat(tag),
        threadRef: '',
        userId: alice(tag),
        sessionId: sid(tag, 1),
        attachedAt: AT,
        relayedItemId: null,
      }
      expect(await attachments.get(chat(tag), '')).toEqual(attachment)
      expect(await attachments.get(chat(other), '')).toBeUndefined()
      expect(await attachments.listForSession(sid(tag, 1))).toEqual([attachment])
      expect(await attachments.listForSession(sid(other, 1))).toEqual([])

      const bindings = store.telegramBindings
      const binding = {
        chatId: chat(tag),
        userId: alice(tag),
        boundAt: AT,
        boundBy: { actor: { kind: 'user', id: alice(tag) }, onBehalfOf: null },
      }
      expect(await bindings.list()).toEqual([binding])
      expect(await bindings.listForUser(alice(tag))).toEqual([binding])
      expect(await bindings.listForUser(alice(other))).toEqual([])

      const facts = store.notificationFacts
      expect(await facts.hasActive(fact(tag, 1), target(tag), NOW)).toBe(true)
      expect(await facts.hasActive(fact(other, 1), target(other), NOW)).toBe(false)
    }
  })
})

describe("a write in one workspace leaves the other's rows unchanged", () => {
  it('message writes, including writes addressed at the other workspace’s ids', async () => {
    const [a, b] = await twoSeeded()
    const before = await rowsOf(a, 'b')
    const m = a.messages
    const B = (n: number) => mid('b', n)

    // Moves and stamps aimed at B's ids: nothing in A matches them.
    await m.markDispatched(scope, B(1), sid('b', 1), AT)
    await m.markTyped(scope, B(1), sid('b', 1), AT)
    await m.markAccepted(scope, B(2), sid('b', 1), 'durable', AT)
    await m.markUnknown(scope, B(4), sid('b', 2))
    await m.markDeliveryAbandoned(scope, B(4), sid('b', 2), AT, 'teardown')
    await m.markDelivered(scope, B(2), sid('b', 1), AT)
    expect(await m.nameTranscriptItem(scope, B(2), sid('b', 1), { id: 'b-item-2' })).toBe(false)
    expect(
      await m.recordHarnessRef(scope, B(2), sid('b', 1), [{ kind: 'codex-turn', id: 'turn-b' }]),
    ).toBe(false)
    await m.markCancelled(scope, B(1))
    await m.markTyping(scope, B(2))
    expect(await m.requestRetract(scope, B(1), AT)).toBe(false)
    await m.markDeliveredByPull(scope, B(1), sid('b', 1), AT)
    await m.markDeliveredByPull(scope, B(5), null, AT)
    await m.markRead(scope, B(3), sid('b', 1), AT)
    await m.markDeadLetter(scope, B(1), AT)
    await m.markDeadLetter(scope, B(2), AT, 'delivery-failed')
    expect(await m.dismissNotice(scope, B(4), AT)).toBe(false)
    await m.expireObserved(scope, {
      id: B(1),
      createdAt: '2026-11-17T10:01:00.000Z',
      lifecycle: 'wait',
      expiresAt: null,
    })
    expect(await m.markAcked(scope, B(3), 'b-ack')).toBe(false)
    expect(await m.markReminded(scope, B(3), AT)).toBe(false)

    // A's own writes.
    expect(
      await m.addMessage(scope, message({ id: mid('a', 6), toKind: 'operator', toId: null })),
    ).toBe(true)
    await m.recordRead(mid('a', 2), sid('a', 1), AT)
    await m.recordWakeCooldown(cooldown('a'), NOW)
    await m.recordWakeCooldown('a-key-2', NOW)
    await m.markCancelled(scope, mid('a', 1))
    expect(await m.markAcked(scope, mid('a', 3), 'a-ack')).toBe(true)
    expect(await m.markReminded(scope, mid('a', 3), AT)).toBe(true)

    expect(await rowsOf(a, 'b')).toEqual(before)
    // And A's own writes landed.
    expect((await m.getMessage(mid('a', 1)))?.deliveryStatus).toBe('cancelled')
    expect((await m.getMessage(mid('a', 6)))?.id).toBe(mid('a', 6))
    expect(await m.getWakeCooldown(cooldown('a'))).toBe(NOW)
    // B still reads all of its own rows as they were.
    expect((await b.messages.getMessage(B(1)))?.deliveryStatus).toBe('stored')
    expect((await b.messages.getMessage(B(3)))?.ackedBy).toBeNull()
    expect(await b.messages.getWakeCooldown(cooldown('b'))).toBe(AT)
  })

  it('messaging writes, including writes addressed at the other workspace’s ids', async () => {
    const [a, b] = await twoSeeded()
    const before = await rowsOf(a, 'b')

    // Deletes and updates aimed at B's keys: nothing in A matches them.
    await a.messagingSessionAttachments.markRelayed(chat('b'), '', sid('b', 1), 'b-relayed')
    await a.messagingSessionAttachments.remove(chat('b'), '')
    await a.telegramBindings.remove(chat('b'))
    await a.telegramBindings.removeForUser(alice('b'))
    const facts = a.notificationFacts
    expect(await facts.retire(fact('b', 1), target('b'), NOW)).toBe(false)
    expect(await facts.retireFactKey(fact('b', 1), NOW)).toBe(0)
    expect(await facts.retireFactKeyPrefix('fact:b:', NOW)).toBe(0)
    await facts.retireByIssue(iss('b', 1))

    // A's own upserts.
    await a.messagingTopics.upsert({
      issueId: iss('a', 1),
      chatId: chat('a'),
      threadRef: 'a-thread-2',
      superagentThreadId: asThreadId('a-thread-sa'),
      updatedAt: NOW,
    })
    await a.messagingSessionAttachments.upsert({
      chatId: chat('a'),
      threadRef: '',
      userId: alice('a'),
      sessionId: sid('a', 2),
      attachedAt: NOW,
      relayedItemId: null,
    })
    await a.telegramBindings.upsert({
      chatId: chat('a'),
      userId: alice('a'),
      boundAt: NOW,
      boundBy: { actor: { kind: 'user', id: alice('a') }, onBehalfOf: null },
    })
    expect(
      await facts.claim({
        factKey: fact('a', 3),
        target: target('a'),
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
    expect((await a.messagingTopics.getByIssue(chat('a'), iss('a', 1)))?.threadRef).toBe(
      'a-thread-2',
    )
    expect((await a.messagingSessionAttachments.get(chat('a'), ''))?.sessionId).toBe(sid('a', 2))
    expect((await a.telegramBindings.list()).map((row) => row.boundAt)).toEqual([NOW])
    // A's live claims are retired, and its sweep deleted its expired one.
    const ownFacts = (await rowsOf(a, 'a')).notification_facts as {
      fact_key: string
      consumed_at: string | null
    }[]
    expect(ownFacts.map((row) => [row.fact_key, row.consumed_at])).toEqual([
      [fact('a', 1), NOW],
      [fact('a', 3), NOW],
    ])
    // B still reads all of its own rows.
    expect(await b.notificationFacts.hasActive(fact('b', 1), target('b'), NOW)).toBe(true)
    expect((await b.telegramBindings.list()).map((row) => row.chatId)).toEqual([chat('b')])
    expect(await b.messagingSessionAttachments.listForSession(sid('b', 1))).toHaveLength(1)
  })

  it('A’s own deletes take A’s rows and no others', async () => {
    const [a] = await twoSeeded()
    const before = await rowsOf(a, 'b')
    await a.messagingSessionAttachments.markRelayed(chat('a'), '', sid('a', 1), 'a-relayed')
    expect((await a.messagingSessionAttachments.get(chat('a'), ''))?.relayedItemId).toBe(
      'a-relayed',
    )
    await a.messagingSessionAttachments.remove(chat('a'), '')
    await a.telegramBindings.removeForUser(alice('a'))
    await a.telegramBindings.remove(chat('a'))
    const facts = a.notificationFacts
    expect(await facts.retire(fact('a', 1), target('a'), NOW)).toBe(true)
    await facts.retireByIssue(iss('a', 1))
    await facts.retireExpired(NOW)

    const own = await rowsOf(a, 'a')
    expect(own.messaging_session_attachments).toEqual([])
    expect(own.telegram_chat_bindings).toEqual([])
    expect(own.notification_facts).toEqual([])
    expect(await rowsOf(a, 'b')).toEqual(before)
  })
})
