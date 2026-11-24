/**
 * EVERY SYNCED RECORD TYPE, DECLARED ONCE (POD-7084, design POD-7059).
 *
 * The order is the wire's: the protocol's record list (`MetadataEntityKind`,
 * `MetadataChange`) is generated from this list in this order, and so is the
 * client kernel's kind table (`client-core/src/replica/kernel/kinds.ts`).
 * The server registers one record builder per declaration
 * (`apps/server/src/sync/record-builders.ts`), and the client-graph schema
 * reads fields and links from here.
 *
 * Groups follow the design's table "Which record types go where". The
 * collections are the design's: always, live, asking, recent, sidebar,
 * sessions with no issue, issue stubs, tree, page, sessions of one issue and
 * one record ({@link DESIGN_COLLECTIONS}). Nothing here loads anything yet;
 * the loader, the fetch route and the store read these declarations in their
 * own tasks (POD-7085 to POD-7087).
 */

import { AgentProfileWire } from '../entities/agent-profile'
import { AutomationRunWire, AutomationWire } from '../entities/automation'
import { ConcertmasterEntryWire, concertmasterEntryRowId } from '../entities/concertmaster'
import { ConversationRecordWire } from '../entities/conversation'
import { EffectRecordWire } from '../entities/effect'
import { IssueDepProjection } from '../entities/issue-dep'
import { IssueEventWire } from '../entities/issue-event'
import { IssueGitStateProjection } from '../entities/issue-git-state'
import {
  IssuePanelArtifactWire,
  IssuePanelDeferredWire,
  IssuePanelStateWire,
  IssuePanelTodoWire,
} from '../entities/issue-panel-records'
import { HostMetricsWire } from '../entities/machine'
import {
  CheckoutWire,
  checkoutRowId,
  MachineAccessWire,
  MachineProjection,
  machineAccessRowId,
} from '../entities/machine-projection'
import { MessageRecordWire } from '../entities/message-record'
import { NoticeWire, noticeRowId } from '../entities/notice'
import { PendingInteractionWire } from '../entities/pending-interaction'
import { RepoProjection } from '../entities/repo'
import { SessionMeta } from '../entities/session'
import { SubscriptionWire, subscriptionRowIdOf } from '../entities/subscription'
import {
  WorkflowBindingWire,
  WorkflowRevisionWire,
  WorkflowRunRecord,
  WorkflowWire,
  workflowBindingRowId,
} from '../entities/workflow'
import { IssueBriefWire, IssueDescriptionWire } from '../fields/issue-body'
import { issueDepId } from '../ids/keys'
import { SlimIssueProjection } from '../projections/issue-bodies'
import { INSTANCE_PREFERENCES_ROW_ID, InstancePreferencesWire } from '../settings/instance-record'
import { ShipLaneProjection, ShipOrderProjection } from '../shipping-projection'
import { IssueUserStateWire, issueUserStateRowId } from '../user-state/issue-state'
import { LayoutWire, layoutRowId } from '../user-state/layout-state'
import { ReadPositionWire, readPositionRowId } from '../user-state/read-position-state'
import { SessionUserStateWire, sessionUserStateRowId } from '../user-state/session-state'
import {
  PinWire,
  pinRowId,
  SuperagentThreadWire,
  superagentThreadRowId,
  TabOrderWire,
  tabOrderRowId,
  UserPreferencesWire,
  userPreferencesRowId,
} from '../user-state/synced-records'
import { type CollectionSpec, defineRecord } from './define-record'
import {
  MachineConditionLive,
  SessionConditionLive,
  SessionTerminalStateLive,
} from './live-payloads'
import { ruleParam as param } from './rule'

// ---------------------------------------------------------------------------
// Shared collection shapes
// ---------------------------------------------------------------------------

/** The policy's number of days a "recent" collection reaches back. */
export const RECENT_DAYS = param('recentDays')

/** Every record of the type: the "always" collection of a type that does not grow with history. */
const ALL: CollectionSpec = {
  part: 'main',
  why: 'The record type does not grow with history, so every client holds all of it.',
}

