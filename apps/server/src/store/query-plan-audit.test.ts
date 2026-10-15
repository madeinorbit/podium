/**
 * EVERY REPOSITORY QUERY IS SERVED BY AN INDEX [POD-6148, server data design §3 rule 3].
 *
 * For every query a repository defines with `prepared(...)` or
 * `preparedFamily(...)`, this asks SQLite how it would run it
 * (`EXPLAIN QUERY PLAN`, on the migrated schema with no statistics) and fails
 * on a plan that reads a whole table or sorts in a temporary B-tree, unless
 * the query is on one of the lists below with a written reason.
 *
 * ONE MODULE INSTANCE. The audit pairs each registered definition with its
 * source site by position (see `matchSites`), which needs every repository
 * module loaded once. It therefore never imports a repository by a second
 * specifier (an absolute path next to the server's `@podium/sync/...` or
 * relative import can load the same file twice).
 *
 * HOW IT SEES EVERY QUERY, NOT ONLY THE ONES A TEST RUNS. Each definition
 * registers itself when it is made (`preparedDefinitions()` in
 * `packages/sync/src/adapters/sqlite/prepared.ts`). The audit opens a store,
 * which loads every repository module through the imports the server itself
 * uses and makes the per-repository definitions, and calls each definition's
 * `build` on a drizzle instance that
 * records instead of running. A family is built at each shape listed in
 * `FAMILY_SHAPES`. The source census (`queryDefinitionSites`) lists every
 * definition site in the source, and the audit fails if a site was never
 * registered, so a query cannot be missed by not being reached.
 */

import {
  type PreparedDefinition,
  preparedDefinitions,
  PREPARED_DEFINITION_LIMIT,
} from '@podium/sync/adapters/sqlite/prepared'
import { eq } from 'drizzle-orm'
import { messages } from '../migrations/schema'
import { param, prepared, shapeOf, type StoreDrizzle } from './executor/sync-drizzle'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { LEGACY_WORKTREE_MIGRATION } from './issues'
import { openTestStore } from '../test-support/open-test-store'
import {
  censusScope,
  queryDefinitionSites,
  type QueryDefinitionSite,
} from '../test-support/prepared-census'
import { issueRowFixture } from '../test-support/issue-row'
import {
  type BuiltStatement,
  definitionFrame,
  explain,
  matchSites,
  planFindings,
  type PlanFinding,
  recordingDrizzle,
  statementsOf,
  tablesOf,
} from '../test-support/query-plan-audit'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { asIssueId, asMachineId, asRepoId, firstAdminMemberId } from '@podium/model'

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..')

const SIZES = [1, 4] as const

/**
 * The shapes each family is audited at, keyed `file:name`. A family's key
 * comes from a finite domain; list each value whose SQL differs in a way the
 * plan can see (each optional filter on its own, each principal shape). A
 * family missing here fails the audit.
 */
const FAMILY_SHAPES: ReadonlyMap<string, readonly (string | number)[]> = new Map<
  string,
  readonly (string | number)[]
>([
  ['apps/server/src/store/shipping.ts:queuedOrdersOfLane', SIZES],
  ['apps/server/src/store/shipping.ts:ordersOfIds', SIZES],
  ['apps/server/src/store/shipping.ts:queuedDependentsOfIds', SIZES],
  ['apps/server/src/store/shipping.ts:stackEdgesFromUppers', SIZES],
  ['apps/server/src/store/shipping.ts:openHoldsOfOrders', SIZES],
  ['apps/server/src/store/shipping.ts:receiptsOfOrders', SIZES],
  ['apps/server/src/store/shipping.ts:issueIdsOfOrders', SIZES],
  ['apps/server/src/store/shipping.ts:queuedOrdersOfLanes', ['1x1', '1x4', '4x4']],
  ['apps/server/src/store/automations.ts:automationOwnersOfIds', SIZES],
  ['apps/server/src/store/automations.ts:runOwnersOfIds', SIZES],
  ['apps/server/src/store/users.ts:insertInvite', ['id']],
  ['apps/server/src/store/conversations/registry.ts:segmentsWithPaths', SIZES],
  ['apps/server/src/store/conversations/registry.ts:parentsOf', SIZES],
  ['apps/server/src/store/conversations/registry.ts:nativeIdsOf', SIZES],
  ['apps/server/src/store/conversations/registry.ts:pathsOfNativeIds', SIZES],
  ['apps/server/src/store/transcript-costs.ts:costsOfIssues', SIZES],
  ['apps/server/src/store/grants.ts:grantsOfResources', SIZES],
  ['apps/server/src/store/grants.ts:upsertGrant', ['set', 'keep']],
  ['apps/server/src/store/grants.ts:deleteGrantsOfResource', ['retain', 'all']],
  ['apps/server/src/store/sessions.ts:bindingOwnersOfIds', SIZES],
  ['apps/server/src/store/sessions.ts:bindingFactsOfIds', SIZES],
  ['apps/server/src/store/sessions.ts:sessionsOfIds', SIZES],
  ['apps/server/src/store/sessions.ts:liveSessionsOfResumeValues', SIZES],
  ['apps/server/src/store/sessions.ts:liveSessionsOfIssueIds', SIZES],
  ['apps/server/src/store/sessions.ts:upsertSessionOfShape', ['id']],
  ['apps/server/src/store/superagent.ts:setThreadBinding', ['podiumSessionId,updatedAt']],
  ['apps/server/src/store/machines.ts:rotateCredentialOf', ['null', 'key']],
  ['apps/server/src/store/issues.ts:issuesByIds', SIZES],
  ['apps/server/src/store/issues.ts:labelsNamed', SIZES],
  ['apps/server/src/store/issues.ts:patchLabel', ['color', 'description', 'color,description']],
  ['apps/server/src/store/issues.ts:commentSearch', ['all', 'limited']],
  ['apps/server/src/store/issues.ts:IssuesRepository.upsert', [shapeOf(issueRowFixture())]],
  [
    'apps/server/src/store/events.ts:eventsSince',
    [
      'b0|k0|x0|r0|s0|asc',
      'b0|k0|x0|r0|s0|desc',
      'b1|k0|x0|r0|s0|desc',
      'b0|k2|x0|r0|s0|asc',
      'b0|k0|x2|r0|s0|asc',
      'b0|k0|x0|r1|s0|asc',
      'b0|k0|x0|r0|s1|asc',
    ],
  ],
  ['apps/server/src/store/messages.ts:insertMessage', ['id']],
  ['apps/server/src/store/messages.ts:messagesWithIds', SIZES],
  ['apps/server/src/store/messages.ts:messagesAddressedTo', ['no-id', 'id']],
  ['apps/server/src/store/messages.ts:ledger', ['issue', 'session', 'both']],
  [
    'apps/server/src/store/messages.ts:pendingPage',
    ['no-id', 'id', 'no-id|after', 'id|after'],
  ],
  [
    'apps/server/src/store/messages.ts:pendingSummaryOf',
    ['no-id', 'id', 'session', 'session-blank'],
  ],
  [
    'apps/server/src/store/messages.ts:pendingSendersOf',
    ['no-id', 'id', 'session', 'session-blank'],
  ],
  [
    'apps/server/src/store/messages.ts:pendingCountOf',
    ['no-id', 'id', 'session', 'session-blank'],
  ],
  ['apps/server/src/store/messages.ts:existingIdsAmong', SIZES],
  ['apps/server/src/store/messages.ts:receiptsAmong', SIZES],
  ['apps/server/src/store/messages.ts:sentAmong', SIZES],
  ['apps/server/src/store/messages.ts:communicatedSince', ['no-id', 'id']],
  ['apps/server/src/store/messages.ts:swapHarnessRef', ['null', 'text']],
  ['apps/server/src/store/messages.ts:openBoundTo', ['1', '4', '1|issue', '4|issue']],
  ['apps/server/src/store/messages.ts:queuedPage', ['start', 'after']],
  ['packages/sync/src/adapters/sqlite/sync-repository.ts:insertChangeRows', SIZES],
  [
    'packages/sync/src/adapters/sqlite/sync-repository.ts:serverTableQueries.queuedCounts',
    ['all', 'one', 'set'],
  ],
  [
    'apps/server/src/store/workflows.ts:workflowsWhere',
    ['a1|s0|r0', 'a0|s0|r0', 'a0|s1|r0', 'a0|s1|r1', 'a1|s0|r1'],
  ],
  ['apps/server/src/store/workflows.ts:insertRunSteps', SIZES],
  [
    'apps/server/src/store/conversations/index.ts:searchConversations',
    [
      'all|any',
      'all|posix',
      'all|windows',
      'fts|any',
      'fts|posix',
      'fts|windows',
      'like|any',
      'like|posix',
      'like|windows',
    ],
  ],
  ['apps/server/src/store/conversations/mirror.ts:segmentsToMirror', ['all', 'dirty']],
])

