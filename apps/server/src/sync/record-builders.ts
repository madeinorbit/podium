/**
 * THE SERVER'S RECORD BUILDERS (POD-6763, design POD-6253 §1).
 *
 * One builder per record kind that can be built from the database: the 24
 * the 2026-11-10 audit found database-only, POD-6765's four, and the three
 * joined or folded kinds (`repo`, `shipLane`, `userPreferences`, POD-6769).
 * `build(ids)` and `streamAll()` read the model tables through the
 * repositories and map each row with the SAME function the kind's publisher
 * uses today, so a built record is the published record. A builder never
 * reads `change_latest`, the change log, or server memory.
 *
 * No kind is left out. Conversation, machine, access and issue git facts read
 * stored rows (POD-6765).
 *
 * `session` joined with POD-6764: its live plane (controller, size, client
 * count, busy, gated requests, last input, context use) left the record for
 * the session topics, and what a daemon reported or the transcript showed is
 * stored on the row, so the record is its row plus the satellites a restart
 * restores it with (`modules/sessions/records.ts`).
 *
 * WHAT IS NOT A PURE FUNCTION OF ROWS, AND WHY IT IS STILL HERE
 *  - Code-derived facts (harness policies/capabilities, wire compatibility,
 *    defaults, effect publication and window sizes) are fingerprinted per kind
 *    in `kind-tokens.ts`, so an upgrade reloads their records without a row write.
 *  - `effect`: the published input depends on which effect kinds this server
 *    serves and how each publishes its input (`EffectExecutorRegistry`). That
 *    is code, not data, but a process must hold the same registry to build it.
 *  - `sessionUserState`: an expired snooze reads as absent, so the record
 *    depends on the clock (`now`) as the publisher's own read does. Records
 *    for a session the person never opened are "cleared" markers the
 *    publisher keeps only on the log; `build(ids)` answers them (the session
 *    and the member still exist), `streamAll()` cannot list them.
 *  - The three windowed kinds carry the window as a query: the newest
 *    `FEED_WINDOW` feed-kind events, every open interaction, and the open
 *    chat messages plus each live session's newest
 *    {@link CONFIRMED_PER_SESSION} confirmed ones. Their publishers decide
 *    what the feed carries from the same reads (POD-6766), so the two agree.
 *
 * Compare at save, the start-up load and the sharing rules read these builders.
 */

import {
  asMachineId,
  checkoutRowId,
  INSTANCE_PREFERENCES_ROW_ID,
  ISSUE_PANEL_KINDS,
  type IssueBodyKind,
  type IssueProjection,
  instancePreferencesRecordOf,
  issueUserStateRowId,
  issueUserStateToWire,
  layoutRowId,
  parseCheckoutRowId,
  parseInteractionRowId,
  parseIssueDepId,
  parseIssueEventRowId,
  parseIssueUserStateRowId,
  parseLayoutRowId,
  parseMachineAccessRowId,
  parseMessageRecordRowId,
  parsePinRowId,
  parseReadPositionRowId,
  parseSessionUserStateRowId,
  parseShipLaneId,
  parseSubscriptionRowId,
  parseSuperagentThreadRowId,
  parseTabOrderRowId,
  parseUserPreferencesRowId,
  parseWorkflowBindingRowId,
  pinRowId,
  readPositionRowId,
  type SessionId,
  type SessionUserStateWire,
  sessionUserStateRowId,
  subscriptionRowIdOf,
  superagentThreadRowId,
  tabOrderRowId,
  type UserId,
  userPreferencesRowId,
  workflowBindingRowId,
} from '@podium/model'
import type { MetadataEntityKind } from '@podium/protocol'
import {
  type BuiltRecord,
  pagesOf,
  RECORD_PAGE_SIZE,
  type RecordBuilder,
  type RecordBuilderGroup,
  RecordBuilderRegistry,
  type RecordPage,
} from '@podium/sync/record-builders'
import { effectRecordOf } from '../modules/effects/feed'
import type { EffectExecutorRegistry } from '../modules/effects/registry'
import { openInteractionRecords } from '../modules/interactions/feed'
import { interactionWireOf } from '../modules/interactions/service'
import { FEED_WINDOW, issueEventRecordOf, issueEventWindow } from '../modules/issue-events/feed'
import {
  issueBriefOf,
  issueDepToProjection,
  issueDescriptionOf,
  issueRowToProjection,
  repoProjectionRows,
  slimIssueProjection,
  slimIssueProjectionOfRow,
} from '../modules/issues/projection'
import { storedMachineRecordFacts } from '../modules/machines/record-facts'
import { machineRecordSpecs } from '../modules/machines/records'
import {
  CONFIRMED_PER_SESSION,
  isOpenChat,
  messageRecords,
  messageWindow,
} from '../modules/message-feed/feed'
import { SessionRecords } from '../modules/sessions/records'
import { sessionProjectionPass, wireRecord } from '../modules/sessions/view'
import {
  laneDependencyIds,
  scheduledShippingProjection,
  shipOrderProjectionRows,
} from '../modules/shipping/projection'
import { shipLaneSchedule, withNativeStackEdges } from '../modules/shipping/queue'
import { superagentThreadWireOf } from '../modules/superagent/thread-records'
import { workflowRunRecordOf } from '../modules/workflows/records'
import type { SessionStore } from '../store'
import { checkoutWireOf } from '../store/checkouts'
import type { IssueRow, MachineRecord, SessionRow } from '../store/types'

