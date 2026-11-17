/**
 * THE WORKSPACE TABLE MANIFEST (POD-6959 design 2.1 and appendix A).
 *
 * Every table this server's database holds, in exactly one class. The classes decide what a
 * query against the table must say about the workspace, so the audit and the type rule read
 * this file rather than guessing from column names:
 *
 *   workspace  every row belongs to one workspace; the table carries workspace_id and every key
 *              leads with it.
 *   identity   the identity package's tables. Account-level rows (a person's login, sessions,
 *              codes) belong to no workspace; the membership tables already carry workspace_id.
 *              Their statements live in packages/identity and are unchanged by this design.
 *   install    one per database: what the installation is, its upgrade marks, its own secrets,
 *              the fleet's job lease. Hosted has one installation for all workspaces.
 *   transient  rows that live inside one write transaction (change capture) or are engine
 *              bookkeeping. Never read across a commit.
 *   derived    FTS5 search indexes, built from a workspace table and scoped by joining it.
 *
 * Where a table comes from (`origin`):
 *
 *   schema     declared in migrations/schema.ts, the sync adapter's schema or the identity
 *              package's schema, and created by the migration chain.
 *   legacy     a pre-upgrade shape that migrations/identity-import-schema.ts declares for the
 *              boot identity import; a deferred migration drops it once the import has run.
 *   runtime    created at boot by the store (the search index), not by a migration.
 *   engine     created by SQLite or by the migrator.
 *   planned    a table the design adds; a later task creates it and changes the origin.
 *
 * Id generation (`idgen`): random (minted at random by the server or a client), client (a client
 * may choose it), machine (the daemon's own UUID), derived (a hash or a harness-native id),
 * autoinc (INTEGER PRIMARY KEY AUTOINCREMENT), natural (made of other ids, names or keys),
 * singleton (one row).
 *
 * `store/workspace-manifest.test.ts` holds this list to the schemas and to a freshly migrated
 * database: an unclassified table, or a classified table that no longer exists, fails it.
 * Adding a table means adding its line here, with the reason it is in its class.
 */

export type TableClass = 'workspace' | 'identity' | 'install' | 'transient' | 'derived'
export type TableOrigin = 'schema' | 'legacy' | 'runtime' | 'engine' | 'planned'
export type IdGeneration =
  | 'random'
  | 'client'
  | 'machine'
  | 'derived'
  | 'autoinc'
  | 'natural'
  | 'singleton'

export interface ManifestEntry {
  readonly class: TableClass
  readonly origin: TableOrigin
  readonly idgen: IdGeneration
  readonly reason: string
  /** A hard case the design discusses in section 2.1. */
  readonly hard?: true
  /** An FTS5 virtual table: its shadow tables (`<name>_data`, …) share its entry. */
  readonly fts5?: true
  /**
   * Why a runtime or engine table may be absent from a freshly migrated database that has
   * search on. Without it, the manifest test requires the table to exist.
   */
  readonly mayBeAbsent?: string
  /**
   * A workspace table whose workspace_id column a later task adds, not the column migration
   * (POD-7012). The non-null workspace_id rule skips it, and the manifest test fails once the
   * column exists, so the task that adds it also removes this field.
   */
  readonly workspaceColumnPending?: string
}

const workspace = <const G extends IdGeneration>(idgen: G, reason: string, hard?: true) =>
  ({ class: 'workspace', origin: 'schema', idgen, reason, ...(hard ? { hard } : {}) }) as const

const identity = <const G extends IdGeneration>(idgen: G, reason: string, hard?: true) =>
  ({ class: 'identity', origin: 'schema', idgen, reason, ...(hard ? { hard } : {}) }) as const

