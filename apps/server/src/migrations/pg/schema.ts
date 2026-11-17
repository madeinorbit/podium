/**
 * THE SERVER SCHEMA ON POSTGRES [POD-6978, POD-6958 design 2.2, 2.3].
 *
 * The twin of `../schema.ts`, table for table, under the same export names, so the
 * store's binding (`store/executor/binding.ts`) hands a query definition these tables
 * as its `t` on Postgres and the same definition source builds native Postgres SQL.
 *
 * GENERATED ONCE by `scripts/generate-pg-schema.ts`, then kept as source. A schema
 * change edits `../schema.ts` and then reruns `bun run schema:pg` or edits this file by
 * hand; `schema-parity.test.ts` (structure and Postgres types) and
 * `schema-parity.type-test.ts` (row types) fail until the two agree. A deliberate
 * difference goes in `schema-overrides.ts`, with its reason, which the generator keeps.
 *
 * The native types of design 2.3 (operator decision OD5); the column classes are declared
 * in `schema-classes.ts`:
 *
 * | column class (SQLite)                 | Postgres                      | Drizzle here       |
 * |--------------------------------------|-------------------------------|--------------------|
 * | ISO timestamp text (class timestamp) | `timestamptz(3)`              | `isoTimestamp`     |
 * | JSON text (class json)               | `json`                        | `jsonText`         |
 * | JSON, `mode: 'json'`                 | `json`                        | `jsonValue`        |
 * | other text (class text)              | `text COLLATE "C"`            | `textC`            |
 * | integer                              | `bigint`                      | `int8`             |
 * | integer one-column primary key       | `bigint` identity, by default | `int8` + identity  |
 * | integer, `mode: 'boolean'`           | `boolean`                     | `boolean`          |
 * | real                                 | `double precision`            | `doublePrecision`  |
 *
 * Every column's TypeScript type is its SQLite twin's, by reference
 * (`$type<SqliteRow<'table'>['column']>()`), so a brand or a value union cannot drift; the
 * Postgres driver (`store/executor/pg-types.ts`) makes the values match at run time.
 * The column types are the sync package's, shared by both twins.
 */

/**
 * THE IDENTITY TABLES are the identity package's Postgres schema, re-exported as `../schema.ts`
 * re-exports its SQLite one. The package owns both twins and runs one suite on both
 * (`packages/identity/src/testing`); the library tables keep the names the cloud already has,
 * exported here under the server schema's names.
 */
export {
  account as identityAccount,
  identityInvitation,
  identityMembership,
  identityMembershipEvent,
  identityOneTimeCode,
  identityWorkspaceRevision,
  rateLimit as identityRateLimit,
  session as identitySession,
  user as identityUser,
  verification as identityVerification,
} from '@podium/identity/schema/pg'

/** Tables only the Postgres schema has: see `PG_ONLY_TABLES` in `schema-overrides.ts`. */
export { transcriptText } from './pg-only-tables'

import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import {
  int8,
  isoTimestamp,
  jsonText,
  jsonValue,
  textC,
} from '../../../../../packages/sync/src/adapters/pg/schema'
import type * as sqlite from '../schema'

/** The SQLite row of the twin table, whose column types every twin column takes. */
type SqliteRow<T extends keyof typeof sqlite> = (typeof sqlite)[T] extends {
  readonly $inferSelect: infer Row
}
  ? Row
  : never

export const accountMachineSends = pgTable(
  'account_machine_sends',
  {
    accountId: textC('account_id').notNull().$type<SqliteRow<'accountMachineSends'>['accountId']>(),
    machineId: textC('machine_id').notNull().$type<SqliteRow<'accountMachineSends'>['machineId']>(),
    sentAt: isoTimestamp('sent_at').notNull().$type<SqliteRow<'accountMachineSends'>['sentAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'accountMachineSends'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'account_machine_sends_pk',
      columns: [table.workspaceId, table.accountId, table.machineId],
    }),
    foreignKey({
      name: 'fk_account_machine_sends_account_id_accounts_id_fk',
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [accounts.workspaceId, accounts.id],
    }).onDelete('cascade'),
  ],
)

export const accounts = pgTable(
  'accounts',
  {
    id: textC('id').notNull().$type<SqliteRow<'accounts'>['id']>(),
    provider: textC('provider').notNull().$type<SqliteRow<'accounts'>['provider']>(),
    kind: textC('kind').notNull().$type<SqliteRow<'accounts'>['kind']>(),
    credential: textC('credential').notNull().$type<SqliteRow<'accounts'>['credential']>(),
    identity: textC('identity')
      .notNull()
      .default(sql`''`)
      .$type<SqliteRow<'accounts'>['identity']>(),
    scope: textC('scope').notNull().default(sql`'role'`).$type<SqliteRow<'accounts'>['scope']>(),
    createdAt: int8('created_at').notNull().$type<SqliteRow<'accounts'>['createdAt']>(),
    ownerUserId: textC('owner_user_id').$type<SqliteRow<'accounts'>['ownerUserId']>(),
    ref: textC('ref').$type<SqliteRow<'accounts'>['ref']>(),
    accountKey: textC('account_key').$type<SqliteRow<'accounts'>['accountKey']>(),
    sharedWith: textC('shared_with').$type<SqliteRow<'accounts'>['sharedWith']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'accounts'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'accounts_pk', columns: [table.workspaceId, table.id] }),
    uniqueIndex('accounts_owner_account_key').on(
      table.workspaceId,
      table.ownerUserId,
      table.accountKey,
    ),
    index('idx_accounts_account_key').on(table.workspaceId, table.accountKey),
  ],
)

export const agentProfiles = pgTable(
  'agent_profiles',
  {
    id: textC('id').notNull().$type<SqliteRow<'agentProfiles'>['id']>(),
    name: textC('name').notNull().$type<SqliteRow<'agentProfiles'>['name']>(),
    description: textC('description')
      .notNull()
      .default(sql`''`)
      .$type<SqliteRow<'agentProfiles'>['description']>(),
    candidatesJson: jsonText('candidates_json')
      .notNull()
      .default(sql`'[]'`)
      .$type<SqliteRow<'agentProfiles'>['candidatesJson']>(),
    machineId: textC('machine_id').$type<SqliteRow<'agentProfiles'>['machineId']>(),
    instructions: textC('instructions')
      .notNull()
      .default(sql`''`)
      .$type<SqliteRow<'agentProfiles'>['instructions']>(),
    createdBy: textC('created_by').$type<SqliteRow<'agentProfiles'>['createdBy']>(),
    updatedBy: textC('updated_by').$type<SqliteRow<'agentProfiles'>['updatedBy']>(),
    createdAt: isoTimestamp('created_at')
      .notNull()
      .$type<SqliteRow<'agentProfiles'>['createdAt']>(),
    updatedAt: isoTimestamp('updated_at')
      .notNull()
      .$type<SqliteRow<'agentProfiles'>['updatedAt']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'agentProfiles'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'agent_profiles_pk', columns: [table.workspaceId, table.id] }),
    unique('agent_profiles_name_unique').on(table.workspaceId, table.name),
  ],
)

export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: textC('id').notNull().$type<SqliteRow<'approvalRequests'>['id']>(),
    machineId: textC('machine_id').notNull().$type<SqliteRow<'approvalRequests'>['machineId']>(),
    sessionId: textC('session_id').notNull().$type<SqliteRow<'approvalRequests'>['sessionId']>(),
    issueId: textC('issue_id').$type<SqliteRow<'approvalRequests'>['issueId']>(),
    opJson: jsonText('op_json').notNull().$type<SqliteRow<'approvalRequests'>['opJson']>(),
    status: textC('status')
      .notNull()
      .default(sql`'pending'`)
      .$type<SqliteRow<'approvalRequests'>['status']>(),
    createdAt: isoTimestamp('created_at')
      .notNull()
      .$type<SqliteRow<'approvalRequests'>['createdAt']>(),
    actor: textC('actor').$type<SqliteRow<'approvalRequests'>['actor']>(),
    onBehalfOf: textC('on_behalf_of').$type<SqliteRow<'approvalRequests'>['onBehalfOf']>(),
    decidedAt: isoTimestamp('decided_at').$type<SqliteRow<'approvalRequests'>['decidedAt']>(),
    resultText: textC('result_text').$type<SqliteRow<'approvalRequests'>['resultText']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'approvalRequests'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'approval_requests_pk', columns: [table.workspaceId, table.id] }),
    index('idx_approval_requests_status').on(table.workspaceId, table.status, table.createdAt),
    check(
      'approval_requests_check_4',
      sql`status IN ('pending','denied','executing','succeeded','failed')`,
    ),
  ],
)

export const artifactUploads = pgTable(
  'artifact_uploads',
  {
    issueId: textC('issue_id').notNull().$type<SqliteRow<'artifactUploads'>['issueId']>(),
    uploadId: textC('upload_id').notNull().$type<SqliteRow<'artifactUploads'>['uploadId']>(),
    beginJson: jsonText('begin_json').notNull().$type<SqliteRow<'artifactUploads'>['beginJson']>(),
    receivedJson: jsonText('received_json')
      .notNull()
      .$type<SqliteRow<'artifactUploads'>['receivedJson']>(),
    createdAt: int8('created_at').notNull().$type<SqliteRow<'artifactUploads'>['createdAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'artifactUploads'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'artifact_uploads_pk',
      columns: [table.workspaceId, table.issueId, table.uploadId],
    }),
    index('idx_artifact_uploads_created').on(table.workspaceId, table.createdAt),
  ],
)

export const automationRuns = pgTable(
  'automation_runs',
  {
    id: textC('id').notNull().$type<SqliteRow<'automationRuns'>['id']>(),
    actor: textC('actor')
      .notNull()
      .default(sql`'system:automation-migration'`)
      .$type<SqliteRow<'automationRuns'>['actor']>(),
    onBehalfOf: textC('on_behalf_of').notNull().$type<SqliteRow<'automationRuns'>['onBehalfOf']>(),
    automationId: textC('automation_id')
      .notNull()
      .$type<SqliteRow<'automationRuns'>['automationId']>(),
    firedAt: isoTimestamp('fired_at').notNull().$type<SqliteRow<'automationRuns'>['firedAt']>(),
    sessionId: textC('session_id').$type<SqliteRow<'automationRuns'>['sessionId']>(),
    outcome: textC('outcome').notNull().$type<SqliteRow<'automationRuns'>['outcome']>(),
    detail: textC('detail').$type<SqliteRow<'automationRuns'>['detail']>(),
    deletedAt: isoTimestamp('deleted_at').$type<SqliteRow<'automationRuns'>['deletedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'automationRuns'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'automation_runs_pk', columns: [table.workspaceId, table.id] }),
    index('idx_automation_runs_automation').on(
      table.workspaceId,
      table.automationId,
      table.firedAt,
    ),
    foreignKey({
      name: 'fk_automation_runs_automation_id_automations_id_fk',
      columns: [table.workspaceId, table.automationId],
      foreignColumns: [automations.workspaceId, automations.id],
    }).onDelete('cascade'),
    check(
      'automation_runs_check_20',
      sql`outcome IN ('spawned','missed','skipped_overlap','error')`,
    ),
  ],
)

export const automations = pgTable(
  'automations',
  {
    id: textC('id').notNull().$type<SqliteRow<'automations'>['id']>(),
    ownerUserId: textC('owner_user_id').notNull().$type<SqliteRow<'automations'>['ownerUserId']>(),
    createdByActor: textC('created_by_actor')
      .notNull()
      .$type<SqliteRow<'automations'>['createdByActor']>(),
    createdByOnBehalfOf: textC('created_by_on_behalf_of')
      .notNull()
      .$type<SqliteRow<'automations'>['createdByOnBehalfOf']>(),
    name: textC('name').notNull().$type<SqliteRow<'automations'>['name']>(),
    enabled: boolean('enabled')
      .notNull()
      .default(false)
      .$type<SqliteRow<'automations'>['enabled']>(),
    repoPath: textC('repo_path').$type<SqliteRow<'automations'>['repoPath']>(),
    scheduleKind: textC('schedule_kind')
      .notNull()
      .default(sql`'cron'`)
      .$type<SqliteRow<'automations'>['scheduleKind']>(),
    cron: textC('cron').notNull().$type<SqliteRow<'automations'>['cron']>(),
    runAt: isoTimestamp('run_at').$type<SqliteRow<'automations'>['runAt']>(),
    targetSessionId:
      textC('target_session_id').$type<SqliteRow<'automations'>['targetSessionId']>(),
    agentKind: textC('agent_kind').notNull().$type<SqliteRow<'automations'>['agentKind']>(),
    model: textC('model').notNull().default(sql`'auto'`).$type<SqliteRow<'automations'>['model']>(),
    effort: textC('effort')
      .notNull()
      .default(sql`'auto'`)
      .$type<SqliteRow<'automations'>['effort']>(),
    prompt: textC('prompt').notNull().$type<SqliteRow<'automations'>['prompt']>(),
    nextRunAt: isoTimestamp('next_run_at').$type<SqliteRow<'automations'>['nextRunAt']>(),
    lastRunAt: isoTimestamp('last_run_at').$type<SqliteRow<'automations'>['lastRunAt']>(),
    createdAt: isoTimestamp('created_at').notNull().$type<SqliteRow<'automations'>['createdAt']>(),
    sessionMode: textC('session_mode')
      .notNull()
      .default(sql`'fresh'`)
      .$type<SqliteRow<'automations'>['sessionMode']>(),
    deletedAt: isoTimestamp('deleted_at').$type<SqliteRow<'automations'>['deletedAt']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'automations'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'automations_pk', columns: [table.workspaceId, table.id] }),
    check('automations_session_mode', sql`session_mode IN ('fresh', 'resume')`),
  ],
)

export const carriedSignIns = pgTable(
  'carried_sign_ins',
  {
    oldTokenHash: textC('old_token_hash')
      .notNull()
      .$type<SqliteRow<'carriedSignIns'>['oldTokenHash']>(),
    deviceSignInId: textC('device_sign_in_id')
      .notNull()
      .$type<SqliteRow<'carriedSignIns'>['deviceSignInId']>(),
    sealed: textC('sealed').notNull().$type<SqliteRow<'carriedSignIns'>['sealed']>(),
    expiresAt: isoTimestamp('expires_at')
      .notNull()
      .$type<SqliteRow<'carriedSignIns'>['expiresAt']>(),
    memberId: textC('member_id').notNull().$type<SqliteRow<'carriedSignIns'>['memberId']>(),
    oldLabel: textC('old_label').notNull().$type<SqliteRow<'carriedSignIns'>['oldLabel']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'carriedSignIns'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'carried_sign_ins_pk', columns: [table.workspaceId, table.oldTokenHash] }),
    index('idx_carried_sign_ins_expires').on(table.workspaceId, table.expiresAt),
    index('idx_carried_sign_ins_member').on(table.workspaceId, table.memberId),
    index('idx_carried_sign_ins_label').on(table.workspaceId, table.oldLabel),
  ],
)

export const checkoutLost = pgTable(
  'checkout_lost',
  {
    userId: textC('user_id').notNull().$type<SqliteRow<'checkoutLost'>['userId']>(),
    machineId: textC('machine_id').notNull().$type<SqliteRow<'checkoutLost'>['machineId']>(),
    path: textC('path').notNull().$type<SqliteRow<'checkoutLost'>['path']>(),
    root: boolean('root').notNull().default(false).$type<SqliteRow<'checkoutLost'>['root']>(),
    lostAt: isoTimestamp('lost_at').notNull().$type<SqliteRow<'checkoutLost'>['lostAt']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'checkoutLost'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'checkout_lost_pk',
      columns: [table.workspaceId, table.userId, table.machineId, table.path],
    }),
    index('idx_checkout_lost_machine').on(table.workspaceId, table.machineId),
  ],
)

export const checkoutReach = pgTable(
  'checkout_reach',
  {
    userId: textC('user_id').notNull().$type<SqliteRow<'checkoutReach'>['userId']>(),
    machineId: textC('machine_id').notNull().$type<SqliteRow<'checkoutReach'>['machineId']>(),
    reach: textC('reach').notNull().$type<SqliteRow<'checkoutReach'>['reach']>(),
    updatedAt: isoTimestamp('updated_at')
      .notNull()
      .$type<SqliteRow<'checkoutReach'>['updatedAt']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'checkoutReach'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'checkout_reach_pk',
      columns: [table.workspaceId, table.userId, table.machineId],
    }),
    index('idx_checkout_reach_machine').on(table.workspaceId, table.machineId),
  ],
)

export const checkouts = pgTable(
  'checkouts',
  {
    machineId: textC('machine_id').notNull().$type<SqliteRow<'checkouts'>['machineId']>(),
    path: textC('path').notNull().$type<SqliteRow<'checkouts'>['path']>(),
    root: textC('root').notNull().$type<SqliteRow<'checkouts'>['root']>(),
    kind: textC('kind').notNull().$type<SqliteRow<'checkouts'>['kind']>(),
    repoId: textC('repo_id').$type<SqliteRow<'checkouts'>['repoId']>(),
    branch: textC('branch').$type<SqliteRow<'checkouts'>['branch']>(),
    originUrl: textC('origin_url').$type<SqliteRow<'checkouts'>['originUrl']>(),
    locked: boolean('locked').notNull().default(false).$type<SqliteRow<'checkouts'>['locked']>(),
    prunable: boolean('prunable')
      .notNull()
      .default(false)
      .$type<SqliteRow<'checkouts'>['prunable']>(),
    updatedAt: isoTimestamp('updated_at').notNull().$type<SqliteRow<'checkouts'>['updatedAt']>(),
    removedAt: isoTimestamp('removed_at').$type<SqliteRow<'checkouts'>['removedAt']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'checkouts'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'checkouts_pk', columns: [table.workspaceId, table.machineId, table.path] }),
    index('idx_checkouts_root').on(table.workspaceId, table.machineId, table.root),
  ],
)

export const clientSessions = pgTable(
  'client_sessions',
  {
    tokenHash: textC('token_hash').notNull().$type<SqliteRow<'clientSessions'>['tokenHash']>(),
    userId: textC('user_id').notNull().$type<SqliteRow<'clientSessions'>['userId']>(),
    createdAt: isoTimestamp('created_at')
      .notNull()
      .$type<SqliteRow<'clientSessions'>['createdAt']>(),
    expiresAt: isoTimestamp('expires_at')
      .notNull()
      .$type<SqliteRow<'clientSessions'>['expiresAt']>(),
    label: textC('label')
      .notNull()
      .default(sql`'login'`)
      .$type<SqliteRow<'clientSessions'>['label']>(),
    sessionId: textC('session_id').$type<SqliteRow<'clientSessions'>['sessionId']>(),
    deviceId: textC('device_id').$type<SqliteRow<'clientSessions'>['deviceId']>(),
    deviceName: textC('device_name').$type<SqliteRow<'clientSessions'>['deviceName']>(),
    platform: textC('platform').$type<SqliteRow<'clientSessions'>['platform']>(),
    lastSeenAt: isoTimestamp('last_seen_at').$type<SqliteRow<'clientSessions'>['lastSeenAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'clientSessions'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'client_sessions_pk', columns: [table.workspaceId, table.tokenHash] }),
    uniqueIndex('idx_client_sessions_session_id').on(table.workspaceId, table.sessionId),
    index('idx_client_sessions_user').on(table.workspaceId, table.userId),
    index('idx_client_sessions_expires').on(table.workspaceId, table.expiresAt),
    index('idx_client_sessions_label').on(table.workspaceId, table.label),
  ],
)

export const conversationIdentities = pgTable(
  'conversation_identities',
  {
    podiumId: textC('podium_id').notNull().$type<SqliteRow<'conversationIdentities'>['podiumId']>(),
    parentPodiumId:
      textC('parent_podium_id').$type<SqliteRow<'conversationIdentities'>['parentPodiumId']>(),
    createdAt: isoTimestamp('created_at')
      .notNull()
      .$type<SqliteRow<'conversationIdentities'>['createdAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'conversationIdentities'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'conversation_identities_pk',
      columns: [table.workspaceId, table.podiumId],
    }),
  ],
)

export const conversationSegmentIncarnations = pgTable(
  'conversation_segment_incarnations',
  {
    machineId: textC('machine_id')
      .notNull()
      .$type<SqliteRow<'conversationSegmentIncarnations'>['machineId']>(),
    nativeId: textC('native_id')
      .notNull()
      .$type<SqliteRow<'conversationSegmentIncarnations'>['nativeId']>(),
    sequence: int8('sequence')
      .notNull()
      .$type<SqliteRow<'conversationSegmentIncarnations'>['sequence']>(),
    device: textC('device')
      .notNull()
      .$type<SqliteRow<'conversationSegmentIncarnations'>['device']>(),
    inode: textC('inode').notNull().$type<SqliteRow<'conversationSegmentIncarnations'>['inode']>(),
    mirroredBytes: int8('mirrored_bytes')
      .notNull()
      .default(0)
      .$type<SqliteRow<'conversationSegmentIncarnations'>['mirroredBytes']>(),
    createdAt: isoTimestamp('created_at')
      .notNull()
      .$type<SqliteRow<'conversationSegmentIncarnations'>['createdAt']>(),
    retiredAt:
      isoTimestamp('retired_at').$type<SqliteRow<'conversationSegmentIncarnations'>['retiredAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'conversationSegmentIncarnations'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'conversation_segment_incarnations_pk',
      columns: [table.workspaceId, table.machineId, table.nativeId, table.sequence],
    }),
    index('conversation_segment_incarnations_native').on(
      table.workspaceId,
      table.machineId,
      table.nativeId,
      table.sequence,
    ),
  ],
)

export const conversationSegments = pgTable(
  'conversation_segments',
  {
    machineId: textC('machine_id')
      .notNull()
      .$type<SqliteRow<'conversationSegments'>['machineId']>(),
    nativeId: textC('native_id').notNull().$type<SqliteRow<'conversationSegments'>['nativeId']>(),
    providerId: textC('provider_id')
      .notNull()
      .$type<SqliteRow<'conversationSegments'>['providerId']>(),
    podiumId: textC('podium_id').notNull().$type<SqliteRow<'conversationSegments'>['podiumId']>(),
    path: textC('path').$type<SqliteRow<'conversationSegments'>['path']>(),
    seqInConv: int8('seq_in_conv')
      .notNull()
      .$type<SqliteRow<'conversationSegments'>['seqInConv']>(),
    linkedBy: textC('linked_by').notNull().$type<SqliteRow<'conversationSegments'>['linkedBy']>(),
    createdAt: isoTimestamp('created_at')
      .notNull()
      .$type<SqliteRow<'conversationSegments'>['createdAt']>(),
    mirroredBytes: int8('mirrored_bytes')
      .notNull()
      .default(0)
      .$type<SqliteRow<'conversationSegments'>['mirroredBytes']>(),
    mirroredAt:
      isoTimestamp('mirrored_at').$type<SqliteRow<'conversationSegments'>['mirroredAt']>(),
    indexedBytes: int8('indexed_bytes')
      .notNull()
      .default(0)
      .$type<SqliteRow<'conversationSegments'>['indexedBytes']>(),
    reportedBytes:
      int8('reported_bytes').$type<SqliteRow<'conversationSegments'>['reportedBytes']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'conversationSegments'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'conversation_segments_pk',
      columns: [table.workspaceId, table.machineId, table.nativeId],
    }),
    index('conversation_segments_podium').on(table.workspaceId, table.podiumId, table.seqInConv),
    index('conversation_segments_path').on(table.workspaceId, table.path),
  ],
)