/** The server already sends only a bounded window of the type. */
const WINDOW: CollectionSpec = {
  part: 'main',
  why: 'The server publishes a bounded window, so the device holds what it sends.',
}

const one = (key: string): CollectionSpec => ({
  part: 'main',
  where: { [key]: { eq: param('id') } },
  why: 'One record, by its id: what a lookup that finds the record absent loads.',
})

const ofIssue = (field: string, why: string): CollectionSpec => ({
  part: 'main',
  where: { [field]: { eq: param('issueId') } },
  why,
})

/** Records that grow with history: the recent ones by policy, older ones a page at a time. */
const historyCollections = (time: string, key: string, what: string) =>
  ({
    recent: {
      part: 'main',
      where: { [time]: { newerThan: { days: RECENT_DAYS } } },
      why: `${what} from the last N days of the policy.`,
    },
    page: {
      part: 'main',
      // The id breaks ties, so the order is total and a page boundary loses nothing.
      page: {
        sort: [
          { field: time, direction: 'desc' },
          { field: key, direction: 'desc' },
        ],
        size: 50,
      },
      why: `Older ${what}, newest first, one page at a time.`,
    },
    one: one(key),
  }) as const satisfies Readonly<Record<string, CollectionSpec>>

// ---------------------------------------------------------------------------
// Issue and session vocabulary the rules use
// ---------------------------------------------------------------------------

/** Open stages: not done and not proposed. `shipping` is open work in system custody. */
export const SIDEBAR_STAGES = ['backlog', 'planning', 'in_progress', 'review', 'shipping'] as const

/** The sidebar: open issues that are not proposed, not archived, not deleted. */
export const SIDEBAR_WHERE = {
  stage: { in: SIDEBAR_STAGES },
  closedReason: { empty: true },
  archived: false,
  deletedAt: { empty: true },
} as const

/** The sessions a flight deck shows on an issue: its roster (`SessionModel.onRoster`). */
export const DECK_SESSION_WHERE = {
  archived: false,
  headless: { not: true },
  agentKind: { not: 'shell' },
} as const

/**
 * A session that waits for the user, by saved fields only (design "Asking"):
 * an open offer (the `offers` row), or an agent state that asks for the user
 * (needs the user, errored, or idle on a question or an approval). The agent
 * state is saved on the session row, overridden by its durable observation
 * checkpoint when there is one; the record carries the result.
 */
export const ASKING_WHERE = [
  { archived: false, offer: { not: { empty: true } } },
  { archived: false, 'agentState.phase': { in: ['needs_user', 'errored'] } },
  {
    archived: false,
    'agentState.phase': 'idle',
    'agentState.idle.kind': { in: ['question', 'approval'] },
  },
] as const

// ---------------------------------------------------------------------------
// The declarations, in wire order
// ---------------------------------------------------------------------------

