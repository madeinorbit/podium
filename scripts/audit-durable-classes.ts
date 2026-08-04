/**
 * THE MEMBERSHIP GATE FOR ADR 1's OWNERSHIP MATRIX — POD-1211, from POD-385's
 * sweep (`docs/agents/pod-385-matrix-coverage-sweep.md`).
 *
 * Run:
 *   bun run audit:durable-classes          # the gate — exit 1 on any finding
 *   bun run audit:durable-classes --json
 *   bun run audit:durable-classes --probe  # prove every check can say YES
 *
 * The gate also runs as a TEST (`audit-durable-classes.test.ts`) so CI executes
 * it: `bun run test` is what CI runs, and an auditor nobody invokes is an
 * auditor that proves nothing.
 *
 * ---------------------------------------------------------------------------
 * WHY A SEPARATE INSTRUMENT AT ALL
 * ---------------------------------------------------------------------------
 *
 * `visibilityClassOf` is TOTAL and default-closed: an id it has never heard of
 * resolves to `personal`. On the safety axis that is ADR 9 D4 working exactly as
 * designed. As a DETECTOR it fails completely — a class nobody ever classified
 * and a class deliberately classified `personal` return the same value, and both
 * read green. POD-385 proved the hole admits a whole missing CLASS and not just
 * a typo: pspec had no row at all and every gate in the repo was green about it.
 * POD-731 found the same shape one level down (a MISTYPED row id also resolves
 * `personal` and passes).
 *
 * So: **membership on the matrix is a separate obligation from classification,
 * and has to be asserted independently.** That is this file. It never calls
 * `visibilityClassOf`; it asks whether the row EXISTS in the index.
 *
 * ---------------------------------------------------------------------------
 * AND IT IS NOT KEYED ON THE SQLITE SCHEMA
 * ---------------------------------------------------------------------------
 *
 * POD-385's Limit 2 is the load-bearing constraint here, and it is stated as a
 * counterexample against itself: *"pspec is files in a repo working tree and
 * appears in no schema at all, so a membership gate keyed on the schema would
 * have caught all fourteen and still missed the class that started this."*
 *
 * Four checks, three populations, because no single population sees the others:
 *
 *   §1  DRIZZLE TABLES — both schema files, not one. `feed_identity` lives in
 *       the sync adapter's schema and POD-385's own method never saw it.
 *   §2  RUNTIME-CREATED TABLES — `CREATE TABLE` executed at boot, in databases
 *       drizzle does not manage at all (`<stateDir>/discovery.db`, the mobile
 *       replica, the FTS indexes). Invisible to §1 by construction.
 *   §3  DURABLE WRITE SITES — every module that writes to the filesystem or
 *       opens a database. This is the population that contains pspec, the
 *       headless turn spool, the uploads directory and the daemon identity
 *       file, none of which any schema mentions. A module that starts writing
 *       durable state fails this check until somebody classifies what it writes.
 *   §4  MEMBERSHIP — every declared store resolves to a row that EXISTS on the
 *       matrix, or carries a written reason it is not an entity class.
 *
 * §3 is deliberately at FILE granularity rather than path granularity. A path
 * scanner has to understand how each module composes its paths, and it goes
 * quietly blind the moment one of them stops using the shape the scanner knows;
 * "which files write durable state" is a question a regex can answer completely.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OWNERSHIP_MATRIX_INDEX } from '../packages/model/src/annotations/matrix'

export interface Finding {
  /** Which obligation failed — the acceptance criterion, in one token. */
  check: string
  /** The store, file or row the finding is about. */
  where: string
  detail: string
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// The inventory — one entry per durable store, with the row that classifies it
// ---------------------------------------------------------------------------

export type StoreKind =
  /** A table in one of the two drizzle schema files. */
  | 'drizzle-table'
  /** A table created by an executed `CREATE TABLE`, in any database. */
  | 'runtime-table'
  /** Bytes on a filesystem: a file, a directory tree, a non-drizzle database. */
  | 'filesystem'

export interface DurableStore {
  /** The store's name where it lives: a table name, or a path. */
  readonly store: string
  readonly kind: StoreKind
  /**
   * The matrix row id that classifies it. `null` means "durable, and
   * deliberately not an entity class" — which requires {@link notEntityState}.
   */
  readonly row: string | null
  /** Required iff `row` is null, and checked for length: an empty reason is a shrug. */
  readonly notEntityState?: string
  /**
   * Source files that write this store. Every file in the repo that performs a
   * durable write must appear on exactly one entry (§3), which is what makes a
   * NEW store impossible to add silently.
   */
  readonly writeSites?: readonly string[]
}

/**
 * THE DURABLE STORE INVENTORY.
 *
 * Adding a table, a file store or a database means adding an entry here, and an
 * entry cannot be added without naming a matrix row or writing down why the
 * store is not an entity class. That is the whole mechanism.
 */