export const conversations = pgTable(
  'conversations',
  {
    id: textC('id').notNull().$type<SqliteRow<'conversations'>['id']>(),
    agentKind: textC('agent_kind').notNull().$type<SqliteRow<'conversations'>['agentKind']>(),
    providerId: textC('provider_id').notNull().$type<SqliteRow<'conversations'>['providerId']>(),
    title: textC('title').$type<SqliteRow<'conversations'>['title']>(),
    name: textC('name').$type<SqliteRow<'conversations'>['name']>(),
    summary: textC('summary').$type<SqliteRow<'conversations'>['summary']>(),
    projectPath: textC('project_path').$type<SqliteRow<'conversations'>['projectPath']>(),
    resumeKind: textC('resume_kind').$type<SqliteRow<'conversations'>['resumeKind']>(),
    resumeValue: textC('resume_value').$type<SqliteRow<'conversations'>['resumeValue']>(),
    createdAt: isoTimestamp('created_at').$type<SqliteRow<'conversations'>['createdAt']>(),
    updatedAt: isoTimestamp('updated_at').$type<SqliteRow<'conversations'>['updatedAt']>(),
    messageCount: int8('message_count').$type<SqliteRow<'conversations'>['messageCount']>(),
    machineId: textC('machine_id').notNull().$type<SqliteRow<'conversations'>['machineId']>(),
    parentConversationId:
      textC('parent_conversation_id').$type<SqliteRow<'conversations'>['parentConversationId']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'conversations'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'conversations_pk', columns: [table.workspaceId, table.id] }),
    index('idx_conversations_project_path').on(table.workspaceId, table.projectPath),
    index('idx_conversations_updated_at').on(table.workspaceId, table.updatedAt),
    index('idx_conversations_top_level_updated')
      .on(table.workspaceId, table.updatedAt, table.id)
      .where(sql`"parent_conversation_id" IS NULL`),
    index('idx_conversations_search').using(
      'gin',
      sql`to_tsvector('simple', translate(coalesce("title", '') || ' ' || coalesce("name", '') || ' ' || coalesce("summary", '') || ' ' || coalesce("project_path", ''), '!"#$%&''()*+,-./:;<=>?@[\\]^_\`{|}~ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞàáâãäåçèéêëìíîïñòóôõöùúûüýÿĀāĂăĄąĆćĈĉĊċČčĎďĐĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĦĨĩĪīĬĭĮįİĲĴĵĶķĹĺĻļĽľĿŁŃńŅņŇňŊŌōŎŏŐőŒŔŕŖŗŘřŚśŜŝŞşŠšŢţŤťŦŨũŪūŬŭŮůŰűŲųŴŵŶŷŸŹźŻżŽžſƁƂƄƆƇƉƊƋƎƏƐƑƓƔƖƗƘƜƝƟƠơƢƤƦƧƩƬƮƯưƱƲƳƵƷƸƼǄǅǇǈǊǋǍǎǏǐǑǒǓǔǕǗǙǛǞǠǢǤǦǧǨǩǪǫǬǮǰǱǲǴǵǶǷǸǹǺǼǾȀȁȂȃȄȅȆȇȈȉȊȋȌȍȎȏȐȑȒȓȔȕȖȗȘșȚțȜȞȟȠȢȤȦȧȨȩȪȬȮȯȰȲȳȺȻȽȾɁɃɄɅɆɈɊɌɎ', '                                aaaaaaæceeeeiiiiðnoooooøuuuuyþaaaaaaceeeeiiiinooooouuuuyyaaaaaaccccccccddđeeeeeeeeeegggggggghhħiiiiiiiiiĳjjkkllllllŀłnnnnnnŋooooooœrrrrrrssssssssttttŧuuuuuuuuuuuuwwyyyzzzzzzsɓƃƅɔƈɖɗƌǝəɛƒɠɣɩɨƙɯɲɵooƣƥʀƨʃƭʈuuʊʋƴƶʒƹƽǆǆǉǉǌǌaaiioouuǖǘǚǜǟǡǣǥggkkooǭǯjǳǳggƕƿnnǻǽǿaaaaeeeeiiiioooorrrruuuussttȝhhƞȣȥaaeeȫȭooȱyyⱥȼƚⱦɂƀʉʌɇɉɋɍɏ'))`,
    ),
  ],
)

export const deliveryReceipts = pgTable(
  'delivery_receipts',
  {
    id: textC('id').notNull().$type<SqliteRow<'deliveryReceipts'>['id']>(),
    orderId: textC('order_id').notNull().$type<SqliteRow<'deliveryReceipts'>['orderId']>(),
    approvedBaseSha: textC('approved_base_sha')
      .notNull()
      .$type<SqliteRow<'deliveryReceipts'>['approvedBaseSha']>(),
    approvedHeadSha: textC('approved_head_sha')
      .notNull()
      .$type<SqliteRow<'deliveryReceipts'>['approvedHeadSha']>(),
    resultCommitSha: textC('result_commit_sha')
      .notNull()
      .$type<SqliteRow<'deliveryReceipts'>['resultCommitSha']>(),
    testedIntegrationSha: textC('tested_integration_sha')
      .notNull()
      .$type<SqliteRow<'deliveryReceipts'>['testedIntegrationSha']>(),
    landedRefSha: textC('landed_ref_sha')
      .notNull()
      .$type<SqliteRow<'deliveryReceipts'>['landedRefSha']>(),
    destinationSha: textC('destination_sha')
      .notNull()
      .$type<SqliteRow<'deliveryReceipts'>['destinationSha']>(),
    validationProfileId: textC('validation_profile_id')
      .notNull()
      .$type<SqliteRow<'deliveryReceipts'>['validationProfileId']>(),
    validationResult: textC('validation_result')
      .notNull()
      .$type<SqliteRow<'deliveryReceipts'>['validationResult']>(),
    destination: textC('destination')
      .notNull()
      .$type<SqliteRow<'deliveryReceipts'>['destination']>(),
    completedAt: isoTimestamp('completed_at')
      .notNull()
      .$type<SqliteRow<'deliveryReceipts'>['completedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'deliveryReceipts'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'delivery_receipts_pk', columns: [table.workspaceId, table.id] }),
    uniqueIndex('idx_delivery_receipts_order').on(table.workspaceId, table.orderId),
    foreignKey({
      name: 'fk_delivery_receipts_order_id_ship_orders_id_fk',
      columns: [table.workspaceId, table.orderId],
      foreignColumns: [shipOrders.workspaceId, shipOrders.id],
    }).onDelete('restrict'),
    check('delivery_receipts_validation_result_check', sql`validation_result = 'passed'`),
  ],
)

export const effects = pgTable(
  'effects',
  {
    id: textC('id').notNull().$type<SqliteRow<'effects'>['id']>(),
    kind: textC('kind').notNull().$type<SqliteRow<'effects'>['kind']>(),
    targetKind: textC('target_kind').notNull().$type<SqliteRow<'effects'>['targetKind']>(),
    targetId: textC('target_id').notNull().$type<SqliteRow<'effects'>['targetId']>(),
    inputJson: jsonText('input_json').notNull().$type<SqliteRow<'effects'>['inputJson']>(),
    resultJson: jsonText('result_json').$type<SqliteRow<'effects'>['resultJson']>(),
    cancelRequested: boolean('cancel_requested')
      .notNull()
      .default(false)
      .$type<SqliteRow<'effects'>['cancelRequested']>(),
    status: textC('status').notNull().$type<SqliteRow<'effects'>['status']>(),
    errorCode: textC('error_code').$type<SqliteRow<'effects'>['errorCode']>(),
    errorMessage: textC('error_message').$type<SqliteRow<'effects'>['errorMessage']>(),
    deadlineAt: int8('deadline_at').$type<SqliteRow<'effects'>['deadlineAt']>(),
    attempts: int8('attempts').notNull().default(0).$type<SqliteRow<'effects'>['attempts']>(),
    stage: textC('stage').$type<SqliteRow<'effects'>['stage']>(),
    decision: textC('decision').$type<SqliteRow<'effects'>['decision']>(),
    deciders: textC('deciders').$type<SqliteRow<'effects'>['deciders']>(),
    startedAt: int8('started_at').$type<SqliteRow<'effects'>['startedAt']>(),
    finishedAt: int8('finished_at').$type<SqliteRow<'effects'>['finishedAt']>(),
    createdBy: textC('created_by').$type<SqliteRow<'effects'>['createdBy']>(),
    actor: textC('actor').$type<SqliteRow<'effects'>['actor']>(),
    createdAt: int8('created_at').notNull().$type<SqliteRow<'effects'>['createdAt']>(),
    updatedAt: int8('updated_at').notNull().$type<SqliteRow<'effects'>['updatedAt']>(),
    revision: int8('revision').notNull().default(1).$type<SqliteRow<'effects'>['revision']>(),
    deletedAt: int8('deleted_at').$type<SqliteRow<'effects'>['deletedAt']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'effects'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'effects_pk', columns: [table.workspaceId, table.id] }),
    index('idx_effects_status_deadline').on(table.workspaceId, table.status, table.deadlineAt),
    index('idx_effects_status_finished').on(table.workspaceId, table.status, table.finishedAt),
    index('idx_effects_deleted').on(table.workspaceId, table.deletedAt),
    index('idx_effects_target').on(
      table.workspaceId,
      table.targetKind,
      table.targetId,
      table.createdAt,
    ),
    index('idx_effects_kind_target').on(
      table.workspaceId,
      table.kind,
      table.targetKind,
      table.targetId,
      table.createdAt,
    ),
    index('idx_effects_awaiting')
      .on(table.workspaceId, table.kind, table.createdAt)
      .where(sql`decision = 'awaiting'`),
    index('idx_effects_unpublished').on(table.workspaceId, table.revision).where(sql`revision = 0`),
  ],
)

export const grantAudiences = pgTable(
  'grant_audiences',
  {
    resourceKind: textC('resource_kind')
      .notNull()
      .$type<SqliteRow<'grantAudiences'>['resourceKind']>(),
    resourceId: textC('resource_id').notNull().$type<SqliteRow<'grantAudiences'>['resourceId']>(),
    grantee: textC('grantee').notNull().$type<SqliteRow<'grantAudiences'>['grantee']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'grantAudiences'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'grant_audiences_pk',
      columns: [table.workspaceId, table.resourceKind, table.resourceId, table.grantee],
    }),
  ],
)

export const grants = pgTable(
  'grants',
  {
    resourceKind: textC('resource_kind').notNull().$type<SqliteRow<'grants'>['resourceKind']>(),
    resourceId: textC('resource_id').notNull().$type<SqliteRow<'grants'>['resourceId']>(),
    grantee: textC('grantee').notNull().$type<SqliteRow<'grants'>['grantee']>(),
    verb: textC('verb').notNull().$type<SqliteRow<'grants'>['verb']>(),
    custody: boolean('custody').notNull().default(false).$type<SqliteRow<'grants'>['custody']>(),
    owner: textC('owner').notNull().$type<SqliteRow<'grants'>['owner']>(),
    visibility: textC('visibility').notNull().$type<SqliteRow<'grants'>['visibility']>(),
    createdAt: isoTimestamp('created_at').notNull().$type<SqliteRow<'grants'>['createdAt']>(),
    actorKind: textC('actor_kind').notNull().$type<SqliteRow<'grants'>['actorKind']>(),
    actorId: textC('actor_id').$type<SqliteRow<'grants'>['actorId']>(),
    onBehalfOf: textC('on_behalf_of').$type<SqliteRow<'grants'>['onBehalfOf']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'grants'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'grants_pk',
      columns: [table.workspaceId, table.resourceKind, table.resourceId, table.grantee, table.verb],
    }),
    uniqueIndex('grants_machine_custodian')
      .on(table.workspaceId, table.resourceId)
      .where(sql`"resource_kind" = 'machine' AND "custody" = true`),
    index('idx_grants_grantee').on(table.workspaceId, table.grantee),
  ],
)

export const issueComments = pgTable(
  'issue_comments',
  {
    id: textC('id').notNull().$type<SqliteRow<'issueComments'>['id']>(),
    issueId: textC('issue_id').notNull().$type<SqliteRow<'issueComments'>['issueId']>(),
    author: textC('author').notNull().$type<SqliteRow<'issueComments'>['author']>(),
    body: textC('body').notNull().$type<SqliteRow<'issueComments'>['body']>(),
    createdAt: isoTimestamp('created_at')
      .notNull()
      .$type<SqliteRow<'issueComments'>['createdAt']>(),
    actor: textC('actor').$type<SqliteRow<'issueComments'>['actor']>(),
    onBehalfOf: textC('on_behalf_of').$type<SqliteRow<'issueComments'>['onBehalfOf']>(),
    editedAt: isoTimestamp('edited_at').$type<SqliteRow<'issueComments'>['editedAt']>(),
    editedBy: textC('edited_by').$type<SqliteRow<'issueComments'>['editedBy']>(),
    editedOnBehalfOf:
      textC('edited_on_behalf_of').$type<SqliteRow<'issueComments'>['editedOnBehalfOf']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'issueComments'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'issue_comments_pk', columns: [table.workspaceId, table.id] }),
    index('idx_issue_comments_issue_time').on(
      table.workspaceId,
      table.issueId,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: 'fk_issue_comments_issue_id_issues_id_fk',
      columns: [table.workspaceId, table.issueId],
      foreignColumns: [issues.workspaceId, issues.id],
    }).onDelete('cascade'),
  ],
)

export const issueDeps = pgTable(
  'issue_deps',
  {
    fromId: textC('from_id').notNull().$type<SqliteRow<'issueDeps'>['fromId']>(),
    toId: textC('to_id').notNull().$type<SqliteRow<'issueDeps'>['toId']>(),
    type: textC('type')
      .notNull()
      .default(sql`'blocked-by'`)
      .$type<SqliteRow<'issueDeps'>['type']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'issueDeps'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'issue_deps_pk',
      columns: [table.workspaceId, table.fromId, table.toId, table.type],
    }),
    index('idx_issue_deps_to_from').on(table.workspaceId, table.toId, table.fromId, table.type),
    index('idx_issue_deps_from').on(table.workspaceId, table.fromId),
    foreignKey({
      name: 'fk_issue_deps_from_id_issues_id_fk',
      columns: [table.workspaceId, table.fromId],
      foreignColumns: [issues.workspaceId, issues.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_issue_deps_to_id_issues_id_fk',
      columns: [table.workspaceId, table.toId],
      foreignColumns: [issues.workspaceId, issues.id],
    }).onDelete('cascade'),
    check(
      'issue_deps_type',
      sql`type IN ('blocked-by', 'related', 'discovered-from', 'supersedes', 'duplicates')`,
    ),
  ],
)

export const issueGitStates = pgTable(
  'issue_git_states',
  {
    issueId: textC('issue_id').notNull().$type<SqliteRow<'issueGitStates'>['issueId']>(),
    factsJson: jsonText('facts_json').notNull().$type<SqliteRow<'issueGitStates'>['factsJson']>(),
    updatedAt: isoTimestamp('updated_at')
      .notNull()
      .$type<SqliteRow<'issueGitStates'>['updatedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'issueGitStates'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'issue_git_states_pk', columns: [table.workspaceId, table.issueId] }),
    foreignKey({
      name: 'fk_issue_git_states_issue_id_issues_id_fk',
      columns: [table.workspaceId, table.issueId],
      foreignColumns: [issues.workspaceId, issues.id],
    }).onDelete('cascade'),
  ],
)

export const issueLabels = pgTable(
  'issue_labels',
  {
    issueId: textC('issue_id').notNull().$type<SqliteRow<'issueLabels'>['issueId']>(),
    labelId: int8('label_id').notNull().$type<SqliteRow<'issueLabels'>['labelId']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'issueLabels'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'issue_labels_pk',
      columns: [table.workspaceId, table.issueId, table.labelId],
    }),
    index('idx_issue_labels_label_id').on(table.workspaceId, table.labelId),
    foreignKey({
      name: 'fk_issue_labels_issue_id_issues_id_fk',
      columns: [table.workspaceId, table.issueId],
      foreignColumns: [issues.workspaceId, issues.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_issue_labels_label_id_labels_id_fk',
      columns: [table.workspaceId, table.labelId],
      foreignColumns: [labels.workspaceId, labels.id],
    }).onDelete('cascade'),
  ],
)

export const issueMessageUserState = pgTable(
  'issue_message_user_state',
  {
    userId: textC('user_id').notNull().$type<SqliteRow<'issueMessageUserState'>['userId']>(),
    issueMessageId: textC('issue_message_id')
      .notNull()
      .$type<SqliteRow<'issueMessageUserState'>['issueMessageId']>(),
    readAt: isoTimestamp('read_at').$type<SqliteRow<'issueMessageUserState'>['readAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'issueMessageUserState'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'issue_message_user_state_pk',
      columns: [table.workspaceId, table.userId, table.issueMessageId],
    }),
  ],
)

export const issueMessages = pgTable(
  'issue_messages',
  {
    id: textC('id').notNull().$type<SqliteRow<'issueMessages'>['id']>(),
    issueId: textC('issue_id').notNull().$type<SqliteRow<'issueMessages'>['issueId']>(),
    fromAuthor: textC('from_author').notNull().$type<SqliteRow<'issueMessages'>['fromAuthor']>(),
    body: textC('body').notNull().$type<SqliteRow<'issueMessages'>['body']>(),
    createdAt: isoTimestamp('created_at')
      .notNull()
      .$type<SqliteRow<'issueMessages'>['createdAt']>(),
    actor: textC('actor').$type<SqliteRow<'issueMessages'>['actor']>(),
    onBehalfOf: textC('on_behalf_of').$type<SqliteRow<'issueMessages'>['onBehalfOf']>(),
    status: textC('status')
      .notNull()
      .default(sql`'unread'`)
      .$type<SqliteRow<'issueMessages'>['status']>(),
    claimedBy: textC('claimed_by').$type<SqliteRow<'issueMessages'>['claimedBy']>(),
    claimedAt: isoTimestamp('claimed_at').$type<SqliteRow<'issueMessages'>['claimedAt']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'issueMessages'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'issue_messages_pk', columns: [table.workspaceId, table.id] }),
    index('idx_issue_messages_issue_time').on(
      table.workspaceId,
      table.issueId,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: 'fk_issue_messages_issue_id_issues_id_fk',
      columns: [table.workspaceId, table.issueId],
      foreignColumns: [issues.workspaceId, issues.id],
    }).onDelete('cascade'),
  ],
)

export const issuePanelArtifacts = pgTable(
  'issue_panel_artifacts',
  {
    id: textC('id').notNull().$type<SqliteRow<'issuePanelArtifacts'>['id']>(),
    issueId: textC('issue_id').notNull().$type<SqliteRow<'issuePanelArtifacts'>['issueId']>(),
    position: int8('position').notNull().$type<SqliteRow<'issuePanelArtifacts'>['position']>(),
    path: textC('path').notNull().$type<SqliteRow<'issuePanelArtifacts'>['path']>(),
    value: jsonText('value').notNull().$type<SqliteRow<'issuePanelArtifacts'>['value']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'issuePanelArtifacts'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'issue_panel_artifacts_pk', columns: [table.workspaceId, table.id] }),
    index('idx_issue_panel_artifacts_order').on(
      table.workspaceId,
      table.issueId,
      table.position,
      table.id,
    ),
    uniqueIndex('idx_issue_panel_artifacts_path').on(table.workspaceId, table.issueId, table.path),
    foreignKey({
      name: 'fk_issue_panel_artifacts_issue_id_issues_id_fk',
      columns: [table.workspaceId, table.issueId],
      foreignColumns: [issues.workspaceId, issues.id],
    }).onDelete('cascade'),
  ],
)

export const issuePanelDeferred = pgTable(
  'issue_panel_deferred',
  {
    id: textC('id').notNull().$type<SqliteRow<'issuePanelDeferred'>['id']>(),
    issueId: textC('issue_id').notNull().$type<SqliteRow<'issuePanelDeferred'>['issueId']>(),
    position: int8('position').notNull().$type<SqliteRow<'issuePanelDeferred'>['position']>(),
    text: textC('text').notNull().$type<SqliteRow<'issuePanelDeferred'>['text']>(),
    addedAt: isoTimestamp('added_at').notNull().$type<SqliteRow<'issuePanelDeferred'>['addedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'issuePanelDeferred'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'issue_panel_deferred_pk', columns: [table.workspaceId, table.id] }),
    index('idx_issue_panel_deferred_order').on(
      table.workspaceId,
      table.issueId,
      table.position,
      table.id,
    ),
    foreignKey({
      name: 'fk_issue_panel_deferred_issue_id_issues_id_fk',
      columns: [table.workspaceId, table.issueId],
      foreignColumns: [issues.workspaceId, issues.id],
    }).onDelete('cascade'),
  ],
)

export const issuePanelStates = pgTable(
  'issue_panel_states',
  {
    id: textC('id').notNull().$type<SqliteRow<'issuePanelStates'>['id']>(),
    text: textC('text').notNull().$type<SqliteRow<'issuePanelStates'>['text']>(),
    updatedAt: isoTimestamp('updated_at')
      .notNull()
      .$type<SqliteRow<'issuePanelStates'>['updatedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'issuePanelStates'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'issue_panel_states_pk', columns: [table.workspaceId, table.id] }),
    foreignKey({
      name: 'fk_issue_panel_states_id_issues_id_fk',
      columns: [table.workspaceId, table.id],
      foreignColumns: [issues.workspaceId, issues.id],
    }).onDelete('cascade'),
  ],
)

export const issuePanelTodos = pgTable(
  'issue_panel_todos',
  {
    id: textC('id').notNull().$type<SqliteRow<'issuePanelTodos'>['id']>(),
    issueId: textC('issue_id').notNull().$type<SqliteRow<'issuePanelTodos'>['issueId']>(),
    position: int8('position').notNull().$type<SqliteRow<'issuePanelTodos'>['position']>(),
    text: textC('text').notNull().$type<SqliteRow<'issuePanelTodos'>['text']>(),
    done: boolean('done').notNull().$type<SqliteRow<'issuePanelTodos'>['done']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'issuePanelTodos'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'issue_panel_todos_pk', columns: [table.workspaceId, table.id] }),
    index('idx_issue_panel_todos_order').on(
      table.workspaceId,
      table.issueId,
      table.position,
      table.id,
    ),
    foreignKey({
      name: 'fk_issue_panel_todos_issue_id_issues_id_fk',
      columns: [table.workspaceId, table.issueId],
      foreignColumns: [issues.workspaceId, issues.id],
    }).onDelete('cascade'),
  ],
)

export const issueRefLetters = pgTable(
  'issue_ref_letters',
  {
    issueId: textC('issue_id').notNull().$type<SqliteRow<'issueRefLetters'>['issueId']>(),
    nextIndex: int8('next_index').notNull().$type<SqliteRow<'issueRefLetters'>['nextIndex']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'issueRefLetters'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'issue_ref_letters_pk', columns: [table.workspaceId, table.issueId] }),
  ],
)