const session = defineRecord({
  builderShape: 'row-and-reads',
  kind: 'session',
  replicaKind: 'sessions',
  schema: SessionMeta,
  key: 'sessionId',
  group: 'byRule',
  // What only the running process knows (POD-6764): pushed on the session
  // topics while a reader watches, never on the record, never stored.
  liveReadings: {
    'session.condition': SessionConditionLive,
    'session.terminalState': SessionTerminalStateLive,
  },
  derived: [
    'resumable',
    'neverBound',
    'transcriptAvailable',
    'harnessHandoff',
    'harnessPromptModeHints',
    'driverFamily',
    'configureFields',
    'attachKinds',
    'refRepoId',
    'refSeq',
    'viaHub',
    'upstreamStale',
    'queuedMessageCount',
  ],
  links: {
    issueId: { to: 'issueProjection', why: 'The issue the session works on.' },
    machineId: { to: 'machine' },
    handoffTargetMachineId: { to: 'machine' },
    agentProfileId: { to: 'agentProfile' },
    refIssueId: { to: 'issueProjection', why: 'The issue its reference is minted under.' },
    refRepoId: { to: 'repo' },
    workflowRunId: { to: 'workflowRun' },
    conversationPodiumId: { to: 'conversation', targetField: 'podiumId' },
  },
  comesWith: [
    {
      collection: 'issueProjection.one',
      key: 'issueId',
      if: { issueId: { not: { empty: true } } },
      why: 'A session is placed and named by its issue.',
    },
    {
      collection: 'sessionUserState.ofSession',
      why: "The user's read and snooze state for the session.",
    },
  ],
  collections: {
    live: {
      part: 'main',
      where: { status: { in: ['starting', 'live'] } },
      why: 'Sessions that are starting or live.',
    },
    asking: {
      part: 'main',
      where: ASKING_WHERE,
      why: 'Sessions that wait for the user, whatever their age: the sidebar keeps a closed issue shown while one does.',
    },
    recent: {
      part: 'main',
      where: { lastActiveAt: { newerThan: { days: RECENT_DAYS } } },
      why: 'Sessions active in the last N days, by the coarse activity time the record carries.',
    },
    noIssue: {
      part: 'main',
      // Bounded by the work, not by history: the sidebar hides a finished
      // session within days (its visibility rule, client-graph
      // `worklist/visible.ts`), so an old idle one is never shown and loads
      // only when a view asks for it.
      where: [
        { archived: false, issueId: { empty: true }, status: { in: ['starting', 'live'] } },
        ...ASKING_WHERE.map((clause) => ({ ...clause, issueId: { empty: true } }) as const),
        {
          archived: false,
          issueId: { empty: true },
          lastActiveAt: { newerThan: { days: RECENT_DAYS } },
        },
      ],
      why: "Sessions with no issue that are not archived and are live, asking or active in the last N days: the sidebar's lanes.",
    },
    ofIssue: ofIssue(
      'issueId',
      'The sessions of one issue: what an issue comes with, and the issue page.',
    ),
    bornOf: ofIssue(
      'refIssueId',
      'The sessions whose reference was minted under one issue, wherever they work now: what `issue.bornSessions` holds (POD-7582).',
    ),
    one: one('sessionId'),
  },
  why: 'One agent or shell session.',
})