/**
 * Columns whose value most rows share, as `table.column`. A plan that seeks
 * only on these is a scan: SQLite without statistics takes any indexed
 * equality as selective (see `planFindings`).
 */
const LOW_SELECTIVITY: ReadonlySet<string> = new Set([
  // Most rows are live; `deleted_at IS NULL` selects nearly all of them.
  'sessions.deleted_at',
  'issues.deleted_at',
  // A handful of resource kinds; one kind is a large share of all grants.
  'grants.resource_kind',
  // Three recipient kinds.
  'messages.to_kind',
])

/**
 * Tables that do not grow with work: their size follows the number of people,
 * machines, repositories or settings, or they hold only rows waiting to be
 * consumed. A scan of one, and a sort of rows read only from these, is
 * accepted for the reason given.
 */
const SMALL_TABLES: ReadonlyMap<string, string> = new Map([
  ['sqlite_sequence', "SQLite's own table: one row per AUTOINCREMENT table."],
  ['accounts', 'Provider accounts the operator configures by hand.'],
  ['automations', 'Schedules people define by hand; a handful per person.'],
  ['machines', 'The fleet: one row per enrolled machine.'],
  ['maintenance_commands', 'The maintenance ledger, held to a fixed size by pruneOldestCommands.'],
  ['repos', 'One row per repository checkout per machine.'],
  ['repo_prefixes', 'One row per repository.'],
  ['server_secrets', 'A fixed set of server keys.'],
  ['settings_audit_events', 'One row per settings change, which people make by hand.'],
  ['users', 'One row per member of the team.'],
  ['user_credentials', 'One row per member credential.'],
  ['member_invites', 'Open invitations, a few per member.'],
  ['telegram_chat_bindings', 'One row per person who bound a chat.'],
  ['workflows', 'Workflow definitions people write by hand.'],
  ['workflow_revisions', 'Revisions of the workflows people write by hand.'],
  ['workflow_bindings', 'One binding per workflow target, set by hand.'],
  ['agent_profiles', 'Agent profiles people define by hand.'],
  ['labels', 'The label vocabulary: one row per label name, which people create by hand.'],
  ['superagent_queued_inputs', 'A transient queue: a row is removed when its input is consumed.'],
  ['superagent_pending_turns', 'A transient queue: a row is removed when its turn starts.'],
  ['queued_messages', 'A transient queue: a row is removed when the message is delivered.'],
  ['upstream_outbox', 'A transient queue: a row is removed when the upstream accepts it.'],
  ['quota_windows', 'Rolling usage windows: a few rows per provider account per week.'],
  ['offers', 'At most one live offer per session, removed when cleared.'],
  ['tab_order', 'One row per person per worktree they arranged.'],
])

