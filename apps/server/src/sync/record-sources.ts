/**
 * WHERE EACH SYNCED RECORD COMES FROM (POD-6253 design §3, POD-6920).
 *
 * Writers name no records. Each kind declares here, once, the model tables
 * its builder (`record-builders.ts`) reads: for each table, the columns it
 * reads, the key columns a changed row is captured with, and how a captured
 * row maps to the kind's record ids. From these declarations
 * `capture-triggers.ts` generates one trigger per (kind, table, operation)
 * that adds a row to `sync_capture` when a row the kind reads is inserted,
 * deleted, or updated in a column the kind reads (`WHEN OLD.c IS NOT NEW.c`),
 * so a column no record carries leaves no trace. At the end of a write the
 * Authority drains the capture through {@link touchedRecords} and appends
 * every record the captured rows reach, built as it is now.
 *
 * A captured change carries the OLD and the NEW key, so a row that moves
 * between parents touches the records of both. One-row kinds say "this row
 * is this record". A kind that joins another table maps the joined row to
 * the records it feeds with one batched read. The three windowed kinds map a
 * row to the part of the window it can change: the rows it moved in or out
 * of the window are worked out from the window as the write left it and the
 * captured old and new keys, so window entry and leave are appended too.
 *
 * `record-sources.test.ts` holds the declarations to the builders: each
 * builder may read only the tables declared here, and changing or deleting
 * any row of those tables may change only records the capture of that change
 * names. A missing declaration fails there, not in production.
 */

import {
  asMachineId,
  canonicalShippingDestination,
  checkoutRowId,
  FEED_EVENT_KINDS,
  INSTANCE_PREFERENCES_ROW_ID,
  ISSUE_PANEL_KINDS,
  type IssueId,
  interactionRowId,
  isFeedEventKind,
  issueDepId,
  issueEventRowId,
  issueUserStateRowId,
  layoutRowId,
  type MachineId,
  machineAccessRowId,
  messageRecordRowId,
  pinRowId,
  readPositionRowId,
  type SessionId,
  sessionUserStateRowId,
  shipLaneId,
  subscriptionRowId,
  superagentThreadRowId,
  tabOrderRowId,
  type UserId,
  userPreferencesRowId,
  workflowBindingRowId,
} from '@podium/model'
import type { MetadataEntityKind } from '@podium/protocol'
import type { CapturedRow } from '@podium/sync'
import { type Column, getTableColumns, getTableName, type Table } from 'drizzle-orm'
import {
  agentProfiles,
  automationRuns,
  automations,
  checkouts,
  conversationSegments,
  conversations,
  deliveryReceipts,
  effects,
  grants,
  issueDeps,
  issueGitStates,
  issueLabels,
  issuePanelArtifacts,
  issuePanelDeferred,
  issuePanelStates,
  issuePanelTodos,
  issues,
  issueUserState,
  labels,
  machines,
  messages,
  meta,
  offers,
  pendingInteractions,
  pins,
  podiumEvents,
  queuedMessages,
  repoPrefixes,
  repos,
  runtimeEventCheckpoints,
  sessionDrafts,
  sessionObservationCheckpoints,
  sessions,
  sessionUserState,
  shipHolds,
  shipOrderStackEdges,
  shipOrders,
  snoozes,
  subscriptions,
  superagentThreads,
  tabOrder,
  userLayout,
  userPreferences,
  userReadPosition,
  users,
  workflowBindings,
  workflowRevisions,
  workflowRunSteps,
  workflowRuns,
  workflows,
} from '../migrations/schema'
import { FEED_WINDOW } from '../modules/issue-events/feed'
import { CONFIRMED_PER_SESSION } from '../modules/message-feed/feed'
import { RUNTIME_EVENT_LOG_KIND } from '../store/events'
import type { RecordReads } from './record-builders'

// ---------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------

/** One captured change of a source row: its key before (update, delete) and
 *  after (insert, update), in the order of {@link RecordSource.keys}. */
export interface SourceChange {
  readonly op: 'i' | 'u' | 'd'
  readonly old: readonly unknown[] | null
  readonly new: readonly unknown[] | null
}

/** One model table a kind reads. */
export interface RecordSource {
  readonly table: Table
  /** The columns the capture keeps, old and new. A change of one always fires. */
  readonly keys: readonly Column[]
  /**
   * What the kind reads of a row: an update that changes none of these is not
   * captured. `'all'` (the default) is every column; `{ allBut }` every column
   * except ones no record carries.
   */
  readonly reads?: 'all' | readonly Column[] | { readonly allBut: readonly Column[] }
  /**
   * Values the kind reads that are derived from a row, as SQL over the row
   * (`{row}` stands for `OLD` or `NEW`): an update fires when one of them
   * changes. Used where the record depends on a predicate of the row, not on
   * its columns.
   */
  readonly derived?: readonly string[]
  /** Only rows this holds for (SQL over `{row}`) can change the kind's records. */
  readonly rows?: string
  /**
   * The operations that can change the kind's records (default all three):
   * a source that matters only when a column moves on an existing row (an
   * issue's deletion) watches updates alone.
   */
  readonly ops?: readonly ('i' | 'u' | 'd')[]
  /** The record ids these changes can have changed. */
  ids(
    changes: readonly SourceChange[],
    reads: RecordReads,
  ): Iterable<string> | Promise<Iterable<string>>
}