const issueProjection = defineRecord({
  builderShape: 'row-and-reads',
  kind: 'issueProjection',
  replicaKind: 'issueProjections',
  schema: SlimIssueProjection,
  key: 'id',
  group: 'byRule',
  stub: [
    // Reference
    'id',
    'repoId',
    'seq',
    // State
    'type',
    'stage',
    'closedReason',
    'archived',
    'deletedAt',
    'isDraftVessel',
    'audience',
    // Parent
    'parentId',
  ],
  body: {
    issueBrief: ['brief'],
    issueDescription: ['description'],
    issuePanelTodo: ['panel.todos'],
    issuePanelArtifact: ['panel.artifacts'],
    issuePanelDeferred: ['panel.deferred'],
    issuePanelState: ['activityNotes', 'notesUpdatedAt'],
  },
  links: {
    parentId: { to: 'issueProjection', why: 'The formal issue tree.' },
    repoId: { to: 'repo' },
    supersededBy: { to: 'issueProjection' },
    duplicateOf: { to: 'issueProjection' },
    machineId: { to: 'machine' },
    agentProfileId: { to: 'agentProfile' },
    coordinatorSessionId: { to: 'session' },
    startedBySession: { to: 'session' },
  },
  parentLink: 'parentId',
  comesWith: [
    {
      collection: 'issueProjection.one',
      key: 'parentId',
      if: { parentId: { not: { empty: true } } },
      why: 'Its parent, and so every ancestor: nesting and placement read the parent chain.',
    },
    { collection: 'issueUserState.ofIssue', why: "The user's read state for it." },
    { collection: 'issueGitState.ofIssue', why: 'Its git state.' },
    { collection: 'issueDep.ofIssue', why: 'Its dependencies.' },
  ],
  collections: {
    stubs: { part: 'stub', why: 'Every issue at stub level: counts and links over all history.' },
    sidebar: {
      part: 'main',
      where: SIDEBAR_WHERE,
      comesWith: [
        {
          collection: 'session.ofIssue',
          where: { archived: false },
          why: 'A sidebar issue comes with its sessions that are not archived.',
        },
      ],
      why: 'Open issues that are not proposed: everything left in the sidebar. Grows with open work, not history.',
    },
    recent: {
      part: 'main',
      where: { updatedAt: { newerThan: { days: RECENT_DAYS } } },
      why: 'Issues changed in the last N days, by their last-change time.',
    },
    tree: {
      part: 'main',
      where: { parentId: { descendantsOf: param('root') } },
      comesWith: [
        {
          collection: 'session.ofIssue',
          where: DECK_SESSION_WHERE,
          why: 'An issue in a tree a flight deck shows comes with the sessions the deck shows.',
        },
      ],
      why: 'All issues under one top-level issue: the view that opens it holds it.',
    },
    byStage: {
      part: 'main',
      where: { stage: { eq: param('stage') }, archived: false, deletedAt: { empty: true } },
      page: {
        sort: [
          { field: 'updatedAt', direction: 'desc' },
          { field: 'id', direction: 'asc' },
        ],
        size: 50,
      },
      why: 'One page of a stage, sorted: a board column, the proposal deck.',
    },
    byStagePriority: {
      part: 'main',
      where: {
        stage: { eq: param('stage') },
        priority: { eq: param('priority') },
        archived: false,
        deletedAt: { empty: true },
      },
      page: {
        sort: [
          { field: 'updatedAt', direction: 'desc' },
          { field: 'id', direction: 'asc' },
        ],
        size: 50,
      },
      why: 'One page of a stage under a priority filter: a board column whose count the stub cannot answer, so its total comes with the page.',
    },
    startedBy: {
      part: 'main',
      where: { startedBySession: { eq: param('sessionId') } },
      why: 'The issues one session started: what `session.startedIssues` and `missionStartedIssues` hold (POD-7582).',
    },
    supersededBy: ofIssue(
      'supersededBy',
      'The issues one issue supersedes: what `issue.supersededIssues` holds (POD-7582).',
    ),
    duplicateOf: ofIssue(
      'duplicateOf',
      'The issues marked duplicates of one issue: what `issue.duplicateIssues` holds (POD-7582).',
    ),
    one: one('id'),
  },
  why: 'The issue record without its body: the unit of work.',
})

const issueDep = defineRecord({
  builderShape: 'row',
  kind: 'issueDep',
  replicaKind: 'issueDeps',
  schema: IssueDepProjection,
  key: 'id',
  // Records already carry their id; captured table rows carry its components.
  rowKey: (row) => row.id ?? issueDepId(row.fromId, row.toId, row.type),
  group: 'comesWithIssue',
  links: {
    fromId: { to: 'issueProjection', why: 'The issue that depends.' },
    toId: { to: 'issueProjection', why: 'The issue it depends on.' },
  },
  collections: {
    ofIssue: ofIssue('fromId', 'The dependency edges of one issue.'),
    toIssue: {
      ...ofIssue(
        'toId',
        'The edges that name one issue as their target, each with the issue that depends: what `issue.spinOffs` and `pageDependents` hold (POD-7582).',
      ),
      comesWith: [
        {
          collection: 'issueProjection.one',
          key: 'fromId',
          why: 'An incoming edge is read through the issue that depends, whose deps list carries it.',
        },
      ],
    },
  },
  why: 'One issue dependency edge.',
})

const repo = defineRecord({
  builderShape: 'row-and-reads',
  kind: 'repo',
  replicaKind: 'repos',
  schema: RepoProjection,
  key: 'id',
  group: 'always',
  collections: { all: ALL },
  why: 'A logical repository: its prefix and name.',
})

const shipOrder = defineRecord({
  builderShape: 'row-and-reads',
  kind: 'shipOrder',
  replicaKind: 'shipOrders',
  schema: ShipOrderProjection,
  key: 'id',
  group: 'always',
  links: { issueId: { to: 'issueProjection' }, repoId: { to: 'repo' } },
  collections: { all: ALL },
  why: 'One shipping order.',
})