export const TABLE_MANIFEST = {
  // ---- server schema: migrations/schema.ts ----
  account_machine_sends: workspace(
    'natural',
    'which machines may use a member credential; follows accounts',
  ),
  accounts: workspace(
    'random',
    'provider credentials of a member (users row); a credential is managed inside the workspace that holds it',
    true,
  ),
  agent_profiles: workspace(
    'random',
    'named launch profiles; global today with UNIQUE(name), which becomes per workspace',
  ),
  approval_requests: workspace('random', 'an agent session asking a member; follows sessions'),
  artifact_uploads: workspace(
    'client',
    "a CLI bundle upload in progress on an issue (POD-7054); the client picks the upload id, and the bytes are chunk objects under the workspace's blob store",
  ),
  automation_runs: workspace('random', 'runs of a workspace automation'),
  automations: workspace('random', 'owned by a member (owner_user_id)'),
  carried_sign_ins: workspace(
    'natural',
    'carried product sign-ins of a member; keyed by an old token hash',
  ),
  checkout_lost: workspace('natural', "a member's lost checkouts on a machine"),
  checkout_reach: workspace('natural', "a member's checkout reach on a machine"),
  checkouts: workspace(
    'natural',
    'worktrees on a workspace machine; (machine_id, path) is per machine, and one machine may serve two workspaces',
  ),
  client_sessions: workspace(
    'random',
    "product session tokens of a member; looked up after the request's workspace is known (POD-6960)",
  ),
  conversation_identities: workspace('random', 'conversation ids of workspace transcripts'),
  conversation_segment_incarnations: workspace(
    'derived',
    'harness-native ids on a workspace machine',
  ),
  conversation_segments: workspace('derived', 'harness-native ids on a workspace machine'),
  conversations: workspace(
    'derived',
    'transcripts of workspace sessions; the FTS content table keys on its rowid',
  ),
  delivery_receipts: workspace('random', 'shipping receipts; follows ship orders'),
  effects: workspace('random', 'the effects outbox of workspace writes'),
  grant_audiences: workspace('natural', 'who may see a workspace resource'),
  grants: workspace('natural', 'verbs on workspace resources'),
  issue_comments: workspace('random', 'follows issues'),
  issue_deps: workspace('natural', 'edges between issues'),
  issue_git_states: workspace('natural', 'follows issues'),
  issue_labels: workspace('natural', 'issue to label; label_id is an integer surrogate'),
  issue_message_user_state: workspace('natural', "a member's state of an issue message"),
  issue_messages: workspace('random', 'follows issues'),
  issue_panel_artifacts: workspace('random', 'follows issues; UNIQUE(issue_id, path)'),
  issue_panel_deferred: workspace('random', 'follows issues'),
  issue_panel_states: workspace('random', 'follows issues'),
  issue_panel_todos: workspace('random', 'follows issues'),
  issue_ref_letters: workspace('natural', 'issue reference letters; natural per issue'),
  issue_text_revisions: workspace('autoinc', 'follows issues'),
  issue_user_state: workspace('natural', "a member's state of an issue"),
  issues: workspace(
    'client',
    'the work items; issue numbers UNIQUE(repo_id, seq) count per workspace and repository',
    true,
  ),
  labels: workspace('autoinc', 'no owner today; label names become unique per workspace'),
  lock_waiters: workspace('autoinc', 'follows locks'),
  locks: workspace(
    'natural',
    'no owner today, keyed (repo_id, name); repo ids are hashes of the origin URL, so two workspaces on one repository share a repo_id',
  ),
  machines: workspace(
    'machine',
    "a machine enrolled into the workspace. Its id is the daemon's own UUID, so one daemon that joins two workspaces has the same id in both",
    true,
  ),
  maintenance_commands: workspace(
    'natural',
    'idempotency of janitor jobs, which act on workspace data (prune, archive, connect scan) and run per workspace in a fleet (POD-6962)',
  ),
  maintenance_leases: {
    class: 'install',
    origin: 'schema',
    idgen: 'natural',
    reason:
      'the janitor lease and fencing token: one per installation or fleet, not per workspace (POD-6962 decides per-workspace leases)',
  },
  message_reads: workspace('natural', 'per-reader receipts of workspace messages'),
  message_wake_cooldowns: workspace('natural', 'wake cooldowns of workspace sessions'),
  messages: workspace('random', 'workspace mail'),
  messaging_issue_topics: workspace('natural', 'chat topics bound to workspace issues'),
  messaging_session_attachments: workspace('natural', 'chat threads bound to workspace sessions'),
  meta: {
    class: 'install',
    origin: 'schema',
    idgen: 'natural',
    reason:
      'install keys only (INSTALL_META_KEYS: schema and upgrade marks, installation identity, update execution, fleet channel); its workspace keys moved to workspace_meta (POD-7013)',
    hard: true,
  },
  native_login_opt_ins: workspace('natural', 'a member opting a harness login in'),
  native_login_transfers: workspace('natural', "a member's login transfers to a machine"),
  notification_facts: workspace('natural', 'notification dedupe of workspace facts'),
  offers: workspace('natural', 'one offer per workspace session'),
  operations: workspace(
    'random',
    'long-running operations a member starts on workspace machines; self-hosted server updates run as the one workspace local',
  ),
  pending_interactions: workspace('random', 'prompts of workspace sessions'),
  pins: workspace('natural', "a member's pins"),
  podium_events: workspace(
    'autoinc',
    'the workspace event log; ids are synced entity ids and consumer cursors',
  ),
  queued_messages: workspace('random', 'queued input of workspace sessions'),
  quota_windows: workspace('natural', "a member's provider quota windows"),
  recap_watermarks: workspace('natural', "a reader's recap cursor on a session"),
  repo_draft_seq: workspace(
    'natural',
    'draft counter per repository; repo ids are shared across workspaces',
  ),
  repo_prefixes: workspace(
    'natural',
    'no owner today; UNIQUE(prefix) becomes per workspace, so two workspaces may both use POD',
  ),
  repos: workspace(
    'derived',
    'repositories on workspace machines; repo_id is a hash of the origin URL',
  ),
  root_integration_receipts: workspace('natural', 'shipping proofs of workspace issues'),
  runtime_event_checkpoints: workspace('natural', 'per session'),
  runtime_event_projection_cursors: workspace(
    'natural',
    'projector cursors over the workspace event log',
  ),
  server_secrets: {
    class: 'install',
    origin: 'schema',
    idgen: 'natural',
    reason:
      "install secrets only (INSTALL_SECRET_KEYS: installation key, update signing keys, identity signing secret); a workspace's own secrets moved to workspace_secrets (POD-7013)",
    hard: true,
  },
  session_drafts: workspace('natural', 'per session'),
  session_observation_checkpoints: workspace('natural', 'per session'),
  session_observation_rebinds: workspace('natural', 'per session'),
  session_terminal_candidates: workspace('natural', 'per session'),
  session_user_state: workspace('natural', "a member's state of a session"),
  sessions: workspace('client', 'agent sessions; a client may choose the id'),
  settings_audit_events: workspace('autoinc', 'audit of workspace settings changes'),
  ship_attempts: workspace('random', 'shipping (landing) of workspace issues'),
  ship_effect_envelopes: workspace('natural', 'shipping'),
  ship_evidence: workspace('natural', 'shipping'),
  ship_holds: workspace('random', 'shipping'),
  ship_lane_revisions: workspace('natural', 'shipping'),
  ship_order_stack_edges: workspace('natural', 'shipping'),
  ship_orders: workspace('random', 'shipping; one active order per issue'),
  ship_recovery_revision: workspace('singleton', 'shipping recovery revision, one per workspace'),
  ship_recovery_work: workspace('natural', 'shipping recovery debt'),
  ship_repair_candidates: workspace('natural', 'shipping'),
  ship_steps: workspace('random', 'shipping'),
  ship_train_active_claims: workspace('natural', 'shipping'),
  ship_train_manifests: workspace('random', 'shipping; digests unique per workspace'),
  ship_train_members: workspace('natural', 'shipping'),
  snoozes: workspace('natural', "a member's snoozes"),
  steward_state: workspace(
    'natural',
    'event-once marks, the event cursor and the janitor claim over the workspace event log',
  ),
  subscription_deliveries: workspace(
    'natural',
    'deliveries of workspace events; event_id is an integer surrogate',
  ),
  subscriptions: workspace('random', 'event subscriptions of workspace subscribers'),
  superagent_messages: workspace('autoinc', "a member's assistant thread messages"),
  superagent_pending_turns: workspace('random', "a member's assistant turns"),
  superagent_queued_inputs: workspace('random', "a member's assistant input"),
  superagent_threads: workspace('random', "a member's assistant threads"),
  tab_order: workspace('natural', "a member's tab order"),
  telegram_chat_bindings: workspace(
    'natural',
    'Telegram chats bound to a member; chat ids are Telegram-native',
  ),
  transcript_costs: workspace('derived', 'cost of workspace transcripts'),
  upstream_outbox: workspace(
    'client',
    'mutations a workspace queued upstream; mutation ids come from clients',
  ),
  user_dock_shell: workspace('natural', "a member's dock"),
  user_layout: workspace('natural', "a member's layout"),
  user_preferences: workspace('natural', "a member's preferences"),
  user_read_position: workspace('natural', "a member's read positions"),
  users: workspace(
    'random',
    "the workspace's member rows; email unique per workspace, one member per account per workspace",
  ),
  workflow_bindings: workspace('natural', 'workflow bound to a workspace target'),
  workflow_events: workspace('autoinc', 'workflow event log'),
  workflow_revisions: workspace('random', 'workflow versions'),
  workflow_run_steps: workspace('natural', 'workflow runs'),
  workflow_runs: workspace('random', 'workflow runs; one live run per subject'),
  workflows: workspace('random', 'workflows; names unique per scope per workspace'),

  // ---- identity package: packages/identity/src/schema/sqlite.ts (re-exported by the server schema) ----
  identity_user: identity('random', 'a person, across all workspaces', true),
  identity_account: identity('random', "a person's login method (password, OAuth); account level"),
  identity_session: identity('random', 'a sign-in session; account level'),
  identity_verification: identity('random', 'email verification; account level'),
  identity_one_time_code: identity('random', 'login codes; account level'),
  identity_membership: identity('natural', 'already keyed (workspace_id, member_id)'),
  identity_membership_event: identity('natural', 'already keyed (workspace_id, version)'),
  identity_workspace_revision: identity('natural', 'already keyed by workspace_id'),
  identity_invitation: identity(
    'random',
    'already carries workspace_id; the token hash is globally unique by construction',
  ),

  // ---- sync package: packages/sync/src/adapters/sqlite/schema.ts ----
  changes: workspace(
    'natural',
    'the change log; already keyed (tenant_id, seq); tenant_id is renamed workspace_id',
  ),
  sync_feed: workspace(
    'natural',
    "the workspace's feed head and floor; already keyed by tenant_id; it is also the workspace's provisioning row (contract C4)",
  ),
  sync_kind: workspace('natural', 'kind generations; already keyed (tenant_id, kind)'),
  applied_mutations: workspace(
    'client',
    'the mutation dedupe ledger; mutation ids come from clients, so a global key would let one workspace mark another workspace mutation as applied',
    true,
  ),
  feed_identity: {
    class: 'install',
    origin: 'schema',
    idgen: 'singleton',
    reason:
      'legacy singleton kept for a later contract step (ADR 13); read by nothing current; dropped by the upgrade',
  },
  sync_capture: {
    class: 'transient',
    origin: 'schema',
    idgen: 'random',
    reason:
      'captured keys of the open write transaction, drained before commit; the keys carry workspace_id',
  },
  sync_capture_guard: {
    class: 'transient',
    origin: 'schema',
    idgen: 'singleton',
    reason: 'always empty; the deferred foreign key that refuses a commit with undrained capture',
  },

  // ---- pre-upgrade shapes the boot identity import reads: migrations/identity-import-schema.ts ----
  // LEGACY(remove-after: 2027-06): import sources of the boot identity import; remove with identity-import-schema.ts.
  member_invites: {
    class: 'install',
    origin: 'legacy',
    idgen: 'random',
    reason:
      'pre-upgrade invitations, read once by the boot identity import of the one workspace local; no workspace reads it afterwards',
    mayBeAbsent:
      'dropped by the deferred identity-import-retirement migration once the import has run',
  },
  user_credentials: {
    class: 'install',
    origin: 'legacy',
    idgen: 'natural',
    reason:
      'pre-upgrade password hashes, read once by the boot identity import of the one workspace local; no workspace reads it afterwards',
    mayBeAbsent:
      'dropped by the deferred identity-import-retirement migration once the import has run',
  },

  // ---- created at boot by the store while search is on (store/conversations, PDM-25) ----
  conversations_fts: {
    class: 'derived',
    origin: 'runtime',
    idgen: 'natural',
    fts5: true,
    reason: 'FTS5 over conversations (external content, rowid); scoped by joining conversations',
  },
  transcript_fts: {
    class: 'derived',
    origin: 'runtime',
    idgen: 'natural',
    fts5: true,
    reason: 'FTS5 over transcript items; scoped through transcript_fts_keys',
  },
  transcript_fts_keys: {
    class: 'workspace',
    origin: 'runtime',
    idgen: 'natural',
    reason:
      'segment of each FTS row; carries workspace_id so a search joins it with the workspace predicate',
    workspaceColumnPending:
      'POD-7022 adds workspace_id to its runtime DDL (store/conversations/transcript-index.ts)',
  },

  // ---- engine bookkeeping ----
  __drizzle_migrations: {
    class: 'install',
    origin: 'engine',
    idgen: 'autoinc',
    reason: 'the migration ledger',
  },
  schema_version: {
    class: 'install',
    origin: 'engine',
    idgen: 'singleton',
    reason: "the legacy runner's ledger on pre-drizzle databases",
    mayBeAbsent: 'only a database first created by the pre-drizzle runner has it',
  },
  sqlite_sequence: {
    class: 'transient',
    origin: 'engine',
    idgen: 'natural',
    reason: 'SQLite AUTOINCREMENT state',
  },
  sqlite_stat1: {
    class: 'transient',
    origin: 'engine',
    idgen: 'natural',
    reason: 'planner statistics',
    mayBeAbsent: 'written by the first ANALYZE, which the store runs on the exclusive lane',
  },

  // ---- the workspace halves of meta and server_secrets (POD-7013) ----
  workspace_meta: workspace(
    'natural',
    'the workspace keys of meta (WORKSPACE_META_KEYS): settings, model catalogs, membership version, sign-in carry-over, retired solo member, its own upgrade receipts; keyed (workspace_id, key)',
  ),
  workspace_secrets: workspace(
    'natural',
    "a workspace's own secrets (WORKSPACE_SECRET_KEYS): the settings secrets, the settings fingerprint key, native login transfers; keyed (workspace_id, key)",
  ),
} as const satisfies Record<string, ManifestEntry>

