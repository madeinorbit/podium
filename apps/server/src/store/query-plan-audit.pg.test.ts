/**
 * EVERY POSTGRES QUERY IS SERVED BY AN INDEX [POD-6992, POD-6958 design 2.11].
 *
 * The Postgres counterpart of `query-plan-audit.test.ts`. For every query a repository
 * defines, built in its Postgres form (on the generated twin tables, as the dialect census
 * builds it), this asks Postgres how it would run it and fails on a plan that reads a whole
 * table that grows with work, or sorts or hashes rows the plan could have read in order,
 * unless the query is on one of the lists below with a written reason. The lists have the
 * SQLite audit's shape: tables that stay small, accepted scans and sorts, whole-table reads
 * on purpose, and query-shape debt.
 *
 * THE PLAN IS THE GENERIC ONE. The Postgres driver prepares every statement, and after a few
 * executions Postgres runs a prepared statement on its generic plan: the one made without
 * the parameter values. `EXPLAIN (GENERIC_PLAN, FORMAT JSON)` (Postgres 16 and later) shows
 * exactly that plan, so the audit needs no values for the `$n` placeholders.
 *
 * THE STATISTICS ARE SEEDED. An empty database plans like a tiny one: a sequential scan of
 * an empty table is the cheapest plan there is. So the audit's database is a clone of the
 * run's template with every table filled ({@link seedRows}): {@link LARGE_ROWS} rows in a
 * table that grows with work, {@link SMALL_ROWS} in one that does not, then `ANALYZE`. The
 * values are generated so the statistics say what the SQLite audit's planner picture says
 * (`query-plan-audit.test.ts`, `modelLowSelectivity`): every key is selective, except the
 * {@link LOW_SELECTIVITY} columns, which most rows share. Half of every other nullable
 * column is NULL, so neither `IS NULL` nor `IS NOT NULL` alone is selective. The workspace leads every key, and a
 * self-hosted install has one workspace, so `workspace_id` is the same in every row. The
 * clone's CHECK constraints are dropped and its foreign keys not checked while it is filled:
 * the planner reads neither.
 *
 * WHAT ELSE IT PROVES.
 *  - Every statement whose SQLite form names an index (`INDEXED BY`, which Postgres does not
 *    have) is planned through that same index on Postgres.
 *  - Every expression index of the Postgres schema (a JSON field `((col ->> 'k') COLLATE
 *    "C")`, `lower(col)`) is used by a query: the queries it was added for write the same
 *    expression, or the planner could not match it.
 *  - The plans the SQLite-only plan tests pin (the message readers' recipient index, the
 *    shipping dependents' active-order index) hold on Postgres too.
 *  - A planted unindexed lookup and a planted sort fail it.
 *
 * It runs on the Postgres leg (`server-store-pg`). It opens a SQLite store in memory only to
 * reach the definitions made inside repository methods, as the dialect census does.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { MESSAGE_PENDING, primeFirstAdminMember } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { pgSyncTables } from '@podium/sync/adapters/pg/schema'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as pgSchema from '../migrations/pg/schema'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'
import { SessionStore } from '../store'
import {
  builtStatements,
  FAMILY_SHAPES,
  isFragment,
  type KeyedDefinition,
  keyedDefinitions,
  REPO_ROOT,
  reachMethodDefinitions,
  type SourceTree,
  trackedSources,
} from '../test-support/definition-census'
import { clonePgTestDatabase, testStoreEngine } from '../test-support/pg-test-database'
import { useRealMigrationChain } from '../test-support/pre-migrated-store'
import type { QueryClient } from './executor/driver'
import { buildPgStoreDrizzle } from './executor/pg-drizzle'

const ENGINE = testStoreEngine()

/** The store's Postgres table set: the server schema's twins and the sync tables' twins. */
const PG_TABLES = Object.freeze({ ...pgSchema, ...pgSyncTables })

// ---------------------------------------------------------------------------
// The planner's picture
// ---------------------------------------------------------------------------

/** Rows a table that grows with work holds in the audit's database. */
const LARGE_ROWS = 10_000
/** Rows a {@link SMALL_TABLES} table holds. */
const SMALL_ROWS = 50

/**
 * Columns whose value most rows share, as `table.column`, and how many values they take. A
 * plan whose index condition names only these reads (nearly) the whole table, as on SQLite
 * (`query-plan-audit.test.ts`, `LOW_SELECTIVITY`).
 */
const LOW_SELECTIVITY: ReadonlyMap<string, LowSelectivity> = new Map<string, LowSelectivity>([
  // Most rows are live; `deleted_at IS NULL` selects nearly all of them.
  ['sessions.deleted_at', 'mostly-null'],
  ['issues.deleted_at', 'mostly-null'],
  // A handful of resource kinds; one kind is a large share of all grants.
  ['grants.resource_kind', 4],
  // Three recipient kinds.
  ['messages.to_kind', 3],
])

/** `n` values in turn, or NULL in all but one row in twenty. */
type LowSelectivity = number | 'mostly-null'

/** The workspace column: one value in every row of a self-hosted install. */
const WORKSPACE_COLUMN = 'workspace_id'

/** Is `table.column` one most rows share? `sync_feed` is keyed by the workspace alone. */
function isLowSelectivity(table: string, column: string): boolean {
  if (column === WORKSPACE_COLUMN) return table !== 'sync_feed'
  return LOW_SELECTIVITY.has(`${table}.${column}`)
}

/**
 * Tables that do not grow with work (the SQLite audit's list, the same reasons), plus the
 * Postgres-only and identity tables. A scan of one, and a sort of rows read only from
 * these, is accepted.
 */