const shipLane = defineRecord({
  builderShape: 'row-and-reads',
  kind: 'shipLane',
  replicaKind: 'shipLanes',
  schema: ShipLaneProjection,
  key: 'id',
  group: 'always',
  links: { repoId: { to: 'repo' } },
  collections: { all: ALL },
  why: "One delivery lane's queue.",
})

const conversation = defineRecord({
  builderShape: 'row-and-reads',
  kind: 'conversation',
  replicaKind: 'conversations',
  schema: ConversationRecordWire,
  key: 'id',
  group: 'byRule',
  collections: historyCollections('createdAt', 'id', 'native conversations'),
  why: 'One native agent conversation found on a machine. Grows with history.',
})

const automation = defineRecord({
  builderShape: 'row',
  kind: 'automation',
  replicaKind: 'automations',
  schema: AutomationWire,
  key: 'id',
  group: 'always',
  links: { targetSessionId: { to: 'session' } },
  collections: { all: ALL },
  why: 'One scheduled automation.',
})

const automationRun = defineRecord({
  builderShape: 'row',
  kind: 'automationRun',
  replicaKind: 'automationRuns',
  schema: AutomationRunWire,
  key: 'id',
  group: 'byRule',
  links: { automationId: { to: 'automation' }, sessionId: { to: 'session' } },
  collections: historyCollections('firedAt', 'id', 'automation runs'),
  why: 'One run of an automation. Grows with history.',
})

const userLayout = defineRecord({
  builderShape: 'row',
  kind: 'userLayout',
  replicaKind: 'userLayouts',
  schema: LayoutWire,
  rowKey: (row) => layoutRowId(row.userId, row.key),
  group: 'always',
  collections: { all: ALL },
  why: "One key of the user's shell layout.",
})

const userReadPosition = defineRecord({
  builderShape: 'row',
  kind: 'userReadPosition',
  replicaKind: 'userReadPositions',
  schema: ReadPositionWire,
  rowKey: (row) => readPositionRowId(row.userId, row.streamId),
  group: 'always',
  collections: { all: ALL },
  why: "The user's read position in one event stream.",
})

const issueEvent = defineRecord({
  builderShape: 'windowed',
  kind: 'issueEvent',
  replicaKind: 'issueEvents',
  schema: IssueEventWire,
  key: 'id',
  group: 'windowed',
  links: { subject: { to: 'issueProjection', why: 'The issue the event is about.' } },
  collections: { window: WINDOW },
  why: 'One curated issue event, in the server window.',
})

const pendingInteraction = defineRecord({
  builderShape: 'windowed',
  kind: 'pendingInteraction',
  replicaKind: 'pendingInteractions',
  schema: PendingInteractionWire,
  key: 'id',
  group: 'always',
  links: { sessionId: { to: 'session', why: 'The session that asks.' } },
  comesWith: [
    {
      collection: 'session.one',
      key: 'sessionId',
      why: 'A pending interaction comes with the session it points to.',
    },
  ],
  collections: { all: ALL },
  why: 'One open blocking ask. Resolving it removes it, so it does not grow with history.',
})

const message = defineRecord({
  builderShape: 'windowed',
  kind: 'message',
  replicaKind: 'messageRecords',
  schema: MessageRecordWire,
  key: 'id',
  group: 'windowed',
  links: { sessionId: { to: 'session' } },
  collections: { window: WINDOW },
  why: 'One chat message a person sent, in the server window.',
})

const issueUserState = defineRecord({
  builderShape: 'row',
  kind: 'issueUserState',
  replicaKind: 'issueUserStates',
  schema: IssueUserStateWire,
  rowKey: (row) => issueUserStateRowId(row.userId, row.entityId),
  group: 'comesWithIssue',
  links: { entityId: { to: 'issueProjection' } },
  collections: {
    ofIssue: ofIssue('entityId', "The user's state for one issue."),
  },
  why: "The user's own state for one issue: read, tucked, joined, assigned.",
})

const sessionUserState = defineRecord({
  builderShape: 'row-and-reads',
  kind: 'sessionUserState',
  replicaKind: 'sessionUserStates',
  schema: SessionUserStateWire,
  rowKey: (row) => sessionUserStateRowId(row.userId, row.sessionId),
  group: 'comesWithSession',
  links: { sessionId: { to: 'session' } },
  collections: {
    ofSession: {
      part: 'main',
      where: { sessionId: { eq: param('sessionId') } },
      why: "The user's state for one session.",
    },
  },
  why: "The user's own state for one session: read and snoozed.",
})