export const DURABLE_STORES: readonly DurableStore[] = [
  // -- §2 Sessions -----------------------------------------------------------
  { store: 'sessions', kind: 'drizzle-table', row: 'session-identity' },
  { store: 'session_drafts', kind: 'drizzle-table', row: 'composer-draft' },
  { store: 'snoozes', kind: 'drizzle-table', row: 'snooze' },
  { store: 'session_user_state', kind: 'drizzle-table', row: 'session-read-at' },
  { store: 'queued_messages', kind: 'drizzle-table', row: 'queued-agent-messages' },
  { store: 'offers', kind: 'drizzle-table', row: 'agent-offers' },
  {
    store: 'session_observation_checkpoints',
    kind: 'drizzle-table',
    row: 'session-observation-bookkeeping',
  },
  {
    store: 'session_observation_rebinds',
    kind: 'drizzle-table',
    row: 'session-observation-bookkeeping',
  },
  {
    store: 'session_terminal_candidates',
    kind: 'drizzle-table',
    row: 'session-observation-bookkeeping',
  },
  {
    store: '<stateDir>/uploads',
    kind: 'filesystem',
    row: 'session-uploads',
    writeSites: ['apps/daemon/src/control/files.ts', 'apps/daemon/src/file-access.ts'],
  },
  {
    store: '<stateDir>/headless-turns',
    kind: 'filesystem',
    row: 'headless-turn-spool',
    writeSites: ['apps/daemon/src/durable-headless.ts'],
  },
  {
    store: '<stateDir>/session-bindings',
    kind: 'filesystem',
    row: 'session-binding',
    writeSites: ['apps/daemon/src/binding-store.ts'],
  },

  // -- §3 Issues & tracker ---------------------------------------------------
  { store: 'issues', kind: 'drizzle-table', row: 'issue-core' },
  { store: 'issue_deps', kind: 'drizzle-table', row: 'issue-graph' },
  { store: 'issue_labels', kind: 'drizzle-table', row: 'issue-core' },
  { store: 'issue_comments', kind: 'drizzle-table', row: 'issue-comments' },
  { store: 'issue_messages', kind: 'drizzle-table', row: 'issue-messages' },
  { store: 'issue_user_state', kind: 'drizzle-table', row: 'issue-message-read-at' },
  { store: 'issue_message_user_state', kind: 'drizzle-table', row: 'issue-message-read-at' },
  { store: 'podium_events', kind: 'drizzle-table', row: 'activity-events' },
  { store: 'subscriptions', kind: 'drizzle-table', row: 'event-subscriptions' },
  { store: 'subscription_deliveries', kind: 'drizzle-table', row: 'subscription-deliveries' },
  {
    store: '<stateDir>/artifacts',
    kind: 'filesystem',
    row: 'artifacts',
    writeSites: ['apps/server/src/modules/issues/artifact-store.ts'],
  },

  // -- §4 Conversations & transcripts ---------------------------------------
  { store: 'conversations', kind: 'drizzle-table', row: 'conversation-registry' },
  { store: 'conversation_identities', kind: 'drizzle-table', row: 'conversation-registry' },
  { store: 'conversation_segments', kind: 'drizzle-table', row: 'segments' },
  {
    store: 'conversations_fts',
    kind: 'runtime-table',
    row: null,
    notEntityState:
      'An FTS5 index over the `conversations` row, created per boot and rebuilt from it. It is a derived read structure, not durable truth: dropping it costs a reindex and loses nothing that is not in the table it indexes.',
    writeSites: [],
  },
  {
    store: 'transcript_fts',
    kind: 'runtime-table',
    row: null,
    notEntityState:
      'An FTS5 index over mirrored transcript text, created per boot from the segments and the lake. Derived read structure, rebuilt from its sources; the classified state is `conversation_segments` and the blobs it points at.',
    writeSites: [],
  },
  {
    store: '<stateDir>/transcripts',
    kind: 'filesystem',
    row: 'blobs',
    writeSites: ['packages/sync/src/mirror.ts'],
  },

  // -- §5 Repos, pins, tabs --------------------------------------------------
  { store: 'repos', kind: 'drizzle-table', row: 'repo-prefix' },
  { store: 'repo_prefixes', kind: 'drizzle-table', row: 'repo-prefix' },
  { store: 'pins', kind: 'drizzle-table', row: 'pins' },
  { store: 'tab_order', kind: 'drizzle-table', row: 'tab-order' },
  // POD-1350. Sidebar/tab layout shell chrome — per-user-state, never grantable.
  // Deliberately NOT `personal` (grantable) and NOT `secret` (must replicate to
  // the owner's own devices). Key routing shared with POD-403.
  { store: 'user_layout', kind: 'drizzle-table', row: 'sidebar-tab-layout' },
  // POD-1380. Event-stream read positions — per-user-state for the same reason
  // as the layout row, and monotonic rather than last-writer-wins.
  { store: 'user_read_position', kind: 'drizzle-table', row: 'feed-read-cursor' },
  {
    store: '<repo>/pspec/SP-xxxx.html',
    kind: 'filesystem',
    row: 'pspec-component',
    writeSites: ['apps/server/src/pspec.ts'],
  },
  {
    store: '<stateDir>/discovery.db',
    kind: 'filesystem',
    row: 'harness-discovery-cache',
    writeSites: ['packages/harness/src/discovery/cache.ts'],
  },
  { store: 'conversation_cache', kind: 'runtime-table', row: 'harness-discovery-cache' },
  {
    store: 'meta',
    kind: 'runtime-table',
    row: 'harness-discovery-cache',
  },
  {
    store: '<stateDir>/hooks',
    kind: 'filesystem',
    row: 'harness-hook-settings',
    writeSites: [
      'apps/daemon/src/codex-hooks.ts',
      'apps/daemon/src/grok-hooks.ts',
      'apps/daemon/src/hook-ingest.ts',
      'apps/daemon/src/codex-identity-receipts.ts',
    ],
  },

  // -- §6 Settings, secrets, accounts ---------------------------------------
  { store: 'server_secrets', kind: 'drizzle-table', row: 'server-owned-secrets' },
  { store: 'settings_audit_events', kind: 'drizzle-table', row: 'settings-audit-trail' },
  // POD-1213. The row is `preferences-personal-keys` — an EXISTING row, already
  // `per-user-state`, whose values these rows now hold. It is deliberately NOT
  // `settings-audit-trail`'s answer (`secret`) and deliberately NOT `personal`:
  // see docs/agents/pod-1213-preference-class-membership.md, which argues both
  // directions rather than inheriting either.
  { store: 'user_preferences', kind: 'drizzle-table', row: 'preferences-personal-keys' },
  { store: 'accounts', kind: 'drizzle-table', row: 'managed-credentials' },
  { store: 'execution_profiles', kind: 'drizzle-table', row: 'workflow-execution-profiles' },
  {
    store: '<stateDir>/config.json',
    kind: 'filesystem',
    row: 'preferences-instance-keys',
    writeSites: ['packages/runtime/src/config.ts'],
  },
  {
    store: '<stateDir>/auth (instance password hash)',
    kind: 'filesystem',
    row: 'account-credential',
    writeSites: [
      'packages/runtime/src/auth-store.ts',
      'apps/server/src/modules/settings/secret-fingerprint.ts',
      'apps/daemon/src/control/credentials.ts',
    ],
  },

  // -- §7 Coordination -------------------------------------------------------
  { store: 'locks', kind: 'drizzle-table', row: 'advisory-locks' },
  { store: 'lock_waiters', kind: 'drizzle-table', row: 'advisory-locks' },
  { store: 'approval_requests', kind: 'drizzle-table', row: 'approval-requests' },
  { store: 'automations', kind: 'drizzle-table', row: 'automations-and-runs' },
  { store: 'automation_runs', kind: 'drizzle-table', row: 'automations-and-runs' },
  { store: 'maintenance_leases', kind: 'drizzle-table', row: 'maintenance-lease' },
  { store: 'maintenance_commands', kind: 'drizzle-table', row: 'maintenance-command-receipts' },
  { store: 'steward_state', kind: 'drizzle-table', row: 'steward-state' },
  { store: 'notification_facts', kind: 'drizzle-table', row: 'notification-facts' },
  { store: 'message_wake_cooldowns', kind: 'drizzle-table', row: 'message-wake-cooldowns' },
  { store: 'repo_draft_seq', kind: 'drizzle-table', row: 'id-allocation-counters' },
  { store: 'issue_ref_letters', kind: 'drizzle-table', row: 'id-allocation-counters' },
  { store: 'workflows', kind: 'drizzle-table', row: 'workflow-definitions' },
  { store: 'workflow_revisions', kind: 'drizzle-table', row: 'workflow-revisions' },
  { store: 'workflow_bindings', kind: 'drizzle-table', row: 'workflow-bindings' },
  { store: 'workflow_runs', kind: 'drizzle-table', row: 'workflow-runs' },
  { store: 'workflow_run_steps', kind: 'drizzle-table', row: 'workflow-runs' },
  { store: 'workflow_events', kind: 'drizzle-table', row: 'workflow-runs' },

  // -- §8 Messaging & superagent --------------------------------------------
  { store: 'messages', kind: 'drizzle-table', row: 'messages-substrate' },
  {
    store: 'message_reads',
    kind: 'drizzle-table',
    row: null,
    notEntityState:
      'PER-READER delivery bookkeeping (POD-1379, [spec:SP-b11e]): one `(message_id, session_id)` row saying that this SESSION has been shown that message, so the mailbox nag stops counting it. Deliberately not the `issue-message-read-at` class, which is a PERSON’s read marker keyed `(user_id, issue_message_id)` — the key here is a session, and a session is not a user: several agent sessions read one issue mailbox and each must be nagged independently, which is the bug that made this table exist (consuming `messages.status`, the ledger SHARED by every session on the issue, destroyed the unread state for all of them). It has no owner, no wire projection and no reader outside the counting predicate; it is the per-reader half of the `messages` delivery ledger, and it dies with the session whose id keys it.',
  },
  { store: 'messaging_issue_topics', kind: 'drizzle-table', row: 'messaging-issue-topics' },
  { store: 'superagent_threads', kind: 'drizzle-table', row: 'superagent-state' },
  { store: 'superagent_messages', kind: 'drizzle-table', row: 'superagent-state' },
  { store: 'superagent_queued_inputs', kind: 'drizzle-table', row: 'superagent-state' },
  { store: 'superagent_pending_turns', kind: 'drizzle-table', row: 'superagent-state' },
  { store: 'recap_watermarks', kind: 'drizzle-table', row: 'recap-watermark' },

  // -- §9 Handoff ------------------------------------------------------------
  {
    store: '<stateDir>/handoff',
    kind: 'filesystem',
    row: 'handoff-bundle',
    writeSites: [
      'apps/server/src/modules/sessions/handoff-transfer.ts',
      'apps/daemon/src/handoff-package.ts',
      'apps/daemon/src/workspace-package.ts',
    ],
  },

  // -- §10 Sync infrastructure ----------------------------------------------
  { store: 'changes', kind: 'drizzle-table', row: 'change-log' },
  { store: 'applied_mutations', kind: 'drizzle-table', row: 'applied-mutations' },
  { store: 'feed_identity', kind: 'drizzle-table', row: 'feed-identity' },
  {
    store: 'upstream_outbox',
    kind: 'drizzle-table',
    row: null,
    notEntityState:
      'The retired legacy hub forwarder path (POD-309). ADR 1 Amendment 1 §3 §10 marks every one of its cells `n/a`, and it is already in the matrix data’s own DECLARED_OMISSIONS with that reason; annotating a row that is being deleted would create the appearance of a supported class.',
  },
  {
    store: 'meta',
    kind: 'drizzle-table',
    row: null,
    notEntityState:
      'Schema metadata — the migration ledger’s key/value row, not an entity class. It describes the database rather than anything in the product, and has no owner, no reader and no wire projection.',
  },
  // The client-local replica. Both rows exist; these are the tables they name.
  { store: 'entities', kind: 'runtime-table', row: 'replica-cursor' },
  { store: 'outbox', kind: 'runtime-table', row: 'client-outbox' },
  { store: 'schema_version', kind: 'runtime-table', row: 'replica-cursor' },

  // -- §1 Identity & deployment scope ---------------------------------------
  { store: 'machines', kind: 'drizzle-table', row: 'machine' },
  {
    store: 'client_sessions',
    kind: 'drizzle-table',
    row: 'per-user-client-session',
    // The mint INSERTs the row, `listSessions`/`revoke` read and delete it. It
    // became a declared write site at the POD-1439 reconciliation, when the mint
    // started writing `user_id` (POD-1079, NOT NULL with no default). Whether
    // filesystem access SHOULD be a sufficient root for that write is the open
    // security question in POD-1604 (the POD-1402 tripwire) and is not settled
    // here; this entry records only that this module is the writer, which is
    // true under either answer.
    writeSites: ['packages/runtime/src/session-mint.ts'],
  },
  {
    store: '<stateDir>/cli-session.json',
    kind: 'filesystem',
    row: null,
    notEntityState:
      'The CLI’s local cache of ONE minted credential, written owner-readable (0600) so a later `podium` invocation can present it. Not an entity class: the durable truth is the `client_sessions` row above, this file is a copy of the plaintext token that row only stores hashed. Deleting it costs a re-mint and loses nothing else, every read treats missing/malformed/expired alike as "no credential", and `PODIUM_SESSION_TOKEN` overrides it entirely.',
    writeSites: ['packages/runtime/src/session-mint.ts'],
  },
  { store: 'users', kind: 'drizzle-table', row: 'user-account' },
  { store: 'user_credentials', kind: 'drizzle-table', row: 'account-credential' },
  { store: 'grants', kind: 'drizzle-table', row: 'grant-edge' },
  { store: 'telegram_chat_bindings', kind: 'drizzle-table', row: 'telegram-chat-binding' },
  {
    store: '<stateDir>/daemon.json',
    kind: 'filesystem',
    row: 'daemon-identity-file',
    writeSites: ['apps/daemon/src/identity.ts'],
  },
  {
    store: '<stateDir>/pending-update.json',
    kind: 'filesystem',
    row: null,
    notEntityState:
      'Daemon-local convergence recovery marker. It records one server grant and its bounded retry count so boot can confirm, retry, or stop after a failed restart; it is not an owned product entity, is never replicated, and deleting it only discards recovery context.',
    writeSites: ['apps/daemon/src/host-runtime.ts', 'apps/daemon/src/pending-grant.ts'],
  },
  {
    store: '<stateDir>/daemon.secret',
    kind: 'filesystem',
    row: 'pairing-token',
    writeSites: ['packages/runtime/src/local-machine.ts'],
  },
  {
    store: '<stateDir>/enrollment.ledger',
    kind: 'filesystem',
    row: 'enrollment-ledger',
    writeSites: ['apps/server/src/enrollment-ledger.ts'],
  },
  {
    store: '<stateDir>/instance.json',
    kind: 'filesystem',
    row: 'instance-id',
    writeSites: ['packages/runtime/src/instance.ts'],
  },
  {
    store: '<stateDir>/podium.db',
    kind: 'filesystem',
    row: null,
    notEntityState:
      'The database FILE itself, which is the container for the drizzle tables above rather than a class of its own. Classifying the container as well as its contents would give two answers to every question about one row; the contents are what this inventory enumerates.',
    writeSites: ['apps/server/src/store.ts', 'apps/server/src/migrations/index.ts'],
  },
]