export type RecordSources = Readonly<Record<MetadataEntityKind, readonly RecordSource[]>>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Every key a change carries: the old one, then the new one. */
function keysOf(changes: readonly SourceChange[]): (readonly unknown[])[] {
  const out: (readonly unknown[])[] = []
  for (const change of changes) {
    if (change.old) out.push(change.old)
    if (change.new) out.push(change.new)
  }
  return out
}

const str = (value: unknown): string => String(value)
const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)]

/** The first key column of every captured key, once each. */
function firstKeys(changes: readonly SourceChange[]): string[] {
  return unique(keysOf(changes).flatMap((key) => (key[0] == null ? [] : [str(key[0])])))
}

/** A table whose row IS the record: the record id is a function of the key. */
function own(
  table: Table,
  keys: readonly Column[],
  idOf: (key: readonly unknown[]) => string | null,
  more: Partial<Pick<RecordSource, 'reads' | 'rows' | 'derived'>> = {},
): RecordSource {
  return {
    table,
    keys,
    ...more,
    ids: (changes) =>
      unique(
        keysOf(changes).flatMap((key) => {
          const id = idOf(key)
          return id === null ? [] : [id]
        }),
      ),
  }
}

/** A table keyed by the record's own id in its first key column. */
const byId = (
  table: Table,
  key: Column,
  more: Partial<Pick<RecordSource, 'reads' | 'rows' | 'derived'>> = {},
): RecordSource => own(table, [key], (k) => (k[0] == null ? null : str(k[0])), more)

/** A parent table whose change reaches records found by a batched read. */
function via(
  table: Table,
  keys: readonly Column[],
  reads: RecordSource['reads'],
  ids: RecordSource['ids'],
  more: Partial<Pick<RecordSource, 'rows' | 'derived' | 'ops'>> = {},
): RecordSource {
  return { table, keys, reads, ids, ...more }
}

/** The person a chat message was sent for, from its attribution columns. */
function senderOf(actorKind: unknown, actorId: unknown, onBehalfOf: unknown): string | null {
  if (typeof onBehalfOf === 'string' && onBehalfOf !== '') return onBehalfOf
  if (actorKind === 'user' && typeof actorId === 'string' && actorId !== '') return actorId
  return null
}

// ---------------------------------------------------------------------------
// The windowed kinds
// ---------------------------------------------------------------------------

/**
 * ISSUE EVENTS: the feed carries the newest `eventWindow` feed-kind events
 * with a subject. The window before the write is the newest of (the events
 * now, less the ones the write added, plus the ones it removed), so the
 * events that entered or left it follow from the window now and the captured
 * keys; an event the write changed is named when it is inside either. A
 * retention batch deleting events below the window names nothing.
 */
async function issueEventIds(
  changes: readonly SourceChange[],
  reads: RecordReads,
): Promise<string[]> {
  const window = Math.max(reads.eventWindow ?? FEED_WINDOW, 1)
  const feedKey = (key: readonly unknown[] | null) =>
    key !== null && typeof key[1] === 'string' && isFeedEventKind(key[1]) && key[2] !== ''
      ? { id: Number(key[0]), subject: str(key[2]) }
      : null
  const added = new Set<number>()
  const removed: { id: number; subject: string }[] = []
  const touched: { id: number; subject: string }[] = []
  for (const change of changes) {
    const was = feedKey(change.old)
    const now = feedKey(change.new)
    if (was) touched.push(was)
    if (now) touched.push(now)
    if (was && (!now || now.id !== was.id)) removed.push(was)
    if (now && (!was || was.id !== now.id)) added.add(now.id)
  }
  if (touched.length === 0) return []
  const current = await reads.store.events.feedWindowIds({ limit: window + changes.length })
  const after = current.slice(0, window)
  const before = [...current.filter((row) => !added.has(row.id)), ...removed]
    .sort((a, b) => b.id - a.id)
    .slice(0, window)
  const afterIds = new Set(after.map((row) => row.id))
  const beforeIds = new Set(before.map((row) => row.id))
  const out: string[] = []
  for (const row of after)
    if (!beforeIds.has(row.id)) out.push(issueEventRowId(row.id, row.subject))
  for (const row of before)
    if (!afterIds.has(row.id)) out.push(issueEventRowId(row.id, row.subject))
  for (const row of touched) {
    if (afterIds.has(row.id) || beforeIds.has(row.id))
      out.push(issueEventRowId(row.id, row.subject))
  }
  return unique(out)
}

/** The message key: id, to_id, actor_kind, actor_id, on_behalf_of,
 *  delivery_status, created_at. */
const MESSAGE_KEYS = [
  messages.id,
  messages.toId,
  messages.actorKind,
  messages.actorId,
  messages.onBehalfOf,
  messages.deliveryStatus,
  messages.createdAt,
] as const

interface ChatKey {
  readonly id: string
  readonly sessionId: string
  readonly recordId: string | null
  readonly confirmed: boolean
  readonly createdAt: string
}