const machine = defineRecord({
  builderShape: 'row-and-reads',
  kind: 'machine',
  replicaKind: 'machines',
  schema: MachineProjection,
  key: 'id',
  group: 'always',
  liveReadings: { 'machine.condition': MachineConditionLive, 'machine.metrics': HostMetricsWire },
  collections: { all: ALL },
  why: 'One machine. Its load is a live reading, pushed while watched.',
})

const issueGitState = defineRecord({
  builderShape: 'row-and-reads',
  kind: 'issueGitState',
  replicaKind: 'issueGitStates',
  schema: IssueGitStateProjection,
  key: 'id',
  group: 'comesWithIssue',
  links: { id: { to: 'issueProjection' } },
  collections: {
    ofIssue: ofIssue('id', 'The git state of one issue.'),
  },
  why: "The server's git observation of one issue's checkout.",
})

const effect = defineRecord({
  builderShape: 'row',
  kind: 'effect',
  replicaKind: 'effects',
  schema: EffectRecordWire,
  key: 'id',
  group: 'windowed',
  collections: { window: WINDOW },
  why: 'One one-shot effect and its status; ended ones leave after the retention window.',
})

const pin = defineRecord({
  builderShape: 'row',
  kind: 'pin',
  replicaKind: 'pins',
  schema: PinWire,
  rowKey: (row) => pinRowId(row.userId, row.kind, row.entityId),
  group: 'always',
  links: {
    entityId: {
      to: ['issueProjection', 'session'],
      by: { field: 'kind', kinds: { issue: 'issueProjection', panel: 'session' } },
    },
  },
  comesWith: [
    {
      collection: 'issueProjection.one',
      key: 'entityId',
      if: { kind: 'issue' },
      why: 'A pinned issue comes with its record.',
    },
    {
      collection: 'session.one',
      key: 'entityId',
      if: { kind: 'panel' },
      why: 'A pinned session comes with its record.',
    },
  ],
  collections: { all: ALL },
  why: 'One pin of the user.',
})

const tabOrder = defineRecord({
  builderShape: 'row',
  kind: 'tabOrder',
  replicaKind: 'tabOrders',
  schema: TabOrderWire,
  rowKey: (row) => tabOrderRowId(row.userId, row.entityId),
  group: 'always',
  collections: { all: ALL },
  why: "The user's tab order in one worktree.",
})

const userPreferences = defineRecord({
  builderShape: 'row-and-reads',
  kind: 'userPreferences',
  replicaKind: 'userPreferences',
  schema: UserPreferencesWire,
  rowKey: (row) => userPreferencesRowId(row.userId),
  group: 'always',
  collections: { all: ALL },
  why: "One person's preferences.",
})

const superagentThread = defineRecord({
  builderShape: 'row',
  kind: 'superagentThread',
  replicaKind: 'superagentThreads',
  schema: SuperagentThreadWire,
  rowKey: (row) => superagentThreadRowId(row.ownerUserId, row.threadId),
  group: 'always',
  links: { podiumSessionId: { to: 'session' }, originSessionId: { to: 'session' } },
  collections: { all: ALL },
  why: 'One superagent thread of the user.',
})

const agentProfile = defineRecord({
  builderShape: 'row',
  kind: 'agentProfile',
  replicaKind: 'agentProfiles',
  schema: AgentProfileWire,
  key: 'id',
  group: 'always',
  links: { machineId: { to: 'machine' } },
  collections: { all: ALL },
  why: 'One named agent setup.',
})

const workflow = defineRecord({
  builderShape: 'row-and-reads',
  kind: 'workflow',
  replicaKind: 'workflows',
  schema: WorkflowWire,
  key: 'id',
  group: 'always',
  links: { latestRevisionId: { to: 'workflowRevision' } },
  collections: { all: ALL },
  why: 'One workflow definition.',
})

