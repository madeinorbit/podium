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

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asIssueId, asMachineId, asRepoId, firstAdminMemberId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import {
  PREPARED_DEFINITION_LIMIT,
  type PreparedDefinition,
  preparedDefinitions,
} from '@podium/sync/adapters/sqlite/prepared'
import { fixtureWriteScope } from '@podium/sync/testing'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { messages } from '../migrations/schema'
import { PLANNER_STATISTICS_ROW_FLOOR } from '../migrations/store-lifecycle'
import type { SessionStore } from '../store'
import { issueRowFixture } from '../test-support/issue-row'
import { openTestStore } from '../test-support/open-test-store'
import {
  OPERATOR_PLANNER_STATISTICS,
  OPERATOR_STATISTICS_CAPTURED_AT,
} from '../test-support/operator-planner-statistics'
import {
  censusScope,
  type QueryDefinitionSite,
  queryDefinitionSites,
  type RawSqlSite,
  rawSqlScope,
  rawSqlSites,
} from '../test-support/prepared-census'
import {
  type BuiltStatement,
  definitionFrame,
  explain,
  matchSites,
  type PlanFinding,
  planFindings,
  recordingDrizzle,
  statementsOf,
  tablesOf,
} from '../test-support/query-plan-audit'
import { auditedCollectionShapes } from './collections'
import { param, prepared, type StoreDrizzle, shapeOf } from './executor/sync-drizzle'
import { type IssueListingShape, listingKey } from './issue-listings'
import { LEGACY_WORKTREE_MIGRATION } from './issues'

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..')

const SIZES = [1, 4] as const

/**
 * The shapes each family is audited at, keyed `file:name`. A family's key
 * comes from a finite domain; list each value whose SQL differs in a way the
 * plan can see (each optional filter on its own, each principal shape). A
 * family missing here fails the audit.
 */
/**
 * The issue listing shapes the reports use (POD-6191, `modules/issues/service/
 * reads.ts`), each scoped to a repository and filtered for a reader, and each
 * across every repository unrestricted; the search shape with every filter.
 */
const LISTING_BASES: readonly Omit<IssueListingShape, 'repo'>[] = [
  { live: false, order: 'repo-seq' },
  { live: true, state: 'ready', order: 'priority-seq' },
  { live: true, state: 'blocked', order: 'priority-seq' },
  { live: true, order: 'path-seq' },
  { live: true, parents: 1, order: 'path-seq' },
  { live: true, unarchived: true, parents: 1, order: 'path-seq' },
  { live: true, state: 'open', completeParent: true, order: 'path-seq' },
  { live: true, state: 'open', order: 'seq' },
  { live: true, state: 'open', updatedBefore: true, order: 'updated' },
  { live: false, state: 'open', parents: 1, order: 'repo-seq' },
  { live: true, state: 'ready', order: 'repo-seq' },
  { live: true, state: 'closed', hasWorktree: true, order: 'repo-seq' },
  { live: true, state: 'closed', ids: 1, order: 'repo-seq' },
  {
    live: true,
    state: 'open',
    stage: true,
    priority: true,
    type: true,
    assignee: true,
    parent: true,
    label: true,
    text: true,
    order: 'priority-seq',
  },
  { live: true, deferred: true, order: 'priority-seq' },
  { live: true, unarchived: true, state: 'open', topLevel: true, order: 'seq' },
  { live: true, unarchived: true, state: 'closed', topLevel: true, order: 'path-seq' },
  { live: false, hasWorktree: true, order: 'path-seq' },
  { live: true, deferred: true, order: 'path-seq' },
  { live: true, unarchived: true, hasWorktree: true, order: 'path-seq' },
  { live: true, text: true, order: 'path-seq' },
]
const LISTING_KEYS = LISTING_BASES.flatMap((base) => [
  listingKey({ ...base, repo: true }),
  listingKey({ ...base, repo: false }),
])
const SCOPE_KEYS = [
  listingKey({ live: true, order: 'path-seq', repo: true }),
  listingKey({ live: true, order: 'path-seq', repo: false }),
]

const FAMILY_SHAPES: ReadonlyMap<string, readonly (string | number)[]> = new Map<
  string,
  readonly (string | number)[]