function chatKey(key: readonly unknown[] | null): ChatKey | null {
  if (key === null || key[1] == null) return null
  const sender = senderOf(key[2], key[3], key[4])
  const id = str(key[0])
  const sessionId = str(key[1])
  return {
    id,
    sessionId,
    recordId:
      sender === null
        ? null
        : messageRecordRowId({ sessionId, senderUserId: sender, messageId: id }),
    confirmed: key[5] === 'confirmed',
    createdAt: str(key[6]),
  }
}

const newestFirst = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  a.createdAt === b.createdAt
    ? a.id < b.id
      ? 1
      : a.id > b.id
        ? -1
        : 0
    : a.createdAt < b.createdAt
      ? 1
      : -1

/**
 * CHAT MESSAGES: the open ones, and each live session's newest
 * `confirmedPerSession` confirmed. A written message is named. In every
 * session the write confirmed into or out of, the confirmed tail before the
 * write is the tail now with the captured rows put back as they were, and
 * the records that entered or left it are named too.
 */
async function messageIds(changes: readonly SourceChange[], reads: RecordReads): Promise<string[]> {
  const perSession = reads.confirmedPerSession ?? CONFIRMED_PER_SESSION
  const out: string[] = []
  const wasConfirmed = new Map<string, Map<string, ChatKey>>()
  const nowConfirmed = new Map<string, Set<string>>()
  for (const change of changes) {
    const was = chatKey(change.old)
    const now = chatKey(change.new)
    for (const key of [was, now]) if (key?.recordId) out.push(key.recordId)
    if (was?.confirmed) {
      const map = wasConfirmed.get(was.sessionId) ?? new Map<string, ChatKey>()
      map.set(was.id, was)
      wasConfirmed.set(was.sessionId, map)
    }
    if (now?.confirmed) {
      const set = nowConfirmed.get(now.sessionId) ?? new Set<string>()
      set.add(now.id)
      nowConfirmed.set(now.sessionId, set)
    }
  }
  const affected = unique([...wasConfirmed.keys(), ...nowConfirmed.keys()])
  if (affected.length > 0) {
    const tail = await reads.store.messages.confirmedChatTail(
      perSession + changes.length,
      affected,
      'live',
    )
    const bySession = new Map<string, ChatKey[]>()
    for (const row of tail) {
      if (row.toId === null) continue
      const key = chatKey([
        row.id,
        row.toId,
        row.attribution?.actor?.kind ?? null,
        row.attribution?.actor && 'id' in row.attribution.actor ? row.attribution.actor.id : null,
        row.attribution?.onBehalfOf ?? null,
        row.deliveryStatus,
        row.createdAt,
      ])
      if (key === null) continue
      const list = bySession.get(key.sessionId) ?? []
      list.push(key)
      bySession.set(key.sessionId, list)
    }
    for (const [sessionId, current] of bySession) {
      const was = wasConfirmed.get(sessionId) ?? new Map<string, ChatKey>()
      const now = nowConfirmed.get(sessionId) ?? new Set<string>()
      const after = current.sort(newestFirst).slice(0, perSession)
      const before = [
        ...current.filter((row) => !now.has(row.id) || was.has(row.id)),
        ...[...was.values()].filter((row) => !current.some((c) => c.id === row.id)),
      ]
        .map((row) => was.get(row.id) ?? row)
        .sort(newestFirst)
        .slice(0, perSession)
      const afterIds = new Set(after.map((row) => row.recordId))
      const beforeIds = new Set(before.map((row) => row.recordId))
      for (const row of [...after, ...before]) {
        if (row.recordId && afterIds.has(row.recordId) !== beforeIds.has(row.recordId))
          out.push(row.recordId)
      }
    }
  }
  return unique(out)
}

/** A session is a live conversation: not exited, archived or deleted. */
const LIVE_CONVERSATION = `(coalesce({row}.${sessions.status.name}, '') <> 'exited' AND coalesce({row}.${sessions.archived.name}, 0) = 0 AND {row}.${sessions.deletedAt.name} IS NULL)`

/** Every confirmed chat record of these sessions' tails, live or not. */
async function confirmedTailIds(
  sessionIds: readonly string[],
  reads: RecordReads,
): Promise<string[]> {
  if (sessionIds.length === 0) return []
  const rows = await reads.store.messages.confirmedChatTail(
    reads.confirmedPerSession ?? CONFIRMED_PER_SESSION,
    sessionIds,
    'any',
  )
  return rows.flatMap((row) => {
    const key = chatKey([
      row.id,
      row.toId,
      row.attribution?.actor?.kind ?? null,
      row.attribution?.actor && 'id' in row.attribution.actor ? row.attribution.actor.id : null,
      row.attribution?.onBehalfOf ?? null,
      row.deliveryStatus,
      row.createdAt,
    ])
    return key?.recordId ? [key.recordId] : []
  })
}

// ---------------------------------------------------------------------------
// Joined reads
// ---------------------------------------------------------------------------

/** The sessions whose record reads these issues (their own or reference). */
async function sessionsOfIssues(
  issueIds: readonly string[],
  reads: RecordReads,
): Promise<string[]> {
  if (issueIds.length === 0) return []
  return (await reads.store.sessions.sessionsReferencingIssues(issueIds as IssueId[])).map(
    (row) => row.id,
  )
}

