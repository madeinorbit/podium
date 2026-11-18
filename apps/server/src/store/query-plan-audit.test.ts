/**
 * EVERY REPOSITORY QUERY IS SERVED BY AN INDEX [POD-6148, server data design §3 rule 3].
 *
 * For every query a repository defines with `prepared(...)` or
 * `preparedFamily(...)`, this asks SQLite how it would run it
 * (`EXPLAIN QUERY PLAN`, on the migrated schema with no statistics) and fails
 * on a plan that reads a whole table or sorts in a temporary B-tree, unless
 * the query is on one of the lists below with a written reason.
 *
 * ONE MODULE INSTANCE. The audit pairs each registered definition with the
 * source site its call is on (see `siteContaining`), and plans what one store
 * built. It therefore never imports a repository by a second specifier (an
 * absolute path next to the server's `@podium/sync/...` or relative import can
 * load the same file twice, and register every definition in it twice).
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

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import {
  PREPARED_DEFINITION_LIMIT,
  preparedDefinitions,
} from '@podium/sync/adapters/sqlite/prepared'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { messages } from '../migrations/schema'
import { PLANNER_STATISTICS_ROW_FLOOR } from '../migrations/store-lifecycle'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'
import type { SessionStore } from '../store'
import {
  builtStatements,
  FAMILY_SHAPES,
  type KeyedDefinition,
  keyedDefinitions,
  RAW_SQL_EXEMPT,
  RAW_SQL_PLANNED,
  REPO_ROOT,
  rawExemption,
  rawKey,
  rawSqlCensus,
  reachMethodDefinitions,
  SIZES,
  type SourceTree,
  trackedSources,
} from '../test-support/definition-census'
import { openTestStore } from '../test-support/open-test-store'
import {
  OPERATOR_PLANNER_STATISTICS,
  OPERATOR_STATISTICS_CAPTURED_AT,
} from '../test-support/operator-planner-statistics'
import { type RawSqlSite, rawSqlSites } from '../test-support/prepared-census'
import {
  type BuiltStatement,
  explain,
  type PlanFinding,
  planFindings,
  tablesOf,
} from '../test-support/query-plan-audit'
import { param, prepared, type StoreDrizzle } from './executor/sync-drizzle'
import { WORKSPACE_TABLES } from './workspace-manifest'

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
  // EVERY WORKSPACE TABLE'S WORKSPACE (POD-7024). Every key and index leads with
  // workspace_id, and a self-hosted install has one workspace, so `workspace_id = ?` selects
  // every row: a search constrained by the workspace alone reads the whole table. Without
  // statistics SQLite takes it as selective (and SQLite does not carry the workspace into the
  // branches of an OR unless statistics say it pays), so the audit models it as what it is.
  // `sync_feed` is keyed by the workspace alone (one row per workspace): there it is the key.
  ...[...WORKSPACE_TABLES]
    .filter((table) => table !== 'sync_feed')
    .map((table) => `${table}.workspace_id`),
])

/**
 * An index's statistics as `ANALYZE` writes them for a table of `rows` rows: the row count, then
 * how many rows share each prefix of the index's columns. The workspace leads every index of a
 * workspace table and a self-hosted install has one, so a real ANALYZE finds every row under it;
 * the column after it narrows as the leading column always did (`first`), and the rest to one.
 */
function prefixStatistics(
  rows: number,
  table: string,
  columns: readonly string[],
  first: (rows: number, lowSelectivity: boolean) => number,
): string {
  let narrowed = false
  const perPrefix = columns.map((column) => {
    const low = LOW_SELECTIVITY.has(`${table}.${column}`)
    if (!narrowed && low && column === 'workspace_id') return rows
    if (narrowed) return 1
    narrowed = true
    return first(rows, low)
  })
  return [rows, ...perPrefix].join(' ')
}

/**
 * Tables that do not grow with work: their size follows the number of people,
 * machines, repositories or settings, or they hold only rows waiting to be
 * consumed. A scan of one, and a sort of rows read only from these, is
 * accepted for the reason given.
 */
const SMALL_TABLES: ReadonlyMap<string, string> = new Map([
  ['accounts', 'Provider accounts the operator configures by hand.'],
  ['automations', 'Schedules people define by hand; a handful per person.'],
  ['machines', 'The fleet: one row per enrolled machine.'],
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
  [
    'operations',
    "Durable operations (modules/operations/store.ts): single-flight keeps at most one live row per exclusion group, and retention sweeps each kind's finished history to twenty.",
  ],
  ['offers', 'At most one live offer per session, removed when cleared.'],
  // Read whole per workspace since the keys lead with workspace_id (POD-7024).
  ['sync_kind', 'One generation row per record kind per workspace: a few dozen.'],
  ['workspace_secrets', "A fixed set of a workspace's own keys (POD-7013)."],
  [
    'artifact_uploads',
    'CLI uploads in flight: a row is removed when the upload is published or swept.',
  ],
  ['tab_order', 'One row per person per worktree they arranged.'],
  ['pins', 'A few pins per person, read in the order they were made (POD-7024).'],
  // The end-of-period deletes of these two scan by workspace until the key migration (C1,
  // POD-7024) leads their keys with workspace_id; then they are keyed range deletes.
  [
    'client_sessions',
    'Sign-ins from before shared sign-in (POD-6751): nothing inserts one any more; a row leaves when it is consumed, expires or the period ends.',
  ],
  [
    'carried_sign_ins',
    'One carry record per consumed old sign-in, kept ten minutes and swept when it expires.',
  ],
])

/**
 * Queries whose scan or sort is accepted, keyed `file:name`, with the reason.
 * Every entry here is bounded by something other than the amount of work: a
 * sort of one key's few rows, a one-time repair behind its receipt.
 */
const MIN_MAX_SEEK =
  "A min() or max() over a key that leads with workspace_id: SQLite's min/max optimization " +
  'reads the one entry at that end of the workspace (measured on a million rows: 4 µs a call, ' +
  'against 43 ms for a read of the whole workspace). The plan names only the workspace (POD-7024).'