export const issueTextRevisions = pgTable(
  'issue_text_revisions',
  {
    id: int8('id')
      .primaryKey()
      .generatedByDefaultAsIdentity()
      .$type<SqliteRow<'issueTextRevisions'>['id']>(),
    issueId: textC('issue_id').notNull().$type<SqliteRow<'issueTextRevisions'>['issueId']>(),
    field: textC('field').notNull().$type<SqliteRow<'issueTextRevisions'>['field']>(),
    body: textC('body').notNull().$type<SqliteRow<'issueTextRevisions'>['body']>(),
    source: textC('source').notNull().$type<SqliteRow<'issueTextRevisions'>['source']>(),
    restoredFrom: int8('restored_from').$type<SqliteRow<'issueTextRevisions'>['restoredFrom']>(),
    issueRevision: int8('issue_revision').$type<SqliteRow<'issueTextRevisions'>['issueRevision']>(),
    actor: textC('actor').$type<SqliteRow<'issueTextRevisions'>['actor']>(),
    onBehalfOf: textC('on_behalf_of').$type<SqliteRow<'issueTextRevisions'>['onBehalfOf']>(),
    createdAt: isoTimestamp('created_at')
      .notNull()
      .$type<SqliteRow<'issueTextRevisions'>['createdAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'issueTextRevisions'>['workspaceId']>(),
  },
  (table) => [
    unique('issue_text_revisions_workspace_id_id_unique').on(table.workspaceId, table.id),
    index('idx_issue_text_revisions_issue_field').on(
      table.workspaceId,
      table.issueId,
      table.field,
      table.id,
    ),
    foreignKey({
      name: 'fk_issue_text_revisions_issue_id_issues_id_fk',
      columns: [table.workspaceId, table.issueId],
      foreignColumns: [issues.workspaceId, issues.id],
    }).onDelete('cascade'),
    check('issue_text_revisions_field', sql`field IN ('description', 'brief')`),
    check('issue_text_revisions_source', sql`source IN ('create', 'baseline', 'edit', 'restore')`),
  ],
)

export const issueUserState = pgTable(
  'issue_user_state',
  {
    userId: textC('user_id').notNull().$type<SqliteRow<'issueUserState'>['userId']>(),
    issueId: textC('issue_id').notNull().$type<SqliteRow<'issueUserState'>['issueId']>(),
    readAt: isoTimestamp('read_at').$type<SqliteRow<'issueUserState'>['readAt']>(),
    tuckedAt: isoTimestamp('tucked_at').$type<SqliteRow<'issueUserState'>['tuckedAt']>(),
    joinedAt: isoTimestamp('joined_at').$type<SqliteRow<'issueUserState'>['joinedAt']>(),
    joinedVia: textC('joined_via').$type<SqliteRow<'issueUserState'>['joinedVia']>(),
    assignedAt: isoTimestamp('assigned_at').$type<SqliteRow<'issueUserState'>['assignedAt']>(),
    assignedBy: textC('assigned_by').$type<SqliteRow<'issueUserState'>['assignedBy']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'issueUserState'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'issue_user_state_pk',
      columns: [table.workspaceId, table.userId, table.issueId],
    }),
    index('idx_issue_user_state_issue').on(table.workspaceId, table.issueId),
  ],
)

export const issues = pgTable(
  'issues',
  {
    id: textC('id').notNull().$type<SqliteRow<'issues'>['id']>(),
    ownerUserId: textC('owner_user_id').notNull().$type<SqliteRow<'issues'>['ownerUserId']>(),
    visibility: textC('visibility')
      .notNull()
      .default(sql`'personal'`)
      .$type<SqliteRow<'issues'>['visibility']>(),
    createdByActor: textC('created_by_actor')
      .notNull()
      .$type<SqliteRow<'issues'>['createdByActor']>(),
    createdByOnBehalfOf:
      textC('created_by_on_behalf_of').$type<SqliteRow<'issues'>['createdByOnBehalfOf']>(),
    repoPath: textC('repo_path').notNull().$type<SqliteRow<'issues'>['repoPath']>(),
    repoId: textC('repo_id').$type<SqliteRow<'issues'>['repoId']>(),
    seq: int8('seq').notNull().$type<SqliteRow<'issues'>['seq']>(),
    title: textC('title').notNull().$type<SqliteRow<'issues'>['title']>(),
    description: textC('description')
      .notNull()
      .default(sql`''`)
      .$type<SqliteRow<'issues'>['description']>(),
    brief: textC('brief').$type<SqliteRow<'issues'>['brief']>(),
    stage: textC('stage').notNull().$type<SqliteRow<'issues'>['stage']>(),
    worktreePath: textC('worktree_path').$type<SqliteRow<'issues'>['worktreePath']>(),
    branch: textC('branch').$type<SqliteRow<'issues'>['branch']>(),
    parentBranch: textC('parent_branch')
      .notNull()
      .default(sql`'main'`)
      .$type<SqliteRow<'issues'>['parentBranch']>(),
    defaultAgent: textC('default_agent').notNull().$type<SqliteRow<'issues'>['defaultAgent']>(),
    defaultModel: textC('default_model')
      .notNull()
      .default(sql`'auto'`)
      .$type<SqliteRow<'issues'>['defaultModel']>(),
    defaultEffort: textC('default_effort')
      .notNull()
      .default(sql`'auto'`)
      .$type<SqliteRow<'issues'>['defaultEffort']>(),
    machineId: textC('machine_id').$type<SqliteRow<'issues'>['machineId']>(),
    agentProfileId: textC('agent_profile_id').$type<SqliteRow<'issues'>['agentProfileId']>(),
    linearId: textC('linear_id').$type<SqliteRow<'issues'>['linearId']>(),
    linearIdentifier: textC('linear_identifier').$type<SqliteRow<'issues'>['linearIdentifier']>(),
    linearUrl: textC('linear_url').$type<SqliteRow<'issues'>['linearUrl']>(),
    suggestedStage: textC('suggested_stage').$type<SqliteRow<'issues'>['suggestedStage']>(),
    suggestedReason: textC('suggested_reason').$type<SqliteRow<'issues'>['suggestedReason']>(),
    blockedBy: jsonText('blocked_by')
      .notNull()
      .default(sql`'[]'`)
      .$type<SqliteRow<'issues'>['blockedBy']>(),
    dependencyNote: textC('dependency_note').$type<SqliteRow<'issues'>['dependencyNote']>(),
    prUrl: textC('pr_url').$type<SqliteRow<'issues'>['prUrl']>(),
    priority: int8('priority').notNull().default(2).$type<SqliteRow<'issues'>['priority']>(),
    type: textC('type').notNull().default(sql`'task'`).$type<SqliteRow<'issues'>['type']>(),
    assignee: textC('assignee').$type<SqliteRow<'issues'>['assignee']>(),
    parentId: textC('parent_id').$type<SqliteRow<'issues'>['parentId']>(),
    acceptance: textC('acceptance').$type<SqliteRow<'issues'>['acceptance']>(),
    dueAt: isoTimestamp('due_at').$type<SqliteRow<'issues'>['dueAt']>(),
    deferUntil: textC('defer_until').$type<SqliteRow<'issues'>['deferUntil']>(),
    closedReason: textC('closed_reason').$type<SqliteRow<'issues'>['closedReason']>(),
    closedAt: isoTimestamp('closed_at').$type<SqliteRow<'issues'>['closedAt']>(),
    closedByUserId: textC('closed_by_user_id').$type<SqliteRow<'issues'>['closedByUserId']>(),
    landedAt: isoTimestamp('landed_at').$type<SqliteRow<'issues'>['landedAt']>(),
    landedSha: textC('landed_sha').$type<SqliteRow<'issues'>['landedSha']>(),
    supersededBy: textC('superseded_by').$type<SqliteRow<'issues'>['supersededBy']>(),
    duplicateOf: textC('duplicate_of').$type<SqliteRow<'issues'>['duplicateOf']>(),
    sortKey: textC('sort_key').$type<SqliteRow<'issues'>['sortKey']>(),
    estimateMin: int8('estimate_min').$type<SqliteRow<'issues'>['estimateMin']>(),
    needsHuman: boolean('needs_human')
      .notNull()
      .default(false)
      .$type<SqliteRow<'issues'>['needsHuman']>(),
    humanQuestion: textC('human_question').$type<SqliteRow<'issues'>['humanQuestion']>(),
    humanQuestionOptions:
      jsonText('human_question_options').$type<SqliteRow<'issues'>['humanQuestionOptions']>(),
    humanQuestionAskedBy:
      textC('human_question_asked_by').$type<SqliteRow<'issues'>['humanQuestionAskedBy']>(),
    humanQuestionAskedAt:
      isoTimestamp('human_question_asked_at').$type<SqliteRow<'issues'>['humanQuestionAskedAt']>(),
    humanQuestionAttribution: jsonText('human_question_attribution').$type<
      SqliteRow<'issues'>['humanQuestionAttribution']
    >(),
    createdAt: isoTimestamp('created_at').notNull().$type<SqliteRow<'issues'>['createdAt']>(),
    actor: textC('actor').$type<SqliteRow<'issues'>['actor']>(),
    onBehalfOf: textC('on_behalf_of').$type<SqliteRow<'issues'>['onBehalfOf']>(),
    updatedAt: isoTimestamp('updated_at').notNull().$type<SqliteRow<'issues'>['updatedAt']>(),
    archived: boolean('archived').notNull().default(false).$type<SqliteRow<'issues'>['archived']>(),
    origin: textC('origin').notNull().default(sql`'human'`).$type<SqliteRow<'issues'>['origin']>(),
    draft: boolean('draft').notNull().default(false).$type<SqliteRow<'issues'>['draft']>(),
    audience: textC('audience')
      .notNull()
      .default(sql`'human'`)
      .$type<SqliteRow<'issues'>['audience']>(),
    deletedAt: isoTimestamp('deleted_at').$type<SqliteRow<'issues'>['deletedAt']>(),
    revision: int8('revision').notNull().default(1).$type<SqliteRow<'issues'>['revision']>(),
    coordinatorSessionId:
      textC('coordinator_session_id').$type<SqliteRow<'issues'>['coordinatorSessionId']>(),
    startedBySession: textC('started_by_session').$type<SqliteRow<'issues'>['startedBySession']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'issues'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'issues_pk', columns: [table.workspaceId, table.id] }),
    index('idx_issues_deleted_at').on(table.workspaceId, table.deletedAt),
    index('idx_issues_closed_projection').on(
      table.workspaceId,
      table.id,
      table.stage,
      table.closedReason,
      table.deletedAt,
    ),
    uniqueIndex('idx_issues_repo_id_seq').on(table.workspaceId, table.repoId, table.seq),
    index('idx_issues_parent').on(table.workspaceId, table.parentId),
    index('idx_issues_seq').on(table.workspaceId, table.seq, table.repoPath, table.id),
    index('idx_issues_repo').on(table.workspaceId, table.repoPath),
    index('idx_issues_worktree')
      .on(table.workspaceId, table.worktreePath)
      .where(sql`"worktree_path" IS NOT NULL AND "deleted_at" IS NULL`),
    index('idx_issues_worktree_folded')
      .on(table.workspaceId, sql`lower(replace("worktree_path", '/', '\\'))`)
      .where(sql`"worktree_path" IS NOT NULL AND "deleted_at" IS NULL`),
    index('idx_issues_superseded_by')
      .on(table.workspaceId, table.supersededBy)
      .where(sql`"superseded_by" IS NOT NULL`),
    index('idx_issues_duplicate_of')
      .on(table.workspaceId, table.duplicateOf)
      .where(sql`"duplicate_of" IS NOT NULL`),
    index('idx_issues_agent_profile')
      .on(table.workspaceId, table.agentProfileId)
      .where(sql`"agent_profile_id" IS NOT NULL`),
    foreignKey({
      name: 'fk_issues_parent_id_issues_id_fk',
      columns: [table.workspaceId, table.parentId],
      foreignColumns: [table.workspaceId, table.id],
    }),
    foreignKey({
      name: 'fk_issues_superseded_by_issues_id_fk',
      columns: [table.workspaceId, table.supersededBy],
      foreignColumns: [table.workspaceId, table.id],
    }),
    foreignKey({
      name: 'fk_issues_duplicate_of_issues_id_fk',
      columns: [table.workspaceId, table.duplicateOf],
      foreignColumns: [table.workspaceId, table.id],
    }),
    check(
      'issues_check_1',
      sql`stage IN ('proposed', 'backlog', 'planning', 'in_progress', 'review', 'shipping', 'verifying', 'done')`,
    ),
    check('issues_check_2', sql`priority BETWEEN 0 AND 4`),
    check('issues_check_3', sql`type IN ('task', 'phase', 'decision')`),
  ],
)

export const labels = pgTable(
  'labels',
  {
    id: int8('id').primaryKey().generatedByDefaultAsIdentity().$type<SqliteRow<'labels'>['id']>(),
    name: textC('name').notNull().$type<SqliteRow<'labels'>['name']>(),
    color: textC('color').$type<SqliteRow<'labels'>['color']>(),
    description: textC('description').$type<SqliteRow<'labels'>['description']>(),
    createdAt: isoTimestamp('created_at').notNull().$type<SqliteRow<'labels'>['createdAt']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'labels'>['workspaceId']>(),
  },
  (table) => [
    unique('labels_workspace_id_id_unique').on(table.workspaceId, table.id),
    uniqueIndex('idx_labels_name_nocase').on(table.workspaceId, sql`lower("name")`),
  ],
)

export const lockWaiters = pgTable(
  'lock_waiters',
  {
    id: int8('id')
      .primaryKey()
      .generatedByDefaultAsIdentity()
      .$type<SqliteRow<'lockWaiters'>['id']>(),
    repoId: textC('repo_id').notNull().$type<SqliteRow<'lockWaiters'>['repoId']>(),
    name: textC('name').notNull().$type<SqliteRow<'lockWaiters'>['name']>(),
    sessionId: textC('session_id').notNull().$type<SqliteRow<'lockWaiters'>['sessionId']>(),
    issueId: textC('issue_id').$type<SqliteRow<'lockWaiters'>['issueId']>(),
    label: textC('label').notNull().$type<SqliteRow<'lockWaiters'>['label']>(),
    ttlSeconds: int8('ttl_seconds')
      .notNull()
      .default(120)
      .$type<SqliteRow<'lockWaiters'>['ttlSeconds']>(),
    note: textC('note').$type<SqliteRow<'lockWaiters'>['note']>(),
    enqueuedAt: isoTimestamp('enqueued_at')
      .notNull()
      .$type<SqliteRow<'lockWaiters'>['enqueuedAt']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'lockWaiters'>['workspaceId']>(),
  },
  (table) => [
    unique('lock_waiters_workspace_id_id_unique').on(table.workspaceId, table.id),
    unique('lock_waiters_workspace_id_repo_id_name_session_id_unique').on(
      table.workspaceId,
      table.repoId,
      table.name,
      table.sessionId,
    ),
    index('idx_lock_waiters_session').on(table.workspaceId, table.sessionId),
    index('idx_lock_waiters_lock').on(table.workspaceId, table.repoId, table.name, table.id),
  ],
)

export const locks = pgTable(
  'locks',
  {
    repoId: textC('repo_id').notNull().$type<SqliteRow<'locks'>['repoId']>(),
    name: textC('name').notNull().$type<SqliteRow<'locks'>['name']>(),
    holderSessionId: textC('holder_session_id').$type<SqliteRow<'locks'>['holderSessionId']>(),
    holderIssueId: textC('holder_issue_id').$type<SqliteRow<'locks'>['holderIssueId']>(),
    holderLabel: textC('holder_label').notNull().$type<SqliteRow<'locks'>['holderLabel']>(),
    note: textC('note').$type<SqliteRow<'locks'>['note']>(),
    acquiredAt: isoTimestamp('acquired_at').notNull().$type<SqliteRow<'locks'>['acquiredAt']>(),
    expiresAt: isoTimestamp('expires_at').notNull().$type<SqliteRow<'locks'>['expiresAt']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'locks'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'locks_pk', columns: [table.workspaceId, table.repoId, table.name] }),
    index('idx_locks_expires').on(table.workspaceId, table.expiresAt),
    index('idx_locks_holder_session').on(table.workspaceId, table.holderSessionId),
  ],
)

export const machines = pgTable(
  'machines',
  {
    revokedAt: isoTimestamp('revoked_at').$type<SqliteRow<'machines'>['revokedAt']>(),
    supersededBy: textC('superseded_by').$type<SqliteRow<'machines'>['supersededBy']>(),
    id: textC('id').notNull().$type<SqliteRow<'machines'>['id']>(),
    name: textC('name').notNull().$type<SqliteRow<'machines'>['name']>(),
    hostname: textC('hostname').notNull().$type<SqliteRow<'machines'>['hostname']>(),
    tokenHash: textC('token_hash').notNull().$type<SqliteRow<'machines'>['tokenHash']>(),
    credentialKind: textC('credential_kind')
      .notNull()
      .default(sql`'bearer-hash'`)
      .$type<SqliteRow<'machines'>['credentialKind']>(),
    publicKey: textC('public_key').$type<SqliteRow<'machines'>['publicKey']>(),
    createdAt: isoTimestamp('created_at').notNull().$type<SqliteRow<'machines'>['createdAt']>(),
    lastSeenAt: isoTimestamp('last_seen_at').notNull().$type<SqliteRow<'machines'>['lastSeenAt']>(),
    inventoryJson: jsonText('inventory_json').$type<SqliteRow<'machines'>['inventoryJson']>(),
    harnessVersionsJson:
      jsonText('harness_versions_json').$type<SqliteRow<'machines'>['harnessVersionsJson']>(),
    podiumManaged: boolean('podium_managed')
      .notNull()
      .default(true)
      .$type<SqliteRow<'machines'>['podiumManaged']>(),
    updateChannel: textC('update_channel')
      .notNull()
      .default(sql`'stable'`)
      .$type<SqliteRow<'machines'>['updateChannel']>(),
    updateChannelOverride:
      textC('update_channel_override').$type<SqliteRow<'machines'>['updateChannelOverride']>(),
    appVersion: textC('app_version').$type<SqliteRow<'machines'>['appVersion']>(),
    wireSchemaDigest:
      textC('wire_schema_digest').$type<SqliteRow<'machines'>['wireSchemaDigest']>(),
    installKind: textC('install_kind').$type<SqliteRow<'machines'>['installKind']>(),
    deliveryCapsJson:
      jsonText('delivery_caps_json').$type<SqliteRow<'machines'>['deliveryCapsJson']>(),
    presenceSource: textC('presence_source').$type<SqliteRow<'machines'>['presenceSource']>(),
    serviceAssignmentJson: jsonText('service_assignment_json')
      .notNull()
      .default(sql`'{"server":false,"agentExecution":true}'`)
      .$type<SqliteRow<'machines'>['serviceAssignmentJson']>(),
    assignmentEvidenceJson: jsonText('assignment_evidence_json').$type<
      SqliteRow<'machines'>['assignmentEvidenceJson']
    >(),
    availabilityJson:
      jsonText('availability_json').$type<SqliteRow<'machines'>['availabilityJson']>(),
    serviceReportJson:
      jsonText('service_report_json').$type<SqliteRow<'machines'>['serviceReportJson']>(),
    buildReportedAt:
      isoTimestamp('build_reported_at').$type<SqliteRow<'machines'>['buildReportedAt']>(),
    componentsJson: jsonText('components_json').$type<SqliteRow<'machines'>['componentsJson']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'machines'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'machines_pk', columns: [table.workspaceId, table.id] }),
    check(
      'machines_credential_material',
      sql`(
  ("credential_kind" = 'bearer-hash' AND "token_hash" <> '' AND "public_key" IS NULL)
  OR ("credential_kind" = 'ed25519' AND "token_hash" = '' AND "public_key" IS NOT NULL
      AND length("public_key") = 51 AND substr("public_key", 1, 8) = 'ed25519:')
)`,
    ),
  ],
)

export const maintenanceCommands = pgTable(
  'maintenance_commands',
  {
    jobKind: textC('job_kind').notNull().$type<SqliteRow<'maintenanceCommands'>['jobKind']>(),
    runKey: textC('run_key').notNull().$type<SqliteRow<'maintenanceCommands'>['runKey']>(),
    fencingToken: int8('fencing_token')
      .notNull()
      .$type<SqliteRow<'maintenanceCommands'>['fencingToken']>(),
    resultJson: jsonText('result_json')
      .notNull()
      .$type<SqliteRow<'maintenanceCommands'>['resultJson']>(),
    appliedAt: isoTimestamp('applied_at')
      .notNull()
      .$type<SqliteRow<'maintenanceCommands'>['appliedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'maintenanceCommands'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'maintenance_commands_pk',
      columns: [table.workspaceId, table.jobKind, table.runKey],
    }),
  ],
)

export const maintenanceLeases = pgTable('maintenance_leases', {
  name: textC('name').primaryKey().$type<SqliteRow<'maintenanceLeases'>['name']>(),
  generationId: textC('generation_id')
    .notNull()
    .$type<SqliteRow<'maintenanceLeases'>['generationId']>(),
  fencingToken: int8('fencing_token')
    .notNull()
    .$type<SqliteRow<'maintenanceLeases'>['fencingToken']>(),
  expiresAt: isoTimestamp('expires_at')
    .notNull()
    .$type<SqliteRow<'maintenanceLeases'>['expiresAt']>(),
  protocolVersion: int8('protocol_version')
    .notNull()
    .$type<SqliteRow<'maintenanceLeases'>['protocolVersion']>(),
  schemaVersion: textC('schema_version')
    .notNull()
    .$type<SqliteRow<'maintenanceLeases'>['schemaVersion']>(),
  updatedAt: isoTimestamp('updated_at')
    .notNull()
    .$type<SqliteRow<'maintenanceLeases'>['updatedAt']>(),
})

export const messageReads = pgTable(
  'message_reads',
  {
    messageId: textC('message_id').notNull().$type<SqliteRow<'messageReads'>['messageId']>(),
    sessionId: textC('session_id').notNull().$type<SqliteRow<'messageReads'>['sessionId']>(),
    readAt: isoTimestamp('read_at').notNull().$type<SqliteRow<'messageReads'>['readAt']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'messageReads'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'message_reads_pk',
      columns: [table.workspaceId, table.messageId, table.sessionId],
    }),
    index('idx_message_reads_session').on(table.workspaceId, table.sessionId),
  ],
)