/**
 * Files that perform a durable write but store NO durable class of their own —
 * process supervision, caches rebuilt from source, build tooling, and the
 * generic storage primitives the classified stores are built out of.
 *
 * Every entry carries a reason, and the reason is checked for length, because
 * this list is the one place a real store could be hidden by a shrug.
 */
export const NON_CLASS_WRITE_SITES: readonly { readonly file: string; readonly reason: string }[] =
  [
    {
      file: 'packages/runtime/src/run-registry.ts',
      reason:
        'Pidfiles under `<stateDir>/run` and the detached-component logs under `<stateDir>/logs`. Process supervision: a pidfile describes a RUNNING PROCESS, is meaningless after a reboot, and names nothing anybody owns.',
    },
    {
      file: 'packages/runtime/src/connectivity.ts',
      reason:
        '`<stateDir>/connectivity.json` is a cache of the last reachability probe, rewritten on every check and correct only for an instant. Deleting it changes nothing except that the next probe has no prior to compare against.',
    },
    {
      file: 'packages/runtime/src/sqlite/index.ts',
      reason:
        'The SQLite driver seam itself — it opens whatever database it is handed. The classes live in the tables, and the callers that own those tables are the entries above.',
    },
    {
      file: 'apps/janitor/src/janitor.ts',
      reason:
        'Opens the server database READ-ONLY to observe expiry, and writes through the maintenance lease/command rows, which are classified. It introduces no store of its own.',
    },
    {
      file: 'packages/pty/src/abduco-bin.ts',
      reason:
        'Materializes the embedded `abduco` BINARY under `<stateDir>/bin` so a PTY can be attached. An executable extracted from the shipped bundle is not state: it is byte-identical for every install and is re-extracted if deleted.',
    },
    {
      file: 'apps/daemon/src/pending-grant.ts',
      reason:
        '`pending-update.json` records that a convergence is IN FLIGHT — which target, which version to roll back to, how many attempts — and exists only to survive the daemon restart that sits in the middle of a swap (POD-1670). It is written immediately before the restart and cleared the moment the boot health gate resolves, so it describes an operation rather than anything anybody owns. A corrupt or absent marker is read as absent BY DESIGN, because a daemon that crashed mid-write must still boot; forgetting an in-flight convergence is recoverable by the next grant, an unbootable daemon is not.',
    },
    {
      file: 'apps/server/src/migrations/restore.ts',
      reason:
        'Restores a backup by COPYING database files — the backup over the live database, and the replaced database to a timestamped sibling. A copy of a classified store is that store, not a new one, and the only row it writes is the re-minted `feed_identity` (classified above, ADR 2 D1). Deliberately creates no schema: the doc comment on `remintRestoredEpoch` records why `CREATE TABLE IF NOT EXISTS` here would leave the restored server unable to boot.',
    },
    {
      file: 'packages/telemetry/src/queue.ts',
      reason:
        'The opt-in telemetry spool, whose contents are events already leaving the instance under the telemetry consent gate rather than durable product state. It is drained and truncated, and an empty queue is indistinguishable from a fresh one.',
    },
    {
      file: 'apps/cli/src/cli-spawn.ts',
      reason:
        'Writes the spawn wrapper scripts and log redirection a detached component needs at launch. Process plumbing, regenerated on every spawn.',
    },
    {
      file: 'apps/cli/src/cli-systemd.ts',
      reason:
        'Renders systemd unit files into the user unit directory. Deployment configuration OUTSIDE the state dir, owned by the host’s init system and reproducible from `scripts/render-systemd.ts`.',
    },
    {
      file: 'apps/cli/src/podium-update.ts',
      reason:
        'Stages downloaded release binaries and a VERSION marker during self-update. Installation artefacts, replaced wholesale by the next update.',
    },
    {
      file: 'apps/daemon/src/update-install.ts',
      reason:
        'Stages downloaded grant artifacts beside the installed daemon and swaps the release tree. These installation bytes are replaced wholesale by the next update and are not Podium product state or an entity class.',
    },
    {
      file: 'apps/daemon/src/control/exec.ts',
      reason:
        'Runs an operator-requested command in a workspace; any bytes it writes are the COMMAND’s, in the user’s own repo, and are governed by that repo rather than by this matrix.',
    },
    {
      file: 'apps/daemon/src/control/session.ts',
      reason:
        'Prepares the working directory and scratch files a session needs at spawn. The durable session state is the `sessions` row and the spool, both classified above.',
    },
    {
      file: 'apps/server/src/modules/files/registry.ts',
      reason:
        'Serves and stages files the operator explicitly points at inside their own repos. The bytes are the repo’s, not the instance’s; what Podium stores about them is the artifact row.',
    },
    {
      file: 'apps/server/src/modules/machines/rpc.ts',
      reason:
        'Relays file operations to a daemon on behalf of a caller. A transport, not a store: every byte it moves lands in a store that is classified at its destination.',
    },
    {
      file: 'apps/desktop/scripts/stage-sidecar.ts',
      reason:
        'BUILD tooling — stages the sidecar binary into the Tauri bundle. Runs at package time, never at runtime, and writes into the build output.',
    },
    {
      file: 'apps/mobile/scripts/patch-web-html.ts',
      reason:
        'BUILD tooling — patches the built web index.html for the mobile shell. Runs at package time and writes into the build output.',
    },
    {
      file: 'apps/web/scripts/generate-login-ascii.ts',
      reason:
        'BUILD tooling — generates a static ASCII asset checked into the web app. Runs by hand, writes source, and stores nothing at runtime.',
    },
    {
      file: 'packages/harness/src/discovery/providers/codex-state.ts',
      reason:
        'Opens a THIRD-PARTY harness database read-only to discover its sessions. Another product’s store, on the user’s own disk; Podium classifies what it derives from it (the discovery cache and the conversation registry), not the foreign file.',
    },
    {
      file: 'packages/harness/src/opencode/db.ts',
      reason:
        'Opens the opencode harness’s own database read-only for discovery. A third-party store, for the same reason as the codex one.',
    },
    {
      file: 'packages/sync/src/adapters/indexeddb/store.ts',
      reason:
        'The browser replica’s IndexedDB adapter. Its object stores hold the same replica cache and outbox the mobile SQLite adapter holds, and those two classes (`replica-cursor`, `client-outbox`) are already declared.',
    },
    {
      file: 'packages/sync/src/adapters/mobile-sqlite/store.ts',
      reason:
        'The mobile replica adapter’s open/read/write seam. The tables it creates are enumerated as runtime-table entries above.',
    },
  ]