const SMALL_TABLES: ReadonlyMap<string, string> = new Map([
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
  [
    'operations',
    "Durable operations (modules/operations/store.ts): single-flight keeps at most one live row per exclusion group, and retention sweeps each kind's finished history to twenty.",
  ],
  ['offers', 'At most one live offer per session, removed when cleared.'],
  ['sync_kind', 'One generation row per record kind per workspace: a few dozen.'],
  ['sync_feed', 'One row per workspace.'],
  [
    'sync_capture',
    'Change capture rows live only inside the transaction that wrote them: the drain empties the table before every commit.',
  ],
  [
    'lock_waiters',
    'A transient queue: a waiter is removed when its lock is granted or its wait ends.',
  ],
  ['workspace_secrets', "A fixed set of a workspace's own keys (POD-7013)."],
  [
    'artifact_uploads',
    'CLI uploads in flight: a row is removed when the upload is published or swept.',
  ],
  ['tab_order', 'One row per person per worktree they arranged.'],
  ['pins', 'A few pins per person, read in the order they were made (POD-7024).'],
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
 * Queries whose scan or sort is accepted, keyed `file:name` (or `file:name [shape]`), with
 * the reason. Bounded by something other than the amount of work.
 */
const MIN_MAX_SEEK =
  'A min() or max() over a key that leads with workspace_id: Postgres plans it as the one ' +
  "entry at that end of the workspace's index range (a Limit 1 over the index), so it reads " +
  'one entry; the plan names only the workspace (POD-7024).'
const ALLOWLIST: ReadonlyMap<string, string> = new Map([
  [
    'apps/server/src/store/sessions.ts:anySession',
    'One-row existence probe for setup (POD-7118 from dev/mw): LIMIT 1 stops at the first stored session of the workspace, including tombstones. Reads at most one row regardless of history.',
  ],
  // Postgres only: plans SQLite makes without a scan or sort.
  [
    'apps/server/src/store/messages.ts:messagesAddressedTo [no-id]',
    "The messages to a recipient with no id (the operator's), oldest first: read in order from the partial index idx_messages_recipient_no_id, which holds only rows with no recipient id, so its range on the kind is that recipient's messages. Before it, Postgres sorted every such message for each page (POD-6992).",
  ],

  // The janitor's reads (POD-6993), as the SQLite audit lists them: each runs once per
  // janitor tick, in the janitor's worker on a read session of its own.
  ['apps/server/src/store/janitor-reads.ts:maxEventIdOf', MIN_MAX_SEEK],
  [
    'apps/server/src/store/janitor-reads.ts:eventPruneHeadOf',
    "Walks the workspace's events oldest first along its key (workspace_id, id) and stops at the first prunable one: the cap is a prefix of the ids and the age cutoff starts at the oldest end, so the head is found at once whenever there is one.",
  ],
  [
    'apps/server/src/store/janitor-reads.ts:eventPruneCountOf',
    'Counts the prunable events (too old, or over the cap): the OR of age and cap has no one index, and the log is bounded by the retention policy it prunes to.',
  ],
  [
    'apps/server/src/store/janitor-reads.ts:worktreeGcFirst',
    'Sorts the finished issues still holding a checkout: bounded by the checkouts on disk. SQLite finds them through idx_issues_worktree; on the seed half the issues have a worktree, so Postgres scans instead, which then costs less.',
  ],
  [
    'apps/server/src/store/janitor-reads.ts:worktreeGcAfter',
    'Sorts the finished issues still holding a checkout: bounded by the checkouts on disk. SQLite finds them through idx_issues_worktree; on the seed half the issues have a worktree, so Postgres scans instead, which then costs less.',
  ],
  [
    'apps/server/src/store/accounts.ts:sentMachines',
    "Sorts one account's machine sends: a row per machine the account was sent to; accounts is a small table.",
  ],
  [
    'apps/server/src/store/sessions.ts:sessionById',
    'One session by its key: the sort orders one row.',
  ],
  [
    'apps/server/src/store/sessions.ts:liveHeadlessSessions',
    'Walks the partial index idx_sessions_headless: the live headless sessions only (a few), never the rest.',
  ],
  [
    'apps/server/src/store/effects.ts:publishCopied',
    'Walks the partial index idx_effects_unpublished: the effects not yet published (revision 0), which publishing empties.',
  ],
  // Mirrored from the SQLite audit: the same statement, the same reason.
  ['packages/sync/src/adapters/sqlite/sync-repository.ts:advanceFloor', MIN_MAX_SEEK],
  [
    'apps/server/src/store/automations.ts:lastSpawnedRuns',
    "Walks the automations (a small table: schedules people define by hand) and finds each one's newest spawned run through idx_automation_runs_automation, never the runs of the whole table (POD-6172).",
  ],
  [
    'apps/server/src/store/messages.ts:pendingForSessionProof',
    'Sorts only undelivered rows: the delivery_status IN list selects the pending queue, which empties as messages are delivered.',
  ],
  [
    'apps/server/src/store/messages.ts:ledger',
    'Each UNION arm reads its index newest first and SQLite merges them, stopping at the limit; the temporary B-tree orders only rows tied on (created_at, id), which is unique, so every sort group is one row.',
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
    'apps/server/src/store/messages.ts:queuedPage',
    'Sorts only undelivered rows: the delivery_status IN list selects the pending queue, which empties as messages are delivered.',
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
    'apps/server/src/store/conversations/registry.ts:nativeIdsOf',
    'Sorts the segments of the conversations in the IN list: a few each.',
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
  ['apps/server/src/store/events.ts:highestEventId', MIN_MAX_SEEK],
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
    'apps/server/src/store/issue-listings.ts:labelsOfIssues',
    "Sorts the labels of the issues a report lists, by the issue's primary key, then the label name: a few labels per listed issue (POD-6191).",
  ],
  [
    'apps/server/src/store/issue-listings.ts:liveChildrenOf',
    'Sorts the live children of the parents asked for (their own index lookup), in the boot order a report shows them: a few rows per parent (POD-6191).',
  ],
  [
    'apps/server/src/store/issues.ts:issuesUnderPathOutsideRepo',
    'Sorts the issues at or under one repository path, found through idx_issues_repo (an equality and a range); runs when a repository gains its id.',
  ],
  [
    'apps/server/src/store/issues.ts:legacyWorktreeSkipped',
    'One-time backfill: runs once per database, behind the legacy_worktree_machine_ids_v1 receipt.',
  ],
  [
    'apps/server/src/store/issues.ts:labelsOf',
    "Sorts one issue's labels: the join reads only that issue's issue_labels rows, a handful per issue.",
  ],
  [
    'apps/server/src/store/issues.ts:issuesOfLabels',
    "The change capture's mapping of renamed labels to the issues carrying them (POD-6920): found through idx_issue_labels_label_id, the distinct issue ids sorted in a temporary tree, a few per label; a label rename is rare.",
  ],
  [
    'apps/server/src/store/sessions.ts:liveSessionByResumeValue',
    'Sorts the few live sessions that share one resume value.',
  ],
  [
    'apps/server/src/store/sessions.ts:sessionsOfIds',
    'Sorts the sessions named by the IN list, at most one chunk.',
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
    'apps/server/src/store/sessions.ts:refBackfillCandidates',
    "Sorts the boot ref backfill's candidates (POD-6222): the ref-less sessions that can still get a birth ref, read by index ranges; a few once the first boot named them.",
  ],
  [
    'apps/server/src/store/sessions.ts:deletedSessionsForIssue',
    'Sorts the sessions one issue deleted: a few.',
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
    'apps/server/src/store/shipping.ts:resumableOrdersFifo',
    'Walks only the partial index idx_ship_orders_recovery, named with INDEXED BY: unfinished execution states, excluding queued, held, shipped and cancelled orders.',
  ],
  [
    'apps/server/src/store/shipping.ts:activeOrdersOfLane',
    'Sorts the active orders of one lane, found through idx_ship_orders_lane (POD-6172).',
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
    'apps/server/src/store/workflows.ts:runIdsOfRevisions',
    "The change capture's mapping of a changed workflow revision to the runs that read it (POD-6920): workflow_runs is a small table (a row per started workflow run), and a revision changes only when it is published.",
  ],
  [
    'apps/server/src/store/issues.ts:IssuesRepository.legacyMachine',
    'One-time backfill: runs once per database, behind the legacy_worktree_machine_ids_v1 receipt.',
  ],
])

/**
 * Queries that read a whole table that grows with work, on purpose (the SQLite audit's
 * `WHOLE_TABLE_READS`): record-builder streams during client bootstrap, test oracles,
 * one-time repairs. The list may only shrink.
 */
const WHOLE_TABLE_READS: ReadonlyMap<string, string> = new Map([
  // The first page of a history collection (POD-7085), as the SQLite audit lists them.
  ...(['automationRun', 'conversation', 'workflowRun'] as const).map(
    (kind) =>
      [
        `apps/server/src/store/collections.ts:collectionRows [|${kind}.page#sorted#]`,
        'The first page of a history collection (POD-7085): the whole collection in its order, because the page carries the total the viewer may see. Fetched on demand when a history view opens, never in the first download; later pages seek below their position.',
      ] as const,
  ),
  // The janitor's archive sweeps (POD-6993), as the SQLite audit lists them.
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
  // Postgres only.
  [
    'apps/server/src/store/transcript-costs.ts:costedSessions',
    "Every costed session's id, for the cost sheet: distinct over the costs of the whole table, which the sheet ranks whole (as attributedCosts).",
  ],
  [
    'apps/server/src/store/transcript-costs.ts:latestWindow',
    'The newest cost window over every cost row: no index holds window_since_ms, so the maximum reads the table. An index on (workspace_id, window_since_ms) would make it a seek.',
  ],
  // Mirrored from the SQLite audit: the same statement, the same reason.
  [
    'apps/server/src/store/automations.ts:allLiveRuns',
    'The automationRun record builder streams stored runs during client bootstrap; never at server startup.',
  ],
  [
    'apps/server/src/store/checkouts.ts:allCheckouts',
    'The checkout record builder streams stored rows during client bootstrap. Server startup never reads them.',
  ],
  [
    'apps/server/src/store/messages.ts:confirmedChatWindow',
    "The chat feed's confirmed window as a query (POD-6763, POD-6766): each live session's newest confirmed operator messages, ranked by a window function, which sorts each session's confirmed messages, after a read of `sessions` finds the live ones. Read by the record builder's `streamAll` during client bootstrap, never at server startup or per write (a write reads `confirmedChatTail`). Bounded by live sessions, not by history; the start-up load phase decides whether it stays.",
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
    'apps/server/src/store/issues.ts:deleteOrphanRefLetters',
    'Explicit legacy repair test oracle. The historical data repair runs once in sync-without-boot-reconcile; server startup never runs it.',
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
    'apps/server/src/store/issues.ts:allIssueUserStateRows',
    'The issueUserState record builder streams personal rows during client bootstrap; never at server startup.',
  ],
  [
    'apps/server/src/store/machines.ts:legacySentinelScan',
    'Whole-table read (POD-6172): boot check that no row in any table still names a retired machine sentinel; a sweep by design.',
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
    'apps/server/src/store/user-preferences.ts:allPreferenceRows',
    'The userPreferences record builder streams stored preferences during client bootstrap; never at server startup.',
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
    'apps/server/src/store/superagent.ts:allThreads',
    'The superagentThread record builder streams stored threads during client bootstrap; never at server startup.',
  ],
  [
    'apps/server/src/store/transcript-costs.ts:attributedCosts',
    'Whole-table read (POD-6172): the cost sheet ranks every costed task (CostService.tasks); tokens are summed from a JSON column, so the ranking cannot be paged in SQL.',
  ],
  [
    'apps/server/src/store/transcript-costs.ts:ownCohortFolds',
    "Whole-table read (POD-6172): the rate cohort is a statistic over every qualifying, surviving issue: one grouped SQL aggregate, read when one task's comparison is asked for.",
  ],
  [
    'apps/server/src/store/transcript-costs.ts:costCount',
    'Whole-table read (POD-6172): countAll is a test oracle only; no production code calls it.',
  ],
  [
    'apps/server/src/store/workflows.ts:everyRun',
    'The workflowRun record builder streams runs during client bootstrap. Server startup never reads stored workflow history.',
  ],
  [
    'apps/server/src/store/workflows.ts:everyRunStep',
    'The workflowRun record builder joins run steps during client bootstrap. Server startup never reads them.',
  ],
])

/**
 * Lookups an index could serve but whose SQL prevents it, each with the decision that
 * defers it (the SQLite audit's `SHAPE_DEBT`). The list may only shrink.
 */
const SHAPE_DEBT: ReadonlyMap<string, string> = new Map([
  [
    'apps/server/src/store/collections.ts:collectionRows [|session.asking#ids#]',
    "Who waits for the user, read from each live session's offer and checkpoints: on SQLite the derived column sessions.asks_user answers it through idx_sessions_asking, but on Postgres nothing writes that column yet (PG_UNMAINTAINED_COLUMNS), so the rule reads the workspace's live sessions and probes their satellites. Bounded by the live sessions; POD-7123 keeps the column on Postgres and returns this to the index.",
  ],
  // Mirrored from the SQLite audit: the same statement, the same reason.
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
  [
    'apps/server/src/store/issues.ts:commentSearch',
    'Query shape: substring LIKE over comment bodies; needs server full-text search, which the operator deferred (POD-5617).',
  ],
])

/**
 * Definitions that never run on Postgres, so are not planned there, keyed `file:name`, with
 * why. They read tables only a SQLite install has.
 */
const SQLITE_ONLY_DEFINITIONS: ReadonlyMap<string, string> = new Map([
  [
    'apps/server/src/store/identity-upgrade.ts:passwords',
    "The boot import's read of pre-identity passwords (LEGACY until 2027-06): user_credentials exists only in a SQLite install upgraded from before shared identity. A Postgres store starts at the identity baseline and has no such table (design 2.9), so its boot must not run the import (POD-6994).",
  ],
  [
    'apps/server/src/store/identity-upgrade.ts:links',
    "The boot import's read of pre-identity invitations (LEGACY until 2027-06): member_invites exists only in a SQLite install upgraded from before shared identity; a Postgres store has no such table (design 2.9, POD-6994).",
  ],
])

/**
 * A statement whose SQLite form names an index (`INDEXED BY`) that its plan on the seed does
 * not read, with what a real database looks like where it does, and why. `reshape` runs on
 * the audit's database inside a transaction that is rolled back (the `analyze` tables are
 * analyzed again after it); `values`, when given, are literals for `$1, $2, ...`, so the plan
 * is the one Postgres makes for those values (a custom plan) rather than the generic one.
 */
interface HintShape {
  /** Another index over the same rows the planner may take instead, with the same effect. */
  readonly alsoReads?: string
  readonly reshape?: readonly string[]
  readonly analyze?: readonly string[]
  readonly values?: readonly string[]
  readonly reason: string
}

const WS_LITERAL = `'${SELF_HOSTED_WORKSPACE_ID}'`

/** Keyed `file:name [shape]`. Each is proven by the INDEXED BY test below. */
const HINT_SHAPES: ReadonlyMap<string, HintShape> = new Map<string, HintShape>([
  [
    'apps/server/src/store/effects.ts:newestOnTargetIn [active]',
    {
      // One machine's long history of finished scans, and a few active records.
      reshape: [
        `UPDATE effects SET kind = 'machine.scan', target_kind = 'machine', target_id = 'busy', status = 'succeeded', deleted_at = NULL WHERE right(id, 2) <> '00'`,
      ],
      analyze: ['effects'],
      values: [WS_LITERAL, `'machine.scan'`, `'machine'`, `'busy'`, `'pending'`, `'running'`, '1'],
      // Its key also starts (workspace, status): the same few active rows.
      alsoReads: 'idx_effects_status_finished',
      reason:
        "A target's newest active effect (POD-7031). The active records are a few and a target's finished history is long (a machine keeps thousands of scans); on that shape Postgres reads the active statuses' range of idx_effects_status_deadline, as SQLite is told to, or of idx_effects_status_finished, whose key starts with the same workspace and status: the same rows. On the seed every target holds a record or two, so the target's own records are the fewer.",
    },
  ],
  [
    'apps/server/src/store/effects.ts:purgeTombstones [undefined]',
    {
      values: [WS_LITERAL, WS_LITERAL, '10', '5'],
      reason:
        "The tombstone purge's batch: effects deleted before a bound, at most a batch. The generic plan takes the bound as a third of the table; for a real one Postgres reads idx_effects_tombstones, as SQLite is told to.",
    },
  ],
  ...(
    [
      'apps/server/src/store/events.ts:eventsAboveId [undefined]',
      'apps/server/src/store/janitor-reads.ts:eventsAboveGuessOf [undefined]',
    ] as const
  ).map(
    (key) =>
      [
        key,
        {
          alsoReads: 'podium_events_pkey',
          reason:
            "Counts the events above the row cap's guess (POD-7035). SQLite is told its narrowest index, whose entries it counts without a table page; Postgres counts the primary key's range above the guess, the same rows.",
        },
      ] as const,
  ),
  [
    'apps/server/src/store/events.ts:matchingSubscriptions [a|1]',
    {
      alsoReads: 'idx_sessions_issue_archived',
      reason:
        'The sessions of the anchored issue (POD-7034). SQLite is told idx_sessions_issue; Postgres reads idx_sessions_issue_archived, whose key starts with the same workspace and issue, the same rows.',
    },
  ],
  [
    'apps/server/src/store/events.ts:matchingSubscriptions [ra|4]',
    {
      alsoReads: 'sessions_pk',
      reason:
        "The sessions of the anchored issues (POD-7034). With both arms the subscriptions it matches are few, so Postgres probes each candidate session by its key and tests its issue, instead of reading the issues' sessions through idx_sessions_issue as SQLite is told to; the same rows.",
    },
  ],
  ...[1, 4].map(
    (size) =>
      [
        `apps/server/src/store/workflows.ts:stepsOfRuns [${size}]`,
        {
          alsoReads: 'workflow_run_steps_workspace_id_run_id_position_unique',
          reason:
            'The steps of the listed runs (POD-7034). SQLite is told the primary key (workspace, run, step); Postgres reads the unique (workspace, run, position), whose key starts with the same run, the same rows.',
        },
      ] as const,
  ),
  [
    'packages/sync/src/adapters/sqlite/sync-repository.ts:newestAgedSeq [undefined]',
    {
      values: [WS_LITERAL, '10'],
      reason:
        "The retention prune's age threshold: the newest change older than the retention age. The generic plan, which cannot know the threshold, takes a third of the log as aged and walks the primary key down from the head. For a real threshold, where the aged rows are the log's oldest few, Postgres plans the changes_event_time range, and it keeps that custom plan: it costs a fraction of the generic one.",
    },
  ],
  ...[1, 4].map(
    (size) =>
      [
        `apps/server/src/store/issues.ts:liveWorktreesOnMachines [${size}]`,
        {
          reshape: [`UPDATE issues SET worktree_path = NULL WHERE right(id, 2) <> '00'`],
          analyze: ['issues'],
          // The folded-path index has the same predicate, so it holds the same rows.
          alsoReads: 'idx_issues_worktree_folded',
          reason:
            'The live issues with a recorded worktree on the given machines. SQLite names the partial index of live issues that have a worktree; Postgres reads it when those are a small share of the issues (one in a hundred here). Where they are not, it scans instead, which then costs less than the index.',
        },
      ] as const,
  ),
  [
    'apps/server/src/store/shipping.ts:activeOrdersFifo [undefined]',
    {
      reshape: [`UPDATE ship_orders SET state = 'shipped' WHERE right(id, 2) <> '00'`],
      analyze: ['ship_orders'],
      reason:
        'The active orders, oldest first. Shipped and cancelled orders are the history and active ones a few among them; on that shape Postgres reads the partial index of active orders, as SQLite is told to. On the seed, where every state is as common as the next, active orders are most of the table.',
    },
  ],
  [
    'apps/server/src/store/shipping.ts:shippedLeadersOfOpenTrains [undefined]',
    {
      reshape: [
        `UPDATE ship_train_manifests SET released_at = now(), release_reason = 'released' WHERE right(id, 2) <> '00'`,
      ],
      analyze: ['ship_train_manifests'],
      reason:
        'The leaders of the open trains. Released trains are the history and open ones a few; on that shape Postgres reads the partial index of open trains, as SQLite is told to. On the seed half the trains are open.',
    },
  ],
  [
    'apps/server/src/store/janitor-reads.ts:changeFeedOf [undefined]',
    {
      values: [WS_LITERAL, '10', WS_LITERAL],
      reason:
        "The janitor's read of the feed with the retention prune's age threshold (as newestAgedSeq): the generic plan takes a third of the log as aged and walks the primary key down from the head; for a real threshold Postgres plans the changes_event_time range.",
    },
  ],

  [
    'apps/server/src/store/superagent.ts:syncTurnRunning [undefined]',
    {
      values: [WS_LITERAL, WS_LITERAL, 'true', WS_LITERAL, 'false'],
      reason:
        "Clears the running flag of threads with no pending turn. The flag's value `true` is a bound parameter, so the generic plan takes half the threads as running and joins whole tables. For the value itself, where running threads are few, Postgres reads idx_superagent_threads_running, as SQLite is told to, and it keeps that custom plan: it costs a fraction of the generic one.",
    },
  ],
])

/**
 * A scan or sort that is the planner's cost choice, not the absence of an index, with the
 * proof that an index serves the statement: under `values` (literals for `$1, $2, ...`, so a
 * custom plan for real values instead of the generic one), on the data `reshape` gives
 * (rolled back afterwards), or with the planner switches in `off` turned off, the plan has no
 * finding left except scans of small tables, and reads `reads` when it is given. The test
 * "proves every planner choice" holds each one.
 */
interface PlannerChoice {
  readonly reason: string
  readonly values?: readonly string[]
  readonly reshape?: readonly string[]
  readonly analyze?: readonly string[]
  readonly off?: readonly string[]
  readonly reads?: string
}

/** The joins and scans a nested-loop proof turns off: only per-key index lookups are left. */
const NESTED_LOOP_ONLY = [
  'enable_seqscan',
  'enable_bitmapscan',
  'enable_hashjoin',
  'enable_mergejoin',
  'enable_sort',
  'enable_hashagg',
]

/** Only key lookups through a join, but a JSON list may still be made unique first. */
const KEY_LOOKUPS = ['enable_seqscan', 'enable_bitmapscan', 'enable_hashjoin', 'enable_mergejoin']

const JSON_BATCH =
  "A write over a JSON batch of keys: Postgres estimates any JSON list at 100 rows, so against the audit's 10,000-row table a hash join over the whole table is cheaper than 100 key lookups. Joined key by key (the proof), it reads the primary key; at a real table's size that is also the cheaper plan."

/** Keyed `file:name` or `file:name [shape]`. */
const RECENT_CUTOFF = "'2026-01-01T02:45:00Z'"

/** A collection's recent rule: a range on its time from a cutoff the generic plan cannot know. */
const RECENT_RANGE =
  "A collection's recent records (POD-7085): those after a cutoff of the last N days. The generic plan cannot know the cutoff and takes a third of the rows as recent; for a real one, the newest few, Postgres reads the time index."

const PLANNER_CHOICES: ReadonlyMap<string, PlannerChoice> = new Map<string, PlannerChoice>([
  ...(
    [
      'automationRun.recent',
      'conversation.recent',
      'issueProjection.recent',
      'session.recent',
    ] as const
  ).map(
    (collection) =>
      [
        `apps/server/src/store/collections.ts:collectionRows [|${collection}#ids#recentDays:d]`,
        { values: [WS_LITERAL, RECENT_CUTOFF], reason: RECENT_RANGE },
      ] as const,
  ),
  ...(
    [
      'issueProjection.byStage#sorted#stage:s',
      'issueProjection.byStagePriority#sorted#priority:s,stage:s',
      'issueProjection.sidebar#ids#',
    ] as const
  ).map(
    (shape) =>
      [
        `apps/server/src/store/collections.ts:collectionRows [|${shape}]`,
        {
          off: ['enable_seqscan', 'enable_bitmapscan', 'enable_sort'],
          reason:
            'Issues by stage (POD-7085). Its stages are bound as parameters, so the generic plan cannot know which, and on the seed every stage is as common as the next: it reads the whole table and sorts. idx_issues_stage_updated (workspace, stage, updated_at desc, id) serves a stage in its order; on a real database the open stages are a small share of the history.',
        },
      ] as const,
  ),
  [
    'packages/sync/src/adapters/sqlite/sync-repository.ts:deleteAppliedMutationsBatch',
    {
      values: [WS_LITERAL, WS_LITERAL, '10', '5'],
      reason:
        "The receipt prune's batch (POD-7035): receipts applied before a cutoff, oldest first, at most a batch. The generic plan takes the cutoff as a third of the receipts; for a real one Postgres reads the batch off idx_applied_mutations_applied_at.",
    },
  ],
  [
    'packages/sync/src/adapters/sqlite/sync-repository.ts:deleteChangeHead',
    {
      values: [WS_LITERAL, WS_LITERAL, '10', '5'],
      reason:
        "The retention prune's batch: the oldest seqs up to a bound, at most a batch. The generic plan cannot know the bound or the batch and takes them as a third of the log; for real ones Postgres reads the batch through the primary key.",
    },
  ],
  [
    'apps/server/src/store/effects.ts:purgeTombstones',
    {
      values: [WS_LITERAL, WS_LITERAL, '10', '5'],
      reason:
        "The tombstone purge's batch: effects deleted before a bound, at most a batch. The generic plan takes the bound as a third of the table; for a real one Postgres reads the batch through idx_effects_tombstones (partial over the tombstones since POD-7034).",
    },
  ],

  [
    'apps/server/src/store/issues.ts:issuesMissingRepoIdCount',
    {
      reshape: [
        `UPDATE issues SET repo_id = 'repo' WHERE repo_id IS NULL AND right(id, 2) <> '00'`,
      ],
      analyze: ['issues'],
      reason:
        "Counts the issues that have not got their repository id yet (the boot backfill's work). On the seed half the issues have none; on a real database they are the few left from before repository ids, read through idx_issues_repo_id_seq.",
    },
  ],
  ...(['runOwner', 'runOwnersOfIds [1]', 'runOwnersOfIds [4]'] as const).map(
    (name) =>
      [
        `apps/server/src/store/automations.ts:${name}`,
        {
          off: NESTED_LOOP_ONLY,
          reason:
            "The owner of the runs asked for, by their keys: a merge join with automations, a small table, sorting the few runs for it. Joined key by key it reads the run's and the automation's primary keys.",
        },
      ] as const,
  ),
  [
    'apps/server/src/store/messages.ts:settleNotifiable',
    {
      off: NESTED_LOOP_ONLY,
      reason:
        "A recipient's unacknowledged messages with no reply yet: the planner merges the recipient's few rows (idx_messages_delivered_to_time) with the reply index and stops when the recipient's rows end. Joined row by row it reads the reply index by key.",
    },
  ],
  [
    'apps/server/src/store/conversations/index.ts:upsertConversations',
    { off: KEY_LOOKUPS, reads: 'conversations_pk', reason: JSON_BATCH },
  ],
  [
    'apps/server/src/store/conversations/index.ts:deleteMachineConversations',
    { off: KEY_LOOKUPS, reads: 'conversations_pk', reason: JSON_BATCH },
  ],
  [
    'apps/server/src/store/conversations/registry.ts:adoptParents',
    { off: KEY_LOOKUPS, reads: 'conversation_identities_pk', reason: JSON_BATCH },
  ],
  [
    'apps/server/src/store/events.ts:runtimeEventsAfter',
    {
      off: NESTED_LOOP_ONLY,
      reason:
        'One kind of event after a cursor, a page: the generic plan cannot know the cursor and sorts the range it takes for a third of the log; with no sort allowed it reads the primary key in order from the cursor.',
    },
  ],
])

/**
 * Expression indexes no audited query uses, with why they exist anyway (a uniqueness rule
 * the planner never reads, say). Every other expression index must be used by a query.
 */
const EXPRESSION_INDEXES_UNUSED: ReadonlyMap<string, string> = new Map([])

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * The audit's own connection: postgres.js, one connection, never dropped for idling, so a
 * session setting and a transaction stay on the connection they were made on. Each
 * planner switch and each reshape runs in a transaction of its own (`begin`), never as
 * session state a reconnect would lose.
 */
type AuditDb = postgres.Sql
/** A connection or a transaction on it: what runs one statement. */
type Runner = Pick<postgres.Sql, 'unsafe'>

function openAuditDb(url: string): AuditDb {
  return postgres(url, { max: 1, idle_timeout: 0, onnotice: () => undefined })
}

/**
 * Rows of one statement, as plain objects. Sent as simple-protocol text: an audited
 * statement's `$1` is EXPLAIN's (`GENERIC_PLAN`), not a parameter to bind.
 */
async function rowsOf<Row>(runner: Runner, query: string): Promise<Row[]> {
  const options = { simple: true } as unknown as Parameters<Runner['unsafe']>[2]
  return Array.from((await runner.unsafe(query, [], options)) as unknown as Row[])
}

interface ColumnInfo {
  readonly table_name: string
  readonly column_name: string
  readonly data_type: string
  readonly udt_name: string
  readonly is_nullable: 'YES' | 'NO'
  readonly is_identity: 'YES' | 'NO'
  readonly identity_generation: string | null
  readonly is_generated: 'ALWAYS' | 'NEVER'
}

/**
 * A value of `column` in row `g` of the seed, as a SQL expression over `g`. A column with a
 * closed value set (a CHECK constraint's list, `closed`) cycles through it, so a status has
 * its real handful of values; a boolean is true in one row in twenty, as a flag is set on
 * few rows.
 */
function seedValue(column: ColumnInfo, closed: ReadonlyMap<string, readonly string[]>): string {
  const { table_name: table, column_name: name } = column
  const low = LOW_SELECTIVITY.get(`${table}.${name}`)
  const at = `(timestamptz '2026-01-01T00:00:00Z' + g * interval '1 second')`
  if (name === WORKSPACE_COLUMN) return `'${SELF_HOSTED_WORKSPACE_ID}'`
  const values = closed.get(`${table}.${name}`)
  if (values !== undefined && values.length > 0 && low === undefined) {
    const list = `(ARRAY[${values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', ')}])`
    return `${list}[1 + g % ${values.length}]`
  }
  if (column.udt_name === 'bool' && low === undefined) return '(g % 20 = 0)'
  if (low === 'mostly-null') {
    return `CASE WHEN g % 20 = 0 THEN ${cast(column, at, 'g')} ELSE NULL END`
  }
  if (typeof low === 'number') return cast(column, `'k' || (g % ${low})`, `g % ${low}`)
  const value = cast(column, `'${name}:' || g`, 'g')
  // Half of a nullable column is NULL: neither `IS NULL` nor `IS NOT NULL` is selective.
  return column.is_nullable === 'YES' ? `CASE WHEN g % 2 = 0 THEN NULL ELSE ${value} END` : value
}

/** `text` as the column's type, or `n` for a number. */
function cast(column: ColumnInfo, text: string, n: string): string {
  const at = `(timestamptz '2026-01-01T00:00:00Z' + (${n}) * interval '1 second')`
  switch (column.udt_name) {
    case 'text':
    case 'varchar':
      return `(${text})`
    case 'int2':
    case 'int4':
    case 'int8':
      return `(${n})::${column.udt_name}`
    case 'float4':
    case 'float8':
    case 'numeric':
      return `(${n})::${column.udt_name}`
    case 'bool':
      return `((${n}) % 2 = 0)`
    case 'timestamptz':
    case 'timestamp':
      return `${at}::${column.udt_name}`
    case 'date':
      return `(${at})::date`
    case 'json':
    case 'jsonb':
      return `json_build_object('n', ${n}, 't', ${text}, 'item', json_build_object('kind', ${text}), 'ev', json_build_object('ev', ${text}))::${column.udt_name}`
    case 'bytea':
      return `decode(md5((${n})::text), 'hex')`
    case 'uuid':
      return `md5((${n})::text)::uuid`
    case '_text':
      return `ARRAY[${text}]`
    default:
      throw new Error(
        `the seed has no value for ${column.table_name}.${column.column_name} (${column.udt_name})`,
      )
  }
}

/**
 * The column and values of a closed-set CHECK, as Postgres prints it:
 * `CHECK ((state = ANY (ARRAY['a'::text, 'b'::text])))`, or `CHECK ((kind = 'x'::text))`.
 */
function closedValues(definition: string): { column: string; values: string[] } | undefined {
  const match =
    /^CHECK \(\(\(?"?([a-z_]+)"?\)?(?:::text)? = (ANY \(ARRAY\[(.*)\]\)|'(?:[^']|'')*'::text)\)\)$/.exec(
      definition,
    )
  const nullable =
    /^CHECK \(\(\(\(?"?([a-z_]+)"?\)? IS NULL\) OR \("?[a-z_]+"? = ANY \(ARRAY\[(.*)\]\)\)\)\)$/.exec(
      definition,
    )
  if (!match && nullable) {
    const literals = [...(nullable[2] as string).matchAll(/'((?:[^']|'')*)'/g)].map((m) =>
      (m[1] as string).replaceAll("''", "'"),
    )
    return { column: nullable[1] as string, values: literals }
  }
  if (!match) return undefined
  const literals = [...(match[3] ?? match[2] ?? '').matchAll(/'((?:[^']|'')*)'/g)].map((m) =>
    (m[1] as string).replaceAll("''", "'"),
  )
  return literals.length > 0 ? { column: match[1] as string, values: literals } : undefined
}