/** Every member's access record of these machines, and every machine's of these members. */
async function accessIds(
  machineIds: readonly string[] | 'all',
  userIds: readonly string[] | 'all',
  reads: RecordReads,
): Promise<string[]> {
  const machineList =
    machineIds === 'all'
      ? (await reads.store.machines.listMachines()).map((machine) => machine.id)
      : machineIds
  const userList =
    userIds === 'all'
      ? (await reads.store.users.recordMembers()).map((member) => member.id)
      : userIds
  const out: string[] = []
  for (const machineId of machineList)
    for (const userId of userList)
      out.push(machineAccessRowId(userId as UserId, asMachineId(machineId)))
  return out
}

/** The access rows a change of these machine grant edges can move. */
async function machineGrantAccessIds(
  changes: readonly SourceChange[],
  reads: RecordReads,
): Promise<string[]> {
  const keys = keysOf(changes).filter((key) => key[0] === 'machine')
  const machineIds = unique(keys.map((key) => str(key[1])))
  if (machineIds.length === 0) return []
  if (keys.some((key) => key[3] === 1 || key[3] === true)) return accessIds(machineIds, 'all', reads)
  const admins = (await reads.store.users.recordMembers())
    .filter((member) => member.role === 'admin')
    .map((member) => member.id as string)
  const out: string[] = []
  for (const machineId of machineIds) {
    const custodian = await reads.store.machines.custodian(machineId)
    const members = unique([
      ...keys.filter((key) => str(key[1]) === machineId).map((key) => str(key[2])),
      ...admins,
      ...(custodian === null ? [] : [custodian as string]),
    ])
    out.push(...(await accessIds([machineId], members, reads)))
  }
  return out
}

/** The ship lanes of these orders, and of the queued orders that depend on them. */
async function lanesOfOrders(
  changes: readonly SourceChange[],
  reads: RecordReads,
): Promise<string[]> {
  const out: string[] = []
  const laneOf = (repoId: unknown, destination: unknown, targetBranch: unknown) => {
    if (typeof repoId !== 'string' || repoId === '') return
    const lane = canonicalShippingDestination(
      typeof destination === 'string' ? destination : '',
      typeof targetBranch === 'string' ? targetBranch : '',
    )
    if (lane !== '') out.push(shipLaneId(repoId as never, lane))
  }
  for (const key of keysOf(changes)) laneOf(key[1], key[2], key[3])
  const ids = firstKeys(changes)
  for (const order of await reads.store.shipping.queuedDependentsOf(ids))
    laneOf(order.repoId, order.destination, order.targetBranch)
  return unique(out)
}

/** The lanes of the orders these rows belong to (first key column: an order id). */
async function lanesOfUpperOrders(
  changes: readonly SourceChange[],
  reads: RecordReads,
): Promise<string[]> {
  const orders = await reads.store.shipping.ordersByIds(firstKeys(changes))
  return lanesOfOrders(
    orders.map((order) => ({
      op: 'u',
      old: null,
      new: [order.id, order.repoId, order.destination, order.targetBranch],
    })),
    reads,
  )
}

// ---------------------------------------------------------------------------
// The kinds
// ---------------------------------------------------------------------------

/**
 * What the machine and access records read of a machine row
 * (`record-facts.ts`): every column but its credential, its heartbeat and
 * presence times, its availability and assignment evidence; of the service
 * report and the harness versions, everything but their observation times,
 * which move every few seconds and are on no record.
 */
const MACHINE_ROW_READS = {
  reads: {
    allBut: [
      machines.tokenHash,
      machines.credentialKind,
      machines.publicKey,
      machines.createdAt,
      machines.lastSeenAt,
      machines.presenceSource,
      machines.availabilityJson,
      machines.assignmentEvidenceJson,
      machines.buildReportedAt,
      machines.serviceReportJson,
      machines.harnessVersionsJson,
    ],
  },
  derived: [
    `CASE WHEN json_valid({row}.${machines.serviceReportJson.name}) THEN json_remove({row}.${machines.serviceReportJson.name}, '$.server.observedAt', '$.agentExecution.observedAt') ELSE {row}.${machines.serviceReportJson.name} END`,
    `CASE WHEN json_valid({row}.${machines.harnessVersionsJson.name}) THEN (SELECT json_group_array(json_remove(report.value, '$.lastSeen')) FROM json_each({row}.${machines.harnessVersionsJson.name}) AS report) ELSE {row}.${machines.harnessVersionsJson.name} END`,
  ],
} as const satisfies Partial<RecordSource>

/**
 * A tombstoned row is on no record: its tombstoning (and a restore) is
 * captured, and what happens to it afterwards, a purge included, is not.
 */
const notTombstoned = (deletedAt: Column): string => `{row}.${deletedAt.name} IS NULL`

/**
 * A row of a session's satellite table can change only the record of a
 * session that is on the feed: one whose row exists and is not tombstoned.
 * (A satellite of a missing session would otherwise append a remove for a
 * record that never was.)
 */
const ofLiveSession = (sessionId: Column): string =>
  `EXISTS (SELECT 1 FROM ${getTableName(sessions)} WHERE ${sessions.id.name} = {row}.${sessionId.name} AND ${sessions.deletedAt.name} IS NULL)`