// ---------------------------------------------------------------------------
// The scanners — pure functions over source text, so `--probe` can plant fixtures
// ---------------------------------------------------------------------------

/** Table names declared with drizzle's `sqliteTable('name', …)`. */
export function drizzleTables(source: string): string[] {
  return [...source.matchAll(/sqliteTable\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1] as string)
}

/**
 * Strip `//` and block comments before scanning for EXECUTED SQL.
 *
 * POD-1246: `restore.ts` explains at length why `CREATE TABLE IF NOT EXISTS
 * feed_identity` is the WRONG fix and does not do it — and the scanner read that
 * prose as a create site, demanding a declaration for a table the file never
 * creates. A detector that cannot tell code from a comment about code turns
 * "document the rejected alternative" into a lint failure, which teaches people
 * to stop writing the explanation.
 *
 * Comments cannot create tables, so nothing real is lost. String literals are
 * left alone: `db.exec('CREATE TABLE …')` is exactly what this must still see.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * Table names in an executed `CREATE TABLE` / `CREATE VIRTUAL TABLE`, including
 * the `${CONST}` form — the mobile replica names all four of its tables that
 * way, and a scanner that only understood literals would report a clean file.
 */
export function runtimeTables(source: string): string[] {
  const code = stripComments(source)
  const consts = new Map<string, string>()
  for (const m of code.matchAll(/(?:export\s+)?const\s+(\w+)\s*=\s*['"]([^'"]+)['"]/g)) {
    consts.set(m[1] as string, m[2] as string)
  }
  const names: string[] = []
  for (const m of code.matchAll(
    /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\b\s*)?(\$\{(\w+)\}|[`"']?(?!IF\b)(\w+)[`"']?)/gi,
  )) {
    const viaConst = m[2] ? consts.get(m[2]) : undefined
    const name = viaConst ?? m[3]
    if (name) names.push(name)
  }
  return names
}

/** Does this file perform a durable write — filesystem or database open? */
export function isDurableWriteSite(source: string): boolean {
  return /\b(writeFileSync|appendFileSync|mkdirSync|writeFile\(|appendFile\(|mkdir\(|openDatabase\(|new Database\()/.test(
    source,
  )
}

const SCANNED_ROOTS = ['apps', 'packages', 'services'] as const
const SCHEMA_FILES = [
  'apps/server/src/migrations/schema.ts',
  'packages/sync/src/adapters/sqlite/schema.ts',
] as const

/** Source files the gate reads: non-test TypeScript under the scanned roots. */
export function sourceFiles(root = ROOT): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue
      const rel = relative(root, full)
      if (/\.test\.|\.spec\.|(^|\/)(test|tests|__tests__|fixtures)\//.test(rel)) continue
      // `*-spec.ts` are runner-neutral CONFORMANCE SPECS imported only by tests
      // (`packages/runtime/src/sqlite/*-spec.ts`), which open scratch databases
      // under the OS temp dir. They are test support that happens not to be
      // named `.test.ts`; §3's own excuse list would be the wrong home, because
      // nothing in the product runs them.
      if (/test-support|test-hermetic|\.bench\.|-spec\.ts$/.test(rel)) continue
      out.push(rel)
    }
  }
  for (const r of SCANNED_ROOTS) walk(join(root, r))
  return out.sort()
}

// ---------------------------------------------------------------------------
// §1 — every drizzle table is declared, and every declared one still exists
// ---------------------------------------------------------------------------

export function checkDrizzleTables(
  schemas: readonly { readonly file: string; readonly source: string }[],
  inventory: readonly DurableStore[] = DURABLE_STORES,
): Finding[] {
  const findings: Finding[] = []
  const declared = new Set(inventory.filter((s) => s.kind === 'drizzle-table').map((s) => s.store))
  const live = new Set<string>()
  for (const { file, source } of schemas) {
    for (const table of drizzleTables(source)) {
      live.add(table)
      if (!declared.has(table)) {
        findings.push({
          check: 'drizzle-table-undeclared',
          where: `${file} → ${table}`,
          detail:
            'A durable table with no entry in DURABLE_STORES. Add one naming the matrix row that classifies it, or a written reason it is not an entity class.',
        })
      }
    }
  }
  for (const table of declared) {
    if (!live.has(table)) {
      findings.push({
        check: 'drizzle-table-stale',
        where: table,
        detail:
          'DURABLE_STORES declares a drizzle table that no schema file declares any more. A stale entry keeps a classification alive for a store that is gone, and hides the next one that goes missing.',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// §2 — tables created at runtime, in databases drizzle never sees
// ---------------------------------------------------------------------------

/**
 * The MIGRATION LEDGER carries every historical `CREATE TABLE` as embedded SQL
 * text, so scanning it would re-report all 65 drizzle tables as if they were
 * runtime-created — and worse, would report tables that were dropped ten
 * migrations ago. It is excluded by path, and safely: those statements are
 * generated FROM the drizzle schemas that §1 already enumerates, so nothing can
 * enter the database through the ledger without first entering a schema file.
 */
const MIGRATION_LEDGER = /^apps\/server\/src\/migrations\/(drizzle|.*\.generated\.ts)/

export function checkRuntimeTables(
  files: readonly { readonly file: string; readonly source: string }[],
  inventory: readonly DurableStore[] = DURABLE_STORES,
): Finding[] {
  const declared = new Set(inventory.filter((s) => s.kind === 'runtime-table').map((s) => s.store))
  const findings: Finding[] = []
  for (const { file, source } of files) {
    if (MIGRATION_LEDGER.test(file)) continue
    for (const table of runtimeTables(source)) {
      if (!declared.has(table)) {
        findings.push({
          check: 'runtime-table-undeclared',
          where: `${file} → ${table}`,
          detail:
            'A table created by executed SQL, which no drizzle schema mentions and no schema-keyed gate can see. Declare it in DURABLE_STORES.',
        })
      }
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// §3 — every module that writes durable bytes is accounted for
// ---------------------------------------------------------------------------

export function checkWriteSites(
  files: readonly { readonly file: string; readonly source: string }[],
  inventory: readonly DurableStore[] = DURABLE_STORES,
  nonClass: readonly { readonly file: string; readonly reason: string }[] = NON_CLASS_WRITE_SITES,
): Finding[] {
  const accounted = new Set<string>()
  for (const store of inventory) for (const site of store.writeSites ?? []) accounted.add(site)
  const excused = new Map(nonClass.map((n) => [n.file, n.reason]))
  const findings: Finding[] = []
  for (const { file, source } of files) {
    if (SCHEMA_FILES.includes(file as (typeof SCHEMA_FILES)[number])) continue
    if (!isDurableWriteSite(source)) continue
    if (accounted.has(file)) continue
    const reason = excused.get(file)
    if (reason === undefined) {
      findings.push({
        check: 'write-site-unaccounted',
        where: file,
        detail:
          'This module writes durable bytes (filesystem or database) and appears on no DURABLE_STORES entry and in no NON_CLASS_WRITE_SITES entry. THIS is the check that would have caught pspec: a class can exist entirely outside every schema, but it cannot exist without a module that writes it.',
      })
      continue
    }
    if (reason.length < 60) {
      findings.push({
        check: 'write-site-excuse-too-thin',
        where: file,
        detail:
          'Excused from classification with a reason too short to be one. An unexplained excuse is where a real store hides.',
      })
    }
  }
  for (const [file] of excused) {
    if (!files.some((f) => f.file === file)) {
      findings.push({
        check: 'write-site-excuse-stale',
        where: file,
        detail:
          'NON_CLASS_WRITE_SITES excuses a file that no longer exists in the scanned source. Stale excuses accumulate until the list stops describing the repo.',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// §4 — MEMBERSHIP: the row must EXIST, not merely resolve
// ---------------------------------------------------------------------------

export function checkMatrixMembership(
  inventory: readonly DurableStore[] = DURABLE_STORES,
  index: ReadonlyMap<string, unknown> = OWNERSHIP_MATRIX_INDEX,
): Finding[] {
  const findings: Finding[] = []
  const seen = new Set<string>()
  for (const store of inventory) {
    const key = `${store.kind}:${store.store}`
    if (seen.has(key)) {
      findings.push({
        check: 'store-declared-twice',
        where: key,
        detail: 'Two entries for one store. Whichever is read second silently wins.',
      })
    }
    seen.add(key)

    if (store.row !== null && store.notEntityState !== undefined) {
      findings.push({
        check: 'store-classified-and-excused',
        where: key,
        detail: 'An entry claims both a matrix row and a reason it is not an entity class.',
      })
    }
    if (store.row === null) {
      if ((store.notEntityState ?? '').length < 60) {
        findings.push({
          check: 'store-unclassified-without-reason',
          where: key,
          detail:
            'A durable store with no matrix row and no written reason. This is the exact state POD-385 found fourteen times, and it reads green everywhere else because `visibilityClassOf` answers `personal` for a class it has never heard of.',
        })
      }
      continue
    }
    // The membership assertion itself. NOT `visibilityClassOf`, which is total
    // and would answer `personal` for a row id that does not exist — the POD-731
    // typo and the POD-385 missing class are the same failure through that lens.
    if (!index.has(store.row)) {
      findings.push({
        check: 'store-names-a-row-that-does-not-exist',
        where: `${key} → ${store.row}`,
        detail:
          'The named matrix row is absent from OWNERSHIP_MATRIX_INDEX. A misspelled row id resolves `personal` through `visibilityClassOf` and passes every classification test there is; only a membership check can see it.',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// Running it against the repo
// ---------------------------------------------------------------------------

export function readSources(files: readonly string[], root = ROOT) {
  return files.map((file) => ({ file, source: readFileSync(join(root, file), 'utf8') }))
}

export function auditRepo(root = ROOT): Finding[] {
  const files = readSources(sourceFiles(root), root)
  const schemas = readSources(SCHEMA_FILES, root)
  return [
    ...checkDrizzleTables(schemas),
    ...checkRuntimeTables(files),
    ...checkWriteSites(files),
    ...checkMatrixMembership(),
  ]
}

// ---------------------------------------------------------------------------
// The probe — every check must be able to say YES, and to stay quiet when clean
// ---------------------------------------------------------------------------

const ROW_THAT_EXISTS = 'advisory-locks'

/**
 * Planted fixtures, one per check, plus the clean counterfactual for each. A
 * check that fires on everything is as useless as one that fires on nothing, so
 * both halves are asserted.
 */
export function probe(): Finding[] {
  const fail: Finding[] = []
  const expect = (name: string, dirty: Finding[], clean: Finding[]): void => {
    if (dirty.length === 0) {
      fail.push({ check: name, where: '<probe>', detail: 'planted violation NOT detected' })
    }
    if (clean.length > 0) {
      fail.push({
        check: name,
        where: '<probe>',
        detail: `fired on the clean fixture: ${clean.map((f) => f.check).join(', ')}`,
      })
    }
  }

  const oneEntry: DurableStore[] = [
    { store: 'declared_table', kind: 'drizzle-table', row: ROW_THAT_EXISTS },
  ]

  expect(
    'drizzle-table-undeclared',
    checkDrizzleTables(
      [{ file: '<probe>', source: `sqliteTable("brand_new_table", {})` }],
      oneEntry,
    ),
    checkDrizzleTables(
      [{ file: '<probe>', source: `sqliteTable("declared_table", {})` }],
      oneEntry,
    ),
  )

  expect(
    'drizzle-table-stale',
    checkDrizzleTables([{ file: '<probe>', source: '' }], oneEntry),
    checkDrizzleTables(
      [{ file: '<probe>', source: `sqliteTable('declared_table', {})` }],
      oneEntry,
    ),
  )

  const runtimeEntry: DurableStore[] = [
    { store: 'declared_cache', kind: 'runtime-table', row: ROW_THAT_EXISTS },
  ]
  expect(
    'runtime-table-undeclared',
    checkRuntimeTables(
      [{ file: '<probe>', source: 'db.exec(`CREATE TABLE IF NOT EXISTS secret_spool (x)`)' }],
      runtimeEntry,
    ),
    checkRuntimeTables(
      [{ file: '<probe>', source: 'db.exec(`CREATE TABLE IF NOT EXISTS declared_cache (x)`)' }],
      runtimeEntry,
    ),
  )

  // The `${CONST}` form: the mobile replica writes all four of its tables this
  // way, so a scanner blind to it would report that file clean.
  expect(
    'runtime-table-interpolated',
    checkRuntimeTables(
      [
        {
          file: '<probe>',
          source:
            "const SPOOL_TABLE = 'undeclared_spool'\ndb.exec(`CREATE TABLE IF NOT EXISTS ${SPOOL_TABLE} (x)`)",
        },
      ],
      runtimeEntry,
    ),
    checkRuntimeTables(
      [
        {
          file: '<probe>',
          source: "const T = 'declared_cache'\ndb.exec(`CREATE TABLE IF NOT EXISTS ${T} (x)`)",
        },
      ],
      runtimeEntry,
    ),
  )

  const writeInventory: DurableStore[] = [
    {
      store: 'declared_store',
      kind: 'filesystem',
      row: ROW_THAT_EXISTS,
      writeSites: ['known/writer.ts'],
    },
  ]
  const excuse = [
    {
      file: 'excused/writer.ts',
      reason:
        'A reason long enough to be an actual explanation of why this module writes bytes that are not durable product state at all.',
    },
  ]
  expect(
    'write-site-unaccounted',
    checkWriteSites(
      [{ file: 'brand/new-writer.ts', source: 'writeFileSync(p, x)' }],
      writeInventory,
      excuse,
    ),
    checkWriteSites(
      [
        { file: 'known/writer.ts', source: 'writeFileSync(p, x)' },
        { file: 'excused/writer.ts', source: 'mkdirSync(d)' },
        { file: 'reader/only.ts', source: 'readFileSync(p)' },
      ],
      writeInventory,
      excuse,
    ),
  )

  expect(
    'write-site-excuse-too-thin',
    checkWriteSites([{ file: 'thin/writer.ts', source: 'writeFileSync(p, x)' }], writeInventory, [
      { file: 'thin/writer.ts', reason: 'not state' },
    ]),
    checkWriteSites(
      [{ file: 'excused/writer.ts', source: 'writeFileSync(p, x)' }],
      writeInventory,
      excuse,
    ),
  )

  expect(
    'write-site-excuse-stale',
    checkWriteSites([], writeInventory, excuse),
    checkWriteSites(
      [{ file: 'excused/writer.ts', source: 'writeFileSync(p, x)' }],
      writeInventory,
      excuse,
    ),
  )

  // §4's two failure shapes — the missing class and the mistyped row id. Both
  // resolve to `personal` through `visibilityClassOf`; only membership sees them.
  expect(
    'store-names-a-row-that-does-not-exist',
    checkMatrixMembership([{ store: 'x', kind: 'drizzle-table', row: 'advisory-loks' }]),
    checkMatrixMembership([{ store: 'x', kind: 'drizzle-table', row: ROW_THAT_EXISTS }]),
  )

  expect(
    'store-unclassified-without-reason',
    checkMatrixMembership([{ store: 'x', kind: 'drizzle-table', row: null }]),
    checkMatrixMembership([
      {
        store: 'x',
        kind: 'drizzle-table',
        row: null,
        notEntityState:
          'A reason long enough to be a real explanation of why this store is not a class anybody owns or reads.',
      },
    ]),
  )

  expect(
    'store-declared-twice',
    checkMatrixMembership([
      { store: 'x', kind: 'drizzle-table', row: ROW_THAT_EXISTS },
      { store: 'x', kind: 'drizzle-table', row: ROW_THAT_EXISTS },
    ]),
    checkMatrixMembership([
      { store: 'x', kind: 'drizzle-table', row: ROW_THAT_EXISTS },
      { store: 'x', kind: 'runtime-table', row: ROW_THAT_EXISTS },
    ]),
  )

  return fail
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = (): boolean => {
  const entry = process.argv[1]
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)
}

if (isMain()) {
  const wants = (flag: string): boolean => process.argv.includes(flag)

  // The probe runs FIRST, always, even without the flag: a green audit from an
  // instrument that cannot say YES is not evidence of anything.
  const probeFailures = probe()
  if (probeFailures.length > 0) {
    console.error('durable-class audit: THE INSTRUMENT IS BROKEN — checks that cannot say YES:')
    for (const f of probeFailures) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(2)
  }
  if (wants('--probe')) {
    console.log(
      'durable-class audit: every check found its planted fixture and spared the clean one',
    )
  }

  const findings = auditRepo()
  if (wants('--json')) {
    console.log(JSON.stringify({ findings }, null, 2))
  } else if (findings.length === 0) {
    console.log(
      `durable-class audit: clean — ${DURABLE_STORES.length} durable stores, every one on the matrix or explained`,
    )
  } else {
    console.error(`durable-class audit: ${findings.length} finding(s)`)
    for (const f of findings) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
  }
  process.exit(findings.length === 0 ? 0 : 1)
}