/**
 * Queries whose scan or sort is accepted, keyed `file:name`, with the reason.
 * Every entry here is bounded by something other than the amount of work: a
 * sort of one key's few rows, a one-time repair behind its receipt.
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map([
  [
    'apps/server/src/store/messages.ts:ledger',
    'Each UNION arm reads its index newest first and SQLite merges them, stopping at the limit; the temporary B-tree orders only rows tied on (created_at, id), which is unique, so every sort group is one row.',
  ],
  [
    'apps/server/src/store/messages.ts:pendingByTarget',
    'Sorts only undelivered rows: the delivery_status IN list selects the pending queue, which empties as messages are delivered.',
  ],
  [
    'apps/server/src/store/messages.ts:pendingForSessionProof',
    'Sorts only undelivered rows: the delivery_status IN list selects the pending queue, which empties as messages are delivered.',
  ],
  [
    'apps/server/src/store/messages.ts:pendingSummaryOf',
    'Sorts only undelivered rows: the delivery_status IN list selects the pending queue, which empties as messages are delivered.',
  ],
  [
    'apps/server/src/store/messages.ts:pendingSendersOf',
    'Sorts only undelivered rows: the delivery_status IN list selects the pending queue, which empties as messages are delivered.',
  ],
  [
    'apps/server/src/store/messages.ts:openBoundTo',
    'Sorts only undelivered rows: the delivery_status IN list selects the pending queue, which empties as messages are delivered.',
  ],
  [
    'apps/server/src/store/messages.ts:openChat',
    "Walks the partial index idx_messages_open_chat (named with INDEXED BY) in its order: a person's chat messages not yet settled or not yet seen, never the confirmed history. The plan is asserted below.",
  ],
  [
    'apps/server/src/store/issues.ts:labelsOf',
    "Sorts one issue's labels: the join reads only that issue's issue_labels rows, a handful per issue.",
  ],
  [
    'apps/server/src/store/messages.ts:queuedPage',
    'Sorts only undelivered rows: the delivery_status IN list selects the pending queue, which empties as messages are delivered.',
  ],
  [
    'apps/server/src/store/messages.ts:latestPendingOperator',
    'Sorts only undelivered rows: the delivery_status IN list selects the pending queue, which empties as messages are delivered.',
  ],
  [
    'apps/server/src/store/sessions.ts:liveSessionByResumeValue',
    'Sorts the few live sessions that share one resume value.',
  ],
  [
    'apps/server/src/store/sessions.ts:liveSessionsOfResumeValues',
    'Sorts the live sessions of the given resume values: the IN list is at most one chunk.',
  ],
  [
    'apps/server/src/store/sessions.ts:liveSessionsOfIssueIds',
    'Sorts the live sessions of the given issues, found through idx_sessions_issue: a few per issue.',
  ],
  [
    'apps/server/src/store/sessions.ts:sessionsOfIds',
    'Sorts the sessions named by the IN list, at most one chunk.',
  ],
  [
    'apps/server/src/store/sessions.ts:deletedSessionsForIssue',
    'Sorts the sessions one issue deleted: a few.',
  ],
  [
    'apps/server/src/store/sessions.ts:pinsOfUser',
    "Sorts one person's pins by when they were made.",
  ],
  ['apps/server/src/store/grants.ts:grantsOfResource', 'Sorts the grants on one resource: a few.'],
  [
    'apps/server/src/store/grants.ts:grantsOfResources',
    'Sorts the grants on the resources of the IN list: a few each.',
  ],
  [
    'apps/server/src/store/interactions.ts:openInteractions',
    'Sorts the open interactions only (status index); answered ones are not read.',
  ],
  [
    'apps/server/src/store/approvals.ts:executingApprovals',
    'Sorts the approvals executing right now (status index): a handful.',
  ],
  [
    'apps/server/src/store/conversations/registry.ts:nativeIdsOf',
    'Sorts the segments of the conversations in the IN list: a few each.',
  ],
  [
    'apps/server/src/store/conversations/index.ts:searchConversations [fts|any]',
    'Sorts the full-text matches, which the FTS index found.',
  ],
  [
    'apps/server/src/store/conversations/index.ts:searchConversations [fts|posix]',
    'Sorts the full-text matches, which the FTS index found.',
  ],
  [
    'apps/server/src/store/conversations/index.ts:searchConversations [fts|windows]',
    'Sorts the full-text matches, which the FTS index found.',
  ],
  [
    'apps/server/src/store/conversations/transcript-index.ts:searchTranscripts',
    'Sorts the full-text matches by rank, which the FTS index found.',
  ],
  [
    'apps/server/src/store/events.ts:runtimeTranscriptPayloads',
    "Sorts one subject's transcript events, found through the subject index.",
  ],
  [
    'apps/server/src/store/events.ts:eventsSince',
    "Reads events after the caller's cursor through the kind index and sorts that page.",
  ],
  [
    'apps/server/src/store/events.ts:eventIdBeyondCap',
    'Walks the newest `cap` events by primary key to find where pruning starts; it reads the cap, not the table.',
  ],
  [
    'apps/server/src/store/events.ts:deletePruneBatch',
    'Reads the oldest events in id order and stops at the batch limit.',
  ],
  [
    'apps/server/src/store/events.ts:subscriptionsOf',
    "Sorts one subscriber's subscriptions, found through idx_subscriptions_subscriber.",
  ],
  [
    'apps/server/src/store/shipping.ts:queuedOrdersOfLane',
    'Sorts the queued orders of one lane, found through idx_ship_orders_lane.',
  ],
  [
    'apps/server/src/store/shipping.ts:queuedOrdersOfLanes',
    'Sorts the queued orders of the listed lanes, found through idx_ship_orders_lane: the queues of the lanes in one feed batch.',
  ],
  [
    'apps/server/src/store/shipping.ts:queuedDependentsOfIds',
    'Reads only active orders, through the partial index idx_ship_orders_one_active_issue, and sorts them.',
  ],
  ['apps/server/src/store/shipping.ts:latestAttemptOfOrder', "Sorts one order's attempts: a few."],
  [
    'apps/server/src/store/shipping.ts:activeClaimOrdersOfLane',
    "Sorts the claims of one lane's open trains, found through idx_ship_train_manifests_open_lane.",
  ],
  ['apps/server/src/store/shipping.ts:stepsOfAttempt', "Sorts one attempt's steps: tens at most."],
  [
    'apps/server/src/store/shipping.ts:latestStepOfEffect',
    "Sorts one attempt's steps for one effect: a few.",
  ],
  [
    'apps/server/src/store/shipping.ts:envelopeProofsOfAttempt',
    "Sorts one attempt's effect envelopes: a few.",
  ],
  [
    'apps/server/src/store/user-layout.ts:worktreesOfSessions',
    'Sorts the worktrees of the sessions in its argument.',
  ],
  [
    'apps/server/src/store/workflows.ts:liveRuns',
    'Sorts the live runs only, found through workflow_runs_status.',
  ],
  [
    'apps/server/src/store/workflows.ts:liveRunOfSession',
    'Sorts the live runs of one session, found through the status and coordinator indexes.',
  ],
  [
    'apps/server/src/store/issues.ts:issuesUnderPathOutsideRepo',
    'Sorts the issues at or under one repository path, found through idx_issues_repo (an equality and a range); runs when a repository gains its id.',
  ],
  [
    'apps/server/src/store/conversations/transcript-index.ts:catchUpKeys',
    'Keys the transcript FTS rows past the last keyed rowid, a rowid range, when search opens: every row once, the first time the key table exists, and normally none after.',
  ],
  [
    'apps/server/src/store/issues.ts:legacyWorktreeSkipped',
    'One-time backfill: runs once per database, behind the legacy_worktree_machine_ids_v1 receipt.',
  ],
  [
    'apps/server/src/store/issues.ts:IssuesRepository.legacyMachine',
    'One-time backfill: runs once per database, behind the legacy_worktree_machine_ids_v1 receipt.',
  ],
])

/**
 * Queries that read a whole table that grows with work, on purpose: boot
 * loaders of the in-memory copies POD-6140 removes, full listings and sweeps.
 * No index can serve them; changing what they read is rule 5 (read only what
 * is needed), owned by the sub-issue named in each reason. The list may only
 * shrink.
 */