/** The fleet's update channel and published targets (`machine-record-context.ts`). */
const MACHINE_CONTEXT_ROWS = `{row}.${meta.key.name} IN ('machines.fleet-channel.v1', 'updates.execution.v1')`

/**
 * What a machine record reads of those rows: the channel's whole value, and
 * of the update checkpoint only each channel's published version, so a
 * checkpoint write that moved no version leaves no trace.
 */
const MACHINE_CONTEXT_VALUE = `CASE WHEN {row}.${meta.key.name} = 'updates.execution.v1' AND json_valid({row}.${meta.value.name}) THEN (SELECT group_concat(json_extract(target.value, '$[0]') || '=' || coalesce(json_extract(target.value, '$[1].version'), ''), ',') FROM json_each({row}.${meta.value.name}, '$.targets') AS target) ELSE {row}.${meta.value.name} END`

/** The machine context rows, captured by key and by {@link MACHINE_CONTEXT_VALUE}. */
const machineContext = (ids: RecordSource['ids']): RecordSource =>
  via(meta, [meta.key], [], ids, { rows: MACHINE_CONTEXT_ROWS, derived: [MACHINE_CONTEXT_VALUE] })

/** The feed event kinds, as an SQL list. */
const FEED_KINDS_SQL = FEED_EVENT_KINDS.map((kind) => `'${kind.replaceAll("'", "''")}'`).join(', ')

const panelTables = {
  issuePanelTodo: issuePanelTodos,
  issuePanelArtifact: issuePanelArtifacts,
  issuePanelDeferred: issuePanelDeferred,
  issuePanelState: issuePanelStates,
} as const

/** A soft-deleted issue takes these kinds' records with it. */
const issueDeletion = (
  ids: (
    issueIds: readonly string[],
    reads: RecordReads,
  ) => Promise<Iterable<string>> | Iterable<string>,
): RecordSource =>
  via(issues, [issues.id], [issues.deletedAt], (changes, reads) => ids(firstKeys(changes), reads), {
    // A new issue has none of these records yet, and a purged one's leave
    // with their own rows.
    ops: ['u'],
  })

const panelSources = Object.fromEntries(
  ISSUE_PANEL_KINDS.map((kind) => {
    const table = panelTables[kind]
    return [
      kind,
      [
        byId(table, table.id),
        issueDeletion(async (issueIds, reads) =>
          (await reads.store.issues.panel.forIssues(kind, issueIds)).map((record) => record.id),
        ),
      ],
    ]
  }),
) as unknown as Record<(typeof ISSUE_PANEL_KINDS)[number], readonly RecordSource[]>