/** What the builders read: the store's repositories (in process, or built over
 *  the sync worker's read-only connection), the effect kinds this server
 *  serves, and the clock a snooze expires against. */
export interface RecordReads {
  readonly store: Pick<
    SessionStore,
    | 'issues'
    | 'sessions'
    | 'users'
    | 'shipping'
    | 'automations'
    | 'layout'
    | 'readPositions'
    | 'events'
    | 'interactions'
    | 'messages'
    | 'effects'
    | 'superagent'
    | 'agentProfiles'
    | 'workflows'
    | 'checkouts'
    | 'settings'
    | 'machines'
    | 'grants'
    | 'conversations'
    // The session record's satellites and joins (POD-6764).
    | 'observationCheckpoints'
    | 'repos'
    | 'sync'
  >
  readonly effectExecutors: Pick<EffectExecutorRegistry, 'get'>
  readonly now: () => number
  /** Window sizes shared with a test's feed publishers. Production uses their defaults. */
  readonly confirmedPerSession?: number
  readonly eventWindow?: number
}

type Builder = RecordBuilder<RecordReads>

/** Parse each id with `parse`; an id the kind never composed is no record. */
function parsed<T>(ids: readonly string[], parse: (id: string) => T | null | undefined): T[] {
  const out: T[] = []
  for (const id of ids) {
    try {
      const key = parse(id)
      if (key !== null && key !== undefined) out.push(key)
    } catch {
      // Not this kind's id.
    }
  }
  return out
}

const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)]

const conversation: Builder = {
  kind: 'conversation',
  shape: 'row-and-reads',
  async build({ store }, ids) {
    return (await store.conversations.index.records(ids)).map((value) => ({ id: value.id, value }))
  },
  async *streamAll({ store }) {
    for await (const page of store.conversations.index.recordPages(RECORD_PAGE_SIZE))
      yield page.map((value) => ({ id: value.id, value }))
  },
}

const issueGitState: Builder = {
  kind: 'issueGitState',
  shape: 'row-and-reads',
  async build({ store }, ids) {
    return [...(await store.issues.gitStates.getMany(ids)).values()].map((value) => ({
      id: value.id,
      value,
    }))
  },
  async *streamAll({ store }) {
    for await (const page of store.issues.gitStates.pages(RECORD_PAGE_SIZE))
      yield page.map((value) => ({ id: value.id, value }))
  },
}

const machine: Builder = {
  kind: 'machine',
  shape: 'row-and-reads',
  async build({ store }, ids) {
    return (await storedMachineRecordFacts(store, parsed(ids, asMachineId))).map(
      ({ machine: value }) => ({ id: value.id, value }),
    )
  },
  async *streamAll(reads) {
    for await (const page of reads.store.machines.recordPages(RECORD_PAGE_SIZE))
      yield (await storedMachineRecordFacts(reads.store, undefined, { records: page })).map(
        ({ machine: value }) => ({ id: value.id, value }),
      )
  },
}

async function storedAccessRows(
  { store }: RecordReads,
  ids: readonly string[],
  records?: readonly MachineRecord[],
  memberIds?: ReadonlySet<string>,
): Promise<BuiltRecord[]> {
  if (ids.length === 0) return []
  const machineIds = ids.map(asMachineId)
  const edges = await store.grants.loadForResources('machine', machineIds)
  const facts = await storedMachineRecordFacts(store, machineIds, { grants: edges, records })
  const specs = await machineRecordSpecs({
    facts: async () => facts,
    grants: async () => edges,
    members: async () => (await store.users.recordMembers())
      .filter((member) => memberIds === undefined || memberIds.has(member.id)),
  })
  return specs.flatMap((spec) =>
    spec.entity === 'machineAccess' && spec.op === 'upsert'
      ? [{ id: spec.id, value: spec.value }]
      : [],
  )
}

const machineAccess: Builder = {
  kind: 'machineAccess',
  shape: 'row-and-reads',
  async build(reads, ids) {
    const asked = new Set(ids)
    const keys = parsed(ids, parseMachineAccessRowId)
    return (
      await storedAccessRows(
        reads,
        unique(keys.map(({ machineId }) => machineId)),
        undefined,
        new Set(keys.map(({ userId }) => userId)),
      )
    ).filter(({ id }) => asked.has(id))
  },
  async *streamAll(reads) {
    for await (const page of reads.store.machines.recordPages(RECORD_PAGE_SIZE))
      yield* pagesOf(
        await storedAccessRows(
          reads,
          page.map(({ id }) => id),
          page,
        ),
      )
  },
}

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