export const messageWakeCooldowns = pgTable(
  'message_wake_cooldowns',
  {
    key: textC('key').notNull().$type<SqliteRow<'messageWakeCooldowns'>['key']>(),
    attemptedAt: isoTimestamp('attempted_at')
      .notNull()
      .$type<SqliteRow<'messageWakeCooldowns'>['attemptedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'messageWakeCooldowns'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'message_wake_cooldowns_pk', columns: [table.workspaceId, table.key] }),
  ],
)

export const messages = pgTable(
  'messages',
  {
    id: textC('id').notNull().$type<SqliteRow<'messages'>['id']>(),
    threadId: textC('thread_id').notNull().$type<SqliteRow<'messages'>['threadId']>(),
    inReplyTo: textC('in_reply_to').$type<SqliteRow<'messages'>['inReplyTo']>(),
    fromKind: textC('from_kind').notNull().$type<SqliteRow<'messages'>['fromKind']>(),
    fromSession: textC('from_session').$type<SqliteRow<'messages'>['fromSession']>(),
    fromIssue: textC('from_issue').$type<SqliteRow<'messages'>['fromIssue']>(),
    actorKind: textC('actor_kind').$type<SqliteRow<'messages'>['actorKind']>(),
    actorId: textC('actor_id').$type<SqliteRow<'messages'>['actorId']>(),
    onBehalfOf: textC('on_behalf_of').$type<SqliteRow<'messages'>['onBehalfOf']>(),
    delegationRef: textC('delegation_ref').$type<SqliteRow<'messages'>['delegationRef']>(),
    toKind: textC('to_kind').notNull().$type<SqliteRow<'messages'>['toKind']>(),
    toId: textC('to_id').$type<SqliteRow<'messages'>['toId']>(),
    kind: textC('kind').notNull().default(sql`'message'`).$type<SqliteRow<'messages'>['kind']>(),
    urgency: textC('urgency')
      .notNull()
      .default(sql`'fyi'`)
      .$type<SqliteRow<'messages'>['urgency']>(),
    lifecycle: textC('lifecycle')
      .notNull()
      .default(sql`'wait'`)
      .$type<SqliteRow<'messages'>['lifecycle']>(),
    body: textC('body').notNull().$type<SqliteRow<'messages'>['body']>(),
    attachmentsJson: jsonText('attachments_json').$type<SqliteRow<'messages'>['attachmentsJson']>(),
    expiresAt: isoTimestamp('expires_at').$type<SqliteRow<'messages'>['expiresAt']>(),
    createdAt: isoTimestamp('created_at').notNull().$type<SqliteRow<'messages'>['createdAt']>(),
    deliveryStatus: textC('delivery_status')
      .notNull()
      .default(sql`'stored'`)
      .$type<SqliteRow<'messages'>['deliveryStatus']>(),
    deliveryHeld: textC('delivery_held').$type<SqliteRow<'messages'>['deliveryHeld']>(),
    deliveredAt: isoTimestamp('delivered_at').$type<SqliteRow<'messages'>['deliveredAt']>(),
    deliveredTo: textC('delivered_to').$type<SqliteRow<'messages'>['deliveredTo']>(),
    ackedBy: textC('acked_by').$type<SqliteRow<'messages'>['ackedBy']>(),
    hop: int8('hop').notNull().default(0).$type<SqliteRow<'messages'>['hop']>(),
    clampedFrom: jsonText('clamped_from').$type<SqliteRow<'messages'>['clampedFrom']>(),
    remindedAt: isoTimestamp('reminded_at').$type<SqliteRow<'messages'>['remindedAt']>(),
    fromName: textC('from_name').$type<SqliteRow<'messages'>['fromName']>(),
    readAt: isoTimestamp('read_at').$type<SqliteRow<'messages'>['readAt']>(),
    injectedAt: isoTimestamp('injected_at').$type<SqliteRow<'messages'>['injectedAt']>(),
    deliveryDeferredAt:
      isoTimestamp('delivery_deferred_at').$type<SqliteRow<'messages'>['deliveryDeferredAt']>(),
    deliveryDeferredReason: textC('delivery_deferred_reason').$type<
      SqliteRow<'messages'>['deliveryDeferredReason']
    >(),
    deadLetteredAt:
      isoTimestamp('dead_lettered_at').$type<SqliteRow<'messages'>['deadLetteredAt']>(),
    expectsResponse: boolean('expects_response')
      .notNull()
      .default(false)
      .$type<SqliteRow<'messages'>['expectsResponse']>(),
    factKey: textC('fact_key').$type<SqliteRow<'messages'>['factKey']>(),
    factTarget: textC('fact_target').$type<SqliteRow<'messages'>['factTarget']>(),
    transcriptItemId:
      textC('transcript_item_id').$type<SqliteRow<'messages'>['transcriptItemId']>(),
    transcriptItemCursor:
      textC('transcript_item_cursor').$type<SqliteRow<'messages'>['transcriptItemCursor']>(),
    harnessRefJson: jsonText('harness_ref_json').$type<SqliteRow<'messages'>['harnessRefJson']>(),
    noticeDismissedAt:
      isoTimestamp('notice_dismissed_at').$type<SqliteRow<'messages'>['noticeDismissedAt']>(),
    retractRequestedAt:
      isoTimestamp('retract_requested_at').$type<SqliteRow<'messages'>['retractRequestedAt']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'messages'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'messages_pk', columns: [table.workspaceId, table.id] }),
    index('idx_messages_delivered_to_time').on(
      table.workspaceId,
      table.deliveredTo,
      table.createdAt,
      table.id,
    ),
    index('idx_messages_open_chat')
      .on(table.workspaceId, table.createdAt)
      .where(
        sql`"from_kind" = 'operator' AND "to_kind" = 'session' AND "notice_dismissed_at" IS NULL AND "delivery_status" NOT IN ('confirmed', 'cancelled')`,
      ),
    index('idx_messages_from_session_time').on(
      table.workspaceId,
      table.fromSession,
      table.createdAt,
      table.id,
    ),
    index('idx_messages_from_issue')
      .on(table.workspaceId, table.fromIssue, table.createdAt, table.id)
      .where(sql`"from_issue" IS NOT NULL`),
    index('idx_messages_recipient_time').on(
      table.workspaceId,
      table.toKind,
      table.toId,
      table.createdAt,
      table.id,
    ),
    index('idx_messages_reply')
      .on(table.workspaceId, table.inReplyTo, table.kind)
      .where(sql`"in_reply_to" IS NOT NULL`),
    index('idx_messages_thread').on(table.workspaceId, table.threadId),
    index('idx_messages_recipient_delivery').on(
      table.workspaceId,
      table.toKind,
      table.toId,
      table.deliveryStatus,
      table.createdAt,
      table.id,
    ),
    index('idx_messages_delivery_order').on(
      table.workspaceId,
      table.deliveryStatus,
      table.createdAt,
      table.id,
    ),
    index('idx_messages_delivery_expiry_explicit').on(
      table.workspaceId,
      table.deliveryStatus,
      table.expiresAt,
      table.id,
    ),
    index('idx_messages_delivery_expiry_implicit').on(
      table.workspaceId,
      table.deliveryStatus,
      table.lifecycle,
      table.expiresAt,
      table.createdAt,
      table.id,
    ),
    check('messages_check_5', sql`from_kind IN ('operator','superagent','agent','system')`),
    check('messages_check_6', sql`to_kind IN ('issue','session','operator')`),
    check('messages_check_7', sql`kind IN ('message','ack','notification','question')`),
    check('messages_check_8', sql`urgency IN ('fyi','next-turn','interrupt')`),
    check('messages_check_9', sql`lifecycle IN ('wait','wake')`),
    check(
      'messages_delivery_status',
      sql`delivery_status IN ('stored','dispatched','reached-machine','typing','typed','accepted','confirmed','cancelled','failed','expired','unknown')`,
    ),
    check('messages_delivery_held', sql`delivery_held IN ('memory','durable')`),
  ],
)

export const messagingIssueTopics = pgTable(
  'messaging_issue_topics',
  {
    issueId: textC('issue_id').notNull().$type<SqliteRow<'messagingIssueTopics'>['issueId']>(),
    chatId: textC('chat_id').notNull().$type<SqliteRow<'messagingIssueTopics'>['chatId']>(),
    threadRef: textC('thread_ref')
      .notNull()
      .$type<SqliteRow<'messagingIssueTopics'>['threadRef']>(),
    superagentThreadId: textC('superagent_thread_id')
      .notNull()
      .$type<SqliteRow<'messagingIssueTopics'>['superagentThreadId']>(),
    updatedAt: isoTimestamp('updated_at')
      .notNull()
      .$type<SqliteRow<'messagingIssueTopics'>['updatedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'messagingIssueTopics'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'messaging_issue_topics_pk',
      columns: [table.workspaceId, table.issueId, table.chatId],
    }),
    index('idx_messaging_issue_topics_ref').on(table.workspaceId, table.chatId, table.threadRef),
  ],
)

export const messagingSessionAttachments = pgTable(
  'messaging_session_attachments',
  {
    chatId: textC('chat_id').notNull().$type<SqliteRow<'messagingSessionAttachments'>['chatId']>(),
    threadRef: textC('thread_ref')
      .notNull()
      .$type<SqliteRow<'messagingSessionAttachments'>['threadRef']>(),
    userId: textC('user_id').notNull().$type<SqliteRow<'messagingSessionAttachments'>['userId']>(),
    sessionId: textC('session_id')
      .notNull()
      .$type<SqliteRow<'messagingSessionAttachments'>['sessionId']>(),
    attachedAt: isoTimestamp('attached_at')
      .notNull()
      .$type<SqliteRow<'messagingSessionAttachments'>['attachedAt']>(),
    relayedItemId:
      textC('relayed_item_id').$type<SqliteRow<'messagingSessionAttachments'>['relayedItemId']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'messagingSessionAttachments'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'messaging_session_attachments_pk',
      columns: [table.workspaceId, table.chatId, table.threadRef],
    }),
    index('idx_messaging_session_attachments_session').on(table.workspaceId, table.sessionId),
  ],
)

export const meta = pgTable('meta', {
  key: textC('key').primaryKey().$type<SqliteRow<'meta'>['key']>(),
  value: textC('value').notNull().$type<SqliteRow<'meta'>['value']>(),
})

export const nativeLoginOptIns = pgTable(
  'native_login_opt_ins',
  {
    ownerUserId: textC('owner_user_id')
      .notNull()
      .$type<SqliteRow<'nativeLoginOptIns'>['ownerUserId']>(),
    harness: textC('harness').notNull().$type<SqliteRow<'nativeLoginOptIns'>['harness']>(),
    fingerprint: textC('fingerprint')
      .notNull()
      .$type<SqliteRow<'nativeLoginOptIns'>['fingerprint']>(),
    enabled: int8('enabled').notNull().$type<SqliteRow<'nativeLoginOptIns'>['enabled']>(),
    revision: int8('revision').notNull().$type<SqliteRow<'nativeLoginOptIns'>['revision']>(),
    updatedAt: isoTimestamp('updated_at')
      .notNull()
      .$type<SqliteRow<'nativeLoginOptIns'>['updatedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'nativeLoginOptIns'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'native_login_opt_ins_pk',
      columns: [table.workspaceId, table.ownerUserId, table.harness, table.fingerprint],
    }),
  ],
)

export const nativeLoginTransfers = pgTable(
  'native_login_transfers',
  {
    ownerUserId: textC('owner_user_id')
      .notNull()
      .$type<SqliteRow<'nativeLoginTransfers'>['ownerUserId']>(),
    harness: textC('harness').notNull().$type<SqliteRow<'nativeLoginTransfers'>['harness']>(),
    fingerprint: textC('fingerprint')
      .notNull()
      .$type<SqliteRow<'nativeLoginTransfers'>['fingerprint']>(),
    machineId: textC('machine_id')
      .notNull()
      .$type<SqliteRow<'nativeLoginTransfers'>['machineId']>(),
    outcome: textC('outcome').notNull().$type<SqliteRow<'nativeLoginTransfers'>['outcome']>(),
    revision: int8('revision').notNull().$type<SqliteRow<'nativeLoginTransfers'>['revision']>(),
    at: textC('at').notNull().$type<SqliteRow<'nativeLoginTransfers'>['at']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'nativeLoginTransfers'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'native_login_transfers_pk',
      columns: [
        table.workspaceId,
        table.ownerUserId,
        table.harness,
        table.fingerprint,
        table.machineId,
      ],
    }),
    check('native_login_transfers_outcome', sql`outcome IN ('installed', 'preserved')`),
  ],
)

export const notificationFacts = pgTable(
  'notification_facts',
  {
    factKey: textC('fact_key').notNull().$type<SqliteRow<'notificationFacts'>['factKey']>(),
    target: textC('target').notNull().$type<SqliteRow<'notificationFacts'>['target']>(),
    source: textC('source').$type<SqliteRow<'notificationFacts'>['source']>(),
    issueId: textC('issue_id').$type<SqliteRow<'notificationFacts'>['issueId']>(),
    createdAt: isoTimestamp('created_at')
      .notNull()
      .$type<SqliteRow<'notificationFacts'>['createdAt']>(),
    expiresAt: isoTimestamp('expires_at').$type<SqliteRow<'notificationFacts'>['expiresAt']>(),
    consumedAt: isoTimestamp('consumed_at').$type<SqliteRow<'notificationFacts'>['consumedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'notificationFacts'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'notification_facts_pk',
      columns: [table.workspaceId, table.factKey, table.target],
    }),
    index('idx_notification_facts_issue').on(table.workspaceId, table.issueId),
    index('idx_notification_facts_expires').on(table.workspaceId, table.expiresAt),
  ],
)

export const offers = pgTable(
  'offers',
  {
    sessionId: textC('session_id').notNull().$type<SqliteRow<'offers'>['sessionId']>(),
    message: textC('message').notNull().$type<SqliteRow<'offers'>['message']>(),
    actions: jsonText('actions').notNull().$type<SqliteRow<'offers'>['actions']>(),
    artifacts: jsonText('artifacts').$type<SqliteRow<'offers'>['artifacts']>(),
    createdAt: isoTimestamp('created_at').notNull().$type<SqliteRow<'offers'>['createdAt']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'offers'>['workspaceId']>(),
  },
  (table) => [primaryKey({ name: 'offers_pk', columns: [table.workspaceId, table.sessionId] })],
)

export const operations = pgTable(
  'operations',
  {
    id: textC('id').notNull().$type<SqliteRow<'operations'>['id']>(),
    kind: textC('kind').notNull().$type<SqliteRow<'operations'>['kind']>(),
    exclusionGroup: textC('exclusion_group')
      .notNull()
      .$type<SqliteRow<'operations'>['exclusionGroup']>(),
    state: textC('state').notNull().$type<SqliteRow<'operations'>['state']>(),
    createdAt: int8('created_at').notNull().$type<SqliteRow<'operations'>['createdAt']>(),
    updatedAt: int8('updated_at').notNull().$type<SqliteRow<'operations'>['updatedAt']>(),
    finishedAt: int8('finished_at').$type<SqliteRow<'operations'>['finishedAt']>(),
    payload: jsonText('payload').notNull().$type<SqliteRow<'operations'>['payload']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'operations'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'operations_pk', columns: [table.workspaceId, table.id] }),
    index('idx_operations_group_state').on(table.workspaceId, table.exclusionGroup, table.state),
    index('idx_operations_kind_created').on(table.workspaceId, table.kind, table.createdAt),
  ],
)

export const pendingInteractions = pgTable(
  'pending_interactions',
  {
    id: textC('id').notNull().$type<SqliteRow<'pendingInteractions'>['id']>(),
    sessionId: textC('session_id').notNull().$type<SqliteRow<'pendingInteractions'>['sessionId']>(),
    kind: textC('kind').notNull().$type<SqliteRow<'pendingInteractions'>['kind']>(),
    payloadJson: jsonText('payload_json')
      .notNull()
      .$type<SqliteRow<'pendingInteractions'>['payloadJson']>(),
    source: textC('source').notNull().$type<SqliteRow<'pendingInteractions'>['source']>(),
    answerable: textC('answerable')
      .notNull()
      .$type<SqliteRow<'pendingInteractions'>['answerable']>(),
    fingerprint: textC('fingerprint')
      .notNull()
      .$type<SqliteRow<'pendingInteractions'>['fingerprint']>(),
    status: textC('status')
      .notNull()
      .default(sql`'asked'`)
      .$type<SqliteRow<'pendingInteractions'>['status']>(),
    policyVerdict:
      textC('policy_verdict').$type<SqliteRow<'pendingInteractions'>['policyVerdict']>(),
    askedAt: isoTimestamp('asked_at')
      .notNull()
      .$type<SqliteRow<'pendingInteractions'>['askedAt']>(),
    expiresAt: isoTimestamp('expires_at').$type<SqliteRow<'pendingInteractions'>['expiresAt']>(),
    answeredAt: isoTimestamp('answered_at').$type<SqliteRow<'pendingInteractions'>['answeredAt']>(),
    answeredBy: textC('answered_by').$type<SqliteRow<'pendingInteractions'>['answeredBy']>(),
    answerJson: jsonText('answer_json').$type<SqliteRow<'pendingInteractions'>['answerJson']>(),
    deliveredVia: textC('delivered_via').$type<SqliteRow<'pendingInteractions'>['deliveredVia']>(),
    expiredAt: isoTimestamp('expired_at').$type<SqliteRow<'pendingInteractions'>['expiredAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'pendingInteractions'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'pending_interactions_pk', columns: [table.workspaceId, table.id] }),
    index('idx_pending_interactions_session_time').on(
      table.workspaceId,
      table.sessionId,
      table.askedAt,
      table.id,
    ),
    index('idx_pending_interactions_open').on(table.workspaceId, table.status, table.askedAt),
    uniqueIndex('idx_pending_interactions_fingerprint')
      .on(table.workspaceId, table.sessionId, table.fingerprint)
      .where(sql`status = 'asked'`),
    check(
      'pending_interactions_status_check',
      sql`status IN ('asked','answered','expired','superseded')`,
    ),
    check(
      'pending_interactions_kind_check',
      sql`kind IN ('permission','question','plan-approval','elicitation','login','recovery')`,
    ),
    check(
      'pending_interactions_source_check',
      sql`source IN ('protocol','sdk-callback','hook','screen-classifier')`,
    ),
  ],
)

export const pendingUploads = pgTable(
  'pending_uploads',
  {
    id: textC('id').notNull().$type<SqliteRow<'pendingUploads'>['id']>(),
    ownerUserId: textC('owner_user_id')
      .notNull()
      .$type<SqliteRow<'pendingUploads'>['ownerUserId']>(),
    filename: textC('filename').notNull().$type<SqliteRow<'pendingUploads'>['filename']>(),
    entry: textC('entry').notNull().$type<SqliteRow<'pendingUploads'>['entry']>(),
    mediaType: textC('media_type').notNull().$type<SqliteRow<'pendingUploads'>['mediaType']>(),
    size: int8('size').notNull().$type<SqliteRow<'pendingUploads'>['size']>(),
    createdAt: int8('created_at').notNull().$type<SqliteRow<'pendingUploads'>['createdAt']>(),
    claimedIssueId:
      textC('claimed_issue_id').$type<SqliteRow<'pendingUploads'>['claimedIssueId']>(),
    claimedArtifactId:
      textC('claimed_artifact_id').$type<SqliteRow<'pendingUploads'>['claimedArtifactId']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'pendingUploads'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'pending_uploads_pk', columns: [table.workspaceId, table.id] }),
    index('idx_pending_uploads_created').on(table.workspaceId, table.createdAt),
    index('idx_pending_uploads_claimed').on(table.workspaceId, table.claimedIssueId),
    check(
      'pending_uploads_claim_pair',
      sql`(claimed_issue_id IS NULL) = (claimed_artifact_id IS NULL)`,
    ),
  ],
)

export const pins = pgTable(
  'pins',
  {
    userId: textC('user_id').notNull().$type<SqliteRow<'pins'>['userId']>(),
    kind: textC('kind').notNull().$type<SqliteRow<'pins'>['kind']>(),
    id: textC('id').notNull().$type<SqliteRow<'pins'>['id']>(),
    pinnedAt: isoTimestamp('pinned_at').notNull().$type<SqliteRow<'pins'>['pinnedAt']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'pins'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'pins_pk',
      columns: [table.workspaceId, table.userId, table.kind, table.id],
    }),
    index('idx_pins_target').on(table.workspaceId, table.kind, table.id),
  ],
)

export const podiumEvents = pgTable(
  'podium_events',
  {
    id: int8('id')
      .primaryKey()
      .generatedByDefaultAsIdentity()
      .$type<SqliteRow<'podiumEvents'>['id']>(),
    ts: textC('ts').notNull().$type<SqliteRow<'podiumEvents'>['ts']>(),
    kind: textC('kind').notNull().$type<SqliteRow<'podiumEvents'>['kind']>(),
    subject: textC('subject').notNull().$type<SqliteRow<'podiumEvents'>['subject']>(),
    repoPath: textC('repo_path').$type<SqliteRow<'podiumEvents'>['repoPath']>(),
    payload: jsonText('payload')
      .notNull()
      .default(sql`'{}'`)
      .$type<SqliteRow<'podiumEvents'>['payload']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'podiumEvents'>['workspaceId']>(),
  },
  (table) => [
    unique('podium_events_workspace_id_id_unique').on(table.workspaceId, table.id),
    index('idx_podium_events_repo').on(table.workspaceId, table.repoPath),
    index('idx_podium_events_kind').on(table.workspaceId, table.kind),
    index('idx_podium_events_subject').on(table.workspaceId, table.subject),
    index('idx_podium_events_kind_subject_ts').on(
      table.workspaceId,
      table.kind,
      table.subject,
      table.ts,
    ),
    index('idx_podium_events_kind_subject_id').on(
      table.workspaceId,
      table.kind,
      table.subject,
      table.id,
    ),
  ],
)

export const queuedMessages = pgTable(
  'queued_messages',
  {
    id: textC('id').notNull().$type<SqliteRow<'queuedMessages'>['id']>(),
    sessionId: textC('session_id').notNull().$type<SqliteRow<'queuedMessages'>['sessionId']>(),
    text: textC('text').notNull().$type<SqliteRow<'queuedMessages'>['text']>(),
    queuedAt: int8('queued_at').notNull().$type<SqliteRow<'queuedMessages'>['queuedAt']>(),
    inputOrigin: textC('input_origin')
      .notNull()
      .default(sql`'unknown'`)
      .$type<SqliteRow<'queuedMessages'>['inputOrigin']>(),
    attempts: int8('attempts')
      .notNull()
      .default(0)
      .$type<SqliteRow<'queuedMessages'>['attempts']>(),
    deliveryOwner: textC('delivery_owner').$type<SqliteRow<'queuedMessages'>['deliveryOwner']>(),
    principalKind: textC('principal_kind')
      .notNull()
      .default(sql`'system'`)
      .$type<SqliteRow<'queuedMessages'>['principalKind']>(),
    principalRef: textC('principal_ref')
      .notNull()
      .default(sql`'legacy-session-inbox'`)
      .$type<SqliteRow<'queuedMessages'>['principalRef']>(),
    delegationRef: textC('delegation_ref').$type<SqliteRow<'queuedMessages'>['delegationRef']>(),
    actorKind: textC('actor_kind')
      .notNull()
      .default(sql`'system'`)
      .$type<SqliteRow<'queuedMessages'>['actorKind']>(),
    actorId: textC('actor_id')
      .notNull()
      .default(sql`'legacy-session-inbox'`)
      .$type<SqliteRow<'queuedMessages'>['actorId']>(),
    onBehalfOf: textC('on_behalf_of').$type<SqliteRow<'queuedMessages'>['onBehalfOf']>(),
    sourceMessageId:
      textC('source_message_id').$type<SqliteRow<'queuedMessages'>['sourceMessageId']>(),
    delivery: textC('delivery')
      .notNull()
      .default(sql`'when-ready'`)
      .$type<SqliteRow<'queuedMessages'>['delivery']>(),
    attachmentsJson:
      jsonText('attachments_json').$type<SqliteRow<'queuedMessages'>['attachmentsJson']>(),
    retractRequestedAt:
      int8('retract_requested_at').$type<SqliteRow<'queuedMessages'>['retractRequestedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'queuedMessages'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'queued_messages_pk', columns: [table.workspaceId, table.id] }),
    index('queued_messages_session').on(table.workspaceId, table.sessionId, table.queuedAt),
    check('queued_messages_principal_kind', sql`principal_kind IN ('user','agent','system')`),
    check('queued_messages_actor_kind', sql`actor_kind IN ('user','agent','system')`),
  ],
)

export const quotaWindows = pgTable(
  'quota_windows',
  {
    accountKey: textC('account_key').notNull().$type<SqliteRow<'quotaWindows'>['accountKey']>(),
    agent: textC('agent').notNull().$type<SqliteRow<'quotaWindows'>['agent']>(),
    windowKey: textC('window_key').notNull().$type<SqliteRow<'quotaWindows'>['windowKey']>(),
    resetsAtBucket: int8('resets_at_bucket')
      .notNull()
      .$type<SqliteRow<'quotaWindows'>['resetsAtBucket']>(),
    label: textC('label').notNull().$type<SqliteRow<'quotaWindows'>['label']>(),
    scopeModel: textC('scope_model').$type<SqliteRow<'quotaWindows'>['scopeModel']>(),
    plan: textC('plan').$type<SqliteRow<'quotaWindows'>['plan']>(),
    resetsAtMs: int8('resets_at_ms').notNull().$type<SqliteRow<'quotaWindows'>['resetsAtMs']>(),
    startedAtMs: int8('started_at_ms').$type<SqliteRow<'quotaWindows'>['startedAtMs']>(),
    windowMinutes: int8('window_minutes')
      .notNull()
      .$type<SqliteRow<'quotaWindows'>['windowMinutes']>(),
    firstSeenMs: int8('first_seen_ms').notNull().$type<SqliteRow<'quotaWindows'>['firstSeenMs']>(),
    lastSeenMs: int8('last_seen_ms').notNull().$type<SqliteRow<'quotaWindows'>['lastSeenMs']>(),
    firstPercent: doublePrecision('first_percent')
      .notNull()
      .$type<SqliteRow<'quotaWindows'>['firstPercent']>(),
    peakPercent: doublePrecision('peak_percent')
      .notNull()
      .$type<SqliteRow<'quotaWindows'>['peakPercent']>(),
    lastPercent: doublePrecision('last_percent')
      .notNull()
      .$type<SqliteRow<'quotaWindows'>['lastPercent']>(),
    sampleCount: int8('sample_count').notNull().$type<SqliteRow<'quotaWindows'>['sampleCount']>(),
    partial: boolean('partial').notNull().$type<SqliteRow<'quotaWindows'>['partial']>(),
    source: textC('source').notNull().$type<SqliteRow<'quotaWindows'>['source']>(),
    trailJson: jsonText('trail_json').notNull().$type<SqliteRow<'quotaWindows'>['trailJson']>(),
    ownerUserId: textC('owner_user_id').$type<SqliteRow<'quotaWindows'>['ownerUserId']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'quotaWindows'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'quota_windows_pk',
      columns: [table.workspaceId, table.accountKey, table.windowKey, table.resetsAtBucket],
    }),
    index('idx_quota_windows_series').on(
      table.workspaceId,
      table.accountKey,
      table.windowKey,
      table.resetsAtMs,
    ),
    index('idx_quota_windows_owner').on(
      table.workspaceId,
      table.ownerUserId,
      table.accountKey,
      table.windowKey,
      table.resetsAtMs,
    ),
    index('idx_quota_windows_resets').on(table.workspaceId, table.resetsAtMs),
  ],
)