/**
 * Fill every table of the audit's database and analyze it (see the header). Returns the
 * tables it filled, by name.
 */
async function seedRows(db: AuditDb): Promise<string[]> {
  const filled = await db.begin(async (tx) => await seedIn(tx))
  await db.unsafe('ANALYZE')
  return filled
}

async function seedIn(admin: Runner): Promise<string[]> {
  const columns = await rowsOf<ColumnInfo>(
    admin,
    `SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable, c.is_identity,
            c.identity_generation, c.is_generated
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position`,
  )
  const byTable = new Map<string, ColumnInfo[]>()
  for (const column of columns) {
    byTable.set(column.table_name, [...(byTable.get(column.table_name) ?? []), column])
  }
  // The planner reads no CHECK constraint, and the generated values do not meet them.
  const checks = await rowsOf<{ table_name: string; name: string; definition: string }>(
    admin,
    `SELECT rel.relname AS table_name, con.conname AS name,
            pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE ns.nspname = 'public' AND con.contype = 'c'`,
  )
  const closed = new Map<string, string[]>()
  for (const { table_name, definition } of checks) {
    const list = closedValues(definition)
    if (list) closed.set(`${table_name}.${list.column}`, list.values)
  }
  console.log(
    `postgres query-plan audit: ${closed.size} closed-set columns of ${checks.length} checks`,
  )
  for (const { table_name, name } of checks) {
    await admin.unsafe(`ALTER TABLE "${table_name}" DROP CONSTRAINT "${name}"`)
  }
  // Foreign keys are triggers, which replica mode skips: the rows reference nothing.
  await admin.unsafe('SET LOCAL session_replication_role = replica')
  const filled: string[] = []
  for (const [table, of] of byTable) {
    const written = of.filter(
      (column) =>
        column.is_generated !== 'ALWAYS' &&
        !(column.is_identity === 'YES' && column.identity_generation === 'ALWAYS'),
    )
    const rows = SMALL_TABLES.has(table) ? SMALL_ROWS : LARGE_ROWS
    await admin.unsafe(
      `INSERT INTO "${table}" (${written.map((column) => `"${column.column_name}"`).join(', ')})
       SELECT ${written.map((column) => seedValue(column, closed)).join(', ')} FROM generate_series(1, ${rows}) AS g
       ON CONFLICT DO NOTHING`,
    )
    filled.push(table)
  }
  return filled
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/** One node of `EXPLAIN (FORMAT JSON)`, as far as the audit reads it. */
interface PlanNode {
  readonly 'Node Type': string
  readonly 'Relation Name'?: string
  readonly 'Index Name'?: string
  readonly 'Index Cond'?: string
  readonly 'Recheck Cond'?: string
  readonly Strategy?: string
  readonly 'Sort Key'?: readonly string[]
  readonly 'Presorted Key'?: readonly string[]
  readonly Plans?: readonly PlanNode[]
}

/** What the audit flags in a plan. */
interface PlanFinding {
  readonly kind: 'scan' | 'sort'
  /** The table read whole, or undefined for a sort. */
  readonly table: string | undefined
  readonly detail: string
}

interface Schema {
  /** Each index's table, by index name. */
  readonly tableOfIndex: ReadonlyMap<string, string>
  /** Each index's key columns in order, an expression as `null`, by index name. */
  readonly indexColumns: ReadonlyMap<string, readonly (string | null)[]>
  /** Each table's columns. */
  readonly columnsOf: ReadonlyMap<string, ReadonlySet<string>>
  /** Expression indexes, by name: their table and definition. */
  readonly expressionIndexes: ReadonlyMap<string, { table: string; definition: string }>
}

async function readSchema(admin: Runner): Promise<Schema> {
  const indexes = await rowsOf<{
    name: string
    table: string
    expr: boolean
    def: string
    columns: string
  }>(
    admin,
    `SELECT i.relname AS name, t.relname AS table, x.indexprs IS NOT NULL AS expr,
            pg_get_indexdef(x.indexrelid) AS def,
            (SELECT string_agg(coalesce(a.attname, '*'), ',' ORDER BY k.n)
               FROM unnest(x.indkey[0:x.indnkeyatts - 1]) WITH ORDINALITY AS k(attnum, n)
               LEFT JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
                AND k.attnum > 0) AS columns
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'`,
  )
  const columns = await rowsOf<{ table_name: string; column_name: string }>(
    admin,
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
  )
  const columnsOf = new Map<string, Set<string>>()
  for (const { table_name, column_name } of columns) {
    const set = columnsOf.get(table_name) ?? new Set<string>()
    set.add(column_name)
    columnsOf.set(table_name, set)
  }
  return {
    tableOfIndex: new Map(indexes.map((index) => [index.name, index.table])),
    indexColumns: new Map(
      indexes.map((index) => [
        index.name,
        index.columns.split(',').map((column) => (column === '*' ? null : column)),
      ]),
    ),
    columnsOf,
    expressionIndexes: new Map(
      indexes
        .filter((index) => index.expr)
        .map((index) => [index.name, { table: index.table, definition: index.def }]),
    ),
  }
}

/** Every node of a plan, depth first. */
function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)]
}