>([
  // The collection fetch (POD-7085): every shape the record declarations can ask.
  ['apps/server/src/store/collections.ts:collectionRows', auditedCollectionShapes()],
  [
    'apps/server/src/store/settings-audit.ts:securityEventsNewestFirst',
    ['all', 'people', 'machines', 'credentials', 'comments'].flatMap((kind) =>
      [0, 1].flatMap((actor) => [0, 1].map((refused) => `${kind}|${actor}|${refused}`)),
    ),
  ],
  // The record builders' by-id reads (POD-6763).
  ['apps/server/src/store/automations.ts:liveAutomationsOfIds', SIZES],
  ['apps/server/src/store/automations.ts:liveRunsOfIds', SIZES],
  // The windowed kinds' reads (POD-6766).
  ['apps/server/src/store/messages.ts:confirmedChatTail', ['live|1', 'live|4', 'any|1', 'any|4']],
  ['apps/server/src/store/interactions.ts:openInteractionsOfIds', SIZES],
  ['apps/server/src/store/events.ts:feedEventsOfSubjects', SIZES],
  ['apps/server/src/store/events.ts:feedEventsOfIds', SIZES],
  ['apps/server/src/store/sessions.ts:pinsOfUsers', SIZES],
  // The change capture's mappings (POD-6920): a captured row to its records.
  ['apps/server/src/store/sessions.ts:personalRecordKeysOfUsers', SIZES],
  ['apps/server/src/store/issues.ts:issuesOfLabels', SIZES],
  ['apps/server/src/store/workflows.ts:runIdsOfRevisions', SIZES],
  ['apps/server/src/store/sessions.ts:tabOrdersOfUsers', SIZES],
  ['apps/server/src/store/superagent.ts:threadsOfIds', SIZES],
  ['apps/server/src/store/workflows.ts:workflowsOfIds', SIZES],
  ['apps/server/src/store/workflows.ts:revisionsOfIds', SIZES],
  ['apps/server/src/store/workflows.ts:runsOfIds', SIZES],
  ['apps/server/src/store/workflows.ts:stepsOfRuns', SIZES],
  ['apps/server/src/store/events.ts:subscriptionsOfIds', SIZES],
  ['apps/server/src/store/checkouts.ts:checkoutsOfMachines', SIZES],
  ['apps/server/src/store/user-read-position.ts:positionRowsPage', ['start', 'after']],
  ['apps/server/src/store/effects.ts:liveEffectsOfIds', SIZES],
  ['apps/server/src/store/shipping.ts:queuedOrdersOfLane', SIZES],
  ['apps/server/src/store/shipping.ts:ordersOfIds', SIZES],
  ['apps/server/src/store/shipping.ts:shippedPredecessorsPage', [0, 1, 4]],
  ['apps/server/src/store/shipping.ts:queuedDependentsOfIds', SIZES],
  ['apps/server/src/store/shipping.ts:stackEdgesFromUppers', SIZES],
  ['apps/server/src/store/shipping.ts:openHoldsOfOrders', SIZES],
  ['apps/server/src/store/shipping.ts:receiptsOfOrders', SIZES],
  ['apps/server/src/store/shipping.ts:issueIdsOfOrders', SIZES],
  ['apps/server/src/store/shipping.ts:orderIdsOfIssues', SIZES],
  ['apps/server/src/store/shipping.ts:queuedOrdersOfLanes', ['1x1', '1x4', '4x4']],
  ['apps/server/src/store/automations.ts:automationOwnersOfIds', SIZES],
  ['apps/server/src/store/automations.ts:runOwnersOfIds', SIZES],
  ['apps/server/src/store/effects.ts:audiencesOfIds', SIZES],
  [
    'apps/server/src/store/effects.ts:settleEffect',
    ['running', 'succeeded', 'failed', 'cancelled', 'expired', 'unknown'],
  ],
  ['apps/server/src/store/effects.ts:effectsInStatus', ['pending', 'running']],
  ['apps/server/src/store/effects.ts:decideEffect', ['approve', 'deny']],
  ['apps/server/src/store/effects.ts:newestOnTargetIn', ['active', 'succeeded']],
  ['apps/server/src/store/effects.ts:liveOnTargetKeys', ['1x1', '2x4', '2x512', '4x512']],
  ['apps/server/src/store/user-layout.ts:layoutRowsPage', ['start', 'after']],
  ['apps/server/src/store/users.ts:insertInvite', ['id']],
  ['apps/server/src/store/conversations/registry.ts:segmentsWithPaths', SIZES],
  ['apps/server/src/store/conversations/registry.ts:parentsOf', SIZES],
  ['apps/server/src/store/conversations/registry.ts:nativeIdsOf', SIZES],
  ['apps/server/src/store/conversations/registry.ts:pathsOfNativeIds', SIZES],
  ['apps/server/src/store/transcript-costs.ts:costsOfIssues', SIZES],
  ['apps/server/src/store/grants.ts:grantsOfResources', SIZES],
  ['apps/server/src/store/grants.ts:grantsOfResourceKeys', ['1x1', '2x4', '4x512']],
  ['apps/server/src/store/shipping.ts:activeOrdersOfLane', SIZES],
  ['apps/server/src/store/grants.ts:audiencesOf', SIZES],
  ['apps/server/src/store/machines.ts:machinesByIds', SIZES],
  // A machine's checkouts, its roots, and each member's reach and lost
  // checkouts on it, for a batch of machines (POD-6644).
  ['apps/server/src/store/checkouts.ts:pathsOfMachines', SIZES],
  ['apps/server/src/store/checkouts.ts:rootPathsOfMachines', SIZES],
  ['apps/server/src/store/checkouts.ts:reachOfMachines', SIZES],
  ['apps/server/src/store/checkouts.ts:lostOfMachines', SIZES],
  // Reach writes use bounded power-of-two shapes; include the padded maximum.
  ['apps/server/src/store/checkouts.ts:upsertReach', [1, 4, 512]],
  ['apps/server/src/store/checkouts.ts:deleteReach', [1, 4, 512]],
  ['apps/server/src/store/checkouts.ts:insertLost', [1, 4, 512]],
  ['apps/server/src/store/checkouts.ts:deleteLost', [1, 4, 512]],
  ['apps/server/src/store/users.ts:accountsByIds', SIZES],
  ['apps/server/src/store/issues.ts:worktreeOwnersOf', SIZES],
  ['apps/server/src/store/issues.ts:liveWorktreesOnMachines', SIZES],
  ['apps/server/src/store/issues.ts:issueClosureRowsOf', SIZES],
  ['apps/server/src/store/grants.ts:upsertGrant', ['set', 'keep']],
  ['apps/server/src/store/grants.ts:deleteGrantsOfResource', ['retain', 'all']],
  ['apps/server/src/store/sessions.ts:personalRecordKeys', SIZES],
  ['apps/server/src/store/sessions.ts:bindingOwnersOfIds', SIZES],
  ['apps/server/src/store/sessions.ts:bindingFactsOfIds', SIZES],
  ['apps/server/src/store/sessions.ts:sessionsOfIds', SIZES],
  ['apps/server/src/store/sessions.ts:publishSessionActivity', SIZES],
  ['apps/server/src/store/sessions.ts:liveSessionsOfResumeValues', SIZES],
  ['apps/server/src/store/sessions.ts:liveSessionsOfIssueIds', SIZES],
  ['apps/server/src/store/sessions.ts:upsertSessionOfShape', ['0|id', '31|id']],
  ['apps/server/src/store/sessions.ts:offersOfIds', SIZES],
  ['apps/server/src/store/sessions.ts:draftTimesOfIds', SIZES],
  ['apps/server/src/store/observation-checkpoints.ts:checkpointedLeasesOfIds', SIZES],
  ['apps/server/src/store/observation-checkpoints.ts:leasesOfIds', SIZES],
  ['apps/server/src/store/observation-checkpoints.ts:terminalCandidatesOfIds', SIZES],
  ['apps/server/src/store/messages.ts:pendingForSessionsProof', SIZES],
  ['apps/server/src/store/events.ts:runtimeTranscriptSubjectsOfIds', SIZES],
  ['apps/server/src/store/conversations/registry.ts:podiumIdsOfSegments', SIZES],
  ['apps/server/src/store/conversations/index.ts:curatedConversationsOf', SIZES],
  ['apps/server/src/store/conversations/index.ts:recordRows', SIZES],
  ['apps/server/src/store/conversations/index.ts:recordPage', ['start', 'after']],
  ['apps/server/src/store/issue-git-states.ts:byIds', SIZES],
  ['apps/server/src/store/issue-git-states.ts:pageOf', ['start', 'after']],
  ['apps/server/src/store/issue-panel.ts:todoPage', ['start', 'after']],
  ['apps/server/src/store/issue-panel.ts:todoByIds', SIZES],
  ['apps/server/src/store/issue-panel.ts:todoOfIssues', SIZES],
  ['apps/server/src/store/issue-panel.ts:artifactPage', ['start', 'after']],
  ['apps/server/src/store/issue-panel.ts:artifactByIds', SIZES],
  ['apps/server/src/store/issue-panel.ts:artifactOfIssues', SIZES],
  ['apps/server/src/store/issue-panel.ts:deferredPage', ['start', 'after']],
  ['apps/server/src/store/issue-panel.ts:deferredByIds', SIZES],
  ['apps/server/src/store/issue-panel.ts:deferredOfIssues', SIZES],
  ['apps/server/src/store/issue-panel.ts:statePage', ['start', 'after']],
  ['apps/server/src/store/issue-panel.ts:stateByIds', SIZES],
  ['apps/server/src/store/issue-panel.ts:stateOfIssues', SIZES],
  ['apps/server/src/store/machines.ts:machineRecordPage', ['start', 'after']],
  ['apps/server/src/store/sessions.ts:liveSessionsOfStatuses', SIZES],
  ['apps/server/src/store/sessions.ts:liveSessionsOfBirthLetter', SIZES],
  ['apps/server/src/store/sessions.ts:liveSessionsReferencingIssues', SIZES],
  ['apps/server/src/store/sessions.ts:liveSessionsSpawnedBy', SIZES],
  ['apps/server/src/store/sessions.ts:readAtOfUserSessions', SIZES],
  ['apps/server/src/store/sessions.ts:snoozesOfUserSessions', SIZES],
  ['apps/server/src/store/events.ts:turnStatesOfIds', SIZES],
  ['apps/server/src/store/events.ts:relationshipSubscriptionFor', SIZES],
  ['apps/server/src/store/events.ts:matchingSubscriptions', ['r|1', 'a|1', 'ra|4']],
  ['apps/server/src/store/sessions.ts:upsertSessionsOfShape', ['2|0|id', '4|1|id', '4|31|id']],
  ['apps/server/src/store/superagent.ts:setThreadBinding', ['podiumSessionId,updatedAt']],
  ['apps/server/src/store/machines.ts:rotateCredentialOf', ['null', 'key']],
  ['apps/server/src/store/issues.ts:issuesByIds', SIZES],
  ['apps/server/src/store/issues.ts:issueUserStatesOf', SIZES],
  ['apps/server/src/store/issues.ts:issueRefsAtSeqsOf', SIZES],
  ['apps/server/src/store/issue-listings.ts:issueListing', LISTING_KEYS],
  ['apps/server/src/store/issue-listings.ts:issueCountGroups', SCOPE_KEYS],
  ['apps/server/src/store/issue-listings.ts:issueStatTotals', SCOPE_KEYS],
  ['apps/server/src/store/issue-listings.ts:deferralsOf', SCOPE_KEYS],
  ['apps/server/src/store/issue-listings.ts:labelsOfIssues', SIZES],
  ['apps/server/src/store/issue-listings.ts:depsFromIssues', SIZES],
  ['apps/server/src/store/issue-listings.ts:depsToIssues', SIZES],
  ['apps/server/src/store/issue-listings.ts:commentCountsOfIssues', SIZES],
  ['apps/server/src/store/issue-listings.ts:liveChildrenOf', SIZES],
  ['apps/server/src/store/issue-listings.ts:sortScopeOf', ['parent', 'top', 'top-unpinned']],
  ['apps/server/src/store/issues.ts:labelsNamed', SIZES],
  ['apps/server/src/store/issues.ts:patchLabel', ['color', 'description', 'color,description']],
  ['apps/server/src/store/issues.ts:commentSearch', ['all', 'limited']],
  ['apps/server/src/store/issues.ts:issueRowsPage', ['start', 'after']],
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
  ['apps/server/src/store/messages.ts:attachmentMessagesOfItems', SIZES],
  ['apps/server/src/store/messages.ts:messagesAddressedTo', ['no-id', 'id']],
  ['apps/server/src/store/messages.ts:ledger', ['issue', 'session', 'both']],
  ['apps/server/src/store/messages.ts:pendingPages', SIZES],
  ['apps/server/src/store/messages.ts:pendingTargetsAmong', SIZES],
  [
    'apps/server/src/store/messages.ts:pendingSummaryOf',
    ['no-id', 'id', 'session', 'session-blank'],
  ],
  [
    'apps/server/src/store/messages.ts:pendingSendersOf',
    ['no-id', 'id', 'session', 'session-blank'],
  ],
  ['apps/server/src/store/messages.ts:pendingCountOf', ['no-id', 'id', 'session', 'session-blank']],
  ['apps/server/src/store/messages.ts:existingIdsAmong', SIZES],
  ['apps/server/src/store/messages.ts:receiptsAmong', SIZES],
  ['apps/server/src/store/messages.ts:sentAmong', SIZES],
  ['apps/server/src/store/messages.ts:communicatedSince', ['no-id', 'id']],
  ['apps/server/src/store/messages.ts:swapHarnessRef', ['null', 'text']],
  ['apps/server/src/store/messages.ts:openBoundTo', ['1', '4', '1|issue', '4|issue']],
  ['apps/server/src/store/messages.ts:queuedPage', ['start', 'after']],
  ['apps/server/src/store/messages.ts:wakeCooldownsOf', SIZES],
  ['apps/server/src/store/messages.ts:pendingDeliveredToPage', ['start', 'after']],
  ['packages/sync/src/adapters/sqlite/sync-repository.ts:insertChangeRows', SIZES],
  ['packages/sync/src/adapters/sqlite/sync-repository.ts:installedRowsOfKeys', SIZES],
  ['packages/sync/src/adapters/sqlite/sync-repository.ts:changesWithPrior', SIZES],
  ['packages/sync/src/adapters/sqlite/sync-repository.ts:installedIdsUnderPrefixes', SIZES],
  [
    'packages/sync/src/adapters/sqlite/sync-repository.ts:serverTableQueries.queuedCounts',
    ['all', 'one', ...SIZES],
  ],
  [
    'apps/server/src/store/workflows.ts:workflowsWhere',
    ['a1|s0|r0', 'a0|s0|r0', 'a0|s1|r0', 'a0|s1|r1', 'a1|s0|r1'],
  ],
  ['apps/server/src/store/workflows.ts:insertRunSteps', SIZES],
  // The feed's visibility facts for a batch of workflow-family rows (POD-6676).
  ['apps/server/src/store/workflows.ts:workflowOwnersOfIds', SIZES],
  ['apps/server/src/store/workflows.ts:revisionWorkflowsOfIds', SIZES],
  ['apps/server/src/store/workflows.ts:bindingOwnersOfTargets', SIZES],
  ['apps/server/src/store/workflows.ts:runOwnersOfIds', SIZES],
  [
    'apps/server/src/store/conversations/index.ts:recentConversations',
    [
      'dated|any',
      'dated|posix',
      'dated|windows',
      'undated|any',
      'undated|posix',
      'undated|windows',
    ],
  ],
  [
    'apps/server/src/store/conversations/index.ts:searchConversations',
    ['fts|any', 'fts|posix', 'fts|windows', 'like|any', 'like|posix', 'like|windows'],
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
    'apps/server/src/store/sessions.ts:anySession',
    'One-row existence probe for setup: LIMIT 1 stops at the first stored session, including tombstones. Reads at most one row regardless of history.',
  ],
  [
    'apps/server/src/store/issues.ts:issuesOfLabels',
    "The change capture's mapping of renamed labels to the issues carrying them (POD-6920): found through idx_issue_labels_label_id, the distinct issue ids sorted in a temporary tree, a few per label; a label rename is rare.",
  ],
  [
    'apps/server/src/store/effects.ts:newestOnTargetIn [active]',
    "Sorts only the active effect records: the seek on idx_effects_status_deadline reads the pending and running ones, a few in the whole table, never a target's finished history (POD-7031).",
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
  [
    'apps/server/src/store/transcript-costs.ts:costCount',
    'Whole-table read (POD-6172): countAll is a test oracle only; no production code calls it.',
  ],
])

/**
 * RAW SQL OUTSIDE THE REPOSITORIES [POD-6227]. A statement handed straight to
 * a database handle (`db.prepare(sql)`) is no `prepared(...)` definition, so
 * the census above never sees it. The raw census (`rawSqlSites`) lists every
 * such statement in the server's and the sync package's production source,
 * and each must be on one of these two lists, keyed `file:sql` (the SQL with
 * its whitespace folded):
 * - PLANNED: run against this database's schema, so the audit plans it like a
 *   repository query and the same lists explain a scan or a sort. The value
 *   says why it is raw rather than a repository query.
 * - EXEMPT (by key, by file, or by directory with a trailing `/`): not a
 *   query on the server's tables at run time, with the reason.
 * A raw statement added anywhere in that source fails the census until it is
 * listed, and a listed key with no site left fails it too.
 */
const RAW_SQL_PLANNED: ReadonlyMap<string, string> = new Map([])

const RAW_SQL_EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    'apps/server/src/store/executor/',
    'The drivers: they prepare the statements the repositories built, which the audit plans at their definitions.',
  ],
  [
    'apps/server/src/migrations/',
    'Migration bookkeeping and boot repair (sqlite_master, the migration ledger, VACUUM INTO, quick_check): run once at boot or by a maintenance command before the server serves, on the schema the migrations are building.',
  ],
  [
    'packages/sync/src/adapters/mobile-sqlite/',
    "The phone replica's own database (its outbox and meta tables), not the server's.",
  ],
  [
    'apps/server/src/installation-identity-import.ts',
    'One-time data migration at boot, on the exclusive migration connection, behind its receipt (installation_identity_import_v1): meta and server_secrets by primary key.',
  ],
  [
    'apps/server/src/settings-config-import.ts',
    'One-time data migration at boot of the legacy config.json settings, on the exclusive migration connection, behind its receipt (settings_config_import_v1).',
  ],
  [
    'apps/server/src/enrollment-ledger-import.ts',
    'One-time data migration at boot of the legacy enrollment ledger file, on the exclusive migration connection, behind its marker (enrollment_ledger_imported).',
  ],
  [
    'apps/server/src/fingerprint-key-import.ts',
    'One-time data migration at boot of the legacy fingerprint key file, on the exclusive migration connection, behind its receipt (secret_fingerprint_import_v1).',
  ],
  [
    'apps/server/src/relay.ts:input',
    "Not SQL: the session instruction registry's `prepare(input)`, which builds a session's start instructions.",
  ],
  [
    'apps/server/src/modules/sessions/instructions.ts:context',
    "Not SQL: an instruction provider's `prepare(context)`, which builds a session's start instructions.",
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
    'apps/server/src/store/collections.ts:collectionRows [|session.asking#ids#]',
    'Query shape: the sessions that ask (POD-7085) read the agent state each record carries, the runtime turn state over the observation checkpoint over the row, and the offer unless a later input made it stale; no index serves an expression over three tables. Stored as one derived column on the session row it would be an index seek; reported to POD-5910 as the follow-up.',
  ],
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