const WHOLE_TABLE_READS: ReadonlyMap<string, string> = new Map([
  [
    'apps/server/src/store/issues.ts:issueCwdRows',
    'Whole-table read (POD-6172): boot load of the issue folder rows for the world index (POD-6155).',
  ],
  [
    'apps/server/src/store/issues.ts:issueClosureRows',
    'Whole-table read (POD-6172): the finished-work projection over every issue.',
  ],
  [
    'apps/server/src/store/issues.ts:liveIssueParentEdges',
    "Whole-table read (POD-6172): every live issue's parent edge, for the issue tree.",
  ],
  [
    'apps/server/src/store/issues.ts:issueRowsOfRepo',
    'Whole-table read (POD-6172): every issue of one repository, for listings.',
  ],
  [
    'apps/server/src/store/issues.ts:allIssueRows',
    'Whole-table read (POD-6172): boot load of the issue map.',
  ],
  [
    'apps/server/src/store/issues.ts:issueWorktreeRows',
    "Whole-table read (POD-6172): every issue's worktree, for folder ownership (POD-6155 replaces it with idx_issues_worktree).",
  ],
  [
    'apps/server/src/store/issues.ts:issueSeqRows',
    'Whole-table read (POD-6172): the seq repair sweep over every issue.',
  ],
  [
    'apps/server/src/store/issues.ts:allIssueLabels',
    'Whole-table read (POD-6172): boot load of every label.',
  ],
  [
    'apps/server/src/store/issues.ts:distinctLabels',
    'Whole-table read (POD-6172): every distinct label, for the label picker.',
  ],
  [
    'apps/server/src/store/issues.ts:allDeps',
    'Whole-table read (POD-6172): boot load of every dependency edge.',
  ],
  [
    'apps/server/src/store/issues.ts:commentCountsByIssue',
    'Whole-table read (POD-6172): comment counts of every issue.',
  ],
  [
    'apps/server/src/store/issues.ts:allIssueUserStateRows',
    "Whole-table read (POD-6172): boot load of every person's issue state.",
  ],
  [
    'apps/server/src/store/issues.ts:deleteOrphanRefLetters',
    'Whole-table read (POD-6172): sweep for ref letters whose issue is gone.',
  ],
  [
    'apps/server/src/store/sessions.ts:liveSessions',
    'Whole-table read (POD-6172): boot load of the session map.',
  ],
  [
    'apps/server/src/store/sessions.ts:deletedSessions',
    'Whole-table read (POD-6172): every deleted session, for the archive view.',
  ],
  [
    'apps/server/src/store/sessions.ts:detachDanglingReferences',
    'Whole-table read (POD-6172): boot sweep for session references to deleted issues.',
  ],
  [
    'apps/server/src/store/sessions.ts:allUserStateRows',
    "Whole-table read (POD-6172): boot load of every person's session state.",
  ],
  [
    'apps/server/src/store/sessions.ts:allSnoozeRows',
    'Whole-table read (POD-6172): boot load of every snooze.',
  ],
  [
    'apps/server/src/store/sessions.ts:draftTexts',
    'Whole-table read (POD-6172): boot load of every draft.',
  ],
  [
    'apps/server/src/store/sessions.ts:draftTimes',
    'Whole-table read (POD-6172): boot load of every draft time.',
  ],
  [
    'apps/server/src/store/sessions.ts:allDraftRows',
    'Whole-table read (POD-6172): boot load of every draft.',
  ],
  [
    'packages/sync/src/adapters/sqlite/sync-repository.ts:installedWorld',
    'Whole-table read (POD-6172): the sync bootstrap of change_latest (sync behaviour, out of POD-6148 scope).',
  ],
  [
    'apps/server/src/store/auth.ts:clientSessionsNewestFirst',
    'Whole-table read (POD-6172): every device, for the devices settings page.',
  ],
  [
    'apps/server/src/store/automations.ts:allLiveRuns',
    'Whole-table read (POD-6172): boot load of every automation run.',
  ],
  [
    'apps/server/src/store/automations.ts:lastSpawnedRuns',
    'Whole-table read (POD-6172): the last spawned run of every automation.',
  ],
  [
    'apps/server/src/store/conversations/index.ts:curatedConversations',
    'Whole-table read (POD-6172): every named conversation.',
  ],
  [
    'apps/server/src/store/conversations/index.ts:searchConversations [all|any]',
    'Whole-table read (POD-6172): every conversation, newest first, when no search term is given.',
  ],
  [
    'apps/server/src/store/conversations/index.ts:searchConversations [all|posix]',
    'Whole-table read (POD-6172): every conversation under a folder, newest first.',
  ],
  [
    'apps/server/src/store/conversations/index.ts:searchConversations [all|windows]',
    'Whole-table read (POD-6172): every conversation under a folder, newest first.',
  ],
  [
    'apps/server/src/store/conversations/registry.ts:clearStraySubagentPaths',
    'Whole-table read (POD-6172): boot repair over every segment path.',
  ],
  [
    'apps/server/src/store/events.ts:allSubscriptions',
    'Whole-table read (POD-6172): boot load of every subscription.',
  ],
  [
    'apps/server/src/store/events.ts:enabledSubscriptions',
    'Whole-table read (POD-6172): every enabled subscription.',
  ],
  [
    'apps/server/src/store/grants.ts:grantsOfKind',
    'Whole-table read (POD-6172): every grant of one resource kind.',
  ],
  [
    'apps/server/src/store/grants.ts:allGrants',
    'Whole-table read (POD-6172): boot load of the world index grants (POD-6155).',
  ],
  [
    'apps/server/src/store/machines.ts:legacySentinelScan',
    'Whole-table read (POD-6172): boot check that no row in any table still names a retired machine sentinel; a sweep by design.',
  ],
  [
    'apps/server/src/store/observation-checkpoints.ts:checkpointedLiveLeases',
    'Whole-table read (POD-6172): boot restore of the session map, which loads every live session row itself until it is removed (POD-6159, design §6).',
  ],
  [
    'apps/server/src/store/shipping.ts:allOrders',
    'Whole-table read (POD-6172): boot load of every ship order.',
  ],
  [
    'apps/server/src/store/shipping.ts:allStackEdgesOrdered',
    'Whole-table read (POD-6172): every stack edge.',
  ],
  [
    'apps/server/src/store/shipping.ts:allStackEdges',
    'Whole-table read (POD-6172): every stack edge.',
  ],
  [
    'apps/server/src/store/shipping.ts:allAttempts',
    'Whole-table read (POD-6172): every ship attempt.',
  ],
  ['apps/server/src/store/shipping.ts:allHolds', 'Whole-table read (POD-6172): every ship hold.'],
  [
    'apps/server/src/store/shipping.ts:allReceipts',
    'Whole-table read (POD-6172): every delivery receipt.',
  ],
  [
    'apps/server/src/store/transcript-costs.ts:attributedCosts',
    'Whole-table read (POD-6172): every attributed transcript cost.',
  ],
  [
    'apps/server/src/store/transcript-costs.ts:ownCohortFolds',
    'Whole-table read (POD-6172): the cost folds of every live issue.',
  ],
  [
    'apps/server/src/store/transcript-costs.ts:costCount',
    'Whole-table read (POD-6172): count of every transcript cost row.',
  ],
  [
    'apps/server/src/store/workflows.ts:allRuns',
    'Whole-table read (POD-6172): every workflow run.',
  ],
])