type Manifest = typeof TABLE_MANIFEST

/** Every table name the manifest classifies (SQL names). */
export type TableName = keyof Manifest

type NamesOf<C extends TableClass> = {
  [K in TableName]: Manifest[K]['class'] extends C ? K : never
}[TableName]

/** Tables whose every row belongs to one workspace, planned tables included. */
export type WorkspaceTableName = NamesOf<'workspace'>
/** Tables that are one per database; the only tables a global context may name. */
export type InstallTableName = NamesOf<'install'>

const namesOf = <C extends TableClass>(cls: C): ReadonlySet<NamesOf<C>> =>
  new Set(
    (Object.keys(TABLE_MANIFEST) as TableName[]).filter(
      (name): name is NamesOf<C> => TABLE_MANIFEST[name].class === cls,
    ),
  )

export const WORKSPACE_TABLES: ReadonlySet<WorkspaceTableName> = namesOf('workspace')
export const INSTALL_TABLES: ReadonlySet<InstallTableName> = namesOf('install')

/**
 * The schema export of each install table a current Drizzle schema declares (the legacy
 * import shapes are not part of the binding's tables), so `GlobalTables`
 * (task A1) can be typed as `Pick<Tables, InstallTableExport>`. The manifest test holds this
 * map to the schemas in both directions.
 */