export const RECORD_SOURCES: RecordSources = {
  conversation: [
    // Not its activity stamps: the index keeps them, the record does not
    // carry them (POD-6768).
    byId(conversations, conversations.id, {
      reads: { allBut: [conversations.updatedAt, conversations.messageCount] },
    }),
    // The record carries the Podium id of the segment the conversation is
    // (same machine, native id = conversation id).
    via(
      conversationSegments,
      [conversationSegments.machineId, conversationSegments.nativeId],
      [conversationSegments.podiumId],
      (changes) => unique(keysOf(changes).flatMap((key) => (key[1] == null ? [] : [str(key[1])]))),
    ),
  ],
  issueGitState: [
    byId(issueGitStates, issueGitStates.issueId),
    issueDeletion((issueIds) => issueIds),
  ],
  machine: [
    // The machine record (`record-facts.ts` MachineProjection): its name,
    // logged-out harnesses (inventory), version, channel override and install
    // kind; the rest of the row is the access rows'.
    byId(machines, machines.id, {
      reads: [
        machines.name,
        machines.inventoryJson,
        machines.appVersion,
        machines.updateChannelOverride,
        machines.installKind,
        machines.revokedAt,
        machines.supersededBy,
      ],
    }),
    // The custodian is read from the machine's grant edges.
    via(
      grants,
      [grants.resourceKind, grants.resourceId],
      'all',
      (changes) =>
        unique(keysOf(changes).flatMap((key) => (key[0] === 'machine' ? [str(key[1])] : []))),
      { rows: `{row}.${grants.resourceKind.name} = 'machine'` },
    ),
    // The fleet's update channel and published targets reach every machine.
    machineContext(async (_changes, reads) =>
      (await reads.store.machines.listMachines()).map((machine) => machine.id),
    ),
  ],
  machineAccess: [
    // An access row carries what a member may see and use of the machine,
    // not its name, version or update channel (those are the machine record's).
    via(
      machines,
      [machines.id],
      {
        allBut: [
          ...MACHINE_ROW_READS.reads.allBut,
          machines.name,
          machines.appVersion,
          machines.updateChannel,
          machines.updateChannelOverride,
          machines.installKind,
        ],
      },
      (changes, reads) => accessIds(firstKeys(changes), 'all', reads),
      { derived: MACHINE_ROW_READS.derived },
    ),
    // A machine grant edge changes its grantee's row, and the rows that list
    // the machine's grants (its custodian's and the admins'); a custody edge
    // changes who owns it, which every member's row says.
    via(
      grants,
      [grants.resourceKind, grants.resourceId, grants.grantee, grants.custody],
      'all',
      machineGrantAccessIds,
      { rows: `{row}.${grants.resourceKind.name} = 'machine'` },
    ),
    // A member is in the fleet's access while enabled with a role (`recordMembers`).
    via(users, [users.id], [users.role, users.disabledAt], (changes, reads) =>
      accessIds('all', firstKeys(changes), reads),
    ),
    // The access rows are built from the same machine facts, which read the
    // fleet's update context.
    machineContext((_changes, reads) => accessIds('all', 'all', reads)),
  ],
  // A repo is a fold of its registrations: a change to one reaches the
  // logical repo it belongs to, before and after.
  repo: [
    own(repos, [repos.repoId], (key) => (key[0] == null ? null : str(key[0]))),
    own(repoPrefixes, [repoPrefixes.repoId], (key) => (key[0] == null ? null : str(key[0]))),
  ],
  issueProjection: [
    byId(issues, issues.id),
    own(issueLabels, [issueLabels.issueId], (key) => str(key[0])),
    // A label's name reaches the issues carrying it; a new label carries
    // none, and a deleted one leaves them through their own label rows.
    via(
      labels,
      [labels.id],
      [labels.name],
      async (changes, reads) =>
        await reads.store.issues.issueIdsOfLabels(firstKeys(changes).map(Number)),
      { ops: ['u'] },
    ),
  ],
  // Each text is a record of its own, keyed by the issue (POD-6921).
  issueBrief: [byId(issues, issues.id, { reads: [issues.brief] })],
  issueDescription: [byId(issues, issues.id, { reads: [issues.description] })],
  ...panelSources,
  issueDep: [
    own(issueDeps, [issueDeps.fromId, issueDeps.toId, issueDeps.type], (key) =>
      issueDepId(str(key[0]), str(key[1]), str(key[2])),
    ),
  ],
  issueUserState: [
    own(issueUserState, [issueUserState.userId, issueUserState.issueId], (key) =>
      issueUserStateRowId(key[0] as UserId, key[1] as IssueId),
    ),
  ],
  subscription: [
    own(
      subscriptions,
      [subscriptions.subscriberKind, subscriptions.subscriberId, subscriptions.id],
      (key) => subscriptionRowId(key[0] as never, str(key[1]), str(key[2])),
    ),
  ],
  shipOrder: [
    byId(shipOrders, shipOrders.id),
    own(shipHolds, [shipHolds.orderId], (key) => str(key[0])),
    own(deliveryReceipts, [deliveryReceipts.orderId], (key) => str(key[0])),
  ],
  shipLane: [
    via(
      shipOrders,
      [shipOrders.id, shipOrders.repoId, shipOrders.destination, shipOrders.targetBranch],
      'all',
      lanesOfOrders,
    ),
    via(shipOrderStackEdges, [shipOrderStackEdges.upperOrderId], 'all', lanesOfUpperOrders),
    // A lane's plan reads its orders' open holds and delivery receipts.
    via(shipHolds, [shipHolds.orderId], 'all', lanesOfUpperOrders),
    via(deliveryReceipts, [deliveryReceipts.orderId], 'all', lanesOfUpperOrders),
  ],
  automation: [byId(automations, automations.id, { rows: notTombstoned(automations.deletedAt) })],
  automationRun: [
    byId(automationRuns, automationRuns.id, { rows: notTombstoned(automationRuns.deletedAt) }),
  ],
  userLayout: [
    own(
      userLayout,
      [userLayout.userId, userLayout.key],
      (key) => layoutRowId(key[0] as UserId, str(key[1])),
      { reads: { allBut: [userLayout.updatedAt] } },
    ),
  ],
  userReadPosition: [
    own(
      userReadPosition,
      [userReadPosition.userId, userReadPosition.streamId],
      (key) => readPositionRowId(key[0] as UserId, str(key[1])),
      { reads: { allBut: [userReadPosition.updatedAt] } },
    ),
  ],
  pin: [
    own(pins, [pins.userId, pins.kind, pins.id], (key) =>
      pinRowId(key[0] as UserId, key[1] as never, str(key[2])),
    ),
  ],
  tabOrder: [
    own(
      tabOrder,
      [tabOrder.userId, tabOrder.worktree],
      (key) => tabOrderRowId(key[0] as UserId, str(key[1])),
      { reads: { allBut: [tabOrder.updatedAt] } },
    ),
  ],
  // One record per person, folding all of the person's leaves.
  userPreferences: [
    own(userPreferences, [userPreferences.userId], (key) => userPreferencesRowId(key[0] as UserId)),
  ],
  sessionUserState: [
    own(sessionUserState, [sessionUserState.userId, sessionUserState.sessionId], (key) =>
      sessionUserStateRowId(key[0] as UserId, key[1] as SessionId),
    ),
    own(snoozes, [snoozes.userId, snoozes.sessionId], (key) =>
      sessionUserStateRowId(key[0] as UserId, key[1] as SessionId),
    ),
    // A disabled person's markers leave the feed; a deleted session's too.
    via(
      users,
      [users.id],
      [users.disabledAt, users.role],
      async (changes, reads) =>
        await reads.store.sessions.sessionUserStateIdsOf({ userIds: firstKeys(changes) }),
    ),
    via(
      sessions,
      [sessions.id],
      [sessions.deletedAt],
      async (changes, reads) =>
        await reads.store.sessions.sessionUserStateIdsOf({ sessionIds: firstKeys(changes) }),
    ),
  ],
  superagentThread: [
    // Never on the record: the watermarks, the harness's own session id (the
    // record says only whether there is one) and the terminal lock.
    own(
      superagentThreads,
      [superagentThreads.ownerUserId, superagentThreads.id],
      (key) => superagentThreadRowId(key[0] as UserId, str(key[1])),
      {
        reads: {
          allBut: [
            superagentThreads.watermarkItemId,
            superagentThreads.watermarkTs,
            superagentThreads.harnessSessionId,
            superagentThreads.terminalSessionId,
          ],
        },
        derived: [`{row}.${superagentThreads.harnessSessionId.name} IS NOT NULL`],
      },
    ),
  ],
  agentProfile: [byId(agentProfiles, agentProfiles.id)],
  workflow: [
    byId(workflows, workflows.id),
    // The workflow's record reads its revisions (its latest one).
    own(workflowRevisions, [workflowRevisions.workflowId], (key) =>
      key[0] == null ? null : str(key[0]),
    ),
  ],
  workflowRevision: [byId(workflowRevisions, workflowRevisions.id)],
  workflowBinding: [
    own(workflowBindings, [workflowBindings.targetKind, workflowBindings.targetId], (key) =>
      workflowBindingRowId(key[0] as never, str(key[1])),
    ),
  ],
  workflowRun: [
    byId(workflowRuns, workflowRuns.id),
    own(workflowRunSteps, [workflowRunSteps.runId], (key) => str(key[0])),
    via(
      workflowRevisions,
      [workflowRevisions.id],
      [workflowRevisions.workflowId],
      async (changes, reads) => await reads.store.workflows.runIdsOfRevisions(firstKeys(changes)),
    ),
  ],
  instancePreferences: [
    own(meta, [meta.key], () => INSTANCE_PREFERENCES_ROW_ID, {
      rows: `{row}.${meta.key.name} = 'settings'`,
    }),
  ],
  effect: [byId(effects, effects.id, { rows: notTombstoned(effects.deletedAt) })],
  checkout: [
    own(checkouts, [checkouts.machineId, checkouts.path], (key) =>
      checkoutRowId(key[0] as MachineId, str(key[1])),
    ),
  ],
  issueEvent: [
    via(
      podiumEvents,
      [podiumEvents.id, podiumEvents.kind, podiumEvents.subject],
      'all',
      issueEventIds,
      {
        rows: `{row}.${podiumEvents.kind.name} IN (${FEED_KINDS_SQL}) AND {row}.${podiumEvents.subject.name} <> ''`,
      },
    ),
  ],
  pendingInteraction: [
    // An ask is on the feed while it is open: its answering takes it off,
    // and what is written to it afterwards reaches no record.
    own(
      pendingInteractions,
      [pendingInteractions.sessionId, pendingInteractions.id],
      (key) => interactionRowId(str(key[0]), str(key[1])),
      { rows: `{row}.${pendingInteractions.status.name} = 'asked'` },
    ),
  ],
  message: [
    // Not its delivery bookkeeping: the record carries the status.
    via(
      messages,
      MESSAGE_KEYS,
      { allBut: [messages.deliveredAt, messages.deliveredTo, messages.injectedAt, messages.hop] },
      messageIds,
      {
        rows: `{row}.${messages.fromKind.name} = 'operator' AND {row}.${messages.toKind.name} = 'session'`,
      },
    ),
    // A session that stops (or starts again) being a live conversation takes
    // its confirmed tail off the feed (or back).
    via(
      sessions,
      [sessions.id],
      [],
      async (changes, reads) => await confirmedTailIds(firstKeys(changes), reads),
      { derived: [LIVE_CONVERSATION] },
    ),
  ],
  session: [
    // Not the activity and terminal counters and times, the unpublished
    // activity time or the terminal size: the record carries the published
    // activity time, and these are live topics, not record fields (POD-6764).
    byId(sessions, sessions.id, {
      reads: {
        allBut: [
          sessions.lastActiveAt,
          sessions.lastActivePublishAfter,
          sessions.terminalCols,
          sessions.terminalRows,
          sessions.inputCount,
          sessions.outputCount,
          sessions.activityCount,
          sessions.lastOutputAt,
          sessions.lastInputAt,
          sessions.workingMsTotal,
        ],
      },
      rows: notTombstoned(sessions.deletedAt),
    }),
    own(offers, [offers.sessionId], (key) => str(key[0]), { rows: ofLiveSession(offers.sessionId) }),
    own(sessionDrafts, [sessionDrafts.sessionId], (key) => str(key[0]), {
      rows: ofLiveSession(sessionDrafts.sessionId),
    }),
    // The record reads a lease's checkpoint only (`checkpointsOf`): a lease
    // opened or fenced with no checkpoint changes nothing.
    own(
      sessionObservationCheckpoints,
      [sessionObservationCheckpoints.sessionId],
      (key) => str(key[0]),
      {
        reads: [
          sessionObservationCheckpoints.checkpointJson,
          sessionObservationCheckpoints.provider,
        ],
        rows: `{row}.${sessionObservationCheckpoints.checkpointJson.name} IS NOT NULL AND ${ofLiveSession(sessionObservationCheckpoints.sessionId)}`,
      },
    ),
    own(runtimeEventCheckpoints, [runtimeEventCheckpoints.sessionId], (key) => str(key[0]), {
      reads: [runtimeEventCheckpoints.turnStateJson],
      rows: `{row}.${runtimeEventCheckpoints.turnStateJson.name} IS NOT NULL AND ${ofLiveSession(runtimeEventCheckpoints.sessionId)}`,
    }),
    // Whether the session has a runtime transcript: only resets and complete
    // items can change it.
    own(podiumEvents, [podiumEvents.subject], (key) => str(key[0]), {
      rows: `{row}.${podiumEvents.kind.name} = '${RUNTIME_EVENT_LOG_KIND}' AND json_extract({row}.${podiumEvents.payload.name}, '$.t') IN ('transcript-reset', 'item') AND ${ofLiveSession(podiumEvents.subject)}`,
    }),
    // The queued message count.
    own(queuedMessages, [queuedMessages.sessionId], (key) => str(key[0]), {
      reads: [queuedMessages.sessionId],
      rows: ofLiveSession(queuedMessages.sessionId),
    }),
    // The Podium conversation id of the session's resume value.
    via(
      conversationSegments,
      [conversationSegments.machineId, conversationSegments.nativeId],
      [conversationSegments.podiumId],
      async (changes, reads) => {
        const byMachine = new Map<string, string[]>()
        for (const key of keysOf(changes)) {
          const list = byMachine.get(str(key[0])) ?? []
          list.push(str(key[1]))
          byMachine.set(str(key[0]), list)
        }
        const out: string[] = []
        for (const [machineId, nativeIds] of byMachine) {
          for (const rows of (
            await reads.store.sessions.listSessionsByResumeValues(nativeIds)
          ).values())
            for (const row of rows) if (row.machineId === machineId) out.push(row.id)
        }
        return out
      },
    ),
    // The issue and reference joins.
    via(
      issues,
      [issues.id],
      'all',
      async (changes, reads) => await sessionsOfIssues(firstKeys(changes), reads),
    ),
    // The reference's repo, resolved by path.
    via(repos, [repos.path], 'all', async (changes, reads) => {
      const out: string[] = []
      for (const path of firstKeys(changes))
        for (const row of await reads.store.sessions.sessionsUnderPath(path)) out.push(row.id)
      return out
    }),
  ],
}