const workflowRevision = defineRecord({
  builderShape: 'row',
  kind: 'workflowRevision',
  replicaKind: 'workflowRevisions',
  schema: WorkflowRevisionWire,
  key: 'id',
  group: 'always',
  links: { workflowId: { to: 'workflow' } },
  collections: { all: ALL },
  why: 'One revision of a workflow.',
})

const workflowBinding = defineRecord({
  builderShape: 'row',
  kind: 'workflowBinding',
  replicaKind: 'workflowBindings',
  schema: WorkflowBindingWire,
  rowKey: (row) => workflowBindingRowId(row.targetKind, row.targetId),
  group: 'always',
  links: { revisionId: { to: 'workflowRevision' } },
  collections: { all: ALL },
  why: 'Which workflow revision a target uses.',
})

const workflowRun = defineRecord({
  builderShape: 'row-and-reads',
  kind: 'workflowRun',
  replicaKind: 'workflowRuns',
  schema: WorkflowRunRecord,
  key: 'id',
  group: 'byRule',
  links: {
    workflowId: { to: 'workflow' },
    revisionId: { to: 'workflowRevision' },
    coordinatorSessionId: { to: 'session' },
    subjectId: {
      to: ['issueProjection', 'session'],
      by: { field: 'subjectKind', kinds: { issue: 'issueProjection', session: 'session' } },
    },
  },
  collections: historyCollections('startedAt', 'id', 'workflow runs'),
  why: 'One run of a workflow. Grows with history.',
})

const subscription = defineRecord({
  builderShape: 'row',
  kind: 'subscription',
  replicaKind: 'subscriptions',
  schema: SubscriptionWire,
  key: 'id',
  rowKey: (row) => subscriptionRowIdOf(row),
  group: 'always',
  collections: { all: ALL },
  why: 'One automation trigger subscription.',
})

const instancePreferences = defineRecord({
  builderShape: 'row',
  kind: 'instancePreferences',
  replicaKind: 'instancePreferences',
  schema: InstancePreferencesWire,
  rowKey: () => INSTANCE_PREFERENCES_ROW_ID,
  group: 'always',
  collections: { all: ALL },
  why: 'The instance settings: one record per instance.',
})

const machineAccess = defineRecord({
  builderShape: 'row-and-reads',
  kind: 'machineAccess',
  replicaKind: 'machineAccess',
  schema: MachineAccessWire,
  rowKey: (row) => machineAccessRowId(row.userId, row.machineId),
  group: 'always',
  links: { machineId: { to: 'machine' } },
  collections: { all: ALL },
  why: "One member's access to one machine.",
})

const checkout = defineRecord({
  builderShape: 'row',
  kind: 'checkout',
  replicaKind: 'checkouts',
  schema: CheckoutWire,
  rowKey: (row) => checkoutRowId(row.machineId, row.path),
  group: 'always',
  links: { machineId: { to: 'machine' }, repoId: { to: 'repo' } },
  collections: { all: ALL },
  why: 'One checkout on one machine.',
})

/** The brief and the description share one wire shape: the issue id and the text. */
const issueBody = <const K extends string, const R extends string>(
  kind: K,
  replicaKind: R,
  schema: typeof IssueBriefWire,
  what: string,
) =>
  defineRecord({
    builderShape: 'row',
    kind,
    replicaKind,
    schema,
    key: 'id',
    group: 'body',
    bodyOf: 'issueProjection',
    links: { id: { to: 'issueProjection' } },
    collections: { ofIssue: ofIssue('id', `The ${what} of one issue, when it is opened.`) },
    why: `An issue's ${what}, its own record so a small issue change does not resend it.`,
  })

const issueBrief = issueBody('issueBrief', 'issueBriefs', IssueBriefWire, 'brief')
const issueDescription = issueBody(
  'issueDescription',
  'issueDescriptions',
  IssueDescriptionWire,
  'description',
)

const panelItem = { issueId: { to: 'issueProjection' } } as const