export const recapWatermarks = pgTable(
  'recap_watermarks',
  {
    reader: textC('reader').notNull().$type<SqliteRow<'recapWatermarks'>['reader']>(),
    sessionId: textC('session_id').notNull().$type<SqliteRow<'recapWatermarks'>['sessionId']>(),
    watermark: textC('watermark').notNull().$type<SqliteRow<'recapWatermarks'>['watermark']>(),
    updatedAt: isoTimestamp('updated_at')
      .notNull()
      .$type<SqliteRow<'recapWatermarks'>['updatedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'recapWatermarks'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'recap_watermarks_pk',
      columns: [table.workspaceId, table.reader, table.sessionId],
    }),
  ],
)

export const repoDraftSeq = pgTable(
  'repo_draft_seq',
  {
    repoId: textC('repo_id').notNull().$type<SqliteRow<'repoDraftSeq'>['repoId']>(),
    nextSeq: int8('next_seq').notNull().$type<SqliteRow<'repoDraftSeq'>['nextSeq']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'repoDraftSeq'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'repo_draft_seq_pk', columns: [table.workspaceId, table.repoId] }),
  ],
)

export const repoPrefixes = pgTable(
  'repo_prefixes',
  {
    repoId: textC('repo_id').notNull().$type<SqliteRow<'repoPrefixes'>['repoId']>(),
    prefix: textC('prefix').notNull().$type<SqliteRow<'repoPrefixes'>['prefix']>(),
    defaultParentBranch:
      textC('default_parent_branch').$type<SqliteRow<'repoPrefixes'>['defaultParentBranch']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'repoPrefixes'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'repo_prefixes_pk', columns: [table.workspaceId, table.repoId] }),
    unique('repo_prefixes_prefix_unique').on(table.workspaceId, table.prefix),
  ],
)

export const repos = pgTable(
  'repos',
  {
    machineId: textC('machine_id').notNull().$type<SqliteRow<'repos'>['machineId']>(),
    path: textC('path').notNull().$type<SqliteRow<'repos'>['path']>(),
    originUrl: textC('origin_url').$type<SqliteRow<'repos'>['originUrl']>(),
    repoName: textC('repo_name').$type<SqliteRow<'repos'>['repoName']>(),
    addedAt: isoTimestamp('added_at').notNull().$type<SqliteRow<'repos'>['addedAt']>(),
    repoId: textC('repo_id').$type<SqliteRow<'repos'>['repoId']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'repos'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'repos_pk', columns: [table.workspaceId, table.machineId, table.path] }),
  ],
)

export const rootIntegrationReceipts = pgTable(
  'root_integration_receipts',
  {
    rootIssueId: textC('root_issue_id')
      .notNull()
      .$type<SqliteRow<'rootIntegrationReceipts'>['rootIssueId']>(),
    approvedHeadSha: textC('approved_head_sha')
      .notNull()
      .$type<SqliteRow<'rootIntegrationReceipts'>['approvedHeadSha']>(),
    descendants: jsonText('descendants')
      .notNull()
      .default(sql`'[]'`)
      .$type<SqliteRow<'rootIntegrationReceipts'>['descendants']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'rootIntegrationReceipts'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'root_integration_receipts_pk',
      columns: [table.workspaceId, table.rootIssueId, table.approvedHeadSha],
    }),
    foreignKey({
      name: 'fk_root_integration_receipts_root_issue_id_issues_id_fk',
      columns: [table.workspaceId, table.rootIssueId],
      foreignColumns: [issues.workspaceId, issues.id],
    }).onDelete('restrict'),
  ],
)

export const runtimeEventCheckpoints = pgTable(
  'runtime_event_checkpoints',
  {
    sessionId: textC('session_id')
      .notNull()
      .$type<SqliteRow<'runtimeEventCheckpoints'>['sessionId']>(),
    observerGeneration: int8('observer_generation')
      .notNull()
      .$type<SqliteRow<'runtimeEventCheckpoints'>['observerGeneration']>(),
    cursorJson: jsonText('cursor_json')
      .notNull()
      .$type<SqliteRow<'runtimeEventCheckpoints'>['cursorJson']>(),
    turnEpoch: int8('turn_epoch')
      .notNull()
      .$type<SqliteRow<'runtimeEventCheckpoints'>['turnEpoch']>(),
    closedTurnEpoch:
      int8('closed_turn_epoch').$type<SqliteRow<'runtimeEventCheckpoints'>['closedTurnEpoch']>(),
    updatedAt: isoTimestamp('updated_at')
      .notNull()
      .$type<SqliteRow<'runtimeEventCheckpoints'>['updatedAt']>(),
    turnStateJson:
      jsonText('turn_state_json').$type<SqliteRow<'runtimeEventCheckpoints'>['turnStateJson']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'runtimeEventCheckpoints'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'runtime_event_checkpoints_pk',
      columns: [table.workspaceId, table.sessionId],
    }),
  ],
)

export const runtimeEventProjectionCursors = pgTable(
  'runtime_event_projection_cursors',
  {
    projector: textC('projector')
      .notNull()
      .$type<SqliteRow<'runtimeEventProjectionCursors'>['projector']>(),
    lastEventId: int8('last_event_id')
      .notNull()
      .$type<SqliteRow<'runtimeEventProjectionCursors'>['lastEventId']>(),
    updatedAt: isoTimestamp('updated_at')
      .notNull()
      .$type<SqliteRow<'runtimeEventProjectionCursors'>['updatedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'runtimeEventProjectionCursors'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'runtime_event_projection_cursors_pk',
      columns: [table.workspaceId, table.projector],
    }),
  ],
)

export const serverSecrets = pgTable('server_secrets', {
  key: textC('key').primaryKey().$type<SqliteRow<'serverSecrets'>['key']>(),
  value: textC('value').notNull().$type<SqliteRow<'serverSecrets'>['value']>(),
  updatedAt: isoTimestamp('updated_at').notNull().$type<SqliteRow<'serverSecrets'>['updatedAt']>(),
})

export const sessionDrafts = pgTable(
  'session_drafts',
  {
    sessionId: textC('session_id').notNull().$type<SqliteRow<'sessionDrafts'>['sessionId']>(),
    text: textC('text').notNull().$type<SqliteRow<'sessionDrafts'>['text']>(),
    updatedAt: isoTimestamp('updated_at')
      .notNull()
      .$type<SqliteRow<'sessionDrafts'>['updatedAt']>(),
    rev: int8('rev').notNull().default(0).$type<SqliteRow<'sessionDrafts'>['rev']>(),
    origin: textC('origin').$type<SqliteRow<'sessionDrafts'>['origin']>(),
    history: jsonText('history').$type<SqliteRow<'sessionDrafts'>['history']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'sessionDrafts'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'session_drafts_pk', columns: [table.workspaceId, table.sessionId] }),
  ],
)

export const sessionObservationCheckpoints = pgTable(
  'session_observation_checkpoints',
  {
    sessionId: textC('session_id')
      .notNull()
      .$type<SqliteRow<'sessionObservationCheckpoints'>['sessionId']>(),
    schemaVersion: int8('schema_version')
      .notNull()
      .default(1)
      .$type<SqliteRow<'sessionObservationCheckpoints'>['schemaVersion']>(),
    provider: textC('provider')
      .notNull()
      .$type<SqliteRow<'sessionObservationCheckpoints'>['provider']>(),
    providerSessionId:
      textC('provider_session_id').$type<
        SqliteRow<'sessionObservationCheckpoints'>['providerSessionId']
      >(),
    bindingVersion: int8('binding_version')
      .notNull()
      .default(0)
      .$type<SqliteRow<'sessionObservationCheckpoints'>['bindingVersion']>(),
    observationGeneration: int8('observation_generation')
      .notNull()
      .default(0)
      .$type<SqliteRow<'sessionObservationCheckpoints'>['observationGeneration']>(),
    checkpointJson:
      jsonText('checkpoint_json').$type<
        SqliteRow<'sessionObservationCheckpoints'>['checkpointJson']
      >(),
    updatedAt: isoTimestamp('updated_at')
      .notNull()
      .$type<SqliteRow<'sessionObservationCheckpoints'>['updatedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'sessionObservationCheckpoints'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'session_observation_checkpoints_pk',
      columns: [table.workspaceId, table.sessionId],
    }),
  ],
)

export const sessionObservationRebinds = pgTable(
  'session_observation_rebinds',
  {
    sessionId: textC('session_id')
      .notNull()
      .$type<SqliteRow<'sessionObservationRebinds'>['sessionId']>(),
    provider: textC('provider')
      .notNull()
      .$type<SqliteRow<'sessionObservationRebinds'>['provider']>(),
    fromProviderSessionId: textC('from_provider_session_id').$type<
      SqliteRow<'sessionObservationRebinds'>['fromProviderSessionId']
    >(),
    fromBindingVersion: int8('from_binding_version')
      .notNull()
      .$type<SqliteRow<'sessionObservationRebinds'>['fromBindingVersion']>(),
    fromObservationGeneration: int8('from_observation_generation')
      .notNull()
      .$type<SqliteRow<'sessionObservationRebinds'>['fromObservationGeneration']>(),
    toProviderSessionId: textC('to_provider_session_id')
      .notNull()
      .$type<SqliteRow<'sessionObservationRebinds'>['toProviderSessionId']>(),
    resultingBindingVersion: int8('resulting_binding_version')
      .notNull()
      .$type<SqliteRow<'sessionObservationRebinds'>['resultingBindingVersion']>(),
    resultingObservationGeneration: int8('resulting_observation_generation')
      .notNull()
      .$type<SqliteRow<'sessionObservationRebinds'>['resultingObservationGeneration']>(),
    updatedAt: isoTimestamp('updated_at')
      .notNull()
      .$type<SqliteRow<'sessionObservationRebinds'>['updatedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'sessionObservationRebinds'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'session_observation_rebinds_pk',
      columns: [table.workspaceId, table.sessionId],
    }),
    foreignKey({
      name: 'session_observation_rebinds_session_id_fk',
      columns: [table.workspaceId, table.sessionId],
      foreignColumns: [
        sessionObservationCheckpoints.workspaceId,
        sessionObservationCheckpoints.sessionId,
      ],
    }).onDelete('cascade'),
  ],
)

export const sessionTerminalCandidates = pgTable(
  'session_terminal_candidates',
  {
    sessionId: textC('session_id')
      .notNull()
      .$type<SqliteRow<'sessionTerminalCandidates'>['sessionId']>(),
    proofJson: jsonText('proof_json')
      .notNull()
      .$type<SqliteRow<'sessionTerminalCandidates'>['proofJson']>(),
    confirmedAt:
      isoTimestamp('confirmed_at').$type<SqliteRow<'sessionTerminalCandidates'>['confirmedAt']>(),
    consumedAt:
      isoTimestamp('consumed_at').$type<SqliteRow<'sessionTerminalCandidates'>['consumedAt']>(),
    updatedAt: isoTimestamp('updated_at')
      .notNull()
      .$type<SqliteRow<'sessionTerminalCandidates'>['updatedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'sessionTerminalCandidates'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'session_terminal_candidates_pk',
      columns: [table.workspaceId, table.sessionId],
    }),
    foreignKey({
      name: 'session_terminal_candidates_session_id_fk',
      columns: [table.workspaceId, table.sessionId],
      foreignColumns: [
        sessionObservationCheckpoints.workspaceId,
        sessionObservationCheckpoints.sessionId,
      ],
    }).onDelete('cascade'),
  ],
)

export const sessionUserState = pgTable(
  'session_user_state',
  {
    userId: textC('user_id').notNull().$type<SqliteRow<'sessionUserState'>['userId']>(),
    sessionId: textC('session_id').notNull().$type<SqliteRow<'sessionUserState'>['sessionId']>(),
    readAt: isoTimestamp('read_at').$type<SqliteRow<'sessionUserState'>['readAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'sessionUserState'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'session_user_state_pk',
      columns: [table.workspaceId, table.userId, table.sessionId],
    }),
    index('idx_session_user_state_session').on(table.workspaceId, table.sessionId),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    id: textC('id').notNull().$type<SqliteRow<'sessions'>['id']>(),
    ownerUserId: textC('owner_user_id').notNull().$type<SqliteRow<'sessions'>['ownerUserId']>(),
    agentKind: textC('agent_kind').notNull().$type<SqliteRow<'sessions'>['agentKind']>(),
    model: textC('model').$type<SqliteRow<'sessions'>['model']>(),
    effort: textC('effort').$type<SqliteRow<'sessions'>['effort']>(),
    requestedModel: textC('requested_model').$type<SqliteRow<'sessions'>['requestedModel']>(),
    requestedEffort: textC('requested_effort').$type<SqliteRow<'sessions'>['requestedEffort']>(),
    accountId: textC('account_id').$type<SqliteRow<'sessions'>['accountId']>(),
    loginHarness: textC('login_harness').$type<SqliteRow<'sessions'>['loginHarness']>(),
    cwd: textC('cwd').notNull().$type<SqliteRow<'sessions'>['cwd']>(),
    title: textC('title').notNull().$type<SqliteRow<'sessions'>['title']>(),
    originKind: textC('origin_kind').notNull().$type<SqliteRow<'sessions'>['originKind']>(),
    conversationId: textC('conversation_id').$type<SqliteRow<'sessions'>['conversationId']>(),
    resumeKind: textC('resume_kind').$type<SqliteRow<'sessions'>['resumeKind']>(),
    resumeValue: textC('resume_value').$type<SqliteRow<'sessions'>['resumeValue']>(),
    selectedDriverId:
      textC('selected_driver_id').$type<SqliteRow<'sessions'>['selectedDriverId']>(),
    requestedDriverId:
      textC('requested_driver_id').$type<SqliteRow<'sessions'>['requestedDriverId']>(),
    boundDriverId: textC('bound_driver_id').$type<SqliteRow<'sessions'>['boundDriverId']>(),
    boundDriverCapabilities: textC('bound_driver_capabilities').$type<
      SqliteRow<'sessions'>['boundDriverCapabilities']
    >(),
    draftSyncEngine: boolean('draft_sync_engine')
      .notNull()
      .default(false)
      .$type<SqliteRow<'sessions'>['draftSyncEngine']>(),
    agentColor: textC('agent_color').$type<SqliteRow<'sessions'>['agentColor']>(),
    agentStateJson: jsonText('agent_state_json').$type<SqliteRow<'sessions'>['agentStateJson']>(),
    observedModel: textC('observed_model').$type<SqliteRow<'sessions'>['observedModel']>(),
    observedEffort: textC('observed_effort').$type<SqliteRow<'sessions'>['observedEffort']>(),
    handoffTargetMachineId: textC('handoff_target_machine_id').$type<
      SqliteRow<'sessions'>['handoffTargetMachineId']
    >(),
    conversationBinding:
      textC('conversation_binding').$type<SqliteRow<'sessions'>['conversationBinding']>(),
    status: textC('status').notNull().$type<SqliteRow<'sessions'>['status']>(),
    exitCode: int8('exit_code').$type<SqliteRow<'sessions'>['exitCode']>(),
    spawnFailure: textC('spawn_failure').$type<SqliteRow<'sessions'>['spawnFailure']>(),
    durableLabel: textC('durable_label').notNull().$type<SqliteRow<'sessions'>['durableLabel']>(),
    createdAt: isoTimestamp('created_at').notNull().$type<SqliteRow<'sessions'>['createdAt']>(),
    lastActiveAt: isoTimestamp('last_active_at')
      .notNull()
      .$type<SqliteRow<'sessions'>['lastActiveAt']>(),
    publishedLastActiveAt: isoTimestamp('published_last_active_at')
      .notNull()
      .default(sql`'-infinity'`)
      .$type<SqliteRow<'sessions'>['publishedLastActiveAt']>(),
    lastActivePublishAfter: int8('last_active_publish_after')
      .notNull()
      .default(0)
      .$type<SqliteRow<'sessions'>['lastActivePublishAfter']>(),
    name: textC('name').$type<SqliteRow<'sessions'>['name']>(),
    archived: boolean('archived')
      .notNull()
      .default(false)
      .$type<SqliteRow<'sessions'>['archived']>(),
    workState: textC('work_state').$type<SqliteRow<'sessions'>['workState']>(),
    machineId: textC('machine_id').notNull().$type<SqliteRow<'sessions'>['machineId']>(),
    lastOutputAt: isoTimestamp('last_output_at').$type<SqliteRow<'sessions'>['lastOutputAt']>(),
    lastInputAt: isoTimestamp('last_input_at').$type<SqliteRow<'sessions'>['lastInputAt']>(),
    lastResumedAt: isoTimestamp('last_resumed_at').$type<SqliteRow<'sessions'>['lastResumedAt']>(),
    spawnedBy: textC('spawned_by').$type<SqliteRow<'sessions'>['spawnedBy']>(),
    headless: boolean('headless')
      .notNull()
      .default(false)
      .$type<SqliteRow<'sessions'>['headless']>(),
    issueId: textC('issue_id').$type<SqliteRow<'sessions'>['issueId']>(),
    stoppedAt: isoTimestamp('stopped_at').$type<SqliteRow<'sessions'>['stoppedAt']>(),
    stopReason: textC('stop_reason').$type<SqliteRow<'sessions'>['stopReason']>(),
    oomKilledAt: isoTimestamp('oom_killed_at').$type<SqliteRow<'sessions'>['oomKilledAt']>(),
    deletedAt: isoTimestamp('deleted_at').$type<SqliteRow<'sessions'>['deletedAt']>(),
    deletedByIssueId:
      textC('deleted_by_issue_id').$type<SqliteRow<'sessions'>['deletedByIssueId']>(),
    deletionSource: textC('deletion_source').$type<SqliteRow<'sessions'>['deletionSource']>(),
    workflowRunId: textC('workflow_run_id').$type<SqliteRow<'sessions'>['workflowRunId']>(),
    workflowStepId: textC('workflow_step_id').$type<SqliteRow<'sessions'>['workflowStepId']>(),
    agentProfileId: textC('agent_profile_id').$type<SqliteRow<'sessions'>['agentProfileId']>(),
    nameSource: textC('name_source').$type<SqliteRow<'sessions'>['nameSource']>(),
    refIssueId: textC('ref_issue_id').$type<SqliteRow<'sessions'>['refIssueId']>(),
    refLetter: textC('ref_letter').$type<SqliteRow<'sessions'>['refLetter']>(),
    refDraft: int8('ref_draft').$type<SqliteRow<'sessions'>['refDraft']>(),
    terminalCols: int8('terminal_cols')
      .notNull()
      .default(80)
      .$type<SqliteRow<'sessions'>['terminalCols']>(),
    terminalRows: int8('terminal_rows')
      .notNull()
      .default(24)
      .$type<SqliteRow<'sessions'>['terminalRows']>(),
    workingMsTotal: int8('working_ms_total').$type<SqliteRow<'sessions'>['workingMsTotal']>(),
    inputCount: int8('input_count')
      .notNull()
      .default(0)
      .$type<SqliteRow<'sessions'>['inputCount']>(),
    outputCount: int8('output_count')
      .notNull()
      .default(0)
      .$type<SqliteRow<'sessions'>['outputCount']>(),
    activityCount: int8('activity_count')
      .notNull()
      .default(0)
      .$type<SqliteRow<'sessions'>['activityCount']>(),
    delegation: jsonValue('delegation').$type<SqliteRow<'sessions'>['delegation']>(),
    createdByActorKind:
      textC('created_by_actor_kind').$type<SqliteRow<'sessions'>['createdByActorKind']>(),
    createdByActorId:
      textC('created_by_actor_id').$type<SqliteRow<'sessions'>['createdByActorId']>(),
    createdByOnBehalfOf:
      textC('created_by_on_behalf_of').$type<SqliteRow<'sessions'>['createdByOnBehalfOf']>(),
    desired: textC('desired').$type<SqliteRow<'sessions'>['desired']>(),
    desiredForce: boolean('desired_force')
      .notNull()
      .default(false)
      .$type<SqliteRow<'sessions'>['desiredForce']>(),
    revision: int8('revision').notNull().default(1).$type<SqliteRow<'sessions'>['revision']>(),
    observedRevision: int8('observed_revision')
      .notNull()
      .default(1)
      .$type<SqliteRow<'sessions'>['observedRevision']>(),
    lifecycleFailure: textC('lifecycle_failure').$type<SqliteRow<'sessions'>['lifecycleFailure']>(),
    desiredByUser: textC('desired_by_user').$type<SqliteRow<'sessions'>['desiredByUser']>(),
    desiredByAgent: textC('desired_by_agent').$type<SqliteRow<'sessions'>['desiredByAgent']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'sessions'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'sessions_pk', columns: [table.workspaceId, table.id] }),
    index('idx_sessions_pending_activity')
      .on(table.workspaceId, table.lastActivePublishAfter, table.id)
      .where(sql`"published_last_active_at" < "last_active_at" AND "deleted_at" IS NULL`),
    index('idx_sessions_deleted_by_issue').on(table.workspaceId, table.deletedByIssueId),
    index('idx_sessions_lifecycle_pending')
      .on(table.workspaceId, table.machineId)
      .where(sql`"revision" > "observed_revision" AND "deleted_at" IS NULL`),
    index('idx_sessions_deleted_at').on(table.workspaceId, table.deletedAt),
    index('idx_sessions_resume_machine').on(table.workspaceId, table.resumeValue, table.machineId),
    index('idx_sessions_issue').on(table.workspaceId, table.issueId),
    index('idx_sessions_ref_issue')
      .on(table.workspaceId, table.refIssueId)
      .where(sql`"ref_issue_id" IS NOT NULL`),
    index('idx_sessions_machine').on(table.workspaceId, table.machineId),
    index('idx_sessions_cwd').on(table.workspaceId, table.cwd),
    index('idx_sessions_cwd_folded').on(table.workspaceId, sql`lower(replace("cwd", '/', '\\'))`),
    index('idx_sessions_spawned_by').on(table.workspaceId, table.spawnedBy),
    index('idx_sessions_ref_draft').on(table.workspaceId, table.refDraft),
    index('idx_sessions_refless_place')
      .on(table.workspaceId, table.machineId, table.cwd)
      .where(sql`"ref_issue_id" IS NULL AND "ref_draft" IS NULL AND "deleted_at" IS NULL`),
    index('idx_sessions_refless_issue')
      .on(table.workspaceId, table.issueId)
      .where(
        sql`"ref_issue_id" IS NULL AND "ref_draft" IS NULL AND "deleted_at" IS NULL AND "issue_id" IS NOT NULL`,
      ),
    index('idx_sessions_status').on(table.workspaceId, table.status),
    index('idx_sessions_headless')
      .on(table.workspaceId, table.headless)
      .where(sql`"headless" = true`),
    check(
      'sessions_stop_reason_check',
      sql`stop_reason IS NULL OR stop_reason IN ('self', 'parent', 'forced', 'exited')`,
    ),
    check(
      'sessions_created_by_actor_kind',
      sql`created_by_actor_kind IS NULL OR created_by_actor_kind IN ('user', 'agent', 'machine', 'system')`,
    ),
    check(
      'sessions_created_by_system_has_no_human',
      sql`created_by_actor_kind <> 'system' OR created_by_on_behalf_of IS NULL`,
    ),
  ],
)