export const INSTALL_TABLE_EXPORTS = {
  meta: 'meta',
  server_secrets: 'serverSecrets',
  maintenance_leases: 'maintenanceLeases',
  feed_identity: 'feedIdentity',
} as const satisfies Partial<Record<InstallTableName, string>>
export type InstallTableExport = (typeof INSTALL_TABLE_EXPORTS)[keyof typeof INSTALL_TABLE_EXPORTS]

/** The suffixes SQLite gives an FTS5 table's shadow tables. */
const FTS5_SHADOW = /^(.+)_(data|idx|content|docsize|config)$/

/**
 * The entry for a table name as it appears in `sqlite_master`. An FTS5 shadow table resolves
 * to its virtual table's entry; anything else must be listed by name.
 */
export function classifyTable(name: string): ManifestEntry | undefined {
  const own = (TABLE_MANIFEST as Record<string, ManifestEntry>)[name]
  if (own !== undefined) return own
  const shadow = FTS5_SHADOW.exec(name)
  if (shadow === null) return undefined
  const parent = (TABLE_MANIFEST as Record<string, ManifestEntry>)[shadow[1] as string]
  return parent?.fts5 ? parent : undefined
}

/**
 * The files that hold global repositories (repositories over install tables only, built with
 * the global context) or a workspace repository that also reaches install keys (the install
 * halves of `meta` and `server_secrets`, POD-7013). They are the only files that may define a
 * query with `preparedGlobal`
 * (the source guard, `workspace-scope-guard.test.ts`, POD-7014). A file a task has not created
 * yet carries that task in `plannedBy`; the guard fails once the file exists and the field is
 * still set.
 */