/** Every raw SQL statement in the server's and the sync package's production source [POD-6227]. */
function rawSqlCensus(): RawSqlSite[] {
  const paths: string[] = []
  for (const dir of ['apps/server/src', 'packages/sync/src']) {
    for (const entry of readdirSync(join(REPO_ROOT, dir), { recursive: true })) {
      paths.push(
        relative(REPO_ROOT, join(REPO_ROOT, dir, String(entry)))
          .split('\\')
          .join('/'),
      )
    }
  }
  return rawSqlScope(paths).flatMap((file) =>
    rawSqlSites(file, readFileSync(join(REPO_ROOT, file), 'utf8')),
  )
}

const rawKey = (site: RawSqlSite): string => `${site.file}:${site.sql}`

/** Why a raw statement is not planned, or undefined when nothing exempts it. */
function rawExemption(site: RawSqlSite): string | undefined {
  const byKey = RAW_SQL_EXEMPT.get(rawKey(site))
  if (byKey !== undefined) return byKey
  for (const [key, reason] of RAW_SQL_EXEMPT) {
    if (key === site.file || (key.endsWith('/') && site.file.startsWith(key))) return reason
  }
  return undefined
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
  await attempt(() => target.issues.upsertIssue(fixtureWriteScope(), issue))
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
  // A base branch set on a path-derived id whose origin already has a prefix
  // row elsewhere: gaining that origin carries the base branch across.
  await attempt(() => target.repos.addRepo('/audit/five', machineId))
  await attempt(() => target.repos.setRepoDefaultParentBranch(machineId, '/audit/five', 'develop'))
  await attempt(() =>
    target.repos.addRepo('/audit/six', machineId, 'https://example.invalid/five.git', 'AUDF'),
  )
  await attempt(() =>
    target.repos.updateRepoOrigin(machineId, '/audit/five', 'https://example.invalid/five.git'),
  )
  await attempt(() => target.repos.removeRepo('/audit/one', machineId))

  await attempt(() =>
    target.messages.addMessage(fixtureWriteScope(), {
      id: 'msg_audit',
      threadId: 'msg_audit',
      fromKind: 'operator',
      fromId: null,
      toKind: 'issue',
      toId: 'iss_audit',
      body: 'audit',
      createdAt: issue.createdAt,
      deliveryStatus: 'stored',
    } as unknown as Parameters<typeof target.messages.addMessage>[1]),
  )
  await attempt(() => target.messages.markCancelled(fixtureWriteScope(), 'msg_audit'))

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
function modelLowSelectivity(db: SqlDatabase, options?: { replace?: boolean }): void {
  writeStatistics(
    db,
    (table, columns) =>
      LOW_SELECTIVITY.has(`${table}.${columns[0]}`)
        ? ['1000000', '250000', ...columns.slice(1).map(() => '1')].join(' ')
        : undefined,
    options,
  )
}

/**
 * Replace every statistics row with the one `statOf` gives each index (none
 * where it gives undefined), and reload them into this connection's planner.
 */
function writeStatistics(
  db: SqlDatabase,
  statOf: (table: string, columns: readonly string[]) => string | undefined,
  { replace = true }: { replace?: boolean } = {},
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
    const columns = db.prepare(`PRAGMA index_info(${JSON.stringify(name)})`).all() as {
      name: string
    }[]
    const stat = statOf(
      tableName,
      columns.map((column) => column.name),
    )
    if (stat !== undefined) insert.run(tableName, name, stat)
  }
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
  const recording = recordingDrizzle()
  const tables = tablesOf(database)
  const audited: AuditedStatement[] = []
  const fragments = new Set<string>()
  const missingShapes = new Set<string>()
  const buildErrors: string[] = []
  const explainErrors: string[] = []
  const seen = new Set<string>()
  for (const { key, definition } of keyed) {
    if (definition.kind === 'family' && shapesOf(key) === undefined) missingShapes.add(key)
    const shapes: readonly (string | number | undefined)[] =
      definition.kind === 'family' ? (shapesOf(key) ?? []) : [undefined]
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
    const audited = [...auditDefinitions(keyed).audited, ...auditRawSql(rawSqlCensus())]
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
    const openChat = audited.filter(
      (entry) => entry.key === 'apps/server/src/store/messages.ts:openChat',
    )
    expect(openChat.map((entry) => entry.plan)).toEqual([
      ['SCAN messages USING INDEX idx_messages_open_chat'],
    ])
  })

  it('reads the boot ref backfill candidates by index ranges on the ref-less partial indexes (POD-6222)', () => {
    const { keyed } = keyedDefinitions(trackedSources())
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
        'SEARCH s USING INDEX idx_sessions_refless_place (machine_id=? AND cwd>? AND cwd<?)',
        'UNION ALL',
        'SCAN o VIRTUAL TABLE INDEX 1:',
        'SEARCH s USING INDEX idx_sessions_refless_place (machine_id=? AND cwd>?)',
        'UNION ALL',
        'SEARCH s USING INDEX idx_sessions_refless_issue (issue_id>?)',
        'SEARCH i EXISTS USING COVERING INDEX sqlite_autoindex_issues_1 (id=?)',
        'USE TEMP B-TREE FOR ORDER BY',
      ],
    ])
  })

  it('reads the active ship orders through their partial index (POD-6172)', () => {
    const { keyed } = keyedDefinitions(trackedSources())
    const { audited } = auditDefinitions(keyed)
    const active = audited.filter(
      (entry) => entry.key === 'apps/server/src/store/shipping.ts:activeOrdersFifo',
    )
    expect(active.map((entry) => entry.plan)).toEqual([
      [
        'SCAN ship_orders USING INDEX idx_ship_orders_one_active_issue',
        'USE TEMP B-TREE FOR ORDER BY',
      ],
    ])
  })

  it('reads the open trains of shipped leaders through their partial index (POD-6207)', () => {
    const { keyed } = keyedDefinitions(trackedSources())
    const { audited } = auditDefinitions(keyed)
    const open = audited.filter(
      (entry) => entry.key === 'apps/server/src/store/shipping.ts:shippedLeadersOfOpenTrains',
    )
    expect(open.map((entry) => entry.plan)).toEqual([
      [
        'SCAN ship_train_manifests USING INDEX idx_ship_train_manifests_open_lane',
        'SEARCH ship_orders USING INDEX sqlite_autoindex_ship_orders_1 (id=?)',
      ],
    ])
  })

  it('reads the subscriptions a steward poll can match, each arm on its own index (POD-6208)', () => {
    const { keyed } = keyedDefinitions(trackedSources())
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
    // The explicit sources by event and source; the relationship ones by their
    // anchor subscriber, never by event alone (which would read every
    // relationship row of the kind).
    expect(searches('matchingSubscriptions', 'ra|4')).toEqual([
      'sessions idx_sessions_issue',
      'subscriptions idx_subscriptions_match',
      'subscriptions idx_subscriptions_subscriber_event',
      'subscriptions idx_subscriptions_subscriber_event',
    ])
    expect(searches('relationshipSubscriptionFor', 4)).toEqual([
      'subscriptions idx_subscriptions_match',
    ])
  })

  it('reads each history page through its index, with no scan and no sort (POD-6209)', () => {
    const { keyed } = keyedDefinitions(trackedSources())
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
    const { keyed } = keyedDefinitions(trackedSources())
    const audited = [...auditDefinitions(keyed).audited, ...auditRawSql(rawSqlCensus())]
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
    const sites = rawSqlCensus()
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
      [
        String(rows),
        // A low-selectivity column holds a quarter of the rows per value, any
        // other leading column ten (SQLite's own guess), the rest one.
        String(
          LOW_SELECTIVITY.has(`${table}.${columns[0]}`)
            ? Math.max(1, rows / 4)
            : Math.min(rows, 10),
        ),
        ...columns.slice(1).map(() => '1'),
      ].join(' ')

  const unexplained = (): string[] => {
    const { keyed } = keyedDefinitions(trackedSources())
    const { audited } = auditDefinitions(keyed)
    return audited
      .filter((entry) => entry.findings.length > 0 && explanation(entry) === undefined)
      .map((entry) => `${entry.key} [${String(entry.shape ?? '')}]`)
  }

  afterEach(() => modelLowSelectivity(database))

  it('is armed: statistics from one-row tables steer the queries of growing tables into scans', () => {
    writeStatistics(database, analysedAt(1))
    const flagged = unexplained()
    // The runtime-event drain the bench caught scanning (POD-6216), and the
    // other tables that start empty and grow.
    expect(flagged).toEqual(
      expect.arrayContaining([
        'apps/server/src/store/events.ts:runtimeEventsAfter []',
        'apps/server/src/store/messages.ts:queuedAheadOf []',
        'apps/server/src/store/conversations/registry.ts:segmentsWithPaths [4]',
        'apps/server/src/store/sessions.ts:liveSessionsOnMachine []',
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
      const { keyed } = keyedDefinitions(trackedSources())
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
    for (const [index, stat] of OPERATOR_EFFECTS_STATISTICS) insert.run(index, stat)
    database.exec('ANALYZE sqlite_schema')
  }

  const effectPlans = (): Map<string, string> => {
    const { keyed } = keyedDefinitions(trackedSources())
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
          "EXPLAIN QUERY PLAN SELECT * FROM effects WHERE status = ? AND deleted_at IS NULL AND (decision IS NULL OR decision <> 'awaiting') ORDER BY deadline_at LIMIT ?",
        )
        .all(null, null) as { detail: string }[]
    )
      .map((row) => row.detail)
      .join(' | ')
    expect(plan).not.toMatch(/\(deleted_at=\?\)/)
    expect(plan).toMatch(/^SEARCH effects USING INDEX idx_effects_status_deadline \(status=\?\)/)
  })

  it('each sweep statement seeks its own index, with no scan and no sort', () => {
    useOperatorStatistics()
    const plans = effectPlans()
    const expected: readonly (readonly [string, RegExp])[] = [
      // Both statuses build one statement (the status is bound): the audit
      // plans it once, under its first shape.
      [
        'effectsInStatus [pending]',
        /^SEARCH effects USING INDEX idx_effects_status_deadline \(status=\?\)$/,
      ],
      [
        'expireDueEffects',
        /SEARCH effects USING INDEX idx_effects_status_deadline \(status=\? AND deadline_at>\? AND deadline_at<\?\)/,
      ],
      [
        'pruneFinishedEffects',
        /SEARCH effects USING INDEX idx_effects_status_finished \(status=\? AND finished_at<\?\)/,
      ],
      ['purgeTombstones', /SEARCH effects USING INDEX idx_effects_tombstones \(deleted_at<\?\)/],
      [
        'purgeOffFeedFinished',
        /SEARCH candidate USING INDEX idx_effects_kind_target \(kind=\?\).*SEARCH newer USING INDEX idx_effects_kind_target \(kind=\? AND target_kind=\? AND target_id=\? AND created_at>\?\)/,
      ],
      // A machine's last scan (POD-7031): the target's records newest first,
      // where the first hit is nearly always the newest succeeded one.
      [
        'newestOnTargetIn [succeeded]',
        /^SEARCH effects USING INDEX idx_effects_kind_target \(kind=\? AND target_kind=\? AND target_id=\?\)$/,
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
      'SEARCH effects USING INDEX idx_effects_status_deadline (status=?) | USE TEMP B-TREE FOR ORDER BY',
    )
    // Armed: unpinned, the statistics send it through the target's history.
    const unpinned = (
      database
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM effects WHERE kind = ? AND target_kind = ? AND target_id = ? AND status IN ('pending', 'running') AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
        )
        .all(null, null, null) as { detail: string }[]
    )
      .map((row) => row.detail)
      .join(' | ')
    expect(unpinned).toBe(
      'SEARCH effects USING INDEX idx_effects_kind_target (kind=? AND target_kind=? AND target_id=?)',
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
        `INSERT INTO effects (id, kind, target_kind, target_id, input_json, result_json, status,
           finished_at, created_at, updated_at, revision)
         VALUES (?, 'machine.scan', 'machine', ?, '{}', ?, ?, ?, ?, ?, 1)`,
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
      const seekIndex = /USING INDEX (\S+) \(status=\?\)/.exec(plan)?.[1] ?? ''
      expect(seekIndex, plan).toBe('idx_effects_status_deadline')
      const rangeRows = (from: string, where: string): number =>
        (
          db
            .prepare(`SELECT count(*) AS n FROM effects INDEXED BY ${from} WHERE ${where}`)
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
      .filter(([, plan]) => /\(deleted_at=\?\)|SCAN effects\b/.test(plan))
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
  const useOperatorStatistics = (): { applied: number; skipped: string[] } => {
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
      insert.run(table, index, stat)
      applied++
    }
    database.exec('ANALYZE sqlite_schema')
    return { applied, skipped }
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
      const terms = search[2]!.split(' AND ').map((term) => /^(\w+)=\?$/.exec(term.trim())?.[1])
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
    const { keyed } = keyedDefinitions(trackedSources())
    modelLowSelectivity(database)
    const modelled = [...auditDefinitions(keyed).audited, ...auditRawSql(rawSqlCensus())]
    useOperatorStatistics()
    const operator = [
      ...auditDefinitions(keyed, operatorShapes).audited,
      ...auditRawSql(rawSqlCensus()),
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
    const { applied, skipped } = useOperatorStatistics()
    console.log(
      `operator statistics (${OPERATOR_STATISTICS_CAPTURED_AT}): ${applied} rows applied, ` +
        `${skipped.length} name an index the schema no longer has: ${skipped.join(', ')}`,
    )
    // A fixture that applies nothing plans on the defaults and passes.
    expect(applied).toBeGreaterThan(100)
    expect(
      (database.prepare('SELECT COUNT(*) AS n FROM sqlite_stat1').get() as { n: number }).n,
    ).toBe(applied)
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
      `SELECT * FROM sessions WHERE spawned_by IN (${Array.from({ length: size }, () => '?').join(', ')}) AND deleted_by_issue_id IS NULL`
    const columns = new Set(['sessions.deleted_by_issue_id'])
    const walks = (size: number) =>
      nullWalks(explain(database, { sql: planted(size), params: size }), planted(size), columns)
    expect(walks(1)).toEqual([])
    expect(walks(16)).toEqual([
      'SEARCH sessions USING INDEX idx_sessions_deleted_by_issue (deleted_by_issue_id=?)',
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