/** The table columns an index condition constrains. */
function constrainedColumns(condition: string, table: string, schema: Schema): Set<string> {
  const columns = schema.columnsOf.get(table) ?? new Set<string>()
  const out = new Set<string>()
  // Drop string literals and casts' type names, then keep the words that name columns.
  const words = condition.replace(/'(?:[^']|'')*'/g, ' ').match(/[a-z_][a-z0-9_]*/g) ?? []
  for (const word of words) if (columns.has(word)) out.add(word)
  return out
}

/** The scans and sorts of `plan` (see the header). */
function planFindings(plan: PlanNode, schema: Schema): PlanFinding[] {
  const findings: PlanFinding[] = []
  for (const node of nodesOf(plan)) {
    const type = node['Node Type']
    if (type === 'Seq Scan') {
      const table = node['Relation Name']
      findings.push({ kind: 'scan', table, detail: `Seq Scan on ${table}` })
      continue
    }
    if (type === 'Index Scan' || type === 'Index Only Scan' || type === 'Bitmap Index Scan') {
      const index = node['Index Name'] ?? '?'
      const table = schema.tableOfIndex.get(index) ?? node['Relation Name']
      const condition = node['Index Cond']
      if (condition === undefined) {
        findings.push({ kind: 'scan', table, detail: `${type} on ${index} with no condition` })
        continue
      }
      if (table === undefined) continue
      // The index range is set by its leading key columns the condition constrains, up to
      // the first it does not: a condition on a later column only filters inside the range.
      const named = constrainedColumns(condition, table, schema)
      const prefix: string[] = []
      for (const column of schema.indexColumns.get(index) ?? []) {
        // An expression key: constrained when the condition calls a function (Postgres
        // prints some in capitals, `COALESCE(`).
        if (column === null ? !/[a-z_]+\(/i.test(condition) : !named.has(column)) break
        prefix.push(column ?? '(expression)')
      }
      if (prefix.every((column) => column !== '(expression)' && isLowSelectivity(table, column))) {
        findings.push({
          kind: 'scan',
          table,
          detail: `${type} on ${index} ranged only by ${prefix.join(', ') || 'nothing'}: ${condition}`,
        })
      }
      continue
    }
    if (type === 'Sort') {
      findings.push({
        kind: 'sort',
        table: undefined,
        detail: `Sort by ${(node['Sort Key'] ?? []).join(', ')}`,
      })
      continue
    }
    // An incremental sort reads its input in index order and sorts only the rows that tie
    // on the presorted keys: a sort only when those keys are ones most rows share.
    if (type === 'Incremental Sort') {
      const presorted = node['Presorted Key'] ?? []
      const selective = presorted.some((key) => {
        const column = /([a-z_]+)(?:\s+COLLATE\s+"C")?$/.exec(key.replace(/ DESC$/, ''))?.[1]
        return column !== undefined && !LOW_SELECTIVITY_NAMES.has(column)
      })
      if (!selective) {
        findings.push({
          kind: 'sort',
          table: undefined,
          detail: `Incremental Sort by ${(node['Sort Key'] ?? []).join(', ')} presorted only by ${presorted.join(', ') || 'nothing'}`,
        })
      }
    }
    // A hashed aggregate is not a sort: hashing is how Postgres groups, de-duplicates and
    // makes an IN list's subquery unique, and its input is judged by the scans below it.
  }
  return findings
}

/** Column names that are low-selectivity in some table, for a presorted key's check. */
const LOW_SELECTIVITY_NAMES: ReadonlySet<string> = new Set([
  WORKSPACE_COLUMN,
  ...[...LOW_SELECTIVITY.keys()].map((name) => name.slice(name.indexOf('.') + 1)),
])

/** The tables a plan reads, by name: not the target of a write, which a ModifyTable names. */
function tablesInPlan(plan: PlanNode, schema: Schema): string[] {
  const out: string[] = []
  for (const node of nodesOf(plan)) {
    if (node['Node Type'] === 'ModifyTable') continue
    const relation = node['Relation Name']
    if (relation !== undefined) out.push(relation)
    const index = node['Index Name']
    if (index !== undefined && relation === undefined) {
      const table = schema.tableOfIndex.get(index)
      if (table !== undefined) out.push(table)
    }
  }
  return out
}

/** The indexes a plan reads, by name. */
function indexesInPlan(plan: PlanNode): string[] {
  return nodesOf(plan).flatMap((node) =>
    node['Index Name'] === undefined ? [] : [node['Index Name']],
  )
}

// ---------------------------------------------------------------------------
// The definitions, in their Postgres form
// ---------------------------------------------------------------------------

/** A Postgres drizzle instance over the twins whose client refuses to run anything. */
function pgRecordingDrizzle() {
  const refuse = (): never => {
    throw new Error('the Postgres query-plan audit builds queries; it never runs them')
  }
  const client: QueryClient = {
    run: refuse,
    get: refuse,
    all: refuse,
    writeGet: refuse,
    writeAll: refuse,
    batch: refuse,
  }
  return buildPgStoreDrizzle(client, PG_TABLES)
}

/** The SQL of every statement in what a definition built (as the dialect census reads it). */
function sqlOf(built: unknown, depth = 0): string[] {
  if (built === null || typeof built !== 'object') return []
  const query = built as { getQuery?: () => { sql: string }; toSQL?: () => { sql: string } }
  if (typeof query.getQuery === 'function') return [query.getQuery().sql]
  if (typeof query.toSQL === 'function' && !isFragment(built)) return [query.toSQL().sql]
  if (depth < 2) return Object.values(built).flatMap((value) => sqlOf(value, depth + 1))
  return []
}

interface PgStatement {
  readonly key: string
  readonly shape: string | number | undefined
  readonly sql: string
}

/** Every definition's Postgres statements, at each family shape, without duplicates. */
function pgStatements(keyed: readonly KeyedDefinition[]): {
  statements: PgStatement[]
  buildErrors: string[]
  missingShapes: string[]
} {
  const db = pgRecordingDrizzle()
  const statements: PgStatement[] = []
  const buildErrors: string[] = []
  const missingShapes = new Set<string>()
  const seen = new Set<string>()
  for (const { key, definition } of keyed) {
    if (definition.kind === 'family' && !FAMILY_SHAPES.has(key)) missingShapes.add(key)
    const shapes: readonly (string | number | undefined)[] =
      definition.kind === 'family' ? (FAMILY_SHAPES.get(key) ?? []) : [undefined]
    for (const shape of shapes) {
      let built: unknown
      try {
        built = (definition.build as (db: unknown, key: unknown) => unknown)(db, shape)
      } catch (error) {
        buildErrors.push(`${key} [${String(shape)}]: ${(error as Error).message.split('\n')[0]}`)
        continue
      }
      for (const sql of sqlOf(built)) {
        const dedupe = `${key}\u0000${sql}`
        if (seen.has(dedupe)) continue
        seen.add(dedupe)
        statements.push({ key, shape, sql })
      }
    }
  }
  return { statements, buildErrors, missingShapes: [...missingShapes] }
}

interface AuditedStatement extends PgStatement {
  readonly plan: PlanNode
  readonly findings: readonly PlanFinding[]
  /**
   * The findings left when the planner may not sort, hash or scan sequentially where any
   * other plan exists: the structural ones, which no index can serve. Undefined for a clean
   * plan.
   */
  readonly structural?: readonly PlanFinding[]
}

/** Planner switches that leave only plans no index can replace (see {@link AuditedStatement}). */
const FORCED_SETTINGS = [
  'enable_seqscan',
  'enable_sort',
  'enable_incremental_sort',
  'enable_hashagg',
]

/** {@link explain} with the planner kept off every scan, sort and hash an index could replace. */
async function explainForced(db: AuditDb, sql: string): Promise<PlanNode> {
  return await db.begin(async (tx) => {
    for (const setting of FORCED_SETTINGS) await tx.unsafe(`SET LOCAL ${setting} = off`)
    return await explain(tx, sql)
  })
}

/** The plan of one `EXPLAIN (… FORMAT JSON)` result. */
function planOf(rows: readonly { 'QUERY PLAN': unknown }[]): PlanNode {
  const raw = rows[0]?.['QUERY PLAN']
  const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { Plan: PlanNode }[]
  const plan = parsed[0]?.Plan
  if (plan === undefined) throw new Error('EXPLAIN returned no plan')
  return plan
}

/** `EXPLAIN (GENERIC_PLAN, FORMAT JSON)` of one statement. */
async function explain(runner: Runner, sql: string): Promise<PlanNode> {
  return planOf(
    await rowsOf<{ 'QUERY PLAN': unknown }>(runner, `EXPLAIN (GENERIC_PLAN, FORMAT JSON) ${sql}`),
  )
}

/** Carries a plan out of a transaction that must roll back. */
class Planned extends Error {
  constructor(readonly plan: PlanNode) {
    super('rolled back after planning')
  }
}

/** `sql` with `$1, $2, ...` replaced by `values`, highest first so `$1` does not match `$10`. */
function withValues(sql: string, values: readonly string[]): string {
  let out = sql
  for (let n = values.length; n >= 1; n--) out = out.replaceAll(`$${n}`, values[n - 1] as string)
  return out
}

/** The plan of `sql` on the database as `shape` reshapes it, in a transaction rolled back. */
async function explainShaped(
  db: AuditDb,
  sql: string,
  shape: Omit<HintShape, 'reason'> & { readonly off?: readonly string[] },
): Promise<PlanNode> {
  try {
    await db.begin(async (tx) => {
      for (const setting of shape.off ?? []) await tx.unsafe(`SET LOCAL ${setting} = off`)
      for (const statement of shape.reshape ?? []) await tx.unsafe(statement)
      for (const table of shape.analyze ?? []) await tx.unsafe(`ANALYZE "${table}"`)
      const plan =
        shape.values === undefined
          ? await explain(tx, sql)
          : planOf(
              await rowsOf<{ 'QUERY PLAN': unknown }>(
                tx,
                `EXPLAIN (FORMAT JSON) ${withValues(sql, shape.values)}`,
              ),
            )
      throw new Planned(plan)
    })
  } catch (error) {
    if (error instanceof Planned) return error.plan
    throw error
  }
  throw new Error('the reshaped plan was not read')
}

/** The list entry for a statement: by `key [shape]` first, then by `key`. */
function listEntry(entry: PgStatement): string | undefined {
  for (const name of [`${entry.key} [${String(entry.shape)}]`, entry.key]) {
    const found = ALLOWLIST.get(name) ?? WHOLE_TABLE_READS.get(name) ?? SHAPE_DEBT.get(name)
    if (found !== undefined) return found
  }
  return undefined
}

/** Why a flagged statement is accepted, or undefined when it is not. */
function explanation(entry: AuditedStatement, schema: Schema): string | undefined {
  const listed = listEntry(entry)
  if (listed !== undefined) return listed
  const hinted = HINT_SHAPES.get(`${entry.key} [${String(entry.shape)}]`)
  if (hinted !== undefined) return hinted.reason
  const choice =
    PLANNER_CHOICES.get(`${entry.key} [${String(entry.shape)}]`) ?? PLANNER_CHOICES.get(entry.key)
  if (choice !== undefined) return choice.reason
  // Only scans of small tables, and sorts of rows read only from small tables.
  const read = tablesInPlan(entry.plan, schema)
  const scansSmall = entry.findings.every(
    (finding) => finding.kind === 'sort' || SMALL_TABLES.has(finding.table ?? ''),
  )
  if (scansSmall && read.length > 0 && read.every((table) => SMALL_TABLES.has(table))) {
    return 'small tables only'
  }
  if (
    entry.findings.every(
      (finding) => finding.kind === 'scan' && SMALL_TABLES.has(finding.table ?? ''),
    )
  ) {
    return 'scans of small tables only'
  }
  return undefined
}

const describeEntry = (entry: AuditedStatement): string =>
  `${entry.key} [${String(entry.shape ?? '')}]\n  ${entry.findings.map((f) => f.detail).join(' ; ')}\n  sql: ${entry.sql.slice(0, 600)}`

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

const SOURCE: SourceTree = {
  list: (dir) =>
    readdirSync(join(REPO_ROOT, dir), { recursive: true }).map((entry) =>
      relative(REPO_ROOT, join(REPO_ROOT, dir, String(entry)))
        .split('\\')
        .join('/'),
    ),
  read: (file) => readFileSync(join(REPO_ROOT, file), 'utf8'),
}

describe.runIf(ENGINE === 'pg')('every Postgres query is served by an index (POD-6992)', () => {
  let store: SessionStore
  let admin: AuditDb
  let schema: Schema
  let keyed: KeyedDefinition[]
  let audited: AuditedStatement[] = []
  let explainErrors: string[] = []
  let built: ReturnType<typeof pgStatements>
  let census: ReturnType<typeof keyedDefinitions>

  /** Plan one statement and read its findings. */
  const audit = async (statement: PgStatement): Promise<AuditedStatement> => {
    const plan = await explain(admin, statement.sql)
    const findings = planFindings(plan, schema)
    if (findings.length === 0) return { ...statement, plan, findings }
    const structural = planFindings(await explainForced(admin, statement.sql), schema)
    return { ...statement, plan, findings, structural }
  }

  beforeAll(async () => {
    // SQLite reaches the method-level definitions; the leg's opener refuses it by default.
    useRealMigrationChain()
    // No change capture: its guard refuses the rows the reach plants, as `openTestStore`'s.
    store = await SessionStore.open(':memory:', undefined, {
      changeCapture: 'whenLogAttaches',
      workspace: SELF_HOSTED_WORKSPACE_ID,
    })
    const firstAdmin = await store.users.earliestAdmin()
    if (firstAdmin) primeFirstAdminMember(firstAdmin.id)
    await reachMethodDefinitions(store, (store as unknown as { db: SqlDatabase }).db)
    census = keyedDefinitions(trackedSources(SOURCE), SOURCE)
    keyed = census.keyed
    built = pgStatements(keyed)
    const { url } = await clonePgTestDatabase('file')
    admin = openAuditDb(url)
    await seedRows(admin)
    schema = await readSchema(admin)
    const results: AuditedStatement[] = []
    const errors: string[] = []
    for (const statement of built.statements) {
      if (SQLITE_ONLY_DEFINITIONS.has(statement.key)) continue
      try {
        results.push(await audit(statement))
      } catch (error) {
        errors.push(
          `${statement.key} [${String(statement.shape)}]: ${(error as Error).message.split('\n')[0]} :: ${statement.sql.slice(0, 300)}`,
        )
      }
    }
    audited = results
    explainErrors = errors
  }, 600_000)

  afterAll(async () => {
    await admin?.end({ timeout: 5 })
    await store?.close()
  })

  // A reading aid, off by default: PODIUM_PLAN_AUDIT_SHOW=<key fragment>,… prints the
  // generic and forced plans of the matching statements.
  it('shows the plans asked for', async () => {
    const wanted = (process.env.PODIUM_PLAN_AUDIT_SHOW ?? '').split(',').filter(Boolean)
    const tree = (node: PlanNode, depth = 0): string[] => [
      `${'  '.repeat(depth)}${node['Node Type']}${node['Relation Name'] ? ` ${node['Relation Name']}` : ''}${node['Index Name'] ? ` using ${node['Index Name']}` : ''}${node['Index Cond'] ? ` [${node['Index Cond']}]` : ''}${node['Sort Key'] ? ` by ${node['Sort Key'].join(', ')}` : ''}`,
      ...(node.Plans ?? []).flatMap((child) => tree(child, depth + 1)),
    ]
    for (const entry of audited.filter((each) => wanted.some((w) => each.key.includes(w)))) {
      const forced = await explainForced(admin, entry.sql)
      console.log(
        `PLAN ${entry.key} [${String(entry.shape)}]\n${tree(entry.plan).join('\n')}\nFORCED\n${tree(forced).join('\n')}\nSQL ${entry.sql.slice(0, 900)}`,
      )
    }
  })

  it('reaches, builds and plans every query definition in its Postgres form', () => {
    console.log(
      `postgres query-plan audit: ${keyed.length} definitions reached, ${built.statements.length} statements built, ${audited.length} planned`,
    )
    expect(census.unmapped).toEqual([])
    expect(census.unregisteredSites).toEqual([])
    expect(built.missingShapes).toEqual([])
    expect(built.buildErrors).toEqual([])
    for (const error of [...built.buildErrors, ...explainErrors]) console.log(`ERROR ${error}`)
    expect(explainErrors).toEqual([])
    expect(keyed.length).toBeGreaterThan(500)
  })

  it('finds no scan or sort that is not explained', () => {
    const flagged = audited.filter((entry) => entry.findings.length > 0)
    const unexplained = flagged.filter((entry) => explanation(entry, schema) === undefined)
    console.log(
      `postgres query-plan audit: ${audited.length} statements, ${flagged.length} scan or sort, ` +
        `${flagged.length - unexplained.length} explained (${ALLOWLIST.size} allowlisted, ` +
        `${WHOLE_TABLE_READS.size} whole-table reads, ${SHAPE_DEBT.size} query-shape debts, ` +
        `${SMALL_TABLES.size} small tables), ${unexplained.length} unexplained`,
    )
    for (const entry of unexplained) console.log(`UNEXPLAINED ${describeEntry(entry)}`)
    for (const entry of unexplained) {
      console.log(
        `FORCED ${entry.key} [${String(entry.shape ?? '')}] :: ${(entry.structural ?? []).map((f) => f.detail).join(' ; ') || 'clean'}`,
      )
    }
    expect(unexplained.map((entry) => `${entry.key} [${String(entry.shape ?? '')}]`)).toEqual([])
  })

  it('lists no query as an exception whose plan is clean, or that no longer exists', () => {
    const byKey = new Map<string, AuditedStatement[]>()
    for (const entry of audited) {
      for (const name of [entry.key, `${entry.key} [${String(entry.shape)}]`]) {
        byKey.set(name, [...(byKey.get(name) ?? []), entry])
      }
    }
    const stale = [
      ...ALLOWLIST.keys(),
      ...WHOLE_TABLE_READS.keys(),
      ...SHAPE_DEBT.keys(),
      ...PLANNER_CHOICES.keys(),
    ].filter((name) => !(byKey.get(name) ?? []).some((entry) => entry.findings.length > 0))
    for (const name of stale) console.log(`STALE ${name}`)
    expect(stale).toEqual([])
    // A SQLite-only definition must still exist (it is skipped, so it has no plan).
    const built = new Set(keyed.map((entry) => entry.key))
    expect([...SQLITE_ONLY_DEFINITIONS.keys()].filter((name) => !built.has(name))).toEqual([])
  })

  it('plans every statement that names an index on SQLite through the same index', async () => {
    const sqliteForms = builtStatements(keyed).built
    const hinted = new Map<string, string>()
    for (const { key, shape, statement } of sqliteForms) {
      const match = /indexed by "?([a-z0-9_]+)"?/i.exec(statement.sql)
      if (match) hinted.set(`${key} [${String(shape)}]`, match[1] as string)
    }
    const missed: string[] = []
    const shapedButClean: string[] = []
    for (const [name, index] of hinted) {
      const plans = audited.filter((entry) => `${entry.key} [${String(entry.shape)}]` === name)
      const shape = HINT_SHAPES.get(name)
      if (plans.some((entry) => indexesInPlan(entry.plan).includes(index))) {
        if (shape !== undefined) shapedButClean.push(name)
        continue
      }
      const shaped: PlanNode[] = []
      for (const entry of shape === undefined ? [] : plans) {
        shaped.push(await explainShaped(admin, entry.sql, shape as HintShape))
      }
      const accepted = [index, ...(shape?.alsoReads === undefined ? [] : [shape.alsoReads])]
      if (shaped.some((plan) => indexesInPlan(plan).some((each) => accepted.includes(each)))) {
        continue
      }
      const read = (list: readonly PlanNode[]) =>
        list.map((plan) => indexesInPlan(plan).join(', ') || 'no index').join(' | ')
      missed.push(
        `${name}: SQLite names ${index}; Postgres reads ${read(plans.map((entry) => entry.plan))}${shape ? `, and on its shape ${read(shaped)}` : ''}`,
      )
    }
    expect(shapedButClean).toEqual([])
    expect([...HINT_SHAPES.keys()].filter((name) => !hinted.has(name))).toEqual([])
    console.log(`postgres query-plan audit: ${hinted.size} statements carry INDEXED BY on SQLite`)
    for (const line of missed) console.log(`HINT ${line}`)
    expect(hinted.size).toBeGreaterThan(5)
    expect(missed).toEqual([])
  })

  it('proves every planner choice: an index serves the statement', async () => {
    const failures: string[] = []
    const names = new Set(
      audited.flatMap((entry) => [entry.key, `${entry.key} [${String(entry.shape)}]`]),
    )
    for (const [name, choice] of PLANNER_CHOICES) {
      if (!names.has(name)) {
        failures.push(`${name}: no such statement`)
        continue
      }
      const entries = audited.filter(
        (entry) => entry.key === name || `${entry.key} [${String(entry.shape)}]` === name,
      )
      for (const entry of entries) {
        const plan = await explainShaped(admin, entry.sql, choice)
        const left = planFindings(plan, schema).filter(
          (finding) => !(finding.kind === 'scan' && SMALL_TABLES.has(finding.table ?? '')),
        )
        const reads = indexesInPlan(plan)
        if (left.length > 0 || (choice.reads !== undefined && !reads.includes(choice.reads))) {
          failures.push(
            `${name} [${String(entry.shape)}]: ${left.map((finding) => finding.detail).join(' ; ') || 'clean'}; reads ${reads.join(', ') || 'no index'}`,
          )
        }
      }
    }
    for (const line of failures) console.log(`CHOICE ${line}`)
    expect(failures).toEqual([])
  })

  it('uses every expression index of the Postgres schema', async () => {
    // The point (design 2.3, rule 12) is that a query writes the indexed expression exactly,
    // or the planner cannot match it. A small table is scanned whatever its indexes, so an
    // index not read on the seed is planned again for each statement over its table with
    // sequential scans barred: a matching expression then reads the index.
    const used = new Set(audited.flatMap((entry) => indexesInPlan(entry.plan)))
    for (const [name, { table }] of schema.expressionIndexes) {
      if (used.has(name)) continue
      for (const entry of audited.filter((each) =>
        tablesInPlan(each.plan, schema).includes(table),
      )) {
        const plan = await explainShaped(admin, entry.sql, { off: ['enable_seqscan'] })
        if (indexesInPlan(plan).includes(name)) {
          used.add(name)
          console.log(
            `postgres query-plan audit: ${name} matches ${entry.key} [${String(entry.shape)}]`,
          )
          break
        }
      }
    }
    const unused = [...schema.expressionIndexes]
      .filter(([name]) => !used.has(name) && !EXPRESSION_INDEXES_UNUSED.has(name))
      .map(([name, { definition }]) => `${name}: ${definition}`)
    const stale = [...EXPRESSION_INDEXES_UNUSED.keys()].filter(
      (name) => used.has(name) || !schema.expressionIndexes.has(name),
    )
    console.log(
      `postgres query-plan audit: ${schema.expressionIndexes.size} expression indexes: ${[...schema.expressionIndexes.keys()].join(', ')}`,
    )
    for (const line of unused) console.log(`UNUSED ${line}`)
    expect(unused).toEqual([])
    expect(stale).toEqual([])
  })

  it('reads the message readers through the recipient index, not a status scan (POD-5941)', () => {
    for (const name of ['deliveredUnacked', 'settleNotifiable', 'pendingForSessionProof']) {
      const plans = audited.filter(
        (entry) => entry.key === `apps/server/src/store/messages.ts:${name}`,
      )
      expect(plans.length, name).toBeGreaterThan(0)
      for (const entry of plans) {
        const indexes = indexesInPlan(entry.plan)
        // The recipient's own index, by its name as the SQLite test reads it (a prefix).
        expect(
          indexes.some((index) => index.startsWith('idx_messages_delivered_to')),
          `${name}: ${indexes.join(', ')}`,
        ).toBe(true)
        expect(
          indexes.filter((index) => index.startsWith('idx_messages_delivery_')),
          name,
        ).toEqual([])
      }
    }
  })

  it("reads the shipping dependents through the active orders' partial index", async () => {
    // As the SQLite test asks it (`shipping-lane-reads.test.ts`): the queued orders that
    // depend on one issue, on a database whose orders are mostly shipped history, for the
    // state's value itself. A generic plan cannot know the state is `queued`.
    const entry = audited.find(
      (each) =>
        each.key === 'apps/server/src/store/shipping.ts:queuedDependentsOfIds' && each.shape === 1,
    )
    expect(entry).toBeDefined()
    const plan = await explainShaped(admin, (entry as AuditedStatement).sql, {
      reshape: [`UPDATE ship_orders SET state = 'shipped' WHERE right(id, 2) <> '00'`],
      analyze: ['ship_orders'],
      values: [WS_LITERAL, "'queued'", "'dependency'"],
    })
    expect(indexesInPlan(plan)).toContain('idx_ship_orders_one_active_issue')
  })

  it('reads in index order where SQLite does, NULL order included (POD-6992)', () => {
    // The Postgres indexes that store NULLs first (PG_INDEX_NULLS_FIRST) and the partial
    // index for rows with no recipient id: before them, each of these sorted on Postgres.
    const sorted: string[] = []
    const keys = [
      'apps/server/src/store/effects.ts:effectsInStatus',
      'apps/server/src/store/effects.ts:expireDueEffects',
      'apps/server/src/store/janitor-reads.ts:explicitExpiryFirst',
      'apps/server/src/store/janitor-reads.ts:explicitExpiryAfter',
      'apps/server/src/store/messages.ts:messagesAddressedTo',
    ]
    const entries = audited.filter((entry) => keys.includes(entry.key))
    // The repo-seq listing through the repository index, its order intact.
    const listing = audited.filter(
      (entry) =>
        entry.key === 'apps/server/src/store/issue-listings.ts:issueListing' &&
        String(entry.shape).includes('repo-seq') &&
        indexesInPlan(entry.plan).includes('idx_issues_repo_id_seq'),
    )
    for (const entry of [...entries, ...listing]) {
      if (nodesOf(entry.plan).some((node) => node['Node Type'] === 'Sort')) {
        sorted.push(`${entry.key} [${String(entry.shape)}]`)
      }
    }
    expect(entries.length).toBeGreaterThan(keys.length)
    expect(sorted).toEqual([])
  })

  it('fails a planted unindexed lookup and a planted sort', async () => {
    const lookup = await audit({
      key: 'planted:lookup',
      shape: undefined,
      sql: 'select "id" from "messages" where "workspace_id" = $1 and "body" = $2',
    })
    expect(lookup.findings.map((finding) => finding.kind)).toContain('scan')
    expect(explanation(lookup, schema)).toBeUndefined()
    const sorted = await audit({
      key: 'planted:sort',
      shape: undefined,
      sql: 'select "id" from "messages" where "workspace_id" = $1 and "id" = any($2) order by "body"',
    })
    expect(sorted.findings.map((finding) => finding.kind)).toContain('sort')
    expect(explanation(sorted, schema)).toBeUndefined()
    // A keyed lookup on the same table is clean.
    const keyedRead = await audit({
      key: 'planted:keyed',
      shape: undefined,
      sql: 'select "body" from "messages" where "workspace_id" = $1 and "id" = $2',
    })
    expect(keyedRead.findings).toEqual([])
  })
})
