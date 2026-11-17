/**
 * THE SAME-ID SEED OF MAIL AND MESSAGING, shared by its two-workspace test
 * (`store/messages.workspace.test.ts`) and the completeness test
 * (`store/workspace-isolation.test.ts`, POD-7025). Moved here from that test unchanged: both
 * workspaces hold the same ids and natural keys, with content of their own (see the test's
 * header).
 */

import {
  asIssueId,
  asMachineId,
  asSessionId,
  asThreadId,
  asUserId,
  type UserId,
} from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { sql } from 'drizzle-orm'
import type { MessageRow, SessionRow } from '../../store/types'
import type { WorkspaceMessageSlice } from '../message-store-slice'

export type Tag = 'a' | 'b'
export const WS: Record<Tag, string> = { a: 'ws_a', b: 'ws_b' }
/** Each workspace's own timestamp: content, not a key. */
export const AT_OF: Record<Tag, string> = {
  a: '2026-11-17T10:00:00.000Z',
  b: '2026-11-17T10:30:00.000Z',
}
export const AT = AT_OF.a
export const NOW = '2026-11-17T12:00:00.000Z'
export const EARLIER = '2026-11-01T00:00:00.000Z'
export const LATER = '2099-01-01T00:00:00.000Z'
export const scope = fixtureWriteScope()