export const settingsAuditEvents = pgTable(
  'settings_audit_events',
  {
    id: int8('id')
      .primaryKey()
      .generatedByDefaultAsIdentity()
      .$type<SqliteRow<'settingsAuditEvents'>['id']>(),
    command: textC('command').notNull().$type<SqliteRow<'settingsAuditEvents'>['command']>(),
    outcome: textC('outcome').notNull().$type<SqliteRow<'settingsAuditEvents'>['outcome']>(),
    actorKind: textC('actor_kind').notNull().$type<SqliteRow<'settingsAuditEvents'>['actorKind']>(),
    actorId: textC('actor_id').$type<SqliteRow<'settingsAuditEvents'>['actorId']>(),
    onBehalfOf: textC('on_behalf_of').$type<SqliteRow<'settingsAuditEvents'>['onBehalfOf']>(),
    detailJson: jsonText('detail_json')
      .notNull()
      .default(sql`'{}'`)
      .$type<SqliteRow<'settingsAuditEvents'>['detailJson']>(),
    redactedPaths: jsonText('redacted_paths')
      .notNull()
      .default(sql`'[]'`)
      .$type<SqliteRow<'settingsAuditEvents'>['redactedPaths']>(),
    createdAt: isoTimestamp('created_at')
      .notNull()
      .$type<SqliteRow<'settingsAuditEvents'>['createdAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'settingsAuditEvents'>['workspaceId']>(),
  },
  (table) => [
    unique('settings_audit_events_workspace_id_id_unique').on(table.workspaceId, table.id),
    index('settings_audit_events_command').on(table.workspaceId, table.command, table.id),
    index('settings_audit_events_person').on(table.workspaceId, table.onBehalfOf, table.id),
    index('settings_audit_events_result').on(table.workspaceId, table.outcome, table.id),
    check('settings_audit_events_outcome', sql`outcome IN ('applied', 'refused')`),
    check(
      'settings_audit_events_actor_kind',
      sql`actor_kind IN ('user', 'agent', 'machine', 'system')`,
    ),
    check(
      'settings_audit_events_system_has_no_human',
      sql`actor_kind <> 'system' OR on_behalf_of IS NULL`,
    ),
  ],
)

export const shipAttempts = pgTable(
  'ship_attempts',
  {
    id: textC('id').notNull().$type<SqliteRow<'shipAttempts'>['id']>(),
    orderId: textC('order_id').notNull().$type<SqliteRow<'shipAttempts'>['orderId']>(),
    expectedSourceBaseSha: textC('expected_source_base_sha')
      .notNull()
      .$type<SqliteRow<'shipAttempts'>['expectedSourceBaseSha']>(),
    approvedHeadSha: textC('approved_head_sha')
      .notNull()
      .$type<SqliteRow<'shipAttempts'>['approvedHeadSha']>(),
    expectedTargetSha: textC('expected_target_sha')
      .notNull()
      .$type<SqliteRow<'shipAttempts'>['expectedTargetSha']>(),
    machineId: textC('machine_id').notNull().$type<SqliteRow<'shipAttempts'>['machineId']>(),
    leaseGeneration: int8('lease_generation')
      .notNull()
      .$type<SqliteRow<'shipAttempts'>['leaseGeneration']>(),
    startedAt: isoTimestamp('started_at').notNull().$type<SqliteRow<'shipAttempts'>['startedAt']>(),
    finishedAt: isoTimestamp('finished_at').$type<SqliteRow<'shipAttempts'>['finishedAt']>(),
    outcome: textC('outcome').$type<SqliteRow<'shipAttempts'>['outcome']>(),
    submittedHeadSha: textC('submitted_head_sha')
      .notNull()
      .$type<SqliteRow<'shipAttempts'>['submittedHeadSha']>(),
    testedIntegrationSha:
      textC('tested_integration_sha').$type<SqliteRow<'shipAttempts'>['testedIntegrationSha']>(),
    landedRefSha: textC('landed_ref_sha').$type<SqliteRow<'shipAttempts'>['landedRefSha']>(),
    destinationSha: textC('destination_sha').$type<SqliteRow<'shipAttempts'>['destinationSha']>(),
    validationProfileId:
      textC('validation_profile_id').$type<SqliteRow<'shipAttempts'>['validationProfileId']>(),
    validationResult:
      textC('validation_result').$type<SqliteRow<'shipAttempts'>['validationResult']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'shipAttempts'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'ship_attempts_pk', columns: [table.workspaceId, table.id] }),
    unique('idx_ship_attempts_id_order').on(table.workspaceId, table.id, table.orderId),
    index('idx_ship_attempts_order').on(table.workspaceId, table.orderId, table.startedAt),
    foreignKey({
      name: 'fk_ship_attempts_order_id_ship_orders_id_fk',
      columns: [table.workspaceId, table.orderId],
      foreignColumns: [shipOrders.workspaceId, shipOrders.id],
    }).onDelete('restrict'),
    check('ship_attempts_generation_check', sql`lease_generation >= 0`),
    check(
      'ship_attempts_terminal_pair_check',
      sql`(finished_at IS NULL AND outcome IS NULL) OR (finished_at IS NOT NULL AND outcome IS NOT NULL)`,
    ),
    check(
      'ship_attempts_outcome_check',
      sql`outcome IS NULL OR outcome IN ('succeeded', 'failed', 'cancelled')`,
    ),
    check(
      'ship_attempts_validation_pair_check',
      sql`(validation_profile_id IS NULL AND validation_result IS NULL) OR (validation_profile_id IS NOT NULL AND validation_result IS NOT NULL)`,
    ),
    check(
      'ship_attempts_validation_result_check',
      sql`validation_result IS NULL OR validation_result IN ('passed', 'failed')`,
    ),
  ],
)

export const shipEffectEnvelopes = pgTable(
  'ship_effect_envelopes',
  {
    effectKey: textC('effect_key').notNull().$type<SqliteRow<'shipEffectEnvelopes'>['effectKey']>(),
    trainId: textC('train_id').notNull().$type<SqliteRow<'shipEffectEnvelopes'>['trainId']>(),
    attemptId: textC('attempt_id').notNull().$type<SqliteRow<'shipEffectEnvelopes'>['attemptId']>(),
    requestDigest: textC('request_digest')
      .notNull()
      .$type<SqliteRow<'shipEffectEnvelopes'>['requestDigest']>(),
    requestJson: jsonText('request_json')
      .notNull()
      .$type<SqliteRow<'shipEffectEnvelopes'>['requestJson']>(),
    resultJson: jsonText('result_json')
      .notNull()
      .$type<SqliteRow<'shipEffectEnvelopes'>['resultJson']>(),
    recordedAt: isoTimestamp('recorded_at')
      .notNull()
      .$type<SqliteRow<'shipEffectEnvelopes'>['recordedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'shipEffectEnvelopes'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'ship_effect_envelopes_pk', columns: [table.workspaceId, table.effectKey] }),
    uniqueIndex('idx_ship_effect_envelopes_attempt_effect').on(
      table.workspaceId,
      table.attemptId,
      table.effectKey,
    ),
    foreignKey({
      name: 'fk_ship_effect_envelopes_train_id_ship_train_manifests_id_fk',
      columns: [table.workspaceId, table.trainId],
      foreignColumns: [shipTrainManifests.workspaceId, shipTrainManifests.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_ship_effect_envelopes_attempt_id_ship_attempts_id_fk',
      columns: [table.workspaceId, table.attemptId],
      foreignColumns: [shipAttempts.workspaceId, shipAttempts.id],
    }).onDelete('restrict'),
  ],
)

export const shipEvidence = pgTable(
  'ship_evidence',
  {
    ref: textC('ref').notNull().$type<SqliteRow<'shipEvidence'>['ref']>(),
    custodyDigest: textC('custody_digest')
      .notNull()
      .$type<SqliteRow<'shipEvidence'>['custodyDigest']>(),
    contentDigest: textC('content_digest')
      .notNull()
      .$type<SqliteRow<'shipEvidence'>['contentDigest']>(),
    sourceRef: textC('source_ref').notNull().$type<SqliteRow<'shipEvidence'>['sourceRef']>(),
    content: textC('content').notNull().$type<SqliteRow<'shipEvidence'>['content']>(),
    materializedAt: isoTimestamp('materialized_at')
      .notNull()
      .$type<SqliteRow<'shipEvidence'>['materializedAt']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'shipEvidence'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'ship_evidence_pk', columns: [table.workspaceId, table.ref] }),
    index('idx_ship_evidence_source').on(table.workspaceId, table.custodyDigest, table.sourceRef),
    check(
      'ship_evidence_custody_digest_check',
      sql`length(custody_digest) = 64 AND translate(custody_digest, '0123456789abcdef', '') = ''`,
    ),
    check(
      'ship_evidence_content_digest_check',
      sql`length(content_digest) = 64 AND translate(content_digest, '0123456789abcdef', '') = ''`,
    ),
  ],
)

export const shipHolds = pgTable(
  'ship_holds',
  {
    id: textC('id').notNull().$type<SqliteRow<'shipHolds'>['id']>(),
    orderId: textC('order_id').notNull().$type<SqliteRow<'shipHolds'>['orderId']>(),
    generation: int8('generation').notNull().$type<SqliteRow<'shipHolds'>['generation']>(),
    reasonCode: textC('reason_code').notNull().$type<SqliteRow<'shipHolds'>['reasonCode']>(),
    headline: textC('headline').notNull().$type<SqliteRow<'shipHolds'>['headline']>(),
    detail: textC('detail').notNull().$type<SqliteRow<'shipHolds'>['detail']>(),
    evidenceRefs: textC('evidence_refs')
      .notNull()
      .default(sql`'[]'`)
      .$type<SqliteRow<'shipHolds'>['evidenceRefs']>(),
    actions: jsonText('actions')
      .notNull()
      .default(sql`'[]'`)
      .$type<SqliteRow<'shipHolds'>['actions']>(),
    raisedAt: isoTimestamp('raised_at').notNull().$type<SqliteRow<'shipHolds'>['raisedAt']>(),
    resolvedAt: isoTimestamp('resolved_at').$type<SqliteRow<'shipHolds'>['resolvedAt']>(),
    resolution: textC('resolution').$type<SqliteRow<'shipHolds'>['resolution']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'shipHolds'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'ship_holds_pk', columns: [table.workspaceId, table.id] }),
    uniqueIndex('idx_ship_holds_order_generation').on(
      table.workspaceId,
      table.orderId,
      table.generation,
    ),
    uniqueIndex('idx_ship_holds_one_open_order')
      .on(table.workspaceId, table.orderId)
      .where(sql`resolved_at IS NULL`),
    foreignKey({
      name: 'fk_ship_holds_order_id_ship_orders_id_fk',
      columns: [table.workspaceId, table.orderId],
      foreignColumns: [shipOrders.workspaceId, shipOrders.id],
    }).onDelete('restrict'),
    check('ship_holds_generation_check', sql`generation > 0`),
    check(
      'ship_holds_resolution_pair_check',
      sql`(resolved_at IS NULL AND resolution IS NULL) OR (resolved_at IS NOT NULL AND resolution IS NOT NULL)`,
    ),
  ],
)

export const shipLaneRevisions = pgTable(
  'ship_lane_revisions',
  {
    laneKey: textC('lane_key').notNull().$type<SqliteRow<'shipLaneRevisions'>['laneKey']>(),
    revision: int8('revision').notNull().$type<SqliteRow<'shipLaneRevisions'>['revision']>(),
    updatedAt: isoTimestamp('updated_at')
      .notNull()
      .$type<SqliteRow<'shipLaneRevisions'>['updatedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'shipLaneRevisions'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'ship_lane_revisions_pk', columns: [table.workspaceId, table.laneKey] }),
  ],
)

export const shipOrderStackEdges = pgTable(
  'ship_order_stack_edges',
  {
    upperOrderId: textC('upper_order_id')
      .notNull()
      .$type<SqliteRow<'shipOrderStackEdges'>['upperOrderId']>(),
    lowerOrderId: textC('lower_order_id')
      .notNull()
      .$type<SqliteRow<'shipOrderStackEdges'>['lowerOrderId']>(),
    upperApprovedHeadSha: textC('upper_approved_head_sha')
      .notNull()
      .$type<SqliteRow<'shipOrderStackEdges'>['upperApprovedHeadSha']>(),
    lowerApprovedHeadSha: textC('lower_approved_head_sha')
      .notNull()
      .$type<SqliteRow<'shipOrderStackEdges'>['lowerApprovedHeadSha']>(),
    recordedAt: isoTimestamp('recorded_at')
      .notNull()
      .$type<SqliteRow<'shipOrderStackEdges'>['recordedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'shipOrderStackEdges'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'ship_order_stack_edges_pk',
      columns: [table.workspaceId, table.upperOrderId, table.lowerOrderId],
    }),
    index('idx_ship_order_stack_edges_lower').on(table.workspaceId, table.lowerOrderId),
    foreignKey({
      name: 'fk_ship_order_stack_edges_upper_order_id_ship_orders_id_fk',
      columns: [table.workspaceId, table.upperOrderId],
      foreignColumns: [shipOrders.workspaceId, shipOrders.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_ship_order_stack_edges_lower_order_id_ship_orders_id_fk',
      columns: [table.workspaceId, table.lowerOrderId],
      foreignColumns: [shipOrders.workspaceId, shipOrders.id],
    }).onDelete('restrict'),
    check('ship_order_stack_edges_distinct_check', sql`upper_order_id <> lower_order_id`),
  ],
)

export const shipOrders = pgTable(
  'ship_orders',
  {
    id: textC('id').notNull().$type<SqliteRow<'shipOrders'>['id']>(),
    issueId: textC('issue_id').notNull().$type<SqliteRow<'shipOrders'>['issueId']>(),
    repoId: textC('repo_id').notNull().$type<SqliteRow<'shipOrders'>['repoId']>(),
    repoPath: textC('repo_path').$type<SqliteRow<'shipOrders'>['repoPath']>(),
    machineId: textC('machine_id').$type<SqliteRow<'shipOrders'>['machineId']>(),
    targetBranch: textC('target_branch').notNull().$type<SqliteRow<'shipOrders'>['targetBranch']>(),
    destination: textC('destination').notNull().$type<SqliteRow<'shipOrders'>['destination']>(),
    approvedBaseSha: textC('approved_base_sha')
      .notNull()
      .$type<SqliteRow<'shipOrders'>['approvedBaseSha']>(),
    approvedHeadSha: textC('approved_head_sha')
      .notNull()
      .$type<SqliteRow<'shipOrders'>['approvedHeadSha']>(),
    descendantManifest: jsonText('descendant_manifest')
      .notNull()
      .default(sql`'[]'`)
      .$type<SqliteRow<'shipOrders'>['descendantManifest']>(),
    deliveryDependsOn: jsonText('delivery_depends_on')
      .notNull()
      .default(sql`'[]'`)
      .$type<SqliteRow<'shipOrders'>['deliveryDependsOn']>(),
    evidenceManifestRef:
      textC('evidence_manifest_ref').$type<SqliteRow<'shipOrders'>['evidenceManifestRef']>(),
    currentIntegrationReceipt: jsonText('current_integration_receipt').$type<
      SqliteRow<'shipOrders'>['currentIntegrationReceipt']
    >(),
    providerRef: textC('provider_ref').$type<SqliteRow<'shipOrders'>['providerRef']>(),
    requestedByActorKind: textC('requested_by_actor_kind')
      .notNull()
      .$type<SqliteRow<'shipOrders'>['requestedByActorKind']>(),
    requestedByActorId: textC('requested_by_actor_id')
      .notNull()
      .$type<SqliteRow<'shipOrders'>['requestedByActorId']>(),
    requestedByOnBehalfOf: textC('requested_by_on_behalf_of').$type<
      SqliteRow<'shipOrders'>['requestedByOnBehalfOf']
    >(),
    requestedAt: isoTimestamp('requested_at')
      .notNull()
      .$type<SqliteRow<'shipOrders'>['requestedAt']>(),
    policyId: textC('policy_id').notNull().$type<SqliteRow<'shipOrders'>['policyId']>(),
    validationProfile:
      jsonValue('validation_profile').$type<SqliteRow<'shipOrders'>['validationProfile']>(),
    validationProfileDigest: textC('validation_profile_digest').$type<
      SqliteRow<'shipOrders'>['validationProfileDigest']
    >(),
    closeMode: textC('close_mode').notNull().$type<SqliteRow<'shipOrders'>['closeMode']>(),
    state: textC('state').notNull().$type<SqliteRow<'shipOrders'>['state']>(),
    stateChangedAt: isoTimestamp('state_changed_at')
      .notNull()
      .$type<SqliteRow<'shipOrders'>['stateChangedAt']>(),
    holdCode: textC('hold_code').$type<SqliteRow<'shipOrders'>['holdCode']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'shipOrders'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'ship_orders_pk', columns: [table.workspaceId, table.id] }),
    unique('idx_ship_orders_id_issue').on(table.workspaceId, table.id, table.issueId),
    index('idx_ship_orders_issue').on(table.workspaceId, table.issueId),
    index('idx_ship_orders_repo_state_id').on(
      table.workspaceId,
      table.repoId,
      table.state,
      table.id,
    ),
    index('idx_ship_orders_predecessors').on(
      table.workspaceId,
      table.repoId,
      table.state,
      table.stateChangedAt,
      table.id,
    ),
    index('idx_ship_orders_recovery')
      .on(table.workspaceId, table.requestedAt, table.id)
      .where(
        sql`state IN ('preflight', 'composing', 'validating', 'repairing', 'landing', 'publishing', 'verifying')`,
      ),
    index('idx_ship_orders_lane').on(
      table.workspaceId,
      table.repoId,
      table.destination,
      table.requestedAt,
      table.id,
    ),
    uniqueIndex('idx_ship_orders_one_active_issue')
      .on(table.workspaceId, table.issueId)
      .where(sql`state NOT IN ('shipped', 'cancelled')`),
    foreignKey({
      name: 'fk_ship_orders_issue_id_issues_id_fk',
      columns: [table.workspaceId, table.issueId],
      foreignColumns: [issues.workspaceId, issues.id],
    }).onDelete('restrict'),
    check(
      'ship_orders_state_check',
      sql`state IN ('queued', 'preflight', 'composing', 'validating', 'repairing', 'landing', 'publishing', 'verifying', 'shipped', 'held', 'cancelled')`,
    ),
    check('ship_orders_close_mode_check', sql`close_mode IN ('after-destination', 'leave-open')`),
    check(
      'ship_orders_hold_code_check',
      sql`(state = 'held' AND hold_code IS NOT NULL) OR (state <> 'held' AND hold_code IS NULL)`,
    ),
    check(
      'ship_orders_requested_by_actor_kind_check',
      sql`requested_by_actor_kind IN ('user', 'agent', 'machine', 'system')`,
    ),
    check(
      'ship_orders_requested_by_system_has_no_human_check',
      sql`requested_by_actor_kind <> 'system' OR requested_by_on_behalf_of IS NULL`,
    ),
  ],
)

export const shipRecoveryRevision = pgTable(
  'ship_recovery_revision',
  {
    id: int8('id').notNull().$type<SqliteRow<'shipRecoveryRevision'>['id']>(),
    revision: int8('revision')
      .notNull()
      .default(0)
      .$type<SqliteRow<'shipRecoveryRevision'>['revision']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'shipRecoveryRevision'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'ship_recovery_revision_pk', columns: [table.workspaceId, table.id] }),
    check('ship_recovery_revision_singleton', sql`id = 1`),
  ],
)

export const shipRecoveryWork = pgTable(
  'ship_recovery_work',
  {
    key: textC('key').notNull().$type<SqliteRow<'shipRecoveryWork'>['key']>(),
    kind: textC('kind').notNull().$type<SqliteRow<'shipRecoveryWork'>['kind']>(),
    orderId: textC('order_id').notNull().$type<SqliteRow<'shipRecoveryWork'>['orderId']>(),
    payload: jsonText('payload').notNull().$type<SqliteRow<'shipRecoveryWork'>['payload']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'shipRecoveryWork'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'ship_recovery_work_pk', columns: [table.workspaceId, table.key] }),
    index('idx_ship_recovery_work_kind_key').on(table.workspaceId, table.kind, table.key),
    index('idx_ship_recovery_work_order').on(table.workspaceId, table.orderId),
    foreignKey({
      name: 'fk_ship_recovery_work_order_id_ship_orders_id_fk',
      columns: [table.workspaceId, table.orderId],
      foreignColumns: [shipOrders.workspaceId, shipOrders.id],
    }).onDelete('restrict'),
    check(
      'ship_recovery_work_kind_check',
      sql`kind IN ('daemon-ack', 'repair-ack', 'descendants')`,
    ),
  ],
)

