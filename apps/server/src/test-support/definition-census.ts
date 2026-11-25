/**
 * THE QUERY DEFINITION CENSUS THE STORE AUDITS SHARE [POD-6148, POD-6227, POD-7014].
 *
 * Two audits build every repository query without running it: the query-plan
 * audit (`store/query-plan-audit.test.ts`) plans each statement, and the
 * workspace-scope audit (`store/workspace-scope-audit.test.ts`) reads which
 * workspace each one touches. Both need the same set, reached the same way, so
 * this module holds it once:
 *
 *   - `FAMILY_SHAPES`, the shapes each family is built at;
 *   - `reachMethodDefinitions`, which drives the methods that make their
 *     definitions on first use;
 *   - `keyedDefinitions`, which pairs every registered definition with its
 *     source site, and `builtStatements`, which builds each one;
 *   - the raw SQL census and its two lists (`RAW_SQL_PLANNED`, `RAW_SQL_EXEMPT`).
 *
 * ONE MODULE INSTANCE (see the query-plan audit): a file that uses this opens
 * one store and reaches each definition site exactly once.
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asIssueId, asMachineId, asRepoId, firstAdminMemberId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { type PreparedDefinition, preparedDefinitions } from '@podium/sync/adapters/sqlite/prepared'
import { fixtureWriteScope } from '@podium/sync/testing'
import type { SessionStore } from '../store'
import { auditedCollectionShapes } from '../store/collections'
import { shapeOf } from '../store/executor/sync-drizzle'
import { type IssueListingShape, listingKey } from '../store/issue-listings'
import { LEGACY_WORKTREE_MIGRATION } from '../store/issues'
import { issueRowFixture } from './issue-row'
import {
  censusScope,
  type QueryDefinitionSite,
  queryDefinitionSites,
  type RawSqlSite,
  rawSqlScope,
  rawSqlSites,
} from './prepared-census'
import {
  type BuiltStatement,
  definitionFrame,
  recordingDrizzle,
  siteContaining,
  statementsOf,
} from './query-plan-audit'

export const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..')

export const SIZES = [1, 4] as const

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
  // A search page (POD-7108): the first, and one after a cursor.
  { live: true, text: true, limit: true, order: 'priority-seq' },
  { live: true, text: true, after: true, limit: true, order: 'priority-seq' },
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

export const FAMILY_SHAPES: ReadonlyMap<string, readonly (string | number)[]> = new Map<
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
  ['apps/server/src/store/user-layout.ts:worktreesOfSessions', SIZES],
  ['apps/server/src/store/users.ts:insertInvite', ['id']],
  ['apps/server/src/store/conversations/registry.ts:segmentsWithPaths', SIZES],
  ['apps/server/src/store/conversations/registry.ts:parentsOf', SIZES],
  ['apps/server/src/store/conversations/registry.ts:nativeIdsOf', SIZES],
  ['apps/server/src/store/conversations/registry.ts:pathsOfNativeIds', SIZES],
  // The lake conversion's keyset pages (POD-7053): the first page and each later one.
  ['apps/server/src/store/conversations/mirror.ts:lakeConversionSegments', ['start', 'after']],
  ['apps/server/src/store/conversations/mirror.ts:lakeConversionArchived', ['start', 'after']],
  ['apps/server/src/store/transcript-costs.ts:costsOfIssues', SIZES],
  ['apps/server/src/store/grants.ts:grantsOfResources', SIZES],
  // Credential management Task 4: the credentials a person was given, their
  // allowed machines, and the grants to a person or to all members.
  ['apps/server/src/store/credentials.ts:credentialsByIds', SIZES],
  ['apps/server/src/store/credentials.ts:allowedMachinesOfMany', SIZES],
  ['apps/server/src/store/grants.ts:grantsToGrantees', SIZES],
  // A removed member's keys (POD-7594): their grants, chunked at 500.
  ['apps/server/src/store/grants.ts:deleteGrantsOfCredentials', SIZES],
  ['apps/server/src/store/grants.ts:ownersOfCredentials', SIZES],
  ['apps/server/src/store/grants.ts:reparentGrantsOnCredentials', SIZES],
  // The notice inbox (POD-6881): the open notices a record build names, chunked at 500.
  ['apps/server/src/store/notices.ts:openOfIds', SIZES],
  // A Concertmaster's conversation (POD-7211): the entries a record build names, chunked at 500.
  ['apps/server/src/store/concertmaster.ts:entriesOfIds', SIZES],
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
  // A flight deck's seat columns, provenance, children and open asks (POD-7431).
  ['apps/server/src/store/sessions.ts:seatFactsOfIssueIds', SIZES],
  ['apps/server/src/store/sessions.ts:seatFactsOfIds', SIZES],
  ['apps/server/src/store/sessions.ts:seatFactsOfResumeValues', SIZES],
  ['apps/server/src/store/issues.ts:liveIssuesStartedBy', SIZES],
  ['apps/server/src/store/issues.ts:liveUnarchivedChildRows', SIZES],
  ['apps/server/src/store/interactions.ts:openCountsOfSessions', SIZES],
  ['apps/server/src/store/sessions.ts:upsertSessionOfShape', ['0|id', '31|id']],
  ['apps/server/src/store/sessions.ts:offersOfIds', SIZES],
  ['apps/server/src/store/sessions.ts:draftTimesOfIds', SIZES],
  ['apps/server/src/store/observation-checkpoints.ts:checkpointedLeasesOfIds', SIZES],
  ['apps/server/src/store/observation-checkpoints.ts:checkpointRecordFactsOfIds', SIZES],
  ['apps/server/src/store/observation-checkpoints.ts:leasesOfIds', SIZES],
  ['apps/server/src/store/observation-checkpoints.ts:terminalCandidatesOfIds', SIZES],
  // The set fence of a daemon attach's probes (POD-7574).
  ['apps/server/src/store/observation-checkpoints.ts:leaseIdentitiesOfIds', SIZES],
  ['apps/server/src/store/observation-checkpoints.ts:advanceLeaseGenerationsOfIds', SIZES],
  ['apps/server/src/store/observation-checkpoints.ts:deleteTerminalCandidatesOfIds', SIZES],
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
  ['apps/server/src/store/issues.ts:issueAccessByIds', SIZES],
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
      // One subject's page newest first below a cursor, bookkeeping kinds left out (POD-5832).
      'b1|k0|x1|r0|s1|desc',
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
  ['packages/sync/src/adapters/sqlite/sync-repository.ts:upsertAccessMoves', SIZES],
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
  // The search key table's DDL and its catch-up (POD-7022: the workspace column).
  [
    'apps/server/src/store/conversations/transcript-index.ts:createTranscriptKeys',
    ['table', 'drop'],
  ],
  [
    'apps/server/src/store/conversations/transcript-index.ts:catchUpKeys',
    ['all|owned', 'all|every', 'after-last|owned', 'after-last|every'],
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
export const RAW_SQL_PLANNED: ReadonlyMap<string, string> = new Map([])

export const RAW_SQL_EXEMPT: ReadonlyMap<string, string> = new Map([
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
    'apps/server/src/store/legacy-plaintext.ts',
    "Boot-only legacy step that destroys the old plaintext keys once the vault holds them, on the store's exclusive lane before the server serves, and skipped once its state row in meta says done with no old row left: meta by primary key, and accounts and workspace_secrets, both small tables. PRAGMAs and VACUUM are no queries.",
  ],
  [
    'apps/server/src/store/legacy-plaintext-jobs.ts',
    'Legacy plaintext cleanup job on its own connection in a worker thread: VACUUM of the file and the WAL checkpoint that folds the compacted copy back in, and the snapshot scrub over retained backups. PRAGMAs and VACUUM are no queries.',
  ],
  [
    'apps/server/src/store/native-login-transfer-sweep.ts',
    'Boot-only legacy sweep on the migration connection, before anything else opens the file: one count per secrets table of the leftover login transfer rows (small tables), and the delete with its secure_delete and WAL checkpoint PRAGMAs only when one is left.',
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
 * How a census reads the repository: every path under a directory, and a file's text. Each
 * audit makes its own from `node:fs`, so the test file itself shows that it reads source it
 * does not import, which is what puts it in the shard whose inputs are the whole tree
 * (`scripts/server-test-shards.ts`, rule 2).
 */