export const otherOf = (tag: Tag): Tag => (tag === 'a' ? 'b' : 'a')
// The same ids and natural keys in both workspaces.
export const ALICE: UserId = asUserId('user:alice')
export const sid = (n: number) => asSessionId(`s${n}`)
export const iss = (n: number) => asIssueId(`iss-${n}`)
/** A message id; `prefix` makes the ids a plant only one workspace holds. */
export const mid = (n: number, prefix = ''): string => `${prefix}m${n}`
export const ITEM = 'item-1'
export const CHAT = 'chat-1'
export const THREAD = 'thread-1'
export const COOLDOWN = 'key-1'
export const fact = (n: number): string => `fact:${n}`
export const TARGET = 'target-1'
/** The message s1 read: the same ids, a different receipt per workspace. */
export const receipt = (tag: Tag): string => mid(tag === 'a' ? 1 : 5)
export const body = (tag: Tag, id: string): string => `${tag} body ${id}`
/** The tables this group owns, read raw per workspace, for "unchanged" comparisons. */
export const TABLES = [
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
export async function rowsOf(
  store: WorkspaceMessageSlice,
  tag: Tag,
): Promise<Record<string, unknown[]>> {
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

export function session(tag: Tag, n: number): SessionRow {
  return {
    id: sid(n),
    ownerUserId: ALICE,
    agentKind: 'codex',
    cwd: `/repo/w${n}`,
    title: `${tag} session ${n}`,
    name: null,
    nameSource: null,
    originKind: 'spawn',
    conversationId: null,
    resumeKind: 'codex',
    resumeValue: `resume-${n}`,
    status: 'live',
    exitCode: null,
    spawnFailure: null,
    durableLabel: `podium-${n}`,
    createdAt: `2026-11-0${n}T00:00:00.000Z`,
    lastActiveAt: `2026-11-0${n}T00:00:00.000Z`,
    geometry: { cols: 120, rows: 40 },
    archived: false,
    workState: null,
    machineId: asMachineId('machine-1'),
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

export function message(
  tag: Tag,
  input: Omit<Partial<MessageRow>, 'id'> & { id: string },
): MessageRow {
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
    body: body(tag, input.id),
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
 * One workspace's messages, through its own repository (`prefix` names a set only this
 * workspace holds):
 *   m1 s1 (for issue 2) to issue 1, stored;          m2 operator to s1, stored, with attachments;
 *   m3 operator to s1, confirmed into s1, owes a reply; m4 s1 to s2, dispatched toward s2;
 *   m5 system to the operator, stored.
 */
export async function seedMessages(
  store: WorkspaceMessageSlice,
  tag: Tag,
  prefix = '',
): Promise<void> {
  const m = store.messages
  const at = AT_OF[tag]
  await m.addMessage(
    scope,
    message(tag, {
      id: mid(1, prefix),
      fromSession: sid(1),
      fromIssue: iss(2),
      toKind: 'issue',
      toId: iss(1),
      createdAt: '2026-11-17T10:01:00.000Z',
    }),
  )
  await m.addMessage(
    scope,
    message(tag, {
      id: mid(2, prefix),
      fromKind: 'operator',
      toKind: 'session',
      toId: sid(1),
      createdAt: '2026-11-17T10:02:00.000Z',
    }),
  )
  await m.addMessage(
    scope,
    message(tag, {
      id: mid(3, prefix),
      fromKind: 'operator',
      toKind: 'session',
      toId: sid(1),
      expectsResponse: true,
      createdAt: '2026-11-17T10:03:00.000Z',
    }),
  )
  await m.addMessage(
    scope,
    message(tag, {
      id: mid(4, prefix),
      fromSession: sid(1),
      toKind: 'session',
      toId: sid(2),
      createdAt: '2026-11-17T10:04:00.000Z',
    }),
  )
  await m.addMessage(
    scope,
    message(tag, {
      id: mid(5, prefix),
      fromKind: 'system',
      toKind: 'operator',
      toId: null,
      createdAt: '2026-11-17T10:05:00.000Z',
    }),
  )
  // Statuses and stamps the reads need, set directly: these tests are about which workspace a
  // read or write reaches, not how a row got where it is.
  await store.run(
    sql`UPDATE messages SET attachments_json = '[]', transcript_item_id = ${`${prefix}${ITEM}`} WHERE workspace_id = ${WS[tag]} AND id = ${mid(2, prefix)}`,
  )
  await store.run(
    sql`UPDATE messages SET delivery_status = 'confirmed', delivered_to = ${sid(1)}, delivered_at = ${at} WHERE workspace_id = ${WS[tag]} AND id = ${mid(3, prefix)}`,
  )
  await store.run(
    sql`UPDATE messages SET delivery_status = 'dispatched', delivered_to = ${sid(2)}, injected_at = ${at} WHERE workspace_id = ${WS[tag]} AND id = ${mid(4, prefix)}`,
  )
}

/**
 * One workspace's rows, written through its own repositories: the messages above, s1's
 * receipt of its own message, a wake cooldown, a chat topic, a chat attachment, a Telegram
 * binding, and two notification facts (one live, one expired).
 */
export async function seed(store: WorkspaceMessageSlice, tag: Tag): Promise<void> {
  const at = AT_OF[tag]
  await store.sessions.upsertSessions(scope, [session(tag, 1), session(tag, 2)])
  await seedMessages(store, tag)
  const m = store.messages
  await m.recordRead(receipt(tag), sid(1), at)
  await m.recordWakeCooldown(COOLDOWN, at)

  await store.messagingTopics.upsert({
    issueId: iss(1),
    chatId: CHAT,
    threadRef: THREAD,
    superagentThreadId: asThreadId(`${tag}-thread-sa`),
    updatedAt: at,
  })
  await store.messagingSessionAttachments.upsert({
    chatId: CHAT,
    threadRef: '',
    userId: ALICE,
    sessionId: sid(1),
    attachedAt: at,
    relayedItemId: null,
  })
  await store.telegramBindings.upsert({
    chatId: CHAT,
    userId: ALICE,
    boundAt: at,
    boundBy: { actor: { kind: 'user', id: ALICE }, onBehalfOf: null },
  })
  const facts = store.notificationFacts
  await facts.claim({
    factKey: fact(1),
    target: TARGET,
    source: `${tag}-source`,
    issueId: iss(1),
    createdAt: at,
    expiresAt: LATER,
  })
  await facts.claim({
    factKey: fact(2),
    target: TARGET,
    source: null,
    issueId: null,
    createdAt: EARLIER,
    expiresAt: EARLIER,
  })
}
/** A cancelled message from s1 only `tag`'s workspace holds: no queue, no pending. */
export const onlyMessage = (tag: Tag): string => `only-${tag}-m`
export async function plantOnlyMessage(store: WorkspaceMessageSlice, tag: Tag): Promise<void> {
  await store.messages.addMessage(
    scope,
    message(tag, { id: onlyMessage(tag), fromSession: sid(1), toId: asIssueId(`only-${tag}`) }),
  )
  await store.messages.markCancelled(scope, onlyMessage(tag))
}