/**
 * The LOGICAL repo: several machine checkouts fold into one record (its
 * prefix, base branch, chosen path and name), by the fold its publisher uses,
 * `repoProjectionRows`. The registry is a handful of rows, so "these ids"
 * reads it whole and filters.
 */
const repo: Builder = {
  kind: 'repo',
  shape: 'row-and-reads',
  async build({ store }, ids) {
    const asked = new Set(ids)
    return repoProjectionRows(await store.repos.listRepos()).filter((row) => asked.has(row.id))
  },
  streamAll: ({ store }) => pagesOf(store.repos.listRepos().then(repoProjectionRows)),
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

/** One issue row and its labels, as `IssueService` publishes it: the slim
 *  record, without its bodies (POD-6767). A row that cannot be projected
 *  (incomplete attribution) is no record. */
function projectIssues(
  rows: readonly IssueRow[],
  labels: ReadonlyMap<string, string[]>,
): BuiltRecord[] {
  return rows.flatMap((row) => {
    try {
      return [{ id: row.id, value: slimIssueProjectionOfRow(row, labels.get(row.id) ?? []) }]
    } catch {
      return []
    }
  })
}

const issueProjection: Builder = {
  kind: 'issueProjection',
  shape: 'row-and-reads',
  async build({ store }, ids) {
    const rows = [...(await store.issues.getIssues(ids)).values()]
    return projectIssues(rows, await store.issues.labelsOfIssues(rows.map((row) => row.id)))
  },
  async *streamAll({ store }) {
    for await (const page of store.issues.issueRowPages(RECORD_PAGE_SIZE)) {
      yield projectIssues(page, await store.issues.labelsOfIssues(page.map((row) => row.id)))
    }
  },
}

/** One body kind of each issue row (POD-6921): its record, or none when the
 *  field is empty or the row cannot be projected. */
function issueBodyBuilder(
  kind: IssueBodyKind,
  of: (projection: IssueProjection) => { id: string } | undefined,
): Builder {
  const records = (rows: Iterable<IssueRow>): BuiltRecord[] =>
    [...rows].flatMap((row) => {
      try {
        const value = of(issueRowToProjection(row, []))
        return value ? [{ id: row.id, value }] : []
      } catch {
        return []
      }
    })
  return {
    kind,
    shape: 'row',
    build: async ({ store }, ids) => records((await store.issues.getIssues(ids)).values()),
    async *streamAll({ store }) {
      for await (const page of store.issues.issueRowPages(RECORD_PAGE_SIZE)) yield records(page)
    },
  }
}

const issueBrief = issueBodyBuilder('issueBrief', issueBriefOf)
const issueDescription = issueBodyBuilder('issueDescription', issueDescriptionOf)

/** The kinds built from one issue row, in their registry order. */
const ISSUE_ROW_KINDS = ['issueProjection', 'issueBrief', 'issueDescription'] as const

/** Map each stored row once and use its projection for every record built
 *  from it: the slim issue record and its two bodies. */
async function issueRecordPages(
  store: RecordReads['store'],
  rows: readonly IssueRow[],
  asked?: ReadonlyMap<MetadataEntityKind, ReadonlySet<string>>,
): Promise<readonly RecordPage[]> {
  const wants = (kind: MetadataEntityKind, id: string) => !asked || asked.get(kind)?.has(id) === true
  const projectionRows = rows.filter(({ id }) => wants('issueProjection', id))
  const labels = await store.issues.labelsOfIssues(projectionRows.map(({ id }) => id))
  const projections: BuiltRecord[] = []
  const briefs: BuiltRecord[] = []
  const descriptions: BuiltRecord[] = []
  for (const row of rows) {
    try {
      const { id } = row
      const projection = issueRowToProjection(row, labels.get(id) ?? [])
      if (wants('issueProjection', id)) {
        projections.push({ id, value: slimIssueProjection(projection) })
      }
      const brief = wants('issueBrief', id) ? issueBriefOf(projection) : undefined
      if (brief) briefs.push({ id, value: brief })
      const description = wants('issueDescription', id) ? issueDescriptionOf(projection) : undefined
      if (description) descriptions.push({ id, value: description })
    } catch {
      // A row that cannot be projected has no records.
    }
  }
  return [
    { entity: 'issueProjection', records: projections },
    { entity: 'issueBrief', records: briefs },
    { entity: 'issueDescription', records: descriptions },
  ]
}

const issueRecordGroup: RecordBuilderGroup<RecordReads> = {
  kinds: ISSUE_ROW_KINDS,
  async build({ store }, idsByKind) {
    const asked = new Map(
      ISSUE_ROW_KINDS.map((kind) => [kind as MetadataEntityKind, new Set(idsByKind.get(kind))]),
    )
    const rows = await store.issues.getIssues([...asked.values()].flatMap((ids) => [...ids]))
    const pages = await issueRecordPages(store, [...rows.values()], asked)
    return new Map(pages.map(({ entity, records }) => [entity, records]))
  },
  async *streamAll({ store }) {
    for await (const rows of store.issues.issueRowPages(RECORD_PAGE_SIZE)) {
      yield* await issueRecordPages(store, rows)
    }
  },
}

function depRecords(deps: Iterable<{ fromId: string; toId: string; type: string }>): BuiltRecord[] {
  return [...deps].flatMap((dep) => {
    try {
      const value = issueDepToProjection(dep)
      return [{ id: value.id, value }]
    } catch {
      return []
    }
  })
}

const issueDep: Builder = {
  kind: 'issueDep',
  shape: 'row',
  async build({ store }, ids) {
    const from = unique(parsed(ids, parseIssueDepId).map((key) => key.fromId))
    return depRecords(await store.issues.depsFromIssues(from))
  },
  streamAll: ({ store }) => pagesOf(store.issues.listAllIssueDeps().then(depRecords)),
}

const issueUserState: Builder = {
  kind: 'issueUserState',
  shape: 'row',
  async build({ store }, ids) {
    const pairs = parsed(ids, parseIssueUserStateRowId)
    const out: BuiltRecord[] = []
    const byUser = new Map<UserId, string[]>()
    for (const pair of pairs) {
      const list = byUser.get(pair.userId) ?? []
      list.push(pair.entityId)
      byUser.set(pair.userId, list)
    }
    // Asked together, so the people's rows are one batched read (the
    // repository's loader joins loads asked in the same tick): an issue write
    // names every member's record of the issue (POD-6769).
    const loaded = await Promise.all(
      [...byUser].map(
        async ([userId, issueIds]) =>
          [userId, await store.issues.loadIssueUserStates(userId, issueIds)] as const,
      ),
    )
    for (const [userId, states] of loaded) {
      for (const [issueId, state] of states) {
        if (state === undefined) continue
        const value = issueUserStateToWire({ userId, entityId: issueId as never, ...state })
        out.push({ id: issueUserStateRowId(userId, issueId as never), value })
      }
    }
    return out
  },
  streamAll: ({ store }) =>
    pagesOf(
      store.issues.listIssueUserStateRows().then((states) =>
        states.map((state) => ({
          id: issueUserStateRowId(state.userId, state.entityId),
          value: issueUserStateToWire(state),
        })),
      ),
    ),
}

const subscription: Builder = {
  kind: 'subscription',
  shape: 'row',
  async build({ store }, ids) {
    const subscriptionIds = parsed(ids, (id) => parseSubscriptionRowId(id).id)
    return (await store.events.subscriptionsByIds(subscriptionIds)).map((value) => ({
      id: subscriptionRowIdOf(value),
      value,
    }))
  },
  streamAll: ({ store }) =>
    pagesOf(
      store.events
        .allSubscriptionsForBootReconcile()
        .then((rows) => rows.map((value) => ({ id: subscriptionRowIdOf(value), value }))),
    ),
}

// ---------------------------------------------------------------------------
// Issue events, interactions, messages: the windowed kinds
// ---------------------------------------------------------------------------

/** The events the feed carries ({@link issueEventWindow}), as records. */
async function issueEventRecords({ store, eventWindow }: RecordReads): Promise<BuiltRecord[]> {
  return (await issueEventWindow(store.events, eventWindow)).map((value) => ({
    id: value.id,
    value,
  }))
}

const issueEvent: Builder = {
  kind: 'issueEvent',
  shape: 'windowed',
  async build({ store, eventWindow = FEED_WINDOW }, ids) {
    const keys = parsed(ids, parseIssueEventRowId)
    if (keys.length === 0) return []
    const asked = new Set(ids)
    const events = await store.events.feedWindowByIds(
      keys.map((key) => key.eventId),
      eventWindow,
    )
    return events.flatMap((event) => {
      const value = issueEventRecordOf(event)
      return asked.has(value.id) ? [{ id: value.id, value }] : []
    })
  },
  streamAll: (reads) => pagesOf(issueEventRecords(reads)),
}

const pendingInteraction: Builder = {
  kind: 'pendingInteraction',
  shape: 'windowed',
  async build({ store }, ids) {
    const interactionIds = parsed(ids, parseInteractionRowId).map((key) => key.interactionId)
    if (interactionIds.length === 0) return []
    return openInteractionRecords(
      await store.interactions.openOfIds(unique(interactionIds)),
      interactionWireOf,
    )
  },
  streamAll: ({ store }) =>
    pagesOf(
      store.interactions.listOpen().then((rows) => openInteractionRecords(rows, interactionWireOf)),
    ),
}

const message: Builder = {
  kind: 'message',
  shape: 'windowed',
  async build({ store, confirmedPerSession = CONFIRMED_PER_SESSION }, ids) {
    const keys = parsed(ids, parseMessageRecordRowId)
    if (keys.length === 0) return []
    const open = (
      await store.messages.getMessages(unique(keys.map((key) => key.messageId)))
    ).filter(isOpenChat)
    const confirmed = await store.messages.confirmedChatTail(
      confirmedPerSession,
      unique(keys.map((key) => key.sessionId)),
      'live',
    )
    return [...messageRecords([...open, ...confirmed])].map(([id, value]) => ({ id, value }))
  },
  async *streamAll({ store, confirmedPerSession }) {
    const window = await messageWindow(store.messages, confirmedPerSession)
    yield* pagesOf([...window].map(([id, value]) => ({ id, value })))
  },
}

// ---------------------------------------------------------------------------
// Per-user records
// ---------------------------------------------------------------------------

/** Group parsed keys by their person. */
function byUser<K extends { userId: UserId }>(keys: readonly K[]): Map<UserId, K[]> {
  const out = new Map<UserId, K[]>()
  for (const key of keys) {
    const list = out.get(key.userId) ?? []
    list.push(key)
    out.set(key.userId, list)
  }
  return out
}

const userLayout: Builder = {
  kind: 'userLayout',
  shape: 'row',
  async build({ store }, ids) {
    const out: BuiltRecord[] = []
    // A person's layout is a handful of keys: read the person's snapshot.
    for (const userId of byUser(parsed(ids, parseLayoutRowId)).keys()) {
      for (const [key, value] of Object.entries(await store.layout.getSnapshot(userId))) {
        out.push({ id: layoutRowId(userId, key), value: { userId, key, value } })
      }
    }
    return out
  },
  streamAll: ({ store }) =>
    pagesOf(
      store.layout
        .allForBootReconcile()
        .then((rows) => rows.map((value) => ({ id: layoutRowId(value.userId, value.key), value }))),
    ),
}

const userReadPosition: Builder = {
  kind: 'userReadPosition',
  shape: 'row',
  async build({ store }, ids) {
    const out: BuiltRecord[] = []
    for (const userId of byUser(parsed(ids, parseReadPositionRowId)).keys()) {
      for (const [streamId, cursor] of Object.entries(
        await store.readPositions.getSnapshot(userId),
      )) {
        out.push({
          id: readPositionRowId(userId, streamId),
          value: { userId, streamId, lastEventId: cursor.lastEventId, seenAt: cursor.seenAt },
        })
      }
    }
    return out
  },
  async *streamAll({ store }) {
    for await (const page of store.readPositions.allPositionPages(RECORD_PAGE_SIZE)) {
      yield page.map((row) => ({
        id: readPositionRowId(row.userId, row.streamId),
        value: {
          userId: row.userId,
          streamId: row.streamId,
          lastEventId: row.lastEventId,
          seenAt: row.seenAt,
        },
      }))
    }
  },
}

const pin: Builder = {
  kind: 'pin',
  shape: 'row',
  async build({ store }, ids) {
    const users = [...byUser(parsed(ids, parsePinRowId)).keys()]
    return (await store.sessions.pinsOfUsers(users)).map((value) => ({
      id: pinRowId(value.userId as UserId, value.kind, value.entityId),
      value,
    }))
  },
  streamAll: ({ store }) =>
    pagesOf(
      store.sessions.allPinsForBootReconcile().then((pins) =>
        pins.map((value) => ({
          id: pinRowId(value.userId as UserId, value.kind, value.entityId),
          value,
        })),
      ),
    ),
}

const tabOrder: Builder = {
  kind: 'tabOrder',
  shape: 'row',
  async build({ store }, ids) {
    const users = [...byUser(parsed(ids, parseTabOrderRowId)).keys()]
    return (await store.sessions.tabOrdersOfUsers(users)).map((value) => ({
      id: tabOrderRowId(value.userId as UserId, value.entityId),
      value,
    }))
  },
  streamAll: ({ store }) =>
    pagesOf(
      store.sessions.allTabOrdersForBootReconcile().then((orders) =>
        orders.map((value) => ({
          id: tabOrderRowId(value.userId as UserId, value.entityId),
          value,
        })),
      ),
    ),
}

/**
 * One person's preferences, folded: their own leaves over nothing else (the
 * instance's defaults are the `instancePreferences` record). Built with the
 * read the publisher uses, `preferenceRecordFor`, which answers a record for
 * any person, so a write that clears a person's last leaf publishes the empty
 * record as it does today. `streamAll` lists the people who hold a leaf.
 */
const userPreferences: Builder = {
  kind: 'userPreferences',
  shape: 'row-and-reads',
  async build({ store }, ids) {
    const users = unique(parsed(ids, (id) => parseUserPreferencesRowId(id).userId))
    return await Promise.all(
      users.map(async (userId) => ({
        id: userPreferencesRowId(userId),
        value: await store.settings.preferenceRecordFor(userId),
      })),
    )
  },
  streamAll: ({ store }) =>
    pagesOf(
      store.settings
        .allPreferenceRecordsForBootReconcile()
        .then((rows) => rows.map((value) => ({ id: userPreferencesRowId(value.userId), value }))),
    ),
}

/** The people whose markers the feed carries: not disabled. */
async function activeUsers({ store }: RecordReads): Promise<Set<UserId>> {
  return new Set(
    (await store.users.list()).filter((user) => !user.disabledAt).map((user) => user.id as UserId),
  )
}

/** The sessions that still exist (not deleted), of these ids. */
async function existingSessions(
  { store }: RecordReads,
  ids: readonly string[],
): Promise<Set<string>> {
  const rows = await store.sessions.getSessions(unique(ids))
  return new Set([...rows.values()].filter((row) => !row.deletedAt).map((row) => row.id))
}

const sessionUserState: Builder = {
  kind: 'sessionUserState',
  shape: 'row-and-reads',
  async build(reads, ids) {
    const keys = parsed(ids, parseSessionUserStateRowId)
    if (keys.length === 0) return []
    const active = await activeUsers(reads)
    const live = await existingSessions(
      reads,
      keys.map((key) => key.sessionId),
    )
    const out: BuiltRecord[] = []
    for (const [userId, userKeys] of byUser(keys)) {
      if (!active.has(userId)) continue
      const sessionIds = userKeys.map((key) => key.sessionId).filter((id) => live.has(id))
      const states = await reads.store.sessions.userStateOf(userId, sessionIds, reads.now())
      for (const sessionId of sessionIds) {
        const state = states.get(sessionId)
        // No row at all is the explicit cleared marker the publisher keeps.
        const value: SessionUserStateWire = {
          userId,
          sessionId,
          readAt: state?.readAt ?? null,
          ...(state?.snoozedUntil !== undefined ? { snoozedUntil: state.snoozedUntil } : {}),
        }
        out.push({ id: sessionUserStateRowId(userId, sessionId), value })
      }
    }
    return out
  },
  async *streamAll(reads) {
    const rows = await reads.store.sessions.listSessionUserStateRows(undefined, reads.now())
    const active = await activeUsers(reads)
    const live = await existingSessions(
      reads,
      rows.map((row) => row.sessionId),
    )
    yield* pagesOf(
      rows
        .filter((row) => live.has(row.sessionId) && active.has(row.userId))
        .map((value) => ({ id: sessionUserStateRowId(value.userId, value.sessionId), value })),
    )
  },
}

const superagentThread: Builder = {
  kind: 'superagentThread',
  shape: 'row',
  async build({ store }, ids) {
    const threadIds = parsed(ids, parseSuperagentThreadRowId).map((key) => key.threadId)
    return (await store.superagent.superagentThreadsByIds(threadIds)).map((row) => ({
      id: superagentThreadRowId(row.ownerUserId, row.id),
      value: superagentThreadWireOf(row),
    }))
  },
  streamAll: ({ store }) =>
    pagesOf(
      store.superagent.allThreadsForBootReconcile().then((rows) =>
        rows.map((row) => ({
          id: superagentThreadRowId(row.ownerUserId, row.id),
          value: superagentThreadWireOf(row),
        })),
      ),
    ),
}

// ---------------------------------------------------------------------------
// Shipping, automations, effects, checkouts
// ---------------------------------------------------------------------------

const shipOrder: Builder = {
  kind: 'shipOrder',
  shape: 'row-and-reads',
  async build({ store }, ids) {
    const orders = await store.shipping.ordersByIds(ids)
    const orderIds = orders.map((order) => order.id)
    const holds = await store.shipping.openHoldsForOrders(orderIds)
    const receipts = await store.shipping.receiptsForOrders(orderIds)
    return shipOrderProjectionRows(orders, holds.values(), receipts.values())
  },
  async *streamAll({ store }) {
    const orders = await store.shipping.listOrders()
    const holds = await store.shipping.listHolds()
    const receipts = await store.shipping.listReceipts()
    yield* pagesOf(shipOrderProjectionRows(orders, holds, receipts))
  },
}

/**
 * A ship lane: the queue of one repo and destination, as its scheduler sees
 * it. A lane is no row of its own: its record is the per-lane plan
 * (`shipLaneSchedule`) over the lane's queued orders, their recorded
 * native-stack edges, and the orders they depend on outside the lane, the same
 * inputs the tick schedules with. A lane with no queued order has no record.
 * A few reads per lane; a write names the one or two lanes it moves.
 */
const shipLane: Builder = {
  kind: 'shipLane',
  shape: 'row-and-reads',
  async build({ store }, ids) {
    const out: BuiltRecord[] = []
    for (const lane of parsed(ids, parseShipLaneId)) {
      const queued = await store.shipping.queuedLaneOrders(lane.repoId, lane.destination)
      if (queued.length === 0) continue
      const edges = await store.shipping.nativeStackEdgesFrom(queued.map((order) => order.id))
      const merged = withNativeStackEdges(queued, edges)
      const dependencies = await store.shipping.ordersByIds(laneDependencyIds(merged))
      const scheduled = shipLaneSchedule({ ...lane, queued: merged, dependencies })
      out.push({ id: scheduled.lane.id, value: scheduled.lane })
    }
    return out
  },
  async *streamAll({ store }) {
    yield* pagesOf(
      scheduledShippingProjection(
        await store.shipping.listOrders(),
        await store.shipping.listHolds(),
        await store.shipping.listReceipts(),
        await store.shipping.listNativeStackEdges(),
      ).lanes,
    )
  },
}

const automation: Builder = {
  kind: 'automation',
  shape: 'row',
  build: async ({ store }, ids) =>
    (await store.automations.getMany(ids)).map((value) => ({ id: value.id, value })),
  streamAll: ({ store }) =>
    pagesOf(
      store.automations.list().then((rows) => rows.map((value) => ({ id: value.id, value }))),
    ),
}

const automationRun: Builder = {
  kind: 'automationRun',
  shape: 'row',
  build: async ({ store }, ids) =>
    (await store.automations.getRuns(ids)).map((value) => ({ id: value.id, value })),
  streamAll: ({ store }) =>
    pagesOf(
      store.automations
        .listAllRuns()
        .then((rows) => rows.map((value) => ({ id: value.id, value }))),
    ),
}

const effect: Builder = {
  kind: 'effect',
  shape: 'row',
  build: async ({ store, effectExecutors }, ids) =>
    (await store.effects.liveByIds(ids)).map((row) => ({
      id: row.id,
      value: effectRecordOf(row, effectExecutors as EffectExecutorRegistry),
    })),
  async *streamAll({ store, effectExecutors }) {
    for await (const page of store.effects.livePages(RECORD_PAGE_SIZE)) {
      yield page.map((row) => ({
        id: row.id,
        value: effectRecordOf(row, effectExecutors as EffectExecutorRegistry),
      }))
    }
  },
}

const checkout: Builder = {
  kind: 'checkout',
  shape: 'row',
  async build({ store }, ids) {
    const machines = unique(parsed(ids, parseCheckoutRowId).map((key) => key.machineId))
    return (await store.checkouts.ofMachines(machines)).map((row) => ({
      id: checkoutRowId(row.machineId, row.path),
      value: checkoutWireOf(row),
    }))
  },
  streamAll: ({ store }) =>
    pagesOf(
      store.checkouts.all().then((rows) =>
        rows.map((row) => ({
          id: checkoutRowId(row.machineId, row.path),
          value: checkoutWireOf(row),
        })),
      ),
    ),
}

// ---------------------------------------------------------------------------
// Library records: agent profiles, workflows, instance preferences
// ---------------------------------------------------------------------------

const agentProfile: Builder = {
  kind: 'agentProfile',
  shape: 'row',
  // The profile library is configuration-sized; "these ids" filters it.
  build: async ({ store }, ids) => {
    const asked = new Set(ids)
    return (await store.agentProfiles.list())
      .filter((value) => asked.has(value.id))
      .map((value) => ({ id: value.id, value }))
  },
  streamAll: ({ store }) =>
    pagesOf(
      store.agentProfiles.list().then((rows) => rows.map((value) => ({ id: value.id, value }))),
    ),
}

const workflow: Builder = {
  kind: 'workflow',
  shape: 'row',
  build: async ({ store }, ids) =>
    (await store.workflows.workflowsByIds(ids)).map((value) => ({ id: value.id, value })),
  streamAll: ({ store }) =>
    pagesOf(
      store.workflows
        .allWorkflowsForBootReconcile()
        .then((rows) => rows.map((value) => ({ id: value.id, value }))),
    ),
}

const workflowRevision: Builder = {
  kind: 'workflowRevision',
  shape: 'row',
  build: async ({ store }, ids) =>
    (await store.workflows.revisionsByIds(ids)).map((value) => ({ id: value.id, value })),
  streamAll: ({ store }) =>
    pagesOf(
      store.workflows
        .allRevisionsForBootReconcile()
        .then((rows) => rows.map((value) => ({ id: value.id, value }))),
    ),
}

const workflowBinding: Builder = {
  kind: 'workflowBinding',
  shape: 'row',
  // One binding per bound target, configuration-sized; "these ids" filters it.
  build: async ({ store }, ids) => {
    const asked = new Set(
      parsed(ids, parseWorkflowBindingRowId).map((key) =>
        workflowBindingRowId(key.targetKind, key.targetId),
      ),
    )
    return (await store.workflows.listBindings()).flatMap((value) => {
      const id = workflowBindingRowId(value.targetKind, value.targetId)
      return asked.has(id) ? [{ id, value }] : []
    })
  },
  streamAll: ({ store }) =>
    pagesOf(
      store.workflows.listBindings().then((rows) =>
        rows.map((value) => ({
          id: workflowBindingRowId(value.targetKind, value.targetId),
          value,
        })),
      ),
    ),
}

const workflowRun: Builder = {
  kind: 'workflowRun',
  shape: 'row-and-reads',
  build: async ({ store }, ids) =>
    (await store.workflows.runsByIds(ids)).map(({ run, workflowId, steps }) => ({
      id: run.id,
      value: workflowRunRecordOf(run, workflowId, steps),
    })),
  streamAll: ({ store }) =>
    pagesOf(
      store.workflows.allRunsForBootReconcile().then((runs) =>
        runs.map(({ run, workflowId, steps }) => ({
          id: run.id,
          value: workflowRunRecordOf(run, workflowId, steps),
        })),
      ),
    ),
}

async function instancePreferencesRecord({ store }: RecordReads): Promise<BuiltRecord[]> {
  return [
    {
      id: INSTANCE_PREFERENCES_ROW_ID,
      value: instancePreferencesRecordOf(await store.settings.getSettings()),
    },
  ]
}

const instancePreferences: Builder = {
  kind: 'instancePreferences',
  shape: 'row',
  build: async (reads, ids) =>
    ids.includes(INSTANCE_PREFERENCES_ROW_ID) ? await instancePreferencesRecord(reads) : [],
  streamAll: (reads) => pagesOf(instancePreferencesRecord(reads)),
}

// ---------------------------------------------------------------------------

/**
 * `session` (POD-6764): the row, the satellites a restart restores it with (its
 * offer, draft time, observation checkpoint, runtime transcript and turn state,
 * Podium conversation id) and the projection's joins (birth issue, repo, queued
 * messages). Built exactly as a session that does not run is read today
 * (`SessionRecords.fromRows` then `wireRecord`), with no resident session in
 * reach: the projection reads only stored state, so a running session's record
 * is the same value once its writes have settled.
 */
const NO_RESIDENT_SESSIONS = new Map<SessionId, never>()

async function sessionRecordsOf(
  { store }: RecordReads,
  rows: readonly SessionRow[],
): Promise<BuiltRecord[]> {
  const records = await new SessionRecords({ store, sessions: NO_RESIDENT_SESSIONS }).fromRows(
    rows.filter((row) => !row.deletedAt),
  )
  const pass = await sessionProjectionPass(store, records)
  const publishedActivity = new Map(rows.map((row) => [row.id, row.publishedLastActiveAt]))
  return records.map((record) => {
    const lastActiveAt = publishedActivity.get(record.sessionId)
    if (lastActiveAt === undefined)
      throw new Error(`Missing published activity for ${record.sessionId}`)
    // Checkpoints still advance the exact server-side record. Only the synced
    // projection uses the publication value, including bootstrap/worker reads.
    return {
      id: record.sessionId,
      value: { ...wireRecord(record, pass), lastActiveAt },
    }
  })
}

const session: Builder = {
  kind: 'session',
  shape: 'row-and-reads',
  build: async (reads, ids) =>
    await sessionRecordsOf(reads, [
      ...(await reads.store.sessions.getSessions(unique(ids) as SessionId[])).values(),
    ]),
  streamAll: async function* (reads) {
    let after = ''
    for (;;) {
      const rows = await reads.store.sessions.sessionsPage(after, RECORD_PAGE_SIZE)
      if (rows.length > 0) yield await sessionRecordsOf(reads, rows)
      if (rows.length < RECORD_PAGE_SIZE) return
      after = rows.at(-1)?.id ?? after
    }
  },
}

/** The kinds built from the database: the stored-row kinds (POD-6765), `repo`, the audit's 24 in its order with the joined `shipLane` and `userPreferences` (POD-6769), then `session` (POD-6764), and the issue's brief and description split out of the issue record (POD-6921). */
export const DATABASE_ONLY_BUILDERS: readonly Builder[] = [
  conversation,
  issueGitState,
  machine,
  machineAccess,
  repo,
  issueProjection,
  issueBrief,
  issueDescription,
  ...ISSUE_PANEL_KINDS.map(
    (kind): Builder => ({
      kind,
      shape: 'row',
      build: async ({ store }, ids) =>
        (await store.issues.panel.getMany(kind, ids)).map((value) => ({ id: value.id, value })),
      async *streamAll({ store }) {
        for await (const page of store.issues.panel.pages(kind, RECORD_PAGE_SIZE))
          yield page.map((value) => ({ id: value.id, value }))
      },
    }),
  ),
  issueDep,
  issueUserState,
  subscription,
  shipOrder,
  shipLane,
  automation,
  automationRun,
  userLayout,
  userReadPosition,
  pin,
  tabOrder,
  userPreferences,
  sessionUserState,
  superagentThread,
  agentProfile,
  workflow,
  workflowRevision,
  workflowBinding,
  workflowRun,
  instancePreferences,
  effect,
  checkout,
  issueEvent,
  pendingInteraction,
  message,
  session,
]

export function serverRecordBuilders(): RecordBuilderRegistry<RecordReads> {
  return new RecordBuilderRegistry(DATABASE_ONLY_BUILDERS, [issueRecordGroup])
}