export const shipRepairCandidates = pgTable(
  'ship_repair_candidates',
  {
    orderId: textC('order_id').notNull().$type<SqliteRow<'shipRepairCandidates'>['orderId']>(),
    attemptId: textC('attempt_id')
      .notNull()
      .$type<SqliteRow<'shipRepairCandidates'>['attemptId']>(),
    generation: int8('generation')
      .notNull()
      .$type<SqliteRow<'shipRepairCandidates'>['generation']>(),
    sequence: int8('sequence').notNull().$type<SqliteRow<'shipRepairCandidates'>['sequence']>(),
    round: int8('round').notNull().$type<SqliteRow<'shipRepairCandidates'>['round']>(),
    contextDigest: textC('context_digest')
      .notNull()
      .$type<SqliteRow<'shipRepairCandidates'>['contextDigest']>(),
    repairRef: textC('repair_ref')
      .notNull()
      .$type<SqliteRow<'shipRepairCandidates'>['repairRef']>(),
    candidateHeadSha: textC('candidate_head_sha')
      .notNull()
      .$type<SqliteRow<'shipRepairCandidates'>['candidateHeadSha']>(),
    resultToken: textC('result_token')
      .notNull()
      .$type<SqliteRow<'shipRepairCandidates'>['resultToken']>(),
    recordedAt: isoTimestamp('recorded_at')
      .notNull()
      .$type<SqliteRow<'shipRepairCandidates'>['recordedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'shipRepairCandidates'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'ship_repair_candidates_pk',
      columns: [table.workspaceId, table.attemptId, table.sequence],
    }),
    uniqueIndex('idx_ship_repair_candidates_ref').on(table.workspaceId, table.repairRef),
    index('idx_ship_repair_candidates_order').on(table.workspaceId, table.orderId),
    foreignKey({
      name: 'fk_ship_repair_candidates_order_id_ship_orders_id_fk',
      columns: [table.workspaceId, table.orderId],
      foreignColumns: [shipOrders.workspaceId, shipOrders.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_ship_repair_candidates_attempt_id_ship_attempts_id_fk',
      columns: [table.workspaceId, table.attemptId],
      foreignColumns: [shipAttempts.workspaceId, shipAttempts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_ship_repair_candidates_attempt_order',
      columns: [table.workspaceId, table.attemptId, table.orderId],
      foreignColumns: [shipAttempts.workspaceId, shipAttempts.id, shipAttempts.orderId],
    }).onDelete('restrict'),
    check('ship_repair_candidates_generation_check', sql`generation > 0`),
    check('ship_repair_candidates_sequence_check', sql`sequence > 0 AND round = sequence`),
    check(
      'ship_repair_candidates_context_check',
      sql`length(context_digest) = 64 AND translate(context_digest, '0123456789abcdef', '') = ''`,
    ),
  ],
)

export const shipSteps = pgTable(
  'ship_steps',
  {
    id: textC('id').notNull().$type<SqliteRow<'shipSteps'>['id']>(),
    orderId: textC('order_id').notNull().$type<SqliteRow<'shipSteps'>['orderId']>(),
    attemptId: textC('attempt_id').notNull().$type<SqliteRow<'shipSteps'>['attemptId']>(),
    effectKey: textC('effect_key').notNull().$type<SqliteRow<'shipSteps'>['effectKey']>(),
    idempotencyKey: textC('idempotency_key')
      .notNull()
      .$type<SqliteRow<'shipSteps'>['idempotencyKey']>(),
    generation: int8('generation').notNull().$type<SqliteRow<'shipSteps'>['generation']>(),
    inputFence: jsonValue('input_fence').notNull().$type<SqliteRow<'shipSteps'>['inputFence']>(),
    kind: textC('kind').notNull().$type<SqliteRow<'shipSteps'>['kind']>(),
    state: textC('state').notNull().$type<SqliteRow<'shipSteps'>['state']>(),
    outcome: textC('outcome').$type<SqliteRow<'shipSteps'>['outcome']>(),
    summary: textC('summary').notNull().$type<SqliteRow<'shipSteps'>['summary']>(),
    artifactRef: textC('artifact_ref').$type<SqliteRow<'shipSteps'>['artifactRef']>(),
    recordedAt: isoTimestamp('recorded_at').notNull().$type<SqliteRow<'shipSteps'>['recordedAt']>(),
    startedAt: isoTimestamp('started_at').$type<SqliteRow<'shipSteps'>['startedAt']>(),
    finishedAt: isoTimestamp('finished_at').$type<SqliteRow<'shipSteps'>['finishedAt']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'shipSteps'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'ship_steps_pk', columns: [table.workspaceId, table.id] }),
    index('idx_ship_steps_order').on(table.workspaceId, table.orderId, table.recordedAt),
    index('idx_ship_steps_effect').on(
      table.workspaceId,
      table.attemptId,
      table.effectKey,
      table.recordedAt,
    ),
    uniqueIndex('idx_ship_steps_attempt_idempotency').on(
      table.workspaceId,
      table.attemptId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: 'fk_ship_steps_order_id_ship_orders_id_fk',
      columns: [table.workspaceId, table.orderId],
      foreignColumns: [shipOrders.workspaceId, shipOrders.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_ship_steps_attempt_id_ship_attempts_id_fk',
      columns: [table.workspaceId, table.attemptId],
      foreignColumns: [shipAttempts.workspaceId, shipAttempts.id],
    }).onDelete('restrict'),
    check('ship_steps_generation_check', sql`generation >= 0`),
    check(
      'ship_steps_state_check',
      sql`state IN ('planned', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
    check(
      'ship_steps_lifecycle_check',
      sql`(state = 'planned' AND started_at IS NULL AND finished_at IS NULL AND outcome IS NULL)
          OR (state = 'running' AND started_at IS NOT NULL AND finished_at IS NULL AND outcome IS NULL)
          OR (state IN ('succeeded', 'failed', 'cancelled') AND started_at IS NOT NULL AND finished_at IS NOT NULL AND outcome IS NOT NULL)`,
    ),
  ],
)

export const shipTrainActiveClaims = pgTable(
  'ship_train_active_claims',
  {
    trainId: textC('train_id').notNull().$type<SqliteRow<'shipTrainActiveClaims'>['trainId']>(),
    orderId: textC('order_id').notNull().$type<SqliteRow<'shipTrainActiveClaims'>['orderId']>(),
    attemptId: textC('attempt_id')
      .notNull()
      .$type<SqliteRow<'shipTrainActiveClaims'>['attemptId']>(),
    generation: int8('generation')
      .notNull()
      .$type<SqliteRow<'shipTrainActiveClaims'>['generation']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'shipTrainActiveClaims'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'ship_train_active_claims_pk',
      columns: [table.workspaceId, table.trainId, table.orderId],
    }),
    uniqueIndex('idx_ship_train_active_claims_order').on(table.workspaceId, table.orderId),
    uniqueIndex('idx_ship_train_active_claims_attempt').on(table.workspaceId, table.attemptId),
    foreignKey({
      name: 'fk_ship_train_active_claims_train_id_ship_train_manifests_id_fk',
      columns: [table.workspaceId, table.trainId],
      foreignColumns: [shipTrainManifests.workspaceId, shipTrainManifests.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_ship_train_active_claims_member_order',
      columns: [table.workspaceId, table.trainId, table.orderId],
      foreignColumns: [
        shipTrainMembers.workspaceId,
        shipTrainMembers.trainId,
        shipTrainMembers.orderId,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_ship_train_active_claims_member_attempt',
      columns: [table.workspaceId, table.trainId, table.attemptId],
      foreignColumns: [
        shipTrainMembers.workspaceId,
        shipTrainMembers.trainId,
        shipTrainMembers.attemptId,
      ],
    }).onDelete('restrict'),
    check('ship_train_active_claims_generation_check', sql`generation > 0`),
  ],
)

export const shipTrainManifests = pgTable(
  'ship_train_manifests',
  {
    id: textC('id').notNull().$type<SqliteRow<'shipTrainManifests'>['id']>(),
    version: int8('version').notNull().$type<SqliteRow<'shipTrainManifests'>['version']>(),
    subsetId: textC('subset_id').notNull().$type<SqliteRow<'shipTrainManifests'>['subsetId']>(),
    repairRound: int8('repair_round')
      .notNull()
      .$type<SqliteRow<'shipTrainManifests'>['repairRound']>(),
    canonicalDigest: textC('canonical_digest')
      .notNull()
      .$type<SqliteRow<'shipTrainManifests'>['canonicalDigest']>(),
    canonicalJson: jsonText('canonical_json')
      .notNull()
      .$type<SqliteRow<'shipTrainManifests'>['canonicalJson']>(),
    repoId: textC('repo_id').notNull().$type<SqliteRow<'shipTrainManifests'>['repoId']>(),
    repoPath: textC('repo_path').notNull().$type<SqliteRow<'shipTrainManifests'>['repoPath']>(),
    machineId: textC('machine_id').notNull().$type<SqliteRow<'shipTrainManifests'>['machineId']>(),
    laneKey: textC('lane_key').notNull().$type<SqliteRow<'shipTrainManifests'>['laneKey']>(),
    laneRevision: int8('lane_revision')
      .notNull()
      .$type<SqliteRow<'shipTrainManifests'>['laneRevision']>(),
    targetBranch: textC('target_branch')
      .notNull()
      .$type<SqliteRow<'shipTrainManifests'>['targetBranch']>(),
    expectedTargetSha: textC('expected_target_sha')
      .notNull()
      .$type<SqliteRow<'shipTrainManifests'>['expectedTargetSha']>(),
    destination: textC('destination')
      .notNull()
      .$type<SqliteRow<'shipTrainManifests'>['destination']>(),
    providerRef: jsonValue('provider_ref').$type<SqliteRow<'shipTrainManifests'>['providerRef']>(),
    policyId: textC('policy_id').notNull().$type<SqliteRow<'shipTrainManifests'>['policyId']>(),
    validationProfile: jsonValue('validation_profile')
      .notNull()
      .$type<SqliteRow<'shipTrainManifests'>['validationProfile']>(),
    validationProfileDigest: textC('validation_profile_digest')
      .notNull()
      .$type<SqliteRow<'shipTrainManifests'>['validationProfileDigest']>(),
    memberCount: int8('member_count')
      .notNull()
      .$type<SqliteRow<'shipTrainManifests'>['memberCount']>(),
    leaderOrderId: textC('leader_order_id')
      .notNull()
      .$type<SqliteRow<'shipTrainManifests'>['leaderOrderId']>(),
    leaderAttemptId: textC('leader_attempt_id')
      .notNull()
      .$type<SqliteRow<'shipTrainManifests'>['leaderAttemptId']>(),
    leaderGeneration: int8('leader_generation')
      .notNull()
      .$type<SqliteRow<'shipTrainManifests'>['leaderGeneration']>(),
    createdAt: isoTimestamp('created_at')
      .notNull()
      .$type<SqliteRow<'shipTrainManifests'>['createdAt']>(),
    releasedAt: isoTimestamp('released_at').$type<SqliteRow<'shipTrainManifests'>['releasedAt']>(),
    releaseReason:
      textC('release_reason').$type<SqliteRow<'shipTrainManifests'>['releaseReason']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'shipTrainManifests'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'ship_train_manifests_pk', columns: [table.workspaceId, table.id] }),
    uniqueIndex('idx_ship_train_manifests_subset').on(table.workspaceId, table.subsetId),
    uniqueIndex('idx_ship_train_manifests_digest').on(table.workspaceId, table.canonicalDigest),
    index('idx_ship_train_manifests_open_lane')
      .on(table.workspaceId, table.laneKey, table.createdAt, table.id)
      .where(sql`"released_at" IS NULL`),
    index('idx_ship_train_manifests_leader').on(
      table.workspaceId,
      table.leaderOrderId,
      table.leaderAttemptId,
      table.leaderGeneration,
      table.releasedAt,
    ),
    foreignKey({
      name: 'fk_ship_train_manifests_leader_order_id_ship_orders_id_fk',
      columns: [table.workspaceId, table.leaderOrderId],
      foreignColumns: [shipOrders.workspaceId, shipOrders.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_ship_train_manifests_leader_attempt_id_ship_attempts_id_fk',
      columns: [table.workspaceId, table.leaderAttemptId],
      foreignColumns: [shipAttempts.workspaceId, shipAttempts.id],
    }).onDelete('restrict'),
    check('ship_train_manifests_version_check', sql`version = 1`),
    check('ship_train_manifests_repair_round_check', sql`repair_round = 0`),
    check('ship_train_manifests_generation_check', sql`leader_generation > 0`),
    check('ship_train_manifests_lane_revision_check', sql`lane_revision > 0`),
    check('ship_train_manifests_member_count_check', sql`member_count > 0`),
    check(
      'ship_train_manifests_release_pair_check',
      sql`(released_at IS NULL AND release_reason IS NULL) OR (released_at IS NOT NULL AND release_reason IS NOT NULL)`,
    ),
  ],
)

export const shipTrainMembers = pgTable(
  'ship_train_members',
  {
    trainId: textC('train_id').notNull().$type<SqliteRow<'shipTrainMembers'>['trainId']>(),
    ordinal: int8('ordinal').notNull().$type<SqliteRow<'shipTrainMembers'>['ordinal']>(),
    issueId: textC('issue_id').notNull().$type<SqliteRow<'shipTrainMembers'>['issueId']>(),
    orderId: textC('order_id').notNull().$type<SqliteRow<'shipTrainMembers'>['orderId']>(),
    attemptId: textC('attempt_id').notNull().$type<SqliteRow<'shipTrainMembers'>['attemptId']>(),
    generation: int8('generation').notNull().$type<SqliteRow<'shipTrainMembers'>['generation']>(),
    machineId: textC('machine_id').notNull().$type<SqliteRow<'shipTrainMembers'>['machineId']>(),
    sourceBranch: textC('source_branch')
      .notNull()
      .$type<SqliteRow<'shipTrainMembers'>['sourceBranch']>(),
    approvedBaseSha: textC('approved_base_sha')
      .notNull()
      .$type<SqliteRow<'shipTrainMembers'>['approvedBaseSha']>(),
    approvedHeadSha: textC('approved_head_sha')
      .notNull()
      .$type<SqliteRow<'shipTrainMembers'>['approvedHeadSha']>(),
    deliveryDependsOn: jsonValue('delivery_depends_on')
      .notNull()
      .$type<SqliteRow<'shipTrainMembers'>['deliveryDependsOn']>(),
    releasedAt: isoTimestamp('released_at').$type<SqliteRow<'shipTrainMembers'>['releasedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'shipTrainMembers'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'ship_train_members_pk',
      columns: [table.workspaceId, table.trainId, table.ordinal],
    }),
    unique('idx_ship_train_members_order').on(table.workspaceId, table.trainId, table.orderId),
    unique('idx_ship_train_members_issue').on(table.workspaceId, table.trainId, table.issueId),
    unique('idx_ship_train_members_attempt').on(table.workspaceId, table.trainId, table.attemptId),
    unique('idx_ship_train_members_source').on(
      table.workspaceId,
      table.trainId,
      table.sourceBranch,
    ),
    uniqueIndex('idx_ship_train_members_attempt_global').on(table.workspaceId, table.attemptId),
    index('idx_ship_train_members_issue_ref').on(table.workspaceId, table.issueId),
    index('idx_ship_train_members_live_custody').on(
      table.workspaceId,
      table.orderId,
      table.attemptId,
      table.generation,
      table.releasedAt,
    ),
    foreignKey({
      name: 'fk_ship_train_members_train_id_ship_train_manifests_id_fk',
      columns: [table.workspaceId, table.trainId],
      foreignColumns: [shipTrainManifests.workspaceId, shipTrainManifests.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_ship_train_members_issue_id_issues_id_fk',
      columns: [table.workspaceId, table.issueId],
      foreignColumns: [issues.workspaceId, issues.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_ship_train_members_order_id_ship_orders_id_fk',
      columns: [table.workspaceId, table.orderId],
      foreignColumns: [shipOrders.workspaceId, shipOrders.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_ship_train_members_attempt_id_ship_attempts_id_fk',
      columns: [table.workspaceId, table.attemptId],
      foreignColumns: [shipAttempts.workspaceId, shipAttempts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_ship_train_members_attempt_order',
      columns: [table.workspaceId, table.attemptId, table.orderId],
      foreignColumns: [shipAttempts.workspaceId, shipAttempts.id, shipAttempts.orderId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_ship_train_members_order_issue',
      columns: [table.workspaceId, table.orderId, table.issueId],
      foreignColumns: [shipOrders.workspaceId, shipOrders.id, shipOrders.issueId],
    }).onDelete('restrict'),
    check('ship_train_members_ordinal_check', sql`ordinal >= 0`),
    check('ship_train_members_generation_check', sql`generation > 0`),
  ],
)

export const snoozes = pgTable(
  'snoozes',
  {
    userId: textC('user_id').notNull().$type<SqliteRow<'snoozes'>['userId']>(),
    sessionId: textC('session_id').notNull().$type<SqliteRow<'snoozes'>['sessionId']>(),
    snoozedUntil: textC('snoozed_until').$type<SqliteRow<'snoozes'>['snoozedUntil']>(),
    createdAt: isoTimestamp('created_at').notNull().$type<SqliteRow<'snoozes'>['createdAt']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'snoozes'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'snoozes_pk', columns: [table.workspaceId, table.userId, table.sessionId] }),
    index('idx_snoozes_session').on(table.workspaceId, table.sessionId),
  ],
)

export const stewardState = pgTable(
  'steward_state',
  {
    key: textC('key').notNull().$type<SqliteRow<'stewardState'>['key']>(),
    value: textC('value').notNull().$type<SqliteRow<'stewardState'>['value']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'stewardState'>['workspaceId']>(),
  },
  (table) => [primaryKey({ name: 'steward_state_pk', columns: [table.workspaceId, table.key] })],
)

export const subscriptionDeliveries = pgTable(
  'subscription_deliveries',
  {
    subscriptionId: textC('subscription_id')
      .notNull()
      .$type<SqliteRow<'subscriptionDeliveries'>['subscriptionId']>(),
    eventId: int8('event_id').notNull().$type<SqliteRow<'subscriptionDeliveries'>['eventId']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'subscriptionDeliveries'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'subscription_deliveries_pk',
      columns: [table.workspaceId, table.subscriptionId, table.eventId],
    }),
  ],
)

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: textC('id').notNull().$type<SqliteRow<'subscriptions'>['id']>(),
    subscriberKind: textC('subscriber_kind')
      .notNull()
      .$type<SqliteRow<'subscriptions'>['subscriberKind']>(),
    subscriberId: textC('subscriber_id')
      .notNull()
      .$type<SqliteRow<'subscriptions'>['subscriberId']>(),
    event: textC('event').notNull().$type<SqliteRow<'subscriptions'>['event']>(),
    sourceKind: textC('source_kind').notNull().$type<SqliteRow<'subscriptions'>['sourceKind']>(),
    sourceRef: textC('source_ref').notNull().$type<SqliteRow<'subscriptions'>['sourceRef']>(),
    deliverNudge: boolean('deliver_nudge')
      .notNull()
      .default(true)
      .$type<SqliteRow<'subscriptions'>['deliverNudge']>(),
    deliverNotify: boolean('deliver_notify')
      .notNull()
      .default(false)
      .$type<SqliteRow<'subscriptions'>['deliverNotify']>(),
    origin: textC('origin')
      .notNull()
      .default(sql`'custom'`)
      .$type<SqliteRow<'subscriptions'>['origin']>(),
    enabled: boolean('enabled')
      .notNull()
      .default(true)
      .$type<SqliteRow<'subscriptions'>['enabled']>(),
    createdAt: isoTimestamp('created_at')
      .notNull()
      .$type<SqliteRow<'subscriptions'>['createdAt']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'subscriptions'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'subscriptions_pk', columns: [table.workspaceId, table.id] }),
    index('idx_subscriptions_subscriber_event').on(
      table.workspaceId,
      table.subscriberId,
      table.sourceKind,
      table.event,
    ),
    index('idx_subscriptions_match').on(
      table.workspaceId,
      table.event,
      table.sourceKind,
      table.sourceRef,
    ),
    index('idx_subscriptions_created').on(table.workspaceId, table.createdAt, table.id),
  ],
)

export const superagentMessages = pgTable(
  'superagent_messages',
  {
    id: int8('id')
      .primaryKey()
      .generatedByDefaultAsIdentity()
      .$type<SqliteRow<'superagentMessages'>['id']>(),
    ownerUserId: textC('owner_user_id')
      .notNull()
      .$type<SqliteRow<'superagentMessages'>['ownerUserId']>(),
    role: textC('role').notNull().$type<SqliteRow<'superagentMessages'>['role']>(),
    content: textC('content').notNull().$type<SqliteRow<'superagentMessages'>['content']>(),
    toolCalls: jsonText('tool_calls').$type<SqliteRow<'superagentMessages'>['toolCalls']>(),
    toolCallId: textC('tool_call_id').$type<SqliteRow<'superagentMessages'>['toolCallId']>(),
    toolName: textC('tool_name').$type<SqliteRow<'superagentMessages'>['toolName']>(),
    createdAt: isoTimestamp('created_at')
      .notNull()
      .$type<SqliteRow<'superagentMessages'>['createdAt']>(),
    threadId: textC('thread_id')
      .notNull()
      .default(sql`'global'`)
      .$type<SqliteRow<'superagentMessages'>['threadId']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'superagentMessages'>['workspaceId']>(),
  },
  (table) => [
    unique('superagent_messages_workspace_id_id_unique').on(table.workspaceId, table.id),
    index('idx_superagent_messages_thread').on(table.workspaceId, table.threadId, table.id),
  ],
)

export const superagentPendingTurns = pgTable(
  'superagent_pending_turns',
  {
    ownerUserId: textC('owner_user_id')
      .notNull()
      .$type<SqliteRow<'superagentPendingTurns'>['ownerUserId']>(),
    turnId: textC('turn_id').notNull().$type<SqliteRow<'superagentPendingTurns'>['turnId']>(),
    threadId: textC('thread_id').notNull().$type<SqliteRow<'superagentPendingTurns'>['threadId']>(),
    podiumSessionId: textC('podium_session_id')
      .notNull()
      .$type<SqliteRow<'superagentPendingTurns'>['podiumSessionId']>(),
    payloadJson: jsonText('payload_json')
      .notNull()
      .$type<SqliteRow<'superagentPendingTurns'>['payloadJson']>(),
    firstTurn: boolean('first_turn')
      .notNull()
      .default(false)
      .$type<SqliteRow<'superagentPendingTurns'>['firstTurn']>(),
    createdAt: isoTimestamp('created_at')
      .notNull()
      .$type<SqliteRow<'superagentPendingTurns'>['createdAt']>(),
    actor: textC('actor').$type<SqliteRow<'superagentPendingTurns'>['actor']>(),
    onBehalfOf: textC('on_behalf_of').$type<SqliteRow<'superagentPendingTurns'>['onBehalfOf']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'superagentPendingTurns'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'superagent_pending_turns_pk', columns: [table.workspaceId, table.turnId] }),
    unique('superagent_pending_turns_thread_id_unique').on(table.workspaceId, table.threadId),
  ],
)

export const superagentQueuedInputs = pgTable(
  'superagent_queued_inputs',
  {
    ownerUserId: textC('owner_user_id')
      .notNull()
      .$type<SqliteRow<'superagentQueuedInputs'>['ownerUserId']>(),
    inputId: textC('input_id').notNull().$type<SqliteRow<'superagentQueuedInputs'>['inputId']>(),
    threadId: textC('thread_id').notNull().$type<SqliteRow<'superagentQueuedInputs'>['threadId']>(),
    text: textC('text').notNull().$type<SqliteRow<'superagentQueuedInputs'>['text']>(),
    focusJson: jsonText('focus_json').$type<SqliteRow<'superagentQueuedInputs'>['focusJson']>(),
    agentKind: textC('agent_kind').$type<SqliteRow<'superagentQueuedInputs'>['agentKind']>(),
    attachSessionId:
      textC('attach_session_id').$type<SqliteRow<'superagentQueuedInputs'>['attachSessionId']>(),
    model: textC('model').$type<SqliteRow<'superagentQueuedInputs'>['model']>(),
    effort: textC('effort').$type<SqliteRow<'superagentQueuedInputs'>['effort']>(),
    createdAt: isoTimestamp('created_at')
      .notNull()
      .$type<SqliteRow<'superagentQueuedInputs'>['createdAt']>(),
    actor: textC('actor').$type<SqliteRow<'superagentQueuedInputs'>['actor']>(),
    onBehalfOf: textC('on_behalf_of').$type<SqliteRow<'superagentQueuedInputs'>['onBehalfOf']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'superagentQueuedInputs'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'superagent_queued_inputs_pk',
      columns: [table.workspaceId, table.inputId],
    }),
    index('idx_superagent_queued_thread_order').on(
      table.workspaceId,
      table.threadId,
      table.createdAt,
    ),
  ],
)

export const superagentThreads = pgTable(
  'superagent_threads',
  {
    id: textC('id').notNull().$type<SqliteRow<'superagentThreads'>['id']>(),
    ownerUserId: textC('owner_user_id')
      .notNull()
      .$type<SqliteRow<'superagentThreads'>['ownerUserId']>(),
    kind: textC('kind').notNull().$type<SqliteRow<'superagentThreads'>['kind']>(),
    originSessionId:
      textC('origin_session_id').$type<SqliteRow<'superagentThreads'>['originSessionId']>(),
    title: textC('title').$type<SqliteRow<'superagentThreads'>['title']>(),
    watermarkItemId:
      textC('watermark_item_id').$type<SqliteRow<'superagentThreads'>['watermarkItemId']>(),
    watermarkTs: textC('watermark_ts').$type<SqliteRow<'superagentThreads'>['watermarkTs']>(),
    createdAt: isoTimestamp('created_at')
      .notNull()
      .$type<SqliteRow<'superagentThreads'>['createdAt']>(),
    updatedAt: isoTimestamp('updated_at')
      .notNull()
      .$type<SqliteRow<'superagentThreads'>['updatedAt']>(),
    archived: boolean('archived')
      .notNull()
      .default(false)
      .$type<SqliteRow<'superagentThreads'>['archived']>(),
    repoPath: textC('repo_path').$type<SqliteRow<'superagentThreads'>['repoPath']>(),
    agentKind: textC('agent_kind').$type<SqliteRow<'superagentThreads'>['agentKind']>(),
    podiumSessionId:
      textC('podium_session_id').$type<SqliteRow<'superagentThreads'>['podiumSessionId']>(),
    harnessSessionId:
      textC('harness_session_id').$type<SqliteRow<'superagentThreads'>['harnessSessionId']>(),
    terminalSessionId:
      textC('terminal_session_id').$type<SqliteRow<'superagentThreads'>['terminalSessionId']>(),
    model: textC('model').$type<SqliteRow<'superagentThreads'>['model']>(),
    effort: textC('effort').$type<SqliteRow<'superagentThreads'>['effort']>(),
    turnRunning: boolean('turn_running')
      .notNull()
      .default(false)
      .$type<SqliteRow<'superagentThreads'>['turnRunning']>(),
    lastTurnFailureAt:
      isoTimestamp('last_turn_failure_at').$type<
        SqliteRow<'superagentThreads'>['lastTurnFailureAt']
      >(),
    lastTurnFailureMessage: textC('last_turn_failure_message').$type<
      SqliteRow<'superagentThreads'>['lastTurnFailureMessage']
    >(),
    lastTurnFailureUserText: textC('last_turn_failure_user_text').$type<
      SqliteRow<'superagentThreads'>['lastTurnFailureUserText']
    >(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'superagentThreads'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'superagent_threads_pk', columns: [table.workspaceId, table.id] }),
    index('idx_superagent_threads_owner').on(
      table.workspaceId,
      table.ownerUserId,
      table.archived,
      table.updatedAt,
    ),
    index('idx_superagent_threads_running').on(table.workspaceId, table.turnRunning),
  ],
)

export const tabOrder = pgTable(
  'tab_order',
  {
    userId: textC('user_id').notNull().$type<SqliteRow<'tabOrder'>['userId']>(),
    worktree: textC('worktree').notNull().$type<SqliteRow<'tabOrder'>['worktree']>(),
    ids: jsonText('ids').notNull().$type<SqliteRow<'tabOrder'>['ids']>(),
    updatedAt: isoTimestamp('updated_at').notNull().$type<SqliteRow<'tabOrder'>['updatedAt']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'tabOrder'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'tab_order_pk',
      columns: [table.workspaceId, table.userId, table.worktree],
    }),
  ],
)

export const telegramChatBindings = pgTable(
  'telegram_chat_bindings',
  {
    chatId: textC('chat_id').notNull().$type<SqliteRow<'telegramChatBindings'>['chatId']>(),
    userId: textC('user_id').notNull().$type<SqliteRow<'telegramChatBindings'>['userId']>(),
    boundAt: isoTimestamp('bound_at')
      .notNull()
      .$type<SqliteRow<'telegramChatBindings'>['boundAt']>(),
    actorKind: textC('actor_kind')
      .notNull()
      .$type<SqliteRow<'telegramChatBindings'>['actorKind']>(),
    actorId: textC('actor_id').$type<SqliteRow<'telegramChatBindings'>['actorId']>(),
    onBehalfOf: textC('on_behalf_of').$type<SqliteRow<'telegramChatBindings'>['onBehalfOf']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'telegramChatBindings'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'telegram_chat_bindings_pk', columns: [table.workspaceId, table.chatId] }),
  ],
)

export const transcriptCosts = pgTable(
  'transcript_costs',
  {
    machineId: textC('machine_id').notNull().$type<SqliteRow<'transcriptCosts'>['machineId']>(),
    nativeId: textC('native_id').notNull().$type<SqliteRow<'transcriptCosts'>['nativeId']>(),
    path: textC('path').notNull().$type<SqliteRow<'transcriptCosts'>['path']>(),
    harness: textC('harness').notNull().$type<SqliteRow<'transcriptCosts'>['harness']>(),
    sessionId: textC('session_id').$type<SqliteRow<'transcriptCosts'>['sessionId']>(),
    issueId: textC('issue_id').$type<SqliteRow<'transcriptCosts'>['issueId']>(),
    scannedBytes: int8('scanned_bytes')
      .notNull()
      .default(0)
      .$type<SqliteRow<'transcriptCosts'>['scannedBytes']>(),
    firstTsMs: int8('first_ts_ms')
      .notNull()
      .default(0)
      .$type<SqliteRow<'transcriptCosts'>['firstTsMs']>(),
    lastTsMs: int8('last_ts_ms')
      .notNull()
      .default(0)
      .$type<SqliteRow<'transcriptCosts'>['lastTsMs']>(),
    messages: int8('messages')
      .notNull()
      .default(0)
      .$type<SqliteRow<'transcriptCosts'>['messages']>(),
    modelsJson: jsonText('models_json')
      .notNull()
      .$type<SqliteRow<'transcriptCosts'>['modelsJson']>(),
    windowModelsJson: jsonText('window_models_json')
      .notNull()
      .default(sql`'[]'`)
      .$type<SqliteRow<'transcriptCosts'>['windowModelsJson']>(),
    windowSinceMs: int8('window_since_ms')
      .notNull()
      .default(0)
      .$type<SqliteRow<'transcriptCosts'>['windowSinceMs']>(),
    updatedAt: isoTimestamp('updated_at')
      .notNull()
      .$type<SqliteRow<'transcriptCosts'>['updatedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'transcriptCosts'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'transcript_costs_pk',
      columns: [table.workspaceId, table.machineId, table.nativeId],
    }),
    index('idx_transcript_costs_issue').on(table.workspaceId, table.issueId),
    index('idx_transcript_costs_session').on(table.workspaceId, table.sessionId),
  ],
)

export const upstreamOutbox = pgTable(
  'upstream_outbox',
  {
    mutationId: textC('mutation_id').notNull().$type<SqliteRow<'upstreamOutbox'>['mutationId']>(),
    proc: textC('proc').notNull().$type<SqliteRow<'upstreamOutbox'>['proc']>(),
    input: textC('input').notNull().$type<SqliteRow<'upstreamOutbox'>['input']>(),
    queuedAt: int8('queued_at').notNull().$type<SqliteRow<'upstreamOutbox'>['queuedAt']>(),
    attempts: int8('attempts')
      .notNull()
      .default(0)
      .$type<SqliteRow<'upstreamOutbox'>['attempts']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'upstreamOutbox'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'upstream_outbox_pk', columns: [table.workspaceId, table.mutationId] }),
  ],
)

export const userDockShell = pgTable(
  'user_dock_shell',
  {
    userId: textC('user_id').notNull().$type<SqliteRow<'userDockShell'>['userId']>(),
    worktreeKey: textC('worktree_key').notNull().$type<SqliteRow<'userDockShell'>['worktreeKey']>(),
    sessionId: textC('session_id').notNull().$type<SqliteRow<'userDockShell'>['sessionId']>(),
    updatedAt: isoTimestamp('updated_at')
      .notNull()
      .$type<SqliteRow<'userDockShell'>['updatedAt']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'userDockShell'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'user_dock_shell_pk',
      columns: [table.workspaceId, table.userId, table.worktreeKey],
    }),
    index('idx_user_dock_shell_session').on(table.workspaceId, table.sessionId),
    index('idx_user_dock_shell_worktree').on(table.workspaceId, table.worktreeKey),
  ],
)

export const userLayout = pgTable(
  'user_layout',
  {
    userId: textC('user_id').notNull().$type<SqliteRow<'userLayout'>['userId']>(),
    key: textC('key').notNull().$type<SqliteRow<'userLayout'>['key']>(),
    value: textC('value').notNull().$type<SqliteRow<'userLayout'>['value']>(),
    updatedAt: isoTimestamp('updated_at').notNull().$type<SqliteRow<'userLayout'>['updatedAt']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'userLayout'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'user_layout_pk', columns: [table.workspaceId, table.userId, table.key] }),
  ],
)

export const userPreferences = pgTable(
  'user_preferences',
  {
    userId: textC('user_id').notNull().$type<SqliteRow<'userPreferences'>['userId']>(),
    key: textC('key').notNull().$type<SqliteRow<'userPreferences'>['key']>(),
    value: textC('value').notNull().$type<SqliteRow<'userPreferences'>['value']>(),
    updatedAt: isoTimestamp('updated_at')
      .notNull()
      .$type<SqliteRow<'userPreferences'>['updatedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'userPreferences'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'user_preferences_pk',
      columns: [table.workspaceId, table.userId, table.key],
    }),
  ],
)

export const userReadPosition = pgTable(
  'user_read_position',
  {
    userId: textC('user_id').notNull().$type<SqliteRow<'userReadPosition'>['userId']>(),
    streamId: textC('stream_id').notNull().$type<SqliteRow<'userReadPosition'>['streamId']>(),
    lastEventId: int8('last_event_id')
      .notNull()
      .$type<SqliteRow<'userReadPosition'>['lastEventId']>(),
    seenAt: isoTimestamp('seen_at').$type<SqliteRow<'userReadPosition'>['seenAt']>(),
    updatedAt: isoTimestamp('updated_at')
      .notNull()
      .$type<SqliteRow<'userReadPosition'>['updatedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'userReadPosition'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'user_read_position_pk',
      columns: [table.workspaceId, table.userId, table.streamId],
    }),
  ],
)

export const users = pgTable(
  'users',
  {
    id: textC('id').notNull().$type<SqliteRow<'users'>['id']>(),
    displayName: textC('display_name').notNull().$type<SqliteRow<'users'>['displayName']>(),
    email: textC('email').$type<SqliteRow<'users'>['email']>(),
    cloudAccountId: textC('account_id').$type<SqliteRow<'users'>['cloudAccountId']>(),
    avatar: textC('avatar').$type<SqliteRow<'users'>['avatar']>(),
    role: textC('role').notNull().$type<SqliteRow<'users'>['role']>(),
    createdAt: isoTimestamp('created_at').notNull().$type<SqliteRow<'users'>['createdAt']>(),
    disabledAt: isoTimestamp('disabled_at').$type<SqliteRow<'users'>['disabledAt']>(),
    authzGeneration: int8('authz_generation')
      .notNull()
      .default(0)
      .$type<SqliteRow<'users'>['authzGeneration']>(),
    authzChangedAt: isoTimestamp('authz_changed_at').$type<SqliteRow<'users'>['authzChangedAt']>(),
    membershipVersion: int8('membership_version')
      .notNull()
      .default(0)
      .$type<SqliteRow<'users'>['membershipVersion']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'users'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'users_pk', columns: [table.workspaceId, table.id] }),
    uniqueIndex('users_email_unique').on(table.workspaceId, sql`lower("email")`),
    uniqueIndex('users_account_id_unique').on(table.workspaceId, table.cloudAccountId),
  ],
)

export const workflowBindings = pgTable(
  'workflow_bindings',
  {
    targetKind: textC('target_kind').notNull().$type<SqliteRow<'workflowBindings'>['targetKind']>(),
    targetId: textC('target_id').notNull().$type<SqliteRow<'workflowBindings'>['targetId']>(),
    revisionId: textC('revision_id').notNull().$type<SqliteRow<'workflowBindings'>['revisionId']>(),
    updatedByKind: textC('updated_by_kind')
      .notNull()
      .$type<SqliteRow<'workflowBindings'>['updatedByKind']>(),
    updatedById: textC('updated_by_id').$type<SqliteRow<'workflowBindings'>['updatedById']>(),
    updatedAt: isoTimestamp('updated_at')
      .notNull()
      .$type<SqliteRow<'workflowBindings'>['updatedAt']>(),
    ownerUserId: textC('owner_user_id')
      .notNull()
      .$type<SqliteRow<'workflowBindings'>['ownerUserId']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'workflowBindings'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'workflow_bindings_pk',
      columns: [table.workspaceId, table.targetKind, table.targetId],
    }),
    foreignKey({
      name: 'fk_workflow_bindings_revision_id_workflow_revisions_id_fk',
      columns: [table.workspaceId, table.revisionId],
      foreignColumns: [workflowRevisions.workspaceId, workflowRevisions.id],
    }).onDelete('restrict'),
    check(
      'workflow_bindings_check_13',
      sql`target_kind IN ('global', 'repository', 'issue', 'session')`,
    ),
    check('workflow_bindings_check_14', sql`updated_by_kind IN ('operator', 'session')`),
  ],
)

export const workflowEvents = pgTable(
  'workflow_events',
  {
    id: int8('id')
      .primaryKey()
      .generatedByDefaultAsIdentity()
      .$type<SqliteRow<'workflowEvents'>['id']>(),
    workflowId: textC('workflow_id').$type<SqliteRow<'workflowEvents'>['workflowId']>(),
    runId: textC('run_id').$type<SqliteRow<'workflowEvents'>['runId']>(),
    kind: textC('kind').notNull().$type<SqliteRow<'workflowEvents'>['kind']>(),
    actorKind: textC('actor_kind').notNull().$type<SqliteRow<'workflowEvents'>['actorKind']>(),
    actorId: textC('actor_id').$type<SqliteRow<'workflowEvents'>['actorId']>(),
    onBehalfOf: textC('on_behalf_of').$type<SqliteRow<'workflowEvents'>['onBehalfOf']>(),
    payloadJson: jsonText('payload_json')
      .notNull()
      .default(sql`'{}'`)
      .$type<SqliteRow<'workflowEvents'>['payloadJson']>(),
    createdAt: isoTimestamp('created_at')
      .notNull()
      .$type<SqliteRow<'workflowEvents'>['createdAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'workflowEvents'>['workspaceId']>(),
  },
  (table) => [
    unique('workflow_events_workspace_id_id_unique').on(table.workspaceId, table.id),
    index('workflow_events_run').on(table.workspaceId, table.runId, table.id),
    index('workflow_events_workflow').on(table.workspaceId, table.workflowId, table.id),
    check('workflow_events_check_19', sql`actor_kind IN ('operator', 'session')`),
  ],
)

export const workflowRevisions = pgTable(
  'workflow_revisions',
  {
    id: textC('id').notNull().$type<SqliteRow<'workflowRevisions'>['id']>(),
    workflowId: textC('workflow_id')
      .notNull()
      .$type<SqliteRow<'workflowRevisions'>['workflowId']>(),
    version: int8('version').notNull().$type<SqliteRow<'workflowRevisions'>['version']>(),
    instructions: textC('instructions')
      .notNull()
      .$type<SqliteRow<'workflowRevisions'>['instructions']>(),
    stepsJson: jsonText('steps_json')
      .notNull()
      .default(sql`'[]'`)
      .$type<SqliteRow<'workflowRevisions'>['stepsJson']>(),
    createdByKind: textC('created_by_kind')
      .notNull()
      .$type<SqliteRow<'workflowRevisions'>['createdByKind']>(),
    createdById: textC('created_by_id').$type<SqliteRow<'workflowRevisions'>['createdById']>(),
    createdAt: isoTimestamp('created_at')
      .notNull()
      .$type<SqliteRow<'workflowRevisions'>['createdAt']>(),
    publishedAt:
      isoTimestamp('published_at').$type<SqliteRow<'workflowRevisions'>['publishedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'workflowRevisions'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'workflow_revisions_pk', columns: [table.workspaceId, table.id] }),
    unique('workflow_revisions_workspace_id_workflow_id_version_unique').on(
      table.workspaceId,
      table.workflowId,
      table.version,
    ),
    index('workflow_revisions_workflow').on(table.workspaceId, table.workflowId, table.version),
    foreignKey({
      name: 'fk_workflow_revisions_workflow_id_workflows_id_fk',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('cascade'),
    check('workflow_revisions_check_11', sql`version > 0`),
    check('workflow_revisions_check_12', sql`created_by_kind IN ('operator', 'session')`),
  ],
)

export const workflowRunSteps = pgTable(
  'workflow_run_steps',
  {
    runId: textC('run_id').notNull().$type<SqliteRow<'workflowRunSteps'>['runId']>(),
    stepId: textC('step_id').notNull().$type<SqliteRow<'workflowRunSteps'>['stepId']>(),
    position: int8('position').notNull().$type<SqliteRow<'workflowRunSteps'>['position']>(),
    title: textC('title').notNull().$type<SqliteRow<'workflowRunSteps'>['title']>(),
    instructions: textC('instructions')
      .notNull()
      .default(sql`''`)
      .$type<SqliteRow<'workflowRunSteps'>['instructions']>(),
    completionGuidance: textC('completion_guidance')
      .notNull()
      .default(sql`''`)
      .$type<SqliteRow<'workflowRunSteps'>['completionGuidance']>(),
    agentProfileId:
      textC('agent_profile_id').$type<SqliteRow<'workflowRunSteps'>['agentProfileId']>(),
    agentProfileJson:
      jsonText('agent_profile_json').$type<SqliteRow<'workflowRunSteps'>['agentProfileJson']>(),
    status: textC('status').notNull().$type<SqliteRow<'workflowRunSteps'>['status']>(),
    assignedSessionId:
      textC('assigned_session_id').$type<SqliteRow<'workflowRunSteps'>['assignedSessionId']>(),
    attempt: int8('attempt').notNull().default(1).$type<SqliteRow<'workflowRunSteps'>['attempt']>(),
    summary: textC('summary')
      .notNull()
      .default(sql`''`)
      .$type<SqliteRow<'workflowRunSteps'>['summary']>(),
    evidenceJson: jsonText('evidence_json')
      .notNull()
      .default(sql`'{}'`)
      .$type<SqliteRow<'workflowRunSteps'>['evidenceJson']>(),
    observationJson:
      jsonText('observation_json').$type<SqliteRow<'workflowRunSteps'>['observationJson']>(),
    warningsJson: jsonText('warnings_json')
      .notNull()
      .default(sql`'[]'`)
      .$type<SqliteRow<'workflowRunSteps'>['warningsJson']>(),
    startedAt: isoTimestamp('started_at').$type<SqliteRow<'workflowRunSteps'>['startedAt']>(),
    completedAt: isoTimestamp('completed_at').$type<SqliteRow<'workflowRunSteps'>['completedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'workflowRunSteps'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({
      name: 'workflow_run_steps_pk',
      columns: [table.workspaceId, table.runId, table.stepId],
    }),
    unique('workflow_run_steps_workspace_id_run_id_position_unique').on(
      table.workspaceId,
      table.runId,
      table.position,
    ),
    index('workflow_run_steps_assignee').on(
      table.workspaceId,
      table.assignedSessionId,
      table.status,
    ),
    foreignKey({
      name: 'fk_workflow_run_steps_run_id_workflow_runs_id_fk',
      columns: [table.workspaceId, table.runId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }).onDelete('cascade'),
    check('workflow_run_steps_check_16', sql`position >= 0`),
    check(
      'workflow_run_steps_check_17',
      sql`status IN ('pending', 'active', 'blocked', 'complete', 'skipped')`,
    ),
    check('workflow_run_steps_check_18', sql`attempt > 0`),
  ],
)

export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: textC('id').notNull().$type<SqliteRow<'workflowRuns'>['id']>(),
    subjectKind: textC('subject_kind').notNull().$type<SqliteRow<'workflowRuns'>['subjectKind']>(),
    subjectId: textC('subject_id').notNull().$type<SqliteRow<'workflowRuns'>['subjectId']>(),
    coordinatorSessionId: textC('coordinator_session_id')
      .notNull()
      .$type<SqliteRow<'workflowRuns'>['coordinatorSessionId']>(),
    revisionId: textC('revision_id').notNull().$type<SqliteRow<'workflowRuns'>['revisionId']>(),
    status: textC('status').notNull().$type<SqliteRow<'workflowRuns'>['status']>(),
    supersedesRunId:
      textC('supersedes_run_id').$type<SqliteRow<'workflowRuns'>['supersedesRunId']>(),
    startedAt: isoTimestamp('started_at').notNull().$type<SqliteRow<'workflowRuns'>['startedAt']>(),
    completedAt: isoTimestamp('completed_at').$type<SqliteRow<'workflowRuns'>['completedAt']>(),
    ownerUserId: textC('owner_user_id').notNull().$type<SqliteRow<'workflowRuns'>['ownerUserId']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'workflowRuns'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'workflow_runs_pk', columns: [table.workspaceId, table.id] }),
    uniqueIndex('workflow_runs_one_live_subject')
      .on(table.workspaceId, table.subjectKind, table.subjectId)
      .where(sql`"status" IN ('active', 'blocked')`),
    index('workflow_runs_coordinator').on(
      table.workspaceId,
      table.coordinatorSessionId,
      sql`"started_at" desc`,
    ),
    index('workflow_runs_status').on(table.workspaceId, table.status, table.startedAt),
    index('workflow_runs_subject').on(
      table.workspaceId,
      table.subjectKind,
      table.subjectId,
      table.startedAt,
    ),
    index('workflow_runs_started').on(table.workspaceId, table.startedAt, table.id),
    foreignKey({
      name: 'fk_workflow_runs_revision_id_workflow_revisions_id_fk',
      columns: [table.workspaceId, table.revisionId],
      foreignColumns: [workflowRevisions.workspaceId, workflowRevisions.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_workflow_runs_supersedes_run_id_workflow_runs_id_fk',
      columns: [table.workspaceId, table.supersedesRunId],
      foreignColumns: [table.workspaceId, table.id],
    }),
    check('workflow_runs_check_23', sql`subject_kind IN ('issue', 'session')`),
    check('workflow_runs_check_24', sql`status IN ('active', 'blocked', 'complete', 'superseded')`),
  ],
)

export const workflows = pgTable(
  'workflows',
  {
    id: textC('id').notNull().$type<SqliteRow<'workflows'>['id']>(),
    name: textC('name').notNull().$type<SqliteRow<'workflows'>['name']>(),
    description: textC('description')
      .notNull()
      .default(sql`''`)
      .$type<SqliteRow<'workflows'>['description']>(),
    scope: textC('scope').notNull().$type<SqliteRow<'workflows'>['scope']>(),
    scopeRef: textC('scope_ref').$type<SqliteRow<'workflows'>['scopeRef']>(),
    latestRevisionId:
      textC('latest_revision_id').$type<SqliteRow<'workflows'>['latestRevisionId']>(),
    archivedAt: isoTimestamp('archived_at').$type<SqliteRow<'workflows'>['archivedAt']>(),
    createdByKind: textC('created_by_kind')
      .notNull()
      .$type<SqliteRow<'workflows'>['createdByKind']>(),
    createdById: textC('created_by_id').$type<SqliteRow<'workflows'>['createdById']>(),
    createdAt: isoTimestamp('created_at').notNull().$type<SqliteRow<'workflows'>['createdAt']>(),
    updatedAt: isoTimestamp('updated_at').notNull().$type<SqliteRow<'workflows'>['updatedAt']>(),
    ownerUserId: textC('owner_user_id').notNull().$type<SqliteRow<'workflows'>['ownerUserId']>(),
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'workflows'>['workspaceId']>(),
  },
  (table) => [
    primaryKey({ name: 'workflows_pk', columns: [table.workspaceId, table.id] }),
    uniqueIndex('workflows_scope_name_active')
      .on(table.workspaceId, table.scope, sql`COALESCE("scope_ref", '')`, table.name)
      .where(sql`"archived_at" IS NULL`),
    check('workflows_check_21', sql`scope IN ('global', 'repository', 'task')`),
    check('workflows_check_22', sql`created_by_kind IN ('operator', 'session')`),
  ],
)

export const workspaceMeta = pgTable(
  'workspace_meta',
  {
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'workspaceMeta'>['workspaceId']>(),
    key: textC('key').notNull().$type<SqliteRow<'workspaceMeta'>['key']>(),
    value: textC('value').notNull().$type<SqliteRow<'workspaceMeta'>['value']>(),
  },
  (table) => [primaryKey({ name: 'workspace_meta_pk', columns: [table.workspaceId, table.key] })],
)

export const workspaceSecrets = pgTable(
  'workspace_secrets',
  {
    workspaceId: textC('workspace_id')
      .notNull()
      .$type<SqliteRow<'workspaceSecrets'>['workspaceId']>(),
    key: textC('key').notNull().$type<SqliteRow<'workspaceSecrets'>['key']>(),
    value: textC('value').notNull().$type<SqliteRow<'workspaceSecrets'>['value']>(),
    updatedAt: isoTimestamp('updated_at')
      .notNull()
      .$type<SqliteRow<'workspaceSecrets'>['updatedAt']>(),
  },
  (table) => [
    primaryKey({ name: 'workspace_secrets_pk', columns: [table.workspaceId, table.key] }),
  ],
)