// ---------------------------------------------------------------------------
// The drain
// ---------------------------------------------------------------------------

/**
 * The records the captured rows reach, by kind, each id once, kinds in
 * declaration order. A kind outside `kinds` (a test's subset) is skipped.
 * One batched mapping per (kind, source) with captured rows.
 */
export async function touchedRecords(
  rows: readonly CapturedRow[],
  reads: RecordReads,
  kinds?: ReadonlySet<MetadataEntityKind>,
  sources: RecordSources = RECORD_SOURCES,
): Promise<Map<MetadataEntityKind, string[]>> {
  const groups = new Map<
    string,
    { kind: MetadataEntityKind; source: number; changes: SourceChange[] }
  >()
  for (const row of rows) {
    const kind = row.kind as MetadataEntityKind
    if (kinds !== undefined && !kinds.has(kind)) continue
    const key = `${row.kind}\u0000${row.source}`
    let group = groups.get(key)
    if (group === undefined) {
      group = { kind, source: row.source, changes: [] }
      groups.set(key, group)
    }
    group.changes.push({ op: row.op, old: row.oldKey, new: row.newKey })
  }
  const out = new Map<MetadataEntityKind, string[]>()
  const seen = new Map<MetadataEntityKind, Set<string>>()
  for (const { kind, source, changes } of groups.values()) {
    const declared = sources[kind]?.[source]
    if (declared === undefined) {
      throw new Error(`sync capture: no source ${source} declared for kind ${kind}`)
    }
    const ids = await declared.ids(changes, reads)
    let list = out.get(kind)
    let have = seen.get(kind)
    if (list === undefined || have === undefined) {
      list = []
      have = new Set()
      out.set(kind, list)
      seen.set(kind, have)
    }
    for (const id of ids) {
      if (have.has(id)) continue
      have.add(id)
      list.push(id)
    }
  }
  // Kinds in their declaration order, ids in the order captured: one commit's
  // rows come out in the same order however its triggers fired.
  const ordered = new Map<MetadataEntityKind, string[]>()
  for (const kind of Object.keys(sources) as MetadataEntityKind[]) {
    const list = out.get(kind)
    if (list !== undefined && list.length > 0) ordered.set(kind, list)
  }
  return ordered
}

/** The SQL name of every column a source watches, keys first. */
export function watchedColumns(source: RecordSource): string[] {
  const all = Object.values(getTableColumns(source.table)).map((column) => column.name)
  const reads = source.reads ?? 'all'
  const read =
    reads === 'all'
      ? all
      : 'allBut' in reads
        ? all.filter((name) => !reads.allBut.some((column) => column.name === name))
        : reads.map((column) => column.name)
  return unique([...source.keys.map((column) => column.name), ...read])
}

/** The table a source reads, by its SQL name. */
export const sourceTableName = (source: RecordSource): string => getTableName(source.table)