const ALLOWLIST: ReadonlyMap<string, string> = new Map([
  [
    'apps/server/src/store/sessions.ts:anySession',
    'One-row existence probe for setup: LIMIT 1 stops at the first stored session of the workspace, including tombstones. Reads at most one row regardless of history.',
  ],
  [
    'apps/server/src/store/effects.ts:newestOnTargetIn [active]',
    "Sorts only the active effect records: the seek on idx_effects_status_deadline reads the pending and running ones, a few in the whole table, never a target's finished history (POD-7031).",
  ],
  ['apps/server/src/store/events.ts:highestEventId', MIN_MAX_SEEK],
  ['packages/sync/src/adapters/sqlite/sync-repository.ts:advanceFloor', MIN_MAX_SEEK],
  [
    'apps/server/src/store/issues.ts:issuesOfLabels',
    "The change capture's mapping of renamed labels to the issues carrying them (POD-6920): found through idx_issue_labels_label_id, the distinct issue ids sorted in a temporary tree, a few per label; a label rename is rare.",
  ],
  [
    'apps/server/src/store/workflows.ts:runIdsOfRevisions',
    "The change capture's mapping of a changed workflow revision to the runs that read it (POD-6920): workflow_runs is a small table (a row per started workflow run), and a revision changes only when it is published.",
  ],
  [
    'apps/server/src/store/automations.ts:lastSpawnedRuns',
    "Walks the automations (a small table: schedules people define by hand) and finds each one's newest spawned run through idx_automation_runs_automation, never the runs of the whole table (POD-6172).",
  ],
  [
    'apps/server/src/store/issue-listings.ts:labelsOfIssues',
    "Sorts the labels of the issues a report lists, by the issue's primary key, then the label name: a few labels per listed issue (POD-6191).",
  ],
  [
    'apps/server/src/store/issue-listings.ts:liveChildrenOf',
    'Sorts the live children of the parents asked for (their own index lookup), in the boot order a report shows them: a few rows per parent (POD-6191).',
  ],
  [
    'apps/server/src/store/messages.ts:ledger',
    'Each UNION arm reads its index newest first and SQLite merges them, stopping at the limit; the temporary B-tree orders only rows tied on (created_at, id), which is unique, so every sort group is one row.',
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
    'apps/server/src/store/sessions.ts:refBackfillCandidates',
    "Sorts the boot ref backfill's candidates (POD-6222): the ref-less sessions that can still get a birth ref, read by index ranges; a few once the first boot named them.",
  ],
  ['apps/server/src/store/grants.ts:grantsOfResource', 'Sorts the grants on one resource: a few.'],
  [
    'apps/server/src/store/grants.ts:grantsOfResources',
    'Sorts the grants on the resources of the IN list: a few each.',
  ],
  [
    'apps/server/src/store/grants.ts:grantsOfResourceKeys',
    'Sorts the grants on the resources of the two IN lists: a few each.',
  ],
  [
    'apps/server/src/store/interactions.ts:openInteractions',
    'Sorts the open interactions only (status index); answered ones are not read.',
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
    "Puts one subject's newest `limit` transcript events, read newest first by id, back oldest first.",
  ],
  [
    'apps/server/src/store/events.ts:eventsSince',
    "Reads events after the caller's cursor through the kind index and sorts that page.",
  ],
  [
    'apps/server/src/store/events.ts:feedWindowRows',
    "The issue-event feed's window (POD-6766): one arm per feed kind reads that kind's newest `limit` events through the kind index and stops; the sort merges those few hundred rows, never the log.",
  ],
  [
    'apps/server/src/store/events.ts:feedWindowIds',
    "The issue-event feed's window, ids only (POD-6766): one arm per feed kind reads that kind's newest `limit` events through the kind index and stops; the sort merges those few hundred rows, never the log.",
  ],
  [
    'apps/server/src/store/events.ts:feedEventsOfSubjects',
    "The feed-window events of the issues in the IN list (POD-6766): read from the window's oldest id up, so bounded by the window, and sorted by id.",
  ],
  [
    'apps/server/src/store/events.ts:eventsAboveId',
    "Counts the events above the row cap's guess through idx_podium_events_kind, named with INDEXED BY: a kind and a rowid per entry, never a table page, and the log is held to the cap (POD-7035).",
  ],
  [
    'apps/server/src/store/events.ts:deletePruneBatch',
    'Reads the oldest events in id order and stops at the batch limit.',
  ],
  [
    'apps/server/src/store/events.ts:subscriptionsOf',
    "Sorts one subscriber's subscriptions, found through idx_subscriptions_subscriber_event.",
  ],
  [
    'apps/server/src/store/events.ts:matchingSubscriptions',
    "Sorts the steward's candidates for one poll (POD-6208): each arm seeks its index by the polled kinds and sources or by the event issues' ancestor subscribers, so the union holds only rows that can match.",
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
    'apps/server/src/store/shipping.ts:attemptsOfOrder',
    "Sorts one order's attempts: a few (POD-6172).",
  ],
  [
    'apps/server/src/store/shipping.ts:activeOrdersFifo',
    'Walks the partial index idx_ship_orders_one_active_issue (named with INDEXED BY) and sorts what it holds: the active orders only, never the shipped or cancelled history (POD-6172). The plan is asserted below.',
  ],
  [
    'apps/server/src/store/shipping.ts:resumableOrdersFifo',
    'Walks only the partial index idx_ship_orders_recovery, named with INDEXED BY: unfinished execution states, excluding queued, held, shipped and cancelled orders.',
  ],
  [
    'apps/server/src/store/shipping.ts:activeOrdersOfLane',
    'Sorts the active orders of one lane, found through idx_ship_orders_lane (POD-6172).',
  ],
  [
    'apps/server/src/store/shipping.ts:shippedLeadersOfOpenTrains',
    'Walks the partial index idx_ship_train_manifests_open_lane (named with INDEXED BY): the open trains only, never the released history; each leader is one primary-key probe (POD-6207). The plan is asserted below.',
  ],
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
  // The janitor's reads (POD-6993): its raw reads moved into the store with their plans
  // unchanged. Each runs once per janitor tick, in the janitor's worker on a read session
  // of its own, never on the server's request path.
  [
    'apps/server/src/store/janitor-reads.ts:listWorkspacesWithFeed',
    'The cross-workspace read of the allowlist: one row per workspace, read along the sync_feed primary key.',
  ],
  ['apps/server/src/store/janitor-reads.ts:maxEventIdOf', MIN_MAX_SEEK],
  [
    'apps/server/src/store/janitor-reads.ts:eventPruneHeadOf',
    "Walks the workspace's events oldest first along its key (workspace_id, id) and stops at the first prunable one: the cap is a prefix of the ids and the age cutoff starts at the oldest end, so the head is found at once whenever there is one.",
  ],
  [
    'apps/server/src/store/janitor-reads.ts:eventsAboveGuessOf',
    "Counts the workspace's events above the row cap's guess on the narrowest index (named on SQLite): a kind and a rowid per entry, never a table page, and the log is held to the cap (POD-7035, as events.ts:eventsAboveId).",
  ],
  [
    'apps/server/src/store/janitor-reads.ts:eventPruneCountOf',
    'Counts the prunable events (too old, or over the cap): the OR of age and cap has no one index, and the log is bounded by the retention policy it prunes to.',
  ],
  [
    'apps/server/src/store/janitor-reads.ts:worktreeGcFirst',
    'Sorts the finished issues still holding a checkout, found through idx_issues_worktree (worktree_path set): bounded by the checkouts on disk.',
  ],
  [
    'apps/server/src/store/janitor-reads.ts:worktreeGcAfter',
    'Sorts the finished issues still holding a checkout, found through idx_issues_worktree (worktree_path set): bounded by the checkouts on disk.',
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
    'apps/server/src/store/collections.ts:collectionRows [|automationRun.page#sorted#]',
    'The first page of a history collection (POD-7085, brief item 5): the whole collection in its order, walked on its time index, because the page carries the total the viewer may see. Fetched on demand when a history view opens, never in the first download; later pages seek below their position.',
  ],
  [
    'apps/server/src/store/collections.ts:collectionRows [|conversation.page#sorted#]',
    'The first page of a history collection (POD-7085, brief item 5): the whole collection in its order, walked on its time index, because the page carries the total the viewer may see. Fetched on demand when a history view opens, never in the first download; later pages seek below their position.',
  ],
  [
    'apps/server/src/store/collections.ts:collectionRows [|workflowRun.page#sorted#]',
    'The first page of a history collection (POD-7085, brief item 5): the whole collection in its order, walked on its time index, because the page carries the total the viewer may see. Fetched on demand when a history view opens, never in the first download; later pages seek below their position.',
  ],
  [
    'apps/server/src/store/conversations/index.ts:recordPage',
    'A keyset page of stored conversation records, bounded by the requested page size, for full truth and bootstrap. The first page walks the id index.',
  ],
  [
    'apps/server/src/store/issue-git-states.ts:pageOf',
    'A keyset page of stored git observations joined to live issues, bounded by requested page size. The first page walks the observation primary key.',
  ],
  [
    'apps/server/src/store/issue-panel.ts:todoPage',
    'Bounded keyset panel record page joined to its issue; the first page walks its primary key.',
  ],
  [
    'apps/server/src/store/issue-panel.ts:artifactPage',
    'Bounded keyset panel record page joined to its issue; the first page walks its primary key.',
  ],
  [
    'apps/server/src/store/issue-panel.ts:deferredPage',
    'Bounded keyset panel record page joined to its issue; the first page walks its primary key.',
  ],
  [
    'apps/server/src/store/issue-panel.ts:statePage',
    'Bounded keyset panel record page joined to its issue; the first page walks its primary key.',
  ],
  [
    'apps/server/src/store/machines.ts:machineRecordIds',
    'An id-only covering walk for a change that affects the entire fleet, including a member joining or leaving.',
  ],
  [
    'apps/server/src/store/machines.ts:machineRecordPage',
    'A keyset page of stored machine records, bounded by requested page size. The first page walks the id index.',
  ],
  [
    'apps/server/src/store/users.ts:activeRecordMembers',
    'Enabled members id and role only, for each member machine-access record. The output necessarily covers the enabled membership; no credential or other account data is loaded.',
  ],
  [
    'apps/server/src/store/messages.ts:confirmedChatWindow',
    "The chat feed's confirmed window as a query (POD-6763, POD-6766): each live session's newest confirmed operator messages, ranked by a window function, which sorts each session's confirmed messages, after a read of `sessions` finds the live ones. Read by the record builder's `streamAll` during client bootstrap, never at server startup or per write (a write reads `confirmedChatTail`). Bounded by live sessions, not by history; the start-up load phase decides whether it stays.",
  ],
  [
    'apps/server/src/store/checkouts.ts:allCheckouts',
    'The checkout record builder streams stored rows during client bootstrap. Server startup never reads them.',
  ],
  [
    'apps/server/src/store/issue-listings.ts:issueListing',
    "Whole-table read (POD-6172): an unpaged issue listing reads every issue in its scope (one repository by its index, or all of them) and sorts it; it replaces the issue map's scan of every issue (POD-6191), and paging with a cursor bounds it.",
  ],
  [
    'apps/server/src/store/issue-listings.ts:issueCountGroups',
    'Whole-table read (POD-6172): counts every issue in a listing scope by stage, priority, type and assignee, in SQL rather than over the issue map (POD-6191).',
  ],
  [
    'apps/server/src/store/issue-listings.ts:issueStatTotals',
    'Whole-table read (POD-6172): totals over every issue in a listing scope, in SQL rather than over the issue map (POD-6191).',
  ],
  [
    'apps/server/src/store/issue-listings.ts:deferralsOf',
    'Whole-table read (POD-6172): the deferred issues of a listing scope; a deferral is decided by Date.parse, so the scope is read for the rows that carry one (POD-6191).',
  ],
  [
    'apps/server/src/store/issues.ts:liveIssueParentEdges',
    "Whole-table read (POD-6172): every live issue's parent edge, for the cost sheet's rollups (CostService.task and tasks), which fold each costed task into its ancestors over the whole tree.",
  ],
  [
    'apps/server/src/store/issues.ts:issueRowsOfRepo',
    'Whole-table read (POD-6172): every issue of one repository, the repository-scoped arm of listIssueRows, which only tests and the statement census call since the issue map went (POD-6158); listings read issue-listings.ts (POD-6191).',
  ],
  [
    'apps/server/src/store/issues.ts:allIssueRows',
    'Whole-table read (POD-6172): every issue row, for tests and the statement census; no server path reads it since the issue map went (POD-6158).',
  ],
  [
    'apps/server/src/store/issues.ts:issueSeqRows',
    'Explicit legacy collision-repair test oracle. Migrations enforce UNIQUE(repo_id, seq); server startup never runs this repair.',
  ],
  [
    'apps/server/src/store/issues.ts:allDeps',
    'Whole-table read (POD-6172): every dependency edge, for the issueDep record builder during client bootstrap and for the deck (deck.ts), which joins the edges of the issues it shows.',
  ],
  [
    'apps/server/src/store/issues.ts:commentCountsByIssue',
    'Whole-table read (POD-6172): countIssueCommentsByIssue is a test oracle only; no production code calls it since the legacy report batch went with the issue map (POD-6158).',
  ],
  [
    'apps/server/src/store/workflows.ts:everyRun',
    'The workflowRun record builder streams runs during client bootstrap. Server startup never reads stored workflow history.',
  ],
  [
    'apps/server/src/store/workflows.ts:everyRunStep',
    'The workflowRun record builder joins run steps during client bootstrap. Server startup never reads them.',
  ],
  [
    'apps/server/src/store/sessions.ts:allPins',
    "The pin record builder streams each person's pins during client bootstrap; never at server startup.",
  ],
  [
    'apps/server/src/store/superagent.ts:allThreads',
    'The superagentThread record builder streams stored threads during client bootstrap; never at server startup.',
  ],
  [
    'apps/server/src/store/user-preferences.ts:allPreferenceRows',
    'The userPreferences record builder streams stored preferences during client bootstrap; never at server startup.',
  ],
  [
    'apps/server/src/store/issues.ts:allIssueUserStateRows',
    'The issueUserState record builder streams personal rows during client bootstrap; never at server startup.',
  ],
  [
    'apps/server/src/store/issues.ts:deleteOrphanRefLetters',
    'Explicit legacy repair test oracle. The historical data repair runs once in sync-without-boot-reconcile; server startup never runs it.',
  ],
  [
    'apps/server/src/store/sessions.ts:liveSessions',
    'Whole-table read (POD-6172): the full session listing (sessions.list, the list tool). Boot no longer reads it (POD-6160).',
  ],
  [
    'apps/server/src/store/sessions.ts:liveSessionsWithoutRef',
    "Whole-table read of the ref-less sessions (POD-6222): the boot ref backfill's fallback, only while a repo prefix no registered root explains (a removed repo's, or one set on an unregistered path) could name any of them; logged when it runs. Otherwise the backfill reads refBackfillCandidates.",
  ],
  [
    'apps/server/src/store/sessions.ts:deletedSessions',
    "Whole-table read (POD-6172): loadDeletedSessions is a test oracle only; no production code calls it (the archive view reads one issue's tombstones, loadDeletedSessionsForIssue).",
  ],
  [
    'apps/server/src/store/sessions.ts:detachDanglingReferences',
    'Explicit legacy repair test oracle. The historical data repair runs once in sync-without-boot-reconcile; server startup never runs it.',
  ],
  [
    'apps/server/src/store/sessions.ts:allUserStateRows',
    "Whole-table read (POD-6172): every person's sparse session state for the record builder's current-table startup stream (sync/record-builders.ts).",
  ],
  [
    'apps/server/src/store/sessions.ts:allSnoozeRows',
    'Whole-table read (POD-6172): every snooze, read with the session states for the current-table startup stream.',
  ],
  [
    'apps/server/src/store/sessions.ts:draftTexts',
    'Whole-table read (POD-6172): loadDrafts is a test oracle only; no production code calls it.',
  ],
  [
    'apps/server/src/store/sessions.ts:draftTimes',
    'Whole-table read (POD-6172): loadDraftTimes is a test oracle only; production reads the times of a known set of sessions (POD-6160).',
  ],
  [
    'apps/server/src/store/sessions.ts:allDraftRows',
    'Whole-table read (POD-6172): every stored draft, replayed to a connecting client (session-state replayDrafts); a row exists only while its text is not empty, so it grows with unsent drafts, not with history.',
  ],
  [
    'apps/server/src/store/automations.ts:allLiveRuns',
    'The automationRun record builder streams stored runs during client bootstrap; never at server startup.',
  ],
  [
    'apps/server/src/store/machines.ts:legacySentinelScan',
    'Whole-table read (POD-6172): boot check that no row in any table still names a retired machine sentinel; a sweep by design.',
  ],
  [
    'apps/server/src/store/shipping.ts:allOrders',
    'The shipping record builders stream historical orders during client bootstrap; never at server startup. Recovery reads indexed durable debt and unfinished execution states (POD-6797).',
  ],
  [
    'apps/server/src/store/shipping.ts:allStackEdgesOrdered',
    'The shipLane record builder streams stack edges during client bootstrap; never at server startup.',
  ],
  [
    'apps/server/src/store/shipping.ts:allHolds',
    'The shipping record builders stream hold rows during client bootstrap; never at server startup.',
  ],
  [
    'apps/server/src/store/shipping.ts:allReceipts',
    'The shipping record builders stream receipt rows during client bootstrap; never at server startup.',
  ],
  [
    'apps/server/src/store/transcript-costs.ts:attributedCosts',
    'Whole-table read (POD-6172): the cost sheet ranks every costed task (CostService.tasks); tokens are summed from a JSON column, so the ranking cannot be paged in SQL.',
  ],
  [
    'apps/server/src/store/transcript-costs.ts:ownCohortFolds',
    "Whole-table read (POD-6172): the rate cohort is a statistic over every qualifying, surviving issue: one grouped SQL aggregate, read when one task's comparison is asked for.",
  ],
  // The janitor's auto-archive candidates (POD-6993): its raw reads since POD-1210,
  // moved into the store with their plans unchanged, read once per janitor tick in its
  // worker. Serving their order needs a read_at index on the read state tables, a
  // schema change for the key and index owner (POD-6959 side); until then they sweep.
  [
    'apps/server/src/store/janitor-reads.ts:sessionArchiveOf',
    "Sweeps session_user_state for owners' reads of stopped sessions, sorted by read time (the janitor's raw read since POD-1210); needs a read_at index to be a seek.",
  ],
  [
    'apps/server/src/store/janitor-reads.ts:issueArchiveFirst',
    "Reads the top-level issues and their assignee's read state, sorted by read time (the janitor's raw read since POD-1210); needs a read_at index to be a seek.",
  ],
  [
    'apps/server/src/store/janitor-reads.ts:issueArchiveAfter',
    "Reads the top-level issues and their assignee's read state, sorted by read time (the janitor's raw read since POD-1210); needs a read_at index to be a seek.",
  ],
  [
    'apps/server/src/store/transcript-costs.ts:costCount',
    'Whole-table read (POD-6172): countAll is a test oracle only; no production code calls it.',
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

interface AuditedStatement {
  readonly key: string
  readonly shape: string | number | undefined
  readonly statement: BuiltStatement
  readonly plan: readonly string[]
  readonly findings: readonly PlanFinding[]
}

/** Plan each PLANNED raw statement on the migrated schema, like a repository query. */
function auditRawSql(sites: readonly RawSqlSite[]): AuditedStatement[] {
  const tables = tablesOf(database)
  return sites
    .filter((site) => RAW_SQL_PLANNED.has(rawKey(site)))
    .map((site) => {
      const statement: BuiltStatement = {
        sql: site.sql,
        params: (site.sql.match(/\?/g) ?? []).length,
        placeholders: [],
      }
      const plan = explain(database, statement)
      return {
        key: rawKey(site),
        shape: undefined,
        statement,
        plan,
        findings: planFindings(plan, statement.sql, tables, LOW_SELECTIVITY),
      }
    })
}

/**
 * The repository as this audit reads it. It reads source it does not import (every
 * definition site, every raw statement), so it sits in the shard keyed on the whole tree.
 */
const SOURCE: SourceTree = {
  list: (dir) =>
    readdirSync(join(REPO_ROOT, dir), { recursive: true }).map((entry) =>
      relative(REPO_ROOT, join(REPO_ROOT, dir, String(entry)))
        .split('\\')
        .join('/'),
    ),
  read: (file) => readFileSync(join(REPO_ROOT, file), 'utf8'),
}

let store: SessionStore
let database: SqlDatabase

/**
 * THE PLANNER'S PICTURE OF A LARGE DATABASE. With no statistics SQLite takes
 * every indexed equality as selective, so it may seek on `deleted_at IS NULL`
 * rather than on the key a query actually names, which no real database would
 * do. Each index that leads with a {@link LOW_SELECTIVITY} column gets a
 * statistics row saying so (a million rows, a quarter of them per value of the
 * leading column, one per value of the rest); every other index keeps
 * SQLite's default, which assumes a large table and a selective key.
 */
function modelLowSelectivity(db: SqlDatabase, options?: { replace?: boolean }): void {
  writeStatistics(
    db,
    (table, columns, unique) =>
      LOW_SELECTIVITY.has(`${table}.${columns[0]}`)
        ? defaultsAfterWorkspace(table, columns, unique)
        : undefined,
    options,
  )
}

/** SQLite's own guess of the rows per prefix of an index it has no statistics for. */
const SQLITE_DEFAULT_ROWS = [10, 9, 8, 7, 6]

/**
 * A million rows under one workspace, then the statistics SQLite assumes without any for the
 * columns after it (`sqlite3DefaultRowEst`: 10, 9, 8, 7, 6, then 5 rows per prefix, one for the
 * whole key of a unique index), except that a low-selectivity column holds a quarter of what
 * its prefix held. So the workspace prefix adds nothing the planner did not already assume of
 * the index, and it cannot make the column after it look more selective than it is.
 */
function defaultsAfterWorkspace(
  table: string,
  columns: readonly string[],
  unique: boolean,
): string {
  let rows = 1_000_000
  let step = 0
  const perPrefix = columns.map((column, index) => {
    const low = LOW_SELECTIVITY.has(`${table}.${column}`)
    if (low) {
      rows = column === 'workspace_id' && step === 0 ? rows : Math.max(1, Math.floor(rows / 4))
    } else {
      rows = Math.min(rows, SQLITE_DEFAULT_ROWS[step] ?? 5)
      step += 1
    }
    return unique && index === columns.length - 1 ? 1 : rows
  })
  return ['1000000', ...perPrefix].join(' ')
}

/**
 * Replace every statistics row with the one `statOf` gives each index (none
 * where it gives undefined), and reload them into this connection's planner.
 */
function writeStatistics(
  db: SqlDatabase,
  statOf: (table: string, columns: readonly string[], unique: boolean) => string | undefined,
  {
    replace = true,
    only = () => true,
  }: { replace?: boolean; only?: (index: string) => boolean } = {},
): void {
  if (replace) {
    db.exec('ANALYZE')
    db.exec('DELETE FROM sqlite_stat1')
  }
  const indexes = db
    .prepare("SELECT name, tbl_name AS tableName FROM sqlite_master WHERE type = 'index'")
    .all() as { name: string; tableName: string }[]
  const insert = db.prepare('INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, ?, ?)')
  for (const { name, tableName } of indexes) {
    if (!only(name)) continue
    const columns = db.prepare(`PRAGMA index_info(${JSON.stringify(name)})`).all() as {
      name: string
    }[]
    const unique =
      (
        db
          .prepare(`SELECT "unique" AS isUnique FROM pragma_index_list(?) WHERE name = ?`)
          .get(tableName, name) as { isUnique: number } | undefined
      )?.isUnique === 1
    const stat = statOf(
      tableName,
      columns.map((column) => column.name),
      unique,
    )
    if (stat !== undefined) insert.run(tableName, name, stat)
  }
  db.exec('ANALYZE sqlite_schema')
}

beforeAll(async () => {
  store = await openTestStore(':memory:')
  database = (store as unknown as { db: SqlDatabase }).db
  await reachMethodDefinitions(store, database)
  modelLowSelectivity(database)
})

afterAll(async () => {
  await store?.close()
})

/**
 * Build each definition at each of its shapes and read every statement's plan.
 * `shapesOf` gives a family's shapes; by default those of {@link FAMILY_SHAPES}.
 */
function auditDefinitions(
  keyed: readonly KeyedDefinition[],
  shapesOf: (key: string) => readonly (string | number)[] | undefined = (key) =>
    FAMILY_SHAPES.get(key),
): {
  audited: AuditedStatement[]
  fragments: string[]
  missingShapes: string[]
  buildErrors: string[]
  explainErrors: string[]
} {
  const tables = tablesOf(database)
  const { built, fragments, missingShapes, buildErrors } = builtStatements(keyed, shapesOf)
  const audited: AuditedStatement[] = []
  const explainErrors: string[] = []
  for (const { key, shape, statement } of built) {
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
  return { audited, fragments, missingShapes, buildErrors, explainErrors }
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
    const { sites, keyed, unregisteredSites, unmapped } = keyedDefinitions(
      trackedSources(SOURCE),
      SOURCE,
    )
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
    const { keyed } = keyedDefinitions(trackedSources(SOURCE), SOURCE)
    const audited = [...auditDefinitions(keyed).audited, ...auditRawSql(rawSqlCensus(SOURCE))]
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
    const { keyed } = keyedDefinitions(trackedSources(SOURCE), SOURCE)
    const { audited } = auditDefinitions(keyed)
    const openChat = audited.filter(
      (entry) => entry.key === 'apps/server/src/store/messages.ts:openChat',
    )
    // The partial index leads with the workspace (POD-7024): the read seeks the workspace's
    // open chat rows instead of walking the whole index.
    expect(openChat.map((entry) => entry.plan)).toEqual([
      ['SEARCH messages USING INDEX idx_messages_open_chat (workspace_id=?)'],
    ])
  })

  it('reads the boot ref backfill candidates by index ranges on the ref-less partial indexes (POD-6222)', () => {
    const { keyed } = keyedDefinitions(trackedSources(SOURCE), SOURCE)
    const { audited } = auditDefinitions(keyed)
    const candidates = audited.filter(
      (entry) => entry.key === 'apps/server/src/store/sessions.ts:refBackfillCandidates',
    )
    expect(candidates.map((entry) => entry.plan)).toEqual([
      [
        'SEARCH sessions USING INTEGER PRIMARY KEY (rowid=?)',
        'LIST SUBQUERY 4',
        'COMPOUND QUERY',
        'LEFT-MOST SUBQUERY',
        'SCAN b VIRTUAL TABLE INDEX 1:',
        'SEARCH s USING INDEX idx_sessions_refless_place (workspace_id=? AND machine_id=? AND cwd>? AND cwd<?)',
        'UNION ALL',
        'SCAN o VIRTUAL TABLE INDEX 1:',
        'SEARCH s USING INDEX idx_sessions_refless_place (workspace_id=? AND machine_id=? AND cwd>?)',
        'UNION ALL',
        'SEARCH s USING INDEX idx_sessions_refless_issue (workspace_id=? AND issue_id>?)',
        // The probe reads one issue of the workspace, covered by the primary key again since it
        // leads with `workspace_id` (POD-7024).
        'SEARCH i EXISTS USING COVERING INDEX sqlite_autoindex_issues_1 (workspace_id=? AND id=?)',
        'USE TEMP B-TREE FOR ORDER BY',
      ],
    ])
  })

  it('reads the active ship orders through their partial index (POD-6172)', () => {
    const { keyed } = keyedDefinitions(trackedSources(SOURCE), SOURCE)
    const { audited } = auditDefinitions(keyed)
    const active = audited.filter(
      (entry) => entry.key === 'apps/server/src/store/shipping.ts:activeOrdersFifo',
    )
    expect(active.map((entry) => entry.plan)).toEqual([
      [
        'SEARCH ship_orders USING INDEX idx_ship_orders_one_active_issue (workspace_id=?)',
        'USE TEMP B-TREE FOR ORDER BY',
      ],
    ])
  })

  it('reads the open trains of shipped leaders through their partial index (POD-6207)', () => {
    const { keyed } = keyedDefinitions(trackedSources(SOURCE), SOURCE)
    const { audited } = auditDefinitions(keyed)
    const open = audited.filter(
      (entry) => entry.key === 'apps/server/src/store/shipping.ts:shippedLeadersOfOpenTrains',
    )
    expect(open.map((entry) => entry.plan)).toEqual([
      [
        'SEARCH ship_train_manifests USING INDEX idx_ship_train_manifests_open_lane (workspace_id=?)',
        'SEARCH ship_orders USING INDEX sqlite_autoindex_ship_orders_1 (workspace_id=? AND id=?)',
      ],
    ])
  })

  it('reads the subscriptions a steward poll can match, each arm on its own index (POD-6208)', () => {
    const { keyed } = keyedDefinitions(trackedSources(SOURCE), SOURCE)
    const { audited } = auditDefinitions(keyed)
    const searches = (name: string, shape: string | number) =>
      audited
        .filter(
          (entry) =>
            entry.key === `apps/server/src/store/events.ts:${name}` && entry.shape === shape,
        )
        .flatMap((entry) => entry.plan)
        .flatMap((line) => {
          const match = /^SEARCH (\S+) USING (?:COVERING )?INDEX (\S+)/.exec(line)
          return match ? [`${match[1]} ${match[2]}`] : []
        })
        .sort()
    // The explicit sources by event and source. The relationship ones were read by their
    // anchor subscriber; since every index leads with the workspace (POD-7024), SQLite's
    // default statistics, which a table this small keeps (111 rows on the reference database,
    // below the statistics floor), cost the event index as low as the subscriber index, and it
    // reads them by event and source kind: every relationship row of the polled kinds in the
    // workspace. Bounded by the subscriptions people set up; naming the subscriber index is a
    // follow-up reported to POD-6959, as POD-6599 did for effects.
    expect(searches('matchingSubscriptions', 'ra|4')).toEqual([
      'sessions idx_sessions_issue',
      'subscriptions idx_subscriptions_match',
      'subscriptions idx_subscriptions_match',
      'subscriptions idx_subscriptions_match',
    ])
    expect(searches('relationshipSubscriptionFor', 4)).toEqual([
      'subscriptions idx_subscriptions_match',
    ])
  })

  it('reads each history page through its index, with no scan and no sort (POD-6209)', () => {
    const { keyed } = keyedDefinitions(trackedSources(SOURCE), SOURCE)
    const { audited } = auditDefinitions(keyed)
    const plans = (key: string) =>
      audited
        .filter((entry) => entry.key === `apps/server/src/store/${key}`)
        .map((entry) => [String(entry.shape ?? ''), entry.plan] as const)
    expect(plans('workflows.ts:runsPage')).toEqual([
      ['', [expect.stringMatching(/^SEARCH workflow_runs USING INDEX workflow_runs_started \(/)]],
    ])
    const recent = plans('conversations/index.ts:recentConversations')
    expect(recent).toHaveLength(6)
    for (const [, plan] of recent) {
      expect(plan).toEqual([
        expect.stringMatching(
          /^SEARCH (conversations AS )?c USING INDEX idx_conversations_top_level_updated \(/,
        ),
      ])
    }
  })

  it('keeps no stale entry: every listed query still scans or sorts, every small table exists', () => {
    const { keyed } = keyedDefinitions(trackedSources(SOURCE), SOURCE)
    const audited = [...auditDefinitions(keyed).audited, ...auditRawSql(rawSqlCensus(SOURCE))]
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

  it('lists every raw SQL statement outside the repositories, and plans the ones on the server schema (POD-6227)', () => {
    const sites = rawSqlCensus(SOURCE)
    const planned = sites.filter((site) => RAW_SQL_PLANNED.has(rawKey(site)))
    console.log(
      `raw SQL census: ${sites.length} raw statements in ${new Set(sites.map((s) => s.file)).size} files, ` +
        `${planned.length} planned, ${sites.length - planned.length} exempt`,
    )
    // A census that read nothing would pass.
    expect(sites.length).toBeGreaterThan(10)
    const unlisted = sites.filter(
      (site) => !RAW_SQL_PLANNED.has(rawKey(site)) && rawExemption(site) === undefined,
    )
    for (const site of unlisted)
      console.log(`UNLISTED RAW SQL ${site.file}:${site.line} ${site.sql}`)
    expect(unlisted.map(rawKey)).toEqual([])
    // A planned statement is planned from its text.
    expect(planned.filter((site) => !site.literal).map(rawKey)).toEqual([])
    // No stale entry: every key names a site, every directory holds one.
    const keys = new Set(sites.map(rawKey))
    expect([...RAW_SQL_PLANNED.keys()].filter((key) => !keys.has(key))).toEqual([])
    expect(
      [...RAW_SQL_EXEMPT.keys()].filter((key) =>
        key.endsWith('/')
          ? !sites.some((site) => site.file.startsWith(key))
          : !keys.has(key) && !sites.some((site) => site.file === key),
      ),
    ).toEqual([])
    expect([...RAW_SQL_PLANNED.keys()].filter((key) => RAW_SQL_EXEMPT.has(key))).toEqual([])
    for (const reason of [...RAW_SQL_PLANNED.values(), ...RAW_SQL_EXEMPT.values()]) {
      expect(reason.trim().length).toBeGreaterThan(20)
    }
    // Every planned statement was planned.
    expect(
      auditRawSql(sites)
        .map((entry) => entry.key)
        .sort(),
    ).toEqual([...RAW_SQL_PLANNED.keys()].sort())
  })

  it('is armed: a planted raw statement is censused unlisted, and its scan is found', () => {
    const [site] = rawSqlSites(
      'apps/server/src/planted.ts',
      "export const read = (db: { prepare(sql: string): unknown }) => db.prepare('SELECT * FROM messages WHERE body = ?')",
    )
    expect(site).toMatchObject({ sql: 'SELECT * FROM messages WHERE body = ?', literal: true })
    expect(RAW_SQL_PLANNED.has(rawKey(site!)) || rawExemption(site!) !== undefined).toBe(false)
    const plan = explain(database, { sql: site!.sql, params: 1 })
    expect(
      planFindings(plan, site!.sql, tablesOf(database)).map((finding) => finding.kind),
    ).toEqual(['scan'])
    // A dynamic statement is censused by its expression, and a query call without SQL is not one.
    expect(
      rawSqlSites('apps/server/src/planted.ts', 'db.prepare(text); router.query(handler)'),
    ).toMatchObject([{ sql: 'text', literal: false }])
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

/**
 * STATISTICS OF A TABLE ANALYSED WHILE TINY [POD-6223]. The audit above plans
 * every query on a large database's picture. A real database is analysed at
 * whatever size its tables have, and a table analysed at a few rows keeps
 * those statistics until `PRAGMA optimize` finds it ten times larger: the
 * planner then reads it as tiny and scans it, however large it has grown.
 * `refreshPlannerStatistics` drops the statistics of every table analysed
 * below `PLANNER_STATISTICS_ROW_FLOOR`; from the floor up they stay.
 */
describe('POD-6223 — statistics of tables analysed while tiny', () => {
  /** Every index as ANALYZE describes it on a table of `rows` rows. */
  const analysedAt =
    (rows: number) =>
    (table: string, columns: readonly string[]): string =>
      // A low-selectivity column holds a quarter of the rows per value, any other leading
      // column ten (SQLite's own guess), the rest one; the workspace before them all.
      prefixStatistics(rows, table, columns, (all, low) =>
        low ? Math.max(1, all / 4) : Math.min(all, 10),
      )

  const unexplained = (): string[] => {
    const { keyed } = keyedDefinitions(trackedSources(SOURCE), SOURCE)
    const { audited } = auditDefinitions(keyed)
    return audited
      .filter((entry) => entry.findings.length > 0 && explanation(entry) === undefined)
      .map((entry) => `${entry.key} [${String(entry.shape ?? '')}]`)
  }

  afterEach(() => modelLowSelectivity(database))

  it('is armed: statistics from one-row tables steer the queries of growing tables into scans', () => {
    writeStatistics(database, analysedAt(1))
    const flagged = unexplained()
    // The tables that start empty and grow.
    expect(flagged).toEqual(
      expect.arrayContaining([
        // (The runtime-event drain the bench caught scanning, POD-6216, is no longer among
        // them: its key leads with the workspace, and one-row statistics keep it on the key.)
        'apps/server/src/store/messages.ts:queuedAheadOf []',
        'apps/server/src/store/sessions.ts:liveSessionsOnMachine []',
        'apps/server/src/store/issues.ts:issuesByIds [4]',
        'packages/sync/src/adapters/sqlite/sync-repository.ts:changesWithPrior [1]',
      ]),
    )
    expect(flagged.length).toBeGreaterThan(100)
  })

  it('a refresh drops them, so the planner plans every query on its large-table defaults', async () => {
    writeStatistics(database, analysedAt(1))
    await store.refreshPlannerStatistics('periodic')
    expect(database.prepare('SELECT COUNT(*) AS n FROM sqlite_stat1').get()).toEqual({ n: 0 })
    // Below the floor a seek on a low-selectivity column reads fewer rows than
    // the floor, so the large database's picture of those columns stands.
    modelLowSelectivity(database, { replace: false })
    expect(unexplained()).toEqual([])
  })

  it('statistics of tables analysed at the floor plan no query worse than those of a large table', () => {
    // What real statistics of a large database make of each query, whatever
    // the floor: the floor answers only for what the size itself changes.
    writeStatistics(database, analysedAt(1_000_000))
    const large = new Set(unexplained())
    const worse = (rows: number) => {
      writeStatistics(database, analysedAt(rows))
      return unexplained().filter((key) => !large.has(key))
    }
    expect(worse(PLANNER_STATISTICS_ROW_FLOOR)).toEqual([])
    // Armed: well below the floor, the same statistics do steer queries into scans.
    expect(worse(10).length).toBeGreaterThan(0)
  })

  it('statistics of a large table plan every query as well as the defaults do', () => {
    // POD-6224: they planned a session's runtime replay through the ts index
    // and sorted all its runtime events by id; the defaults took an index in
    // id order.
    writeStatistics(database, analysedAt(1_000_000))
    expect(unexplained()).toEqual([])
    writeStatistics(database, analysedAt(PLANNER_STATISTICS_ROW_FLOOR))
    expect(unexplained()).toEqual([])
  })

  it("reads a session's newest runtime events in id order from an index, sorting none of them", () => {
    // The transcript read is listed for its OUTER sort, which puts the newest
    // `limit` rows back oldest first; that listing must not hide a sort of the
    // session's whole history before the limit.
    const runtimePlans = () => {
      const { keyed } = keyedDefinitions(trackedSources(SOURCE), SOURCE)
      const plans = new Map(
        auditDefinitions(keyed)
          .audited.filter((entry) =>
            /events\.ts:(recentRuntimeEventPayloads|runtimeTranscriptPayloads)$/.test(entry.key),
          )
          .map((entry) => [entry.key.split(':')[1], entry.plan.join(' | ')]),
      )
      expect([...plans.keys()].sort()).toEqual([
        'recentRuntimeEventPayloads',
        'runtimeTranscriptPayloads',
      ])
      return plans
    }
    const pictures: [string, () => void][] = [
      ['defaults', () => modelLowSelectivity(database)],
      ['large', () => writeStatistics(database, analysedAt(1_000_000))],
      ['floor', () => writeStatistics(database, analysedAt(PLANNER_STATISTICS_ROW_FLOOR))],
    ]
    for (const [picture, apply] of pictures) {
      apply()
      const plans = runtimePlans()
      expect(`${picture}: ${plans.get('recentRuntimeEventPayloads')}`).not.toMatch(
        /TEMP B-TREE|SCAN/,
      )
      const [inner, outer] = plans.get('runtimeTranscriptPayloads')!.split('SCAN recent')
      expect(`${picture}: ${inner}`).not.toMatch(/TEMP B-TREE|SCAN/)
      expect(`${picture}: ${outer}`).toMatch(/TEMP B-TREE FOR ORDER BY/)
    }
  })
})

/**
 * A captured statistics row of an index that now leads with `workspace_id` (POD-7118):
 * the operator's database is one workspace, so the workspace prefix holds every row,
 * and the captured numbers describe the columns after it. A row captured with the
 * workspace already in the index (the sync tables) is used as it is.
 */
function workspaceLedStat(db: SqlDatabase, index: string, stat: string): string {
  const columns = db.prepare(`PRAGMA index_info(${JSON.stringify(index)})`).all() as {
    name: string
  }[]
  const parts = stat.split(' ')
  if (columns[0]?.name !== 'workspace_id' || parts.length !== columns.length) return stat
  return [parts[0], parts[0], ...parts.slice(1)].join(' ')
}

/** A plan's seek terms with the workspace's own term set aside (it holds every row). */
const WORKSPACE_TERM = 'workspace_id=? AND '

/**
 * THE EFFECTS SWEEP UNDER THE OPERATOR'S STATISTICS [POD-6970]. ANALYZE counts
 * each NULL as its own value, so on a real database `idx_effects_deleted`
 * reads as ten rows per key and `deleted_at IS NULL` looks selective, though
 * nearly every record is live. These are the `effects` rows of `sqlite_stat1`
 * on the operator's server (46k records, 41k of them live finished machine
 * scans), where the sweep's unpinned reads walked every live record and sorted
 * them, twice a minute, to return none. Each sweep statement must seek its own
 * index under them, with no scan and no sort.
 */
describe('POD-6970 — the effects sweep under real statistics', () => {
  const OPERATOR_EFFECTS_STATISTICS: readonly (readonly [string, string])[] = [
    ['idx_effects_unpublished', '0 0'],
    ['idx_effects_awaiting', '0 0 0'],
    ['idx_effects_kind_target', '46241 334 251 6 1'],
    ['idx_effects_target', '46241 1001 11 1'],
    // Captured as `idx_effects_deleted` `46241 10`, a full index; POD-7034 made
    // it partial over the tombstones (9236 of them, 2169 distinct times).
    ['idx_effects_tombstones', '9236 5'],
    ['idx_effects_status_finished', '46241 334 1'],
    ['idx_effects_status_deadline', '46241 334 1'],
    ['sqlite_autoindex_effects_1', '46241 1'],
  ]

  const useOperatorStatistics = () => {
    modelLowSelectivity(database)
    database.exec("DELETE FROM sqlite_stat1 WHERE tbl = 'effects'")
    const insert = database.prepare(
      "INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES ('effects', ?, ?)",
    )
    for (const [index, stat] of OPERATOR_EFFECTS_STATISTICS)
      insert.run(index, workspaceLedStat(database, index, stat))
    database.exec('ANALYZE sqlite_schema')
  }

  const effectPlans = (): Map<string, string> => {
    const { keyed } = keyedDefinitions(trackedSources(SOURCE), SOURCE)
    return new Map(
      auditDefinitions(keyed)
        .audited.filter((entry) => entry.key.startsWith('apps/server/src/store/effects.ts:'))
        .map((entry) => [
          `${entry.key.split(':')[1]}${entry.shape === undefined ? '' : ` [${String(entry.shape)}]`}`,
          entry.plan.join(' | '),
        ]),
    )
  }

  afterEach(() => modelLowSelectivity(database))

  it('the unpinned status read can no longer walk the live records: the soft-delete index holds only tombstones (POD-7034)', () => {
    // Before POD-7034 this read walked every live record through the full
    // `idx_effects_deleted` and sorted them; the walk is armed in the POD-7034
    // block below with a planted full index.
    useOperatorStatistics()
    const plan = (
      database
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM effects WHERE workspace_id = ? AND status = ? AND deleted_at IS NULL AND (decision IS NULL OR decision <> 'awaiting') ORDER BY deadline_at LIMIT ?",
        )
        .all(null, null, null) as { detail: string }[]
    )
      .map((row) => row.detail)
      .join(' | ')
    expect(plan).not.toMatch(/deleted_at=\?\)/)
    expect(plan).toMatch(
      /^SEARCH effects USING INDEX idx_effects_status_deadline \(workspace_id=\? AND status=\?\)/,
    )
  })

  it('each sweep statement seeks its own index, with no scan and no sort', () => {
    useOperatorStatistics()
    const plans = effectPlans()
    const expected: readonly (readonly [string, RegExp])[] = [
      // Both statuses build one statement (the status is bound): the audit
      // plans it once, under its first shape.
      [
        'effectsInStatus [pending]',
        /^SEARCH effects USING INDEX idx_effects_status_deadline \(workspace_id=\? AND status=\?\)$/,
      ],
      [
        'expireDueEffects',
        /SEARCH effects USING INDEX idx_effects_status_deadline \(workspace_id=\? AND status=\? AND deadline_at>\? AND deadline_at<\?\)/,
      ],
      [
        'pruneFinishedEffects',
        /SEARCH effects USING INDEX idx_effects_status_finished \(workspace_id=\? AND status=\? AND finished_at<\?\)/,
      ],
      [
        'purgeTombstones',
        /SEARCH effects USING INDEX idx_effects_tombstones \(workspace_id=\? AND deleted_at<\?\)/,
      ],
      [
        'purgeOffFeedFinished',
        /SEARCH candidate USING INDEX idx_effects_kind_target \(workspace_id=\? AND kind=\?\).*SEARCH newer USING INDEX idx_effects_kind_target \(workspace_id=\? AND kind=\? AND target_kind=\? AND target_id=\? AND created_at>\?\)/,
      ],
      // A machine's last scan (POD-7031): the target's records newest first,
      // where the first hit is nearly always the newest succeeded one.
      [
        'newestOnTargetIn [succeeded]',
        /^SEARCH effects USING INDEX idx_effects_kind_target \(workspace_id=\? AND kind=\? AND target_kind=\? AND target_id=\?\)$/,
      ],
    ]
    for (const [name, pattern] of expected) {
      const plan = plans.get(name)
      expect(plan, name).toBeDefined()
      expect(plan, name).toMatch(pattern)
      expect(`${name}: ${plan}`).not.toMatch(/SCAN (effects|candidate|newer)\b|TEMP B-TREE/)
    }
  })

  it("the active lookup seeks the active statuses, not the target's history, and sorts only those", () => {
    useOperatorStatistics()
    const plan = effectPlans().get('newestOnTargetIn [active]')
    expect(plan).toBe(
      'SEARCH effects USING INDEX idx_effects_status_deadline (workspace_id=? AND status=?) | USE TEMP B-TREE FOR ORDER BY',
    )
    // Armed: unpinned, the statistics send it through the target's history.
    const unpinned = (
      database
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM effects WHERE workspace_id = ? AND kind = ? AND target_kind = ? AND target_id = ? AND status IN ('pending', 'running') AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
        )
        .all(null, null, null, null) as { detail: string }[]
    )
      .map((row) => row.detail)
      .join(' | ')
    expect(unpinned).toBe(
      'SEARCH effects USING INDEX idx_effects_kind_target (workspace_id=? AND kind=? AND target_kind=? AND target_id=?)',
    )
  })

  /**
   * THE ROWS THE ACTIVE LOOKUP READS [POD-7031]. A machine kept 24k finished
   * scans, and the scan the connect path asks about ran through all of them,
   * each fetched with its result, to find none: 3–16 s a minute on the
   * operator's server. bun:sqlite exposes no statement counters, so the rows a
   * SEARCH reads are counted as the entries in the index range its plan seeks:
   * the plan's index, constrained by its seek columns.
   */
  it('reads only the active records, however long the target history', async () => {
    const seeded = await openTestStore(':memory:')
    try {
      const db = (seeded as unknown as { db: SqlDatabase }).db
      const insert = db.prepare(
        `INSERT INTO effects (workspace_id, id, kind, target_kind, target_id, input_json, result_json, status,
           finished_at, created_at, updated_at, revision)
         VALUES ('${SELF_HOSTED_WORKSPACE_ID}', ?, 'machine.scan', 'machine', ?, '{}', ?, ?, ?, ?, ?, 1)`,
      )
      const result = JSON.stringify({ repos: 'x'.repeat(5_000) })
      const HISTORY = 2_000
      db.exec('BEGIN')
      for (let at = 0; at < HISTORY; at++) {
        insert.run(`eff_old_${at}`, 'mch_busy', result, 'succeeded', at, at, at)
      }
      // Another machine's scan is running: the range holds it, the filter drops it.
      insert.run('eff_elsewhere', 'mch_other', null, 'running', null, HISTORY, HISTORY)
      db.exec('COMMIT')

      const machine = { kind: 'machine', id: 'mch_busy' } as const
      expect(await seeded.effects.newestOnTarget('machine.scan', machine, 'active')).toBeUndefined()
      expect((await seeded.effects.newestOnTarget('machine.scan', machine, 'succeeded'))?.id).toBe(
        `eff_old_${HISTORY - 1}`,
      )

      useOperatorStatistics()
      const plan = effectPlans().get('newestOnTargetIn [active]') ?? ''
      const seekIndex = /USING INDEX (\S+) \(workspace_id=\? AND status=\?\)/.exec(plan)?.[1] ?? ''
      expect(seekIndex, plan).toBe('idx_effects_status_deadline')
      const rangeRows = (from: string, where: string): number =>
        (
          db
            .prepare(
              `SELECT count(*) AS n FROM effects INDEXED BY ${from} WHERE workspace_id = '${SELF_HOSTED_WORKSPACE_ID}' AND ${where}`,
            )
            .get() as {
            n: number
          }
        ).n
      const active = "status IN ('pending', 'running')"
      expect(rangeRows(seekIndex, active)).toBe(1)
      // Armed: the target seek the planner chose before reads the whole history.
      expect(
        rangeRows(
          'idx_effects_kind_target',
          "kind = 'machine.scan' AND target_kind = 'machine' AND target_id = 'mch_busy'",
        ),
      ).toBe(HISTORY)

      // Two active scans on the machine: the newer one, among only the active records.
      insert.run('eff_pending', 'mch_busy', null, 'pending', null, HISTORY + 1, HISTORY + 1)
      insert.run('eff_running', 'mch_busy', null, 'running', null, HISTORY + 2, HISTORY + 2)
      expect((await seeded.effects.newestOnTarget('machine.scan', machine, 'active'))?.id).toBe(
        'eff_running',
      )
      expect(rangeRows(seekIndex, active)).toBe(3)
    } finally {
      await seeded.close()
    }
  })

  it('no effects statement walks the live records through a soft-delete index', () => {
    useOperatorStatistics()
    const walks = [...effectPlans()]
      .filter(([, plan]) => /\((?:workspace_id=\? AND )?deleted_at=\?\)|SCAN effects\b/.test(plan))
      .map(([name, plan]) => `${name}: ${plan}`)
    expect(walks).toEqual([])
  })
})

/**
 * EVERY STATEMENT UNDER THE OPERATOR'S STATISTICS, EVERY IN LIST AT EVERY SIZE
 * IT CAN TAKE [POD-7034; POD-7027 findings 2 and 3, guard 1]. The audit above
 * plans on a model of a large database; SQLite plans on `sqlite_stat1`, and the
 * operator's says something no model did. ANALYZE counts each NULL as its own
 * value, so `idx_sessions_deleted_at` read as four sessions per key and
 * `deleted_at IS NULL` as a selective seek: 36 statements walked every live
 * session or issue through a soft-delete or parent index, and an IN list
 * multiplies its per-key estimate by its length, so at 16 ids or more the
 * by-id families flipped to that walk too. Planning only sizes 1 and 4 never
 * saw it.
 *
 * So every statement is planned again under a stored copy of the operator's
 * statistics (`OPERATOR_PLANNER_STATISTICS`, refreshed at each release), each
 * IN-list family at every padded size up to the largest its callers pass, and
 * the audit fails on:
 * - a seek that reads an `IS NULL` filter's rows through an index that holds
 *   the NULLs (every column the seek constrains is filtered `IS NULL` and
 *   compared to no value), under either picture; no list explains one;
 * - a scan of a growing table, or a sort over one, that the lists above do not
 *   explain.
 */
describe('POD-7034 — every statement under the operator statistics', () => {
  /**
   * The largest padded size an IN-list family's callers can pass, where it is
   * not {@link CHUNK_SIZE}'s: a smaller fixed domain, or a larger chunk.
   */
  const LARGEST_IN_LIST: ReadonlyMap<string, number> = new Map<string, number>([
    // Two arms of candidate keys, chunked at WORKTREE_OWNER_CHUNK (2048).
    ['apps/server/src/store/issues.ts:worktreeOwnersOf', 2048],
    // The four persisted session statuses.
    ['apps/server/src/store/sessions.ts:liveSessionsOfStatuses', 4],
    // The shipping destinations: at most three.
    ['apps/server/src/store/shipping.ts:queuedOrdersOfLane', 4],
    ['apps/server/src/store/shipping.ts:activeOrdersOfLane', 4],
    // The mail records route takes at most MAIL_RECORDS_MAX_IDS (100) items.
    ['apps/server/src/store/messages.ts:attachmentMessagesOfItems', 128],
    // PENDING_PAGES_MAX_TARGETS (256) targets a page.
    ['apps/server/src/store/messages.ts:pendingPages', 256],
    ['apps/server/src/store/messages.ts:pendingTargetsAmong', 256],
    // The change log's insert chunk (100 rows).
    ['packages/sync/src/adapters/sqlite/sync-repository.ts:insertChangeRows', 128],
  ])
  /**
   * The padded size of the 500-value chunk every batching caller cuts its list
   * into. A family whose callers pass an unchunked list is planned up to it too:
   * past the table's size a scan is the right plan, so no larger size tells
   * the audit anything.
   */
  const CHUNK_SIZE = 512

  const paddedSizes = (largest: number): number[] => {
    const sizes = [1]
    for (let size = 2; size < largest; size *= 2) sizes.push(size)
    if (largest > 1) sizes.push(largest)
    return sizes
  }

  /** Families whose key names an IN-list size beside other parts, at every padded size. */
  const SIZED_KEY_SHAPES: ReadonlyMap<string, readonly (string | number)[]> = new Map<
    string,
    readonly (string | number)[]
  >([
    [
      'apps/server/src/store/messages.ts:openBoundTo',
      paddedSizes(CHUNK_SIZE).flatMap((size) => [`${size}`, `${size}|issue`]),
    ],
    [
      // CHAT_TAIL_MAX_SESSIONS (256) sessions a chunk.
      'apps/server/src/store/messages.ts:confirmedChatTail',
      paddedSizes(256).flatMap((size) => [`live|${size}`, `any|${size}`]),
    ],
    [
      'apps/server/src/store/events.ts:matchingSubscriptions',
      paddedSizes(CHUNK_SIZE).flatMap((size) => ['r', 'a', 'ra'].map((arms) => `${arms}|${size}`)),
    ],
    [
      'packages/sync/src/adapters/sqlite/sync-repository.ts:serverTableQueries.queuedCounts',
      ['all', 'one', ...paddedSizes(CHUNK_SIZE)],
    ],
  ])

  /** A family's shapes for this picture: an IN-list family at every padded size. */
  const operatorShapes = (key: string): readonly (string | number)[] | undefined => {
    const shapes = FAMILY_SHAPES.get(key)
    if (shapes === SIZES) return paddedSizes(LARGEST_IN_LIST.get(key) ?? CHUNK_SIZE)
    return SIZED_KEY_SHAPES.get(key) ?? shapes
  }

  /** Replace the statistics with the operator's, each row whose table and index exist. */
  const useOperatorStatistics = (): { applied: number; completed: number; skipped: string[] } => {
    database.exec('ANALYZE')
    database.exec('DELETE FROM sqlite_stat1')
    const names = new Set(
      (
        database
          .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')")
          .all() as { name: string }[]
      ).map((row) => row.name),
    )
    const insert = database.prepare('INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, ?, ?)')
    let applied = 0
    const skipped: string[] = []
    for (const [table, index, stat] of OPERATOR_PLANNER_STATISTICS) {
      if (!names.has(table) || (index !== null && !names.has(index))) {
        skipped.push(`${table}.${index}`)
        continue
      }
      insert.run(table, index, index === null ? stat : workspaceLedStat(database, index, stat))
      applied++
    }
    // An index the capture predates (dev/mw's of 2026-11-17) has no row; with its
    // key led by the workspace, SQLite's guess would price that one-workspace prefix
    // as ten rows. On the operator's database it holds the whole table: the table's
    // captured row count, then SQLite's own guesses for the columns after it.
    const described = new Set(
      OPERATOR_PLANNER_STATISTICS.flatMap(([, index]) => (index === null ? [] : [index])),
    )
    const tableRows = new Map<string, number>()
    for (const [table, , stat] of OPERATOR_PLANNER_STATISTICS) {
      tableRows.set(table, Math.max(tableRows.get(table) ?? 0, Number(stat.split(' ')[0])))
    }
    writeStatistics(
      database,
      (table, columns, unique) => {
        const rows = tableRows.get(table)
        if (rows === undefined || columns[0] !== 'workspace_id') return undefined
        const after = columns
          .slice(1)
          .map((_, at, rest) =>
            unique && at === rest.length - 1 ? 1 : Math.min(rows, SQLITE_DEFAULT_ROWS[at] ?? 5),
          )
        return [rows, rows, ...after].join(' ')
      },
      { replace: false, only: (index) => !described.has(index) },
    )
    database.exec('ANALYZE sqlite_schema')
    const completed =
      (database.prepare('SELECT COUNT(*) AS n FROM sqlite_stat1').get() as { n: number }).n -
      applied
    return { applied, completed, skipped }
  }

  /** A column reference in the SQL drizzle writes: optionally quoted, optionally qualified. */
  const columnRef = (column: string): string =>
    `(?:["\`]?\\w+["\`]?\\.)?["\`]?${column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["\`]?`

  /** The statement filters `column IS NULL` and compares it to no value. */
  const filteredNullOnly = (sqlText: string, column: string): boolean =>
    new RegExp(`${columnRef(column)}\\s+is\\s+null\\b`, 'i').test(sqlText) &&
    !new RegExp(`${columnRef(column)}\\s*(?:=|<|>|!=|\\bin\\b|\\bis\\s+\\?)`, 'i').test(sqlText)

  /**
   * The columns whose `IS NULL` selects a large share of the table, as
   * `table.column`: every soft-delete `deleted_at` (nearly every row is live)
   * and an issue's parent (a quarter of the operator's issues are top-level).
   */
  const mostlyNull = (): Set<string> => {
    const out = new Set(['issues.parent_id'])
    for (const table of tablesOf(database)) {
      const columns = database.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as {
        name: string
      }[]
      if (columns.some((column) => column.name === 'deleted_at')) out.add(`${table}.deleted_at`)
    }
    return out
  }

  let schemaTables: Set<string> | undefined

  /**
   * The seeks of a plan that read an `IS NULL` filter's rows through a
   * soft-delete or parent index that holds the NULLs: SQLite prints `IS NULL`
   * as `column=?`, so a seek all of whose terms are such equalities, on
   * mostly-NULL columns the statement only filters `IS NULL`, walks every row
   * the filter keeps.
   */
  const nullWalks = (
    plan: readonly string[],
    sqlText: string,
    columns: ReadonlySet<string> = mostlyNull(),
  ): string[] => {
    const tables = (schemaTables ??= tablesOf(database))
    return plan.filter((detail) => {
      const search = /^SEARCH (\S+)(?: AS \S+)? USING (?:COVERING )?INDEX \S+ \(([^)]*)\)/.exec(
        detail,
      )
      if (!search) return false
      const table = tables.has(search[1]!)
        ? search[1]!
        : planFindings([`SCAN ${search[1]!}`], sqlText, tables)[0]?.table
      const terms = search[2]!
        .replace(WORKSPACE_TERM, '')
        .split(' AND ')
        .map((term) => /^(\w+)=\?$/.exec(term.trim())?.[1])
      return terms.every(
        (column) =>
          column !== undefined &&
          columns.has(`${table}.${column}`) &&
          filteredNullOnly(sqlText, column),
      )
    })
  }

  /**
   * Every statement planned in both pictures, once for the tests below: the
   * modelled one at the audit's shapes, the operator's at every IN-list size.
   */
  let pictures: { modelled: AuditedStatement[]; operator: AuditedStatement[] } | undefined
  const bothPictures = (): { modelled: AuditedStatement[]; operator: AuditedStatement[] } => {
    if (pictures !== undefined) return pictures
    const { keyed } = keyedDefinitions(trackedSources(SOURCE), SOURCE)
    modelLowSelectivity(database)
    const modelled = [...auditDefinitions(keyed).audited, ...auditRawSql(rawSqlCensus(SOURCE))]
    useOperatorStatistics()
    const operator = [
      ...auditDefinitions(keyed, operatorShapes).audited,
      ...auditRawSql(rawSqlCensus(SOURCE)),
    ]
    modelLowSelectivity(database)
    pictures = { modelled, operator }
    return pictures
  }
  /** Planning ~1,900 statements takes seconds on a loaded host. */
  const PICTURES_TIMEOUT_MS = 180_000

  const named = (entry: AuditedStatement): string => `${entry.key} [${String(entry.shape ?? '')}]`

  afterEach(() => modelLowSelectivity(database))

  it('applies the operator statistics to the schema', () => {
    const { applied, completed, skipped } = useOperatorStatistics()
    console.log(
      `operator statistics (${OPERATOR_STATISTICS_CAPTURED_AT}): ${applied} rows applied, ` +
        `${completed} completed for indexes the capture predates, ` +
        `${skipped.length} name an index the schema no longer has: ${skipped.join(', ')}`,
    )
    // A fixture that applies nothing plans on the defaults and passes.
    expect(applied).toBeGreaterThan(100)
    // Only the indexes dev/mw added after the capture are completed (POD-7118).
    expect(completed).toBeLessThan(15)
  })

  it(
    'reads no IS NULL filter through an index that holds the NULLs, under either picture',
    () => {
      const columns = mostlyNull()
      // A census that found no soft-delete column would find no walk.
      expect([...columns]).toEqual(
        expect.arrayContaining(['sessions.deleted_at', 'issues.deleted_at', 'effects.deleted_at']),
      )
      const walksOf = (audited: readonly AuditedStatement[]) =>
        audited.flatMap((entry) =>
          nullWalks(entry.plan, entry.statement.sql, columns).map(
            (detail) => `${named(entry)}: ${detail}`,
          ),
        )
      const { modelled, operator } = bothPictures()
      const modelledWalks = walksOf(modelled)
      const operatorWalks = walksOf(operator)
      for (const walk of modelledWalks) console.log(`NULL WALK (modelled) ${walk}`)
      for (const walk of operatorWalks) console.log(`NULL WALK (operator statistics) ${walk}`)
      expect(modelledWalks).toEqual([])
      expect(operatorWalks).toEqual([])
    },
    PICTURES_TIMEOUT_MS,
  )

  /** A finding as the lists decide it: a scan by the table it reads, any sort as one. */
  const findingClass = (finding: PlanFinding): string =>
    finding.kind === 'scan' ? `scan ${finding.table}` : 'sort'

  /**
   * Plans read under the operator statistics that no list above was written
   * for, keyed `file:name [shape]` or `file:name`, with the reason. An entry on
   * those lists explains only the findings its statement has in the modelled
   * picture: a list entry written about a sort of a few rows does not accept a
   * scan the same statement takes at 512 ids.
   */
  const OPERATOR_PLANS: ReadonlyMap<string, string> = new Map<string, string>([
    [
      'apps/server/src/store/sessions.ts:readAtOfUser',
      "One person's read times of every session: on a server with one member every row is theirs, so the scan reads the rows the seek on the (user_id, session_id) key would; with more members the statistics give fewer rows a person and it seeks.",
    ],
    [
      'apps/server/src/store/issue-panel.ts:statePage [start]',
      "The first keyset page of the issue state panels walks their primary key in order and stops at the page size, probing each row's issue; the other panel pages walk the same way (a whole-table read, listed above).",
    ],
    [
      'apps/server/src/store/issue-panel.ts:artifactPage [start]',
      "POD-7118: with both keys led by the workspace, the first artifact page joins from the workspace's live issues (the covering projection index) and sorts the artifacts it finds, rather than walking the artifacts' key to the page size; it reads at most every live issue once, and the pages after it seek below their position.",
    ],
    [
      'apps/server/src/store/sessions.ts:liveSessionsOfIssueIds [512]',
      "POD-7118: at 512 issues the statistics' seven sessions an issue come to half the operator's sessions, so the planner reads the workspace's sessions in key order once instead of seeking 512 times; smaller lists seek idx_sessions_issue.",
    ],
    [
      'apps/server/src/store/sessions.ts:refBackfillCandidates',
      "The boot ref backfill's third arm walks the partial index idx_sessions_refless_issue, which holds only the ref-less sessions with an issue (none on the operator's server), and sorts the few candidates it finds (POD-6222).",
    ],
  ])

  /** The finding classes of each statement key in the modelled picture. */
  const modelledFindings = (): Map<string, Set<string>> => {
    const out = new Map<string, Set<string>>()
    for (const entry of bothPictures().modelled) {
      const classes = out.get(entry.key) ?? new Set<string>()
      for (const finding of entry.findings) classes.add(findingClass(finding))
      out.set(entry.key, classes)
    }
    return out
  }

  /** Each table the operator's statistics describe, by its row count there. */
  const operatorRows = (): Map<string, number> => {
    const rows = new Map<string, number>()
    for (const [table, , stat] of OPERATOR_PLANNER_STATISTICS) {
      rows.set(table, Math.max(rows.get(table) ?? 0, Number(stat.split(' ')[0])))
    }
    return rows
  }

  /** The IN-list size a shape names: its largest number, if any. */
  const listSize = (shape: string | number | undefined): number | undefined => {
    if (typeof shape === 'number') return shape
    const sizes = (shape ?? '').match(/\d+/g)?.map(Number) ?? []
    return sizes.length > 0 ? Math.max(...sizes) : undefined
  }

  /**
   * Why a plan under the operator statistics is accepted, or undefined.
   *
   * - A table their statistics do not describe is below the analysis floor on
   *   the operator's server (`PLANNER_STATISTICS_ROW_FLOOR`): the planner sizes
   *   it as it is, here a few planted rows, so its scans are judged by the
   *   modelled picture alone.
   * - A list entry explains only the findings its statement has in the
   *   modelled picture.
   * - A scan at an IN-list size of at least a quarter of the table's rows reads
   *   at most four rows for each asked: the planner's choice while the table is
   *   that small, and it seeks again as the table grows. A per-key estimate
   *   that only looks large (a few common values, or NULLs counted as values)
   *   is not this: its list is a small share of the table, and the statement
   *   names its index.
   */
  const operatorExplanation = (
    entry: AuditedStatement,
    modelled: ReadonlyMap<string, ReadonlySet<string>>,
    rows: ReadonlyMap<string, number>,
  ): string | undefined => {
    const own = OPERATOR_PLANS.get(named(entry)) ?? OPERATOR_PLANS.get(entry.key)
    if (own !== undefined) return own
    const reason = explanation(entry)
    const known = modelled.get(entry.key) ?? new Set<string>()
    const size = listSize(entry.shape)
    const accepted = (finding: PlanFinding): boolean => {
      if (finding.kind === 'scan' && !rows.has(finding.table!)) return true
      if (reason === 'small tables only') return true
      if (reason !== undefined && known.has(findingClass(finding))) return true
      return finding.kind === 'scan' && size !== undefined && size * 4 >= rows.get(finding.table!)!
    }
    return entry.findings.every(accepted) ? (reason ?? 'a list a quarter of the table') : undefined
  }

  it(
    'finds no unexplained scan or sort under them, at every IN-list size',
    () => {
      const modelled = modelledFindings()
      const rows = operatorRows()
      const audited = bothPictures().operator
      const flagged = audited.filter((entry) => entry.findings.length > 0)
      const unexplained = flagged.filter(
        (entry) => operatorExplanation(entry, modelled, rows) === undefined,
      )
      console.log(
        `query-plan audit under the operator statistics: ${audited.length} statements, ` +
          `${flagged.length} scan or sort, ${unexplained.length} unexplained`,
      )
      for (const entry of unexplained) {
        console.log(`UNEXPLAINED (operator) ${describeEntry(entry)}`)
      }
      expect(unexplained.map(named)).toEqual([])
      // No stale entry: each names a statement that scans or sorts under them.
      const flaggedNames = new Set(flagged.flatMap((entry) => [entry.key, named(entry)]))
      expect([...OPERATOR_PLANS.keys()].filter((key) => !flaggedNames.has(key))).toEqual([])
      for (const reason of OPERATOR_PLANS.values()) {
        expect(reason.trim().length).toBeGreaterThan(20)
      }
    },
    PICTURES_TIMEOUT_MS,
  )

  it('is armed: an IN list flips to an IS NULL walk at 16 ids through an index that holds the NULLs', () => {
    // `idx_sessions_deleted_by_issue` is still a full index over a mostly-NULL
    // column (6941 rows, 17 a key): what the soft-delete indexes were. No
    // statement filters it IS NULL; this one does, to show the flip.
    useOperatorStatistics()
    const planted = (size: number) =>
      `SELECT * FROM sessions WHERE workspace_id = ? AND spawned_by IN (${Array.from({ length: size }, () => '?').join(', ')}) AND deleted_by_issue_id IS NULL`
    const columns = new Set(['sessions.deleted_by_issue_id'])
    const walks = (size: number) =>
      nullWalks(explain(database, { sql: planted(size), params: size + 1 }), planted(size), columns)
    expect(walks(1)).toEqual([])
    expect(walks(16)).toEqual([
      'SEARCH sessions USING INDEX idx_sessions_deleted_by_issue (workspace_id=? AND deleted_by_issue_id=?)',
    ])
    // An equality on a value is a seek, not a walk; a range is never one.
    expect(
      nullWalks(
        ['SEARCH sessions USING INDEX idx_sessions_spawned_by (spawned_by=?)'],
        'SELECT * FROM sessions WHERE spawned_by IN (?) AND deleted_at IS NULL',
      ),
    ).toEqual([])
    expect(
      nullWalks(
        ['SEARCH sessions USING INDEX idx_sessions_tombstones (deleted_at<?)'],
        'SELECT id FROM sessions WHERE deleted_at < ?',
      ),
    ).toEqual([])
    // A column the statement also compares to a value is a seek on that value.
    expect(
      nullWalks(
        ['SEARCH issues USING INDEX idx_issues_children (parent_id=?)'],
        'SELECT * FROM issues WHERE parent_id = ? AND deleted_at IS NULL',
      ),
    ).toEqual([])
  })

  it('plans each IN-list family at every padded size up to its largest', () => {
    expect(paddedSizes(512)).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 512])
    expect(paddedSizes(8)).toEqual([1, 2, 4, 8])
    for (const key of LARGEST_IN_LIST.keys()) expect(FAMILY_SHAPES.get(key), key).toBe(SIZES)
    // A sized key extends a family's audited shapes, so it covers them.
    for (const [key, shapes] of SIZED_KEY_SHAPES) {
      expect(shapes, key).toEqual(expect.arrayContaining([...(FAMILY_SHAPES.get(key) ?? [''])]))
    }
  })
})