export interface SourceTree {
  /** The repository path of every entry under `dir`, recursively, with `/` separators. */
  list(dir: string): string[]
  /** The text of the file at a repository path. */
  read(file: string): string
}

/** The repository sources the definition census covers. */
export function trackedSources(tree: SourceTree): string[] {
  return censusScope(
    ['apps/server/src/store', 'packages/sync/src/adapters/sqlite'].flatMap((dir) => tree.list(dir)),
  )
}

/** Every raw SQL statement in the server's and the sync package's production source [POD-6227]. */
export function rawSqlCensus(tree: SourceTree): RawSqlSite[] {
  const paths = ['apps/server/src', 'packages/sync/src'].flatMap((dir) => tree.list(dir))
  return rawSqlScope(paths).flatMap((file) => rawSqlSites(file, tree.read(file)))
}

export const rawKey = (site: RawSqlSite): string => `${site.file}:${site.sql}`

/** Why a raw statement is not planned, or undefined when nothing exempts it. */
export function rawExemption(site: RawSqlSite): string | undefined {
  const byKey = RAW_SQL_EXEMPT.get(rawKey(site))
  if (byKey !== undefined) return byKey
  for (const [key, reason] of RAW_SQL_EXEMPT) {
    if (key === site.file || (key.endsWith('/') && site.file.startsWith(key))) return reason
  }
  return undefined
}

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
export async function reachMethodDefinitions(
  target: SessionStore,
  database: SqlDatabase,
): Promise<void> {
  // The full-text tables are made at runtime when search is enabled, not by a migration.
  await target.conversations.ensureFts(true)
  const machineId = asMachineId(target.hostMachine!.id)
  const now = new Date().toISOString()
  database
    .prepare(
      'INSERT INTO machines (workspace_id, id, name, hostname, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(target.workspaceId, machineId, 'audit', 'audit', 'audit-token-hash', now, now)
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
    .prepare(
      'INSERT OR IGNORE INTO repos (workspace_id, machine_id, path, added_at) VALUES (?, ?, ?, ?)',
    )
    .run(target.workspaceId, machineId, '/audit/three/', new Date().toISOString())
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

/** A query builder that is not a statement: a subquery another definition embeds. */
export function isFragment(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  if (typeof (value as { getSQL?: unknown }).getSQL === 'function') return true
  const parts = Object.values(value)
  return parts.length > 0 && parts.every(isFragment)
}

/** A definition the audit checks, by the key its lists use. */
export interface KeyedDefinition {
  readonly key: string
  readonly definition: PreparedDefinition
}

/**
 * Every registered definition paired with its source site, plus the coverage
 * facts: sites never reached, and definitions no site accounts for.
 *
 * A definition is paired with the site whose call spans the source line its
 * stack names (`siteContaining`), so the pairing of one definition does not
 * depend on any other, on the order the engine reports positions in, or on a
 * column [POD-7064]. `unmapped` lists each definition whose frame lands in a
 * census file but on no site, or on a site of the other kind (a family on a
 * plain definition, or the reverse): either means the frame is not where the
 * call is, and a census that took it would key the definition wrongly.
 */
export function keyedDefinitions(
  sources: readonly string[],
  tree: SourceTree,
): {
  sites: QueryDefinitionSite[]
  keyed: KeyedDefinition[]
  unregisteredSites: string[]
  unmapped: string[]
} {
  const sites = sources.flatMap((file) => queryDefinitionSites(file, tree.read(file)))
  const sitesByFile = new Map<string, QueryDefinitionSite[]>()
  for (const site of sites)
    sitesByFile.set(site.file, [...(sitesByFile.get(site.file) ?? []), site])
  const unmapped = new Set<string>()
  const registered = new Set<QueryDefinitionSite>()
  const keyed: KeyedDefinition[] = []
  for (const definition of preparedDefinitions()) {
    const frame = definitionFrame(definition.site, REPO_ROOT)
    const fileSites = frame && sitesByFile.get(frame.file)
    if (!frame || !fileSites) continue
    const site = siteContaining(fileSites, frame.line)
    const at = `${frame.file}:${frame.line}:${frame.column}`
    if (!site) {
      unmapped.add(`${at}: a ${definition.kind} definition on no definition site`)
      continue
    }
    if (site.kind !== definition.kind) {
      unmapped.add(`${at}: a ${definition.kind} definition on ${site.kind} site ${site.name}`)
      continue
    }
    registered.add(site)
    keyed.push({ key: `${site.file}:${site.name}`, definition })
  }
  return {
    sites,
    keyed,
    unregisteredSites: sites
      .filter((site) => !registered.has(site))
      .map((site) => `${site.file}:${site.startLine} ${site.name}`),
    unmapped: [...unmapped],
  }
}

/** One statement a definition built, at one of its shapes. */
export interface BuiltDefinitionStatement {
  readonly key: string
  readonly shape: string | number | undefined
  readonly definition: PreparedDefinition
  readonly statement: BuiltStatement
}

/**
 * Build each definition at each of its shapes on a drizzle instance that
 * records instead of running, and collect every statement (once per key and
 * SQL text), with what could not be built.
 */
export function builtStatements(
  keyed: readonly KeyedDefinition[],
  shapesOf: (key: string) => readonly (string | number)[] | undefined = (key) =>
    FAMILY_SHAPES.get(key),
): {
  built: BuiltDefinitionStatement[]
  fragments: string[]
  missingShapes: string[]
  buildErrors: string[]
} {
  const recording = recordingDrizzle()
  const built: BuiltDefinitionStatement[] = []
  const fragments = new Set<string>()
  const missingShapes = new Set<string>()
  const buildErrors: string[] = []
  const seen = new Set<string>()
  for (const { key, definition } of keyed) {
    if (definition.kind === 'family' && shapesOf(key) === undefined) missingShapes.add(key)
    const shapes: readonly (string | number | undefined)[] =
      definition.kind === 'family' ? (shapesOf(key) ?? []) : [undefined]
    for (const shape of shapes) {
      let result: unknown
      let statements: BuiltStatement[]
      try {
        result = (definition.build as (db: unknown, key: unknown) => unknown)(recording, shape)
        statements = statementsOf(result)
      } catch (error) {
        buildErrors.push(`${key} [${String(shape)}]: ${(error as Error).message}`)
        continue
      }
      if (statements.length === 0) {
        if (isFragment(result)) fragments.add(key)
        else buildErrors.push(`${key} [${String(shape)}]: built no statement`)
      }
      for (const statement of statements) {
        const dedupe = `${key}\u0000${statement.sql}`
        if (seen.has(dedupe)) continue
        seen.add(dedupe)
        built.push({ key, shape, definition, statement })
      }
    }
  }
  return {
    built,
    fragments: [...fragments],
    missingShapes: [...missingShapes],
    buildErrors,
  }
}