export const GLOBAL_REPOSITORY_FILES: ReadonlyMap<
  string,
  { readonly reason: string; readonly plannedBy?: string }
> = new Map([
  [
    'apps/server/src/store/database.ts',
    {
      reason:
        "the store database's own statements (POD-7010): each workspace's provisioning insert",
    },
  ],
  [
    'apps/server/src/store/settings.ts',
    {
      reason:
        "a workspace's settings repository; the identity links receipt it records is an install key of meta, read by the migrator (POD-7013)",
    },
  ],
  [
    'apps/server/src/store/issues.ts',
    {
      reason:
        "a workspace's issues repository; the legacy worktree backfill's receipt is an install key of meta (legacy_worktree_machine_ids_v1)",
    },
  ],
  [
    'apps/server/src/store/server-secrets.ts',
    {
      reason:
        "a workspace's secrets repository; the installation key and the identity signing secret it serves are the install's, in server_secrets and meta (POD-7013)",
    },
  ],
])

// ---------------------------------------------------------------------------
// The keys of meta and server_secrets (POD-6959 design 2.1, POD-7013)
// ---------------------------------------------------------------------------

/**
 * One key of a key/value table: by its exact name, or every key that starts with a prefix
 * (a key family such as `model_catalog:<machine>`).
 */