/**
 * Lookups an index could serve but whose SQL prevents it (a LIKE on a bound
 * prefix, a literal turned into a parameter, an expression over the column).
 * POD-6173 rewrote the rest; what is left needs full-text search, and each
 * reason names the decision that defers it. The list may only shrink.
 */
const SHAPE_DEBT: ReadonlyMap<string, string> = new Map([
  [
    'apps/server/src/store/issues.ts:commentSearch',
    'Query shape: substring LIKE over comment bodies; needs server full-text search, which the operator deferred (POD-5617).',
  ],
  [
    'apps/server/src/store/conversations/index.ts:searchConversations [like|any]',
    'Query shape: substring LIKE over conversations; the FTS path serves this when enabled, and server full-text search is deferred (POD-5617).',
  ],
  [
    'apps/server/src/store/conversations/index.ts:searchConversations [like|posix]',
    'Query shape: substring LIKE over conversations; the FTS path serves this when enabled, and server full-text search is deferred (POD-5617).',
  ],
  [
    'apps/server/src/store/conversations/index.ts:searchConversations [like|windows]',
    'Query shape: substring LIKE over conversations; the FTS path serves this when enabled, and server full-text search is deferred (POD-5617).',
  ],
])

function trackedSources(): string[] {
  const out: string[] = []
  for (const dir of ['apps/server/src/store', 'packages/sync/src/adapters/sqlite']) {
    for (const entry of readdirSync(join(REPO_ROOT, dir), { recursive: true })) {
      out.push(relative(REPO_ROOT, join(REPO_ROOT, dir, String(entry))))
    }
  }
  return censusScope(out.map((path) => path.split('\\').join('/')))
}

interface AuditedStatement {
  readonly key: string
  readonly shape: string | number | undefined
  readonly statement: BuiltStatement
  readonly plan: readonly string[]
  readonly findings: readonly PlanFinding[]
}

let store: SessionStore
let database: SqlDatabase

/** Run, ignoring the outcome: a definition registers before its statement runs. */
async function attempt(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch {
    // The statement may refuse on these planted rows; the definition was made.
  }
}

/**
 * Reach the definitions made inside a method rather than at module level.
 *
 * `IssuesRepository` and `ReposRepository` define their writes inside the
 * method that invalidates their read cache first (see `issueWrites` and
 * `repoWrites`), and `MessagesRepository` defines one status write per move.
 * Such a definition is made the first time its method reaches it, so the
 * audit drives each method once, with rows planted to take the branch that
 * holds it. A new method-level definition that this does not reach fails the
 * coverage check by name.
 */