const issuePanelTodo = defineRecord({
  builderShape: 'row-and-reads',
  kind: 'issuePanelTodo',
  replicaKind: 'issuePanelTodos',
  schema: IssuePanelTodoWire,
  key: 'id',
  group: 'body',
  bodyOf: 'issueProjection',
  links: panelItem,
  collections: { ofIssue: ofIssue('issueId', 'The panel todos of one issue, when it is opened.') },
  why: "One todo of an issue's panel.",
})

const issuePanelArtifact = defineRecord({
  builderShape: 'row-and-reads',
  kind: 'issuePanelArtifact',
  replicaKind: 'issuePanelArtifacts',
  schema: IssuePanelArtifactWire,
  key: 'id',
  group: 'body',
  bodyOf: 'issueProjection',
  links: panelItem,
  collections: {
    ofIssue: ofIssue('issueId', 'The panel artifacts of one issue, when it is opened.'),
  },
  why: "One artifact of an issue's panel.",
})

const issuePanelDeferred = defineRecord({
  builderShape: 'row-and-reads',
  kind: 'issuePanelDeferred',
  replicaKind: 'issuePanelDeferreds',
  schema: IssuePanelDeferredWire,
  key: 'id',
  group: 'body',
  bodyOf: 'issueProjection',
  links: panelItem,
  collections: {
    ofIssue: ofIssue('issueId', 'The deferred items of one issue, when it is opened.'),
  },
  why: "One deferred item of an issue's panel.",
})

const issuePanelState = defineRecord({
  builderShape: 'row-and-reads',
  kind: 'issuePanelState',
  replicaKind: 'issuePanelStates',
  schema: IssuePanelStateWire,
  key: 'id',
  group: 'body',
  bodyOf: 'issueProjection',
  links: { id: { to: 'issueProjection' } },
  collections: { ofIssue: ofIssue('id', 'The panel state line of one issue, when it is opened.') },
  why: "An issue's panel state line and its notes time.",
})

const inboxNotice = defineRecord({
  builderShape: 'row',
  kind: 'inboxNotice',
  replicaKind: 'inboxNotices',
  schema: NoticeWire,
  rowKey: (row) => noticeRowId(row.recipientUserId, row.noticeId),
  group: 'always',
  collections: { all: ALL },
  why: "One open notice in one person's inbox (POD-6881, credential management spec §13); a resolved notice is a remove.",
})

const concertmasterEntry = defineRecord({
  builderShape: 'row',
  kind: 'concertmasterEntry',
  replicaKind: 'concertmasterEntries',
  schema: ConcertmasterEntryWire,
  rowKey: (row) => concertmasterEntryRowId(row.sessionId, row.entryId),
  // Not listed in what a session comes with: holding a session does not hold
  // its conversation. The curated chat and the Concertmaster dock panel read
  // `ofSession` while they show the session, and that read holds it.
  group: 'comesWithSession',
  links: { sessionId: { to: 'session', why: 'The Concertmaster session it was said in.' } },
  collections: {
    ofSession: {
      part: 'main',
      where: { sessionId: { eq: param('sessionId') } },
      why: "One Concertmaster session's curated conversation: its messages and its asks, held while the session's chat or dock panel is shown.",
    },
  },
  why: "One entry of a Concertmaster's curated conversation (POD-7211): a message the agent sent, one its person sent, or an ask.",
})

/** Every record type, in wire order. */
export const RECORDS = [
  session,
  issueProjection,
  issueDep,
  repo,
  shipOrder,
  shipLane,
  conversation,
  automation,
  automationRun,
  userLayout,
  userReadPosition,
  issueEvent,
  pendingInteraction,
  message,
  issueUserState,
  sessionUserState,
  machine,
  issueGitState,
  effect,
  pin,
  tabOrder,
  userPreferences,
  superagentThread,
  agentProfile,
  workflow,
  workflowRevision,
  workflowBinding,
  workflowRun,
  subscription,
  instancePreferences,
  machineAccess,
  checkout,
  issueBrief,
  issueDescription,
  issuePanelTodo,
  issuePanelArtifact,
  issuePanelDeferred,
  issuePanelState,
  inboxNotice,
  concertmasterEntry,
] as const