export type KeyPattern = { readonly key: string } | { readonly prefix: string }

/** Whether `key` is one of `patterns`. */
export function keyIn(patterns: readonly KeyPattern[], key: string): boolean {
  return patterns.some((p) => ('key' in p ? p.key === key : key.startsWith(p.prefix)))
}

/**
 * THE INSTALL KEYS OF `meta`: what the installation is, its schema and upgrade marks, the
 * fleet-wide update state. One per database; read and written through global definitions or by
 * the migrator and the boot imports. `store/workspace-manifest.test.ts` holds a migrated and
 * booted database's `meta` to this list.
 */
export const INSTALL_META_KEYS: readonly KeyPattern[] = [
  // The legacy runner's version row, on a database the pre-drizzle runner created.
  { key: 'schema_version' },
  // The installation identity's public half (installation-identity.ts).
  { key: 'installation_identity' },
  // Fleet update execution and the fleet channel (recovery-store.ts, machine-record-context.ts).
  { key: 'updates.execution.v1' },
  { key: 'machines.fleet-channel.v1' },
  // Read by the migrator before any repository exists (migrations/index.ts).
  { key: 'identity.legacyLinksImported' },
  // The one-time boot imports and upgrade marks.
  { key: 'repo-identity-upgrade' },
  { key: 'installation_identity_import_v1' },
  { key: 'settings_config_import_v1' },
  { key: 'secret_fingerprint_import_v1' },
  { key: 'update_signing_key_imported_v1' },
  { key: 'enrollment_ledger_imported' },
  { key: 'legacy_worktree_machine_ids_v1' },
]