async function reachMethodDefinitions(target: SessionStore): Promise<void> {
  // The full-text tables are made at runtime when search is enabled, not by a migration.
  await target.conversations.ensureFts(true)
  const machineId = asMachineId(target.hostMachineId)
  const now = new Date().toISOString()
  database
    .prepare(
      'INSERT INTO machines (id, name, hostname, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(machineId, 'audit', 'audit', 'audit-token-hash', now, now)
  const auditIssue = (over: Parameters<typeof issueRowFixture>[0]) =>
    issueRowFixture({
      machineId,
      ownerUserId: firstAdminMemberId(),
      createdByOnBehalfOf: null,
      parentId: null,
      supersededBy: null,
      duplicateOf: null,
      coordinatorSessionId: null,
      startedBySession: null,
      humanQuestionAskedBy: null,
      ...over,
    })
  await attempt(() =>
    target.repos.addRepo('/audit/one', machineId, 'https://example.invalid/one.git', 'AUD'),
  )
  const issue = auditIssue({
    id: 'iss_audit',
    stage: 'review',
    repoPath: '/audit/repo',
    repoId: 'repo_audit',
  })
  await attempt(() => target.issues.upsertIssue(issue))
  await attempt(() =>
    target.issues.transitionShippingStage(
      asIssueId('iss_audit'),
      'review',
      'shipping',
      issue.createdAt,
    ),
  )
  // Two rows with no repo id and one seq: the legacy collision `renumberCollidingIssueSeqs`
  // repairs. A write through the repository resolves the repo id, so they are planted.
  database.exec(`
    CREATE TEMP TABLE audit_issue AS SELECT * FROM issues WHERE id = 'iss_audit';
    UPDATE audit_issue SET id = 'iss_audit_a', repo_id = NULL, seq = 7, repo_path = '/audit/one';
    INSERT INTO issues SELECT * FROM audit_issue;
    UPDATE audit_issue SET id = 'iss_audit_b';
    INSERT INTO issues SELECT * FROM audit_issue;
    DROP TABLE audit_issue;
  `)
  await attempt(() => target.issues.renumberCollidingIssueSeqs())
  // A row under the path whose repo id differs: the one `assignRepoIdToIssuesUnder` moves.
  await attempt(() =>
    target.issues.assignRepoIdToIssuesUnder(asRepoId('repo_audit_other'), '/audit/repo'),
  )
  // Boot already ran the legacy backfill and left its receipt; remove it so the backfill runs again.
  database.prepare('DELETE FROM meta WHERE key = ?').run(LEGACY_WORKTREE_MIGRATION)
  await attempt(() => target.issues.backfillLegacyWorktreeMachineIds(machineId))
  await attempt(() => target.issues.deleteIssue('iss_audit_b'))

  await attempt(() => target.repos.addRepo('/audit/two', machineId))
  await attempt(() => target.repos.setRepoPrefix(machineId, '/audit/two', 'AUDB'))
  // A row stored with a trailing slash: `updateRepoOrigin` renames it to the normalized path.
  database
    .prepare('INSERT OR IGNORE INTO repos (machine_id, path, added_at) VALUES (?, ?, ?)')
    .run(machineId, '/audit/three/', new Date().toISOString())
  await attempt(() =>
    target.repos.updateRepoOrigin(machineId, '/audit/three', 'https://example.invalid/three.git'),
  )
  // A repo on its path-derived id, with a prefix: gaining an origin re-keys the prefix.
  await attempt(() => target.repos.addRepo('/audit/four', machineId))
  await attempt(() =>
    target.repos.updateRepoOrigin(machineId, '/audit/four', 'https://example.invalid/four.git'),
  )
  await attempt(() => target.repos.removeRepo('/audit/one', machineId))

  await attempt(() =>
    target.messages.addMessage({
      id: 'msg_audit',
      threadId: 'msg_audit',
      fromKind: 'operator',
      fromId: null,
      toKind: 'issue',
      toId: 'iss_audit',
      body: 'audit',
      createdAt: issue.createdAt,
      deliveryStatus: 'stored',
    } as unknown as Parameters<typeof target.messages.addMessage>[0]),
  )
  await attempt(() => target.messages.markCancelled('msg_audit'))

  // Two `ReposRepository` methods each define the same statement into one slot
  // (`insertPrefixIfAbsent`, `deleteRow`), so whichever runs first makes it and
  // the other site is never evaluated. Empty those two slots and run the other
  // method. (Not a second store: every definition site must run exactly once,
  // because a site evaluated again later may report a different position.)
  const repoWrites = (target.repos as unknown as { repoWrites: Record<string, unknown> }).repoWrites
  delete repoWrites.insertPrefixIfAbsent
  delete repoWrites.deleteRow
  await attempt(() =>
    target.repos.ensurePrefixForRepoId(asRepoId('repo_audit_prefix'), 'auditprefix'),
  )
  await attempt(() => target.repos.removeRepo('/audit/two', machineId))
}

/**
 * THE PLANNER'S PICTURE OF A LARGE DATABASE. With no statistics SQLite takes
 * every indexed equality as selective, so it may seek on `deleted_at IS NULL`
 * rather than on the key a query actually names, which no real database would
 * do. Each index that leads with a {@link LOW_SELECTIVITY} column gets a
 * statistics row saying so (a million rows, a quarter of them per value of the
 * leading column, one per value of the rest); every other index keeps
 * SQLite's default, which assumes a large table and a selective key.
 */
function modelLowSelectivity(db: SqlDatabase): void {
  db.exec('ANALYZE')
  db.exec('DELETE FROM sqlite_stat1')
  const indexes = db
    .prepare("SELECT name, tbl_name AS tableName FROM sqlite_master WHERE type = 'index'")
    .all() as { name: string; tableName: string }[]
  const insert = db.prepare('INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, ?, ?)')
  for (const { name, tableName } of indexes) {
    const columns = db.prepare(`PRAGMA index_info(${JSON.stringify(name)})`).all() as {
      name: string
    }[]
    if (!LOW_SELECTIVITY.has(`${tableName}.${columns[0]?.name}`)) continue
    insert.run(tableName, name, ['1000000', '250000', ...columns.slice(1).map(() => '1')].join(' '))
  }
  // Reload the statistics into this connection's planner.
  db.exec('ANALYZE sqlite_schema')
}

beforeAll(async () => {
  store = await openTestStore(':memory:')
  database = (store as unknown as { db: SqlDatabase }).db
  await reachMethodDefinitions(store)
  modelLowSelectivity(database)
})

afterAll(async () => {
  await store?.close()
})

/** A query builder that is not a statement: a subquery another definition embeds. */
function isFragment(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  if (typeof (value as { getSQL?: unknown }).getSQL === 'function') return true
  const parts = Object.values(value)
  return parts.length > 0 && parts.every(isFragment)
}

/** A definition the audit checks, by the key its lists use. */
interface KeyedDefinition {
  readonly key: string
  readonly definition: PreparedDefinition
}

/**
 * Every registered definition paired with its source site, plus the coverage
 * facts: sites never reached, files whose positions could not be paired.
 */
function keyedDefinitions(sources: readonly string[]): {
  sites: QueryDefinitionSite[]
  keyed: KeyedDefinition[]
  unregisteredSites: string[]
  unmapped: string[]
} {
  const sites = sources.flatMap((file) =>
    queryDefinitionSites(file, readFileSync(join(REPO_ROOT, file), 'utf8')),
  )
  const sitesByFile = new Map<string, QueryDefinitionSite[]>()
  for (const site of sites)
    sitesByFile.set(site.file, [...(sitesByFile.get(site.file) ?? []), site])
  const definitions = preparedDefinitions().map((definition) => ({
    definition,
    frame: definitionFrame(definition.site, REPO_ROOT),
  }))
  const positionsByFile = new Map<string, { line: number; column: number }[]>()
  for (const { frame } of definitions) {
    if (frame && sitesByFile.has(frame.file)) {
      positionsByFile.set(frame.file, [...(positionsByFile.get(frame.file) ?? []), frame])
    }
  }
  const unmapped: string[] = []
  const siteAt = new Map<string, Map<string, QueryDefinitionSite>>()
  for (const [file, fileSites] of sitesByFile) {
    const matched = matchSites(positionsByFile.get(file) ?? [], fileSites)
    if (matched) siteAt.set(file, matched)
    else {
      const reached = new Set((positionsByFile.get(file) ?? []).map((p) => `${p.line}:${p.column}`))
        .size
      const methodSites = fileSites.filter((site) => !site.moduleLevel).map((site) => site.name)
      const frames = [
        ...new Set(
          definitions
            .filter(({ frame }) => frame?.file === file)
            .map(
              ({ definition }) =>
                (definition.site.stack ?? '').split('\n').find((line) => line.includes(file)) ?? '',
            ),
        ),
      ].slice(0, 6)
      unmapped.push(
        `${file}: ${fileSites.length} definition sites, ${reached} positions reached; ` +
          `method-level sites: ${methodSites.join(', ')}; positions: ${[
            ...new Set((positionsByFile.get(file) ?? []).map((p) => `${p.line}:${p.column}`)),
          ].join(
            ' ',
          )}; site lines: ${fileSites.map((site) => site.startLine).join(' ')}; sample frames: ${frames.join(' || ')}`,
      )
    }
  }
  const registered = new Set<QueryDefinitionSite>()
  const keyed: KeyedDefinition[] = []
  for (const { definition, frame } of definitions) {
    const site = frame && siteAt.get(frame.file)?.get(`${frame.line}:${frame.column}`)
    if (!site) continue
    registered.add(site)
    keyed.push({ key: `${site.file}:${site.name}`, definition })
  }
  return {
    sites,
    keyed,
    unregisteredSites:
      siteAt.size === sitesByFile.size
        ? sites
            .filter((site) => !registered.has(site))
            .map((site) => `${site.file}:${site.startLine} ${site.name}`)
        : [],
    unmapped,
  }
}

/** Build each definition at each of its shapes and read every statement's plan. */
function auditDefinitions(keyed: readonly KeyedDefinition[]): {
  audited: AuditedStatement[]
  fragments: string[]
  missingShapes: string[]
  buildErrors: string[]
  explainErrors: string[]
} {
  const recording = recordingDrizzle()
  const tables = tablesOf(database)
  const audited: AuditedStatement[] = []
  const fragments = new Set<string>()
  const missingShapes = new Set<string>()
  const buildErrors: string[] = []
  const explainErrors: string[] = []
  const seen = new Set<string>()
  for (const { key, definition } of keyed) {
    if (definition.kind === 'family' && !FAMILY_SHAPES.has(key)) missingShapes.add(key)
    const shapes: readonly (string | number | undefined)[] =
      definition.kind === 'family' ? (FAMILY_SHAPES.get(key) ?? []) : [undefined]
    for (const shape of shapes) {
      let built: unknown
      let statements: BuiltStatement[]
      try {
        built = (definition.build as (db: unknown, key: unknown) => unknown)(recording, shape)
        statements = statementsOf(built)
      } catch (error) {
        buildErrors.push(`${key} [${String(shape)}]: ${(error as Error).message}`)
        continue
      }
      if (statements.length === 0) {
        if (isFragment(built)) fragments.add(key)
        else buildErrors.push(`${key} [${String(shape)}]: built no statement`)
      }
      for (const statement of statements) {
        const dedupe = `${key}\u0000${statement.sql}`
        if (seen.has(dedupe)) continue
        seen.add(dedupe)
        let plan: string[]
        try {
          plan = explain(database, statement)
        } catch (error) {
          explainErrors.push(
            `${key} [${String(shape)}]: ${(error as Error).message} :: ${statement.sql}`,
          )
          continue
        }
        audited.push({
          key,
          shape,
          statement,
          plan,
          findings: planFindings(plan, statement.sql, tables, LOW_SELECTIVITY),
        })
      }
    }
  }
  return {
    audited,
    fragments: [...fragments],
    missingShapes: [...missingShapes],
    buildErrors,
    explainErrors,
  }
}

/** The tables a plan reads, by name. */
function tablesInPlan(entry: AuditedStatement): string[] {
  const tables = tablesOf(database)
  const out: string[] = []
  for (const detail of entry.plan) {
    const match = /^(?:SCAN|SEARCH) (\S+)/.exec(detail)
    if (!match) continue
    const named = tables.has(match[1]!)
      ? match[1]!
      : planFindings([`SCAN ${match[1]!}`], entry.statement.sql, tables)[0]?.table
    if (named !== undefined) out.push(named)
  }
  return out
}

/** The list entry for a statement: by `key [shape]` first, then by `key`. */
function listEntry(entry: AuditedStatement): string | undefined {
  for (const name of [`${entry.key} [${String(entry.shape)}]`, entry.key]) {
    const found = ALLOWLIST.get(name) ?? WHOLE_TABLE_READS.get(name) ?? SHAPE_DEBT.get(name)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Why a flagged statement is accepted, or undefined when it is not: its key is
 * on one of the lists, or every table it reads is a small one.
 */
function explanation(entry: AuditedStatement): string | undefined {
  const listed = listEntry(entry)
  if (listed !== undefined) return listed
  const read = tablesInPlan(entry)
  if (read.length > 0 && read.every((table) => SMALL_TABLES.has(table))) return 'small tables only'
  return undefined
}

const describeEntry = (entry: AuditedStatement): string =>
  `${entry.key} [${String(entry.shape ?? '')}]\n  ${entry.findings.map((f) => f.detail).join(' ; ')}\n  plan: ${entry.plan.join(' | ')}\n  sql: ${entry.statement.sql.slice(0, 600)}`

describe('POD-6148 — every repository query is served by an index', () => {
  it('reaches and builds every query definition in the repositories', () => {
    const { sites, keyed, unregisteredSites, unmapped } = keyedDefinitions(trackedSources())
    const { audited, fragments, missingShapes, buildErrors, explainErrors } =
      auditDefinitions(keyed)
    // THE REPORT: how much the audit checked.
    console.log(
      `query-plan audit: ${sites.length} definition sites in ${new Set(sites.map((s) => s.file)).size} files, ` +
        `${keyed.length} definitions reached, ${audited.length} statements planned, ` +
        `${fragments.length} subquery fragments planned inside their statements`,
    )
    expect(preparedDefinitions().length).toBeLessThan(PREPARED_DEFINITION_LIMIT)
    // A census that read nothing would pass; the covered set is hundreds of definitions.
    expect(sites.length).toBeGreaterThan(500)
    expect(unmapped).toEqual([])
    expect(unregisteredSites).toEqual([])
    expect(missingShapes).toEqual([])
    expect(buildErrors).toEqual([])
    expect(explainErrors).toEqual([])
  })

  it('finds no scan or sort that is not explained', () => {
    const { keyed } = keyedDefinitions(trackedSources())
    const { audited } = auditDefinitions(keyed)
    const flagged = audited.filter((entry) => entry.findings.length > 0)
    const unexplained = flagged.filter((entry) => explanation(entry) === undefined)
    console.log(
      `query-plan audit: ${audited.length} statements, ${flagged.length} scan or sort, ` +
        `${flagged.length - unexplained.length} explained (${ALLOWLIST.size} allowlisted, ` +
        `${WHOLE_TABLE_READS.size} whole-table reads, ${SHAPE_DEBT.size} query-shape debts, ` +
        `${SMALL_TABLES.size} small tables), ${unexplained.length} unexplained`,
    )
    for (const entry of unexplained) console.log(`UNEXPLAINED ${describeEntry(entry)}`)
    expect(unexplained.map((entry) => `${entry.key} [${String(entry.shape ?? '')}]`)).toEqual([])
  })

  it('reads the open chat through its partial index (POD-6173)', () => {
    const { keyed } = keyedDefinitions(trackedSources())
    const { audited } = auditDefinitions(keyed)
    const openChat = audited.filter((entry) => entry.key === 'apps/server/src/store/messages.ts:openChat')
    expect(openChat.map((entry) => entry.plan)).toEqual([
      ['SCAN messages USING INDEX idx_messages_open_chat'],
    ])
  })

  it('keeps no stale entry: every listed query still scans or sorts, every small table exists', () => {
    const { keyed } = keyedDefinitions(trackedSources())
    const { audited } = auditDefinitions(keyed)
    const flaggedKeys = new Set(
      audited
        .filter((entry) => entry.findings.length > 0)
        .flatMap((entry) => [entry.key, `${entry.key} [${String(entry.shape)}]`]),
    )
    const listed = [...ALLOWLIST.keys(), ...WHOLE_TABLE_READS.keys(), ...SHAPE_DEBT.keys()]
    expect(listed.filter((key) => !flaggedKeys.has(key))).toEqual([])
    // A key on two lists is two different decisions about one query.
    expect(listed.filter((key, index) => listed.indexOf(key) !== index)).toEqual([])
    const tables = tablesOf(database)
    expect([...SMALL_TABLES.keys()].filter((table) => !tables.has(table))).toEqual([])
    for (const reason of [
      ...ALLOWLIST.values(),
      ...WHOLE_TABLE_READS.values(),
      ...SHAPE_DEBT.values(),
      ...SMALL_TABLES.values(),
    ]) {
      expect(reason.trim().length).toBeGreaterThan(20)
    }
  })

  it('is armed: a planted unindexed lookup fails it, and an indexed one passes', () => {
    // Two definitions made here register like any repository's: one looks
    // messages up by `body`, which no index serves, one by primary key.
    prepared((db: StoreDrizzle) =>
      db
        .select()
        .from(messages)
        .where(eq(messages.body, param(messages.body, 'body')))
        .prepare(),
    )
    prepared((db: StoreDrizzle) =>
      db
        .select()
        .from(messages)
        .where(eq(messages.id, param(messages.id, 'id')))
        .prepare(),
    )
    const [plantedScan, plantedSearch] = preparedDefinitions().slice(-2)
    const { audited } = auditDefinitions([
      { key: 'planted:scan', definition: plantedScan! },
      { key: 'planted:search', definition: plantedSearch! },
    ])
    const scan = audited.find((entry) => entry.key === 'planted:scan')!
    const search = audited.find((entry) => entry.key === 'planted:search')!
    expect(scan.findings.map((finding) => finding.kind)).toEqual(['scan'])
    expect(explanation(scan)).toBeUndefined()
    expect(search.findings).toEqual([])
  })
})