/**
 * THE WORKSPACE KEYS OF `meta`, now in `workspace_meta`. The migration
 * `20261117060140_workspace-meta-split` moved exactly these to the workspace `local`; its SQL
 * spells the same list, and `migrations/workspace-meta-split.test.ts` ties the two together.
 */
export const WORKSPACE_META_KEYS: readonly KeyPattern[] = [
  // The instance-preferences blob (settings.ts).
  { key: 'settings' },
  // The live model catalog per machine, and the unkeyed shape before the split.
  { key: 'model_catalog' },
  { prefix: 'model_catalog:' },
  // The hosted membership cursor (identity/server-identity.ts).
  { key: 'identity.appliedMembershipVersion' },
  // The end of the sign-in carry-over period (sign-in-carry-over.ts).
  { key: 'signInCarryOver.endsAt' },
  // The member the solo era's rows were given, and the receipt cutoff that goes with it.
  { key: 'retired_solo_member_id' },
  { key: 'legacy_mutation_receipt_cutoff' },
  // Setup enrollment receipts, committed with the workspace's machine row.
  { prefix: 'setup_enrollment:' },
  // Receipts of data migrations over the workspace's own rows.
  { prefix: 'data_migration:' },
  // The retired hub replica blobs (POD-309): inert, but the workspace's data.
  { key: 'upstream_sync_cursor' },
  { key: 'upstream_sessions' },
  { key: 'upstream_conversations' },
  { key: 'upstream_issues' },
]

/** THE INSTALL SECRETS of `server_secrets`; held to a migrated and booted database as `meta`. */
export const INSTALL_SECRET_KEYS: readonly KeyPattern[] = [
  { key: 'installation.privateKey' },
  { key: 'updates.signingKey' },
  { key: 'updates.signingKeyAnchor' },
  { key: 'identity.signingSecret' },
]

/** THE WORKSPACE SECRETS, now in `workspace_secrets`; moved as {@link WORKSPACE_META_KEYS}. */
export const WORKSPACE_SECRET_KEYS: readonly KeyPattern[] = [
  // The settings secrets: the whole SERVER_SECRET_KEYS vocabulary.
  { key: 'apiKeys.openrouter' },
  { key: 'apiKeys.anthropic' },
  { key: 'apiKeys.openai' },
  { key: 'integrations.linearApiKey' },
  { key: 'notifications.telegramBotToken' },
  // The MAC key of secret fingerprints (fingerprint-key-import.ts).
  { key: 'settings.fingerprintKey' },
  // A member's native login snapshot while it moves to a machine.
  { prefix: 'native-login-transfer:' },
]
