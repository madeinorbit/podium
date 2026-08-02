/**
 * THE OWNERSHIP MATRIX AS DATA — POD-304.
 *
 * Every replicated aggregate and field group, with all eleven normative columns
 * (ADR 1 D4's eight plus Amendment 1 D8's owner / visibility class / grants),
 * the attribution pair, the `system` writer rule, and the two annotations the
 * pack's open items assign to this issue: owner/grant inheritance on create
 * (ADR 9 §3 O4) and whether visibility is mutable after create (the inventory
 * Phase 2 / POD-1077 consumes).
 *
 * ---------------------------------------------------------------------------
 * PROVENANCE OF EVERY VALUE
 * ---------------------------------------------------------------------------
 *
 * The eight original columns are transcribed from `docs/adr/0001-authority-ownership.md`
 * §§1–10. The three new ones are transcribed from
 * `docs/adr/0001-authority-ownership-amendment-1.md` §3, INCLUDING its §11 (the
 * classes the multi-user amendments themselves introduce). Where the two
 * documents differ, the amendment wins and the row says so — the base matrix's
 * own header warns that "a row read from this section alone is now an incomplete
 * answer". Three amended rows to know about:
 *
 *   - session `readAt` LEFT the user-authored-labels group and became per-user
 *     state (Amendment 1 D10);
 *   - `archived` / `workState` are SHARED session facts and moved from
 *     `field-LWW` to `exp-rev` (D10) — a session that is `done` is not `done`
 *     only for me;
 *   - the field-LWW inventory shrank to ONE member, instance-scope preference
 *     keys, plus the composer draft's named interim defect.
 *
 * Nothing here decides policy. Rows that make an open question concrete cite it
 * (`open: ['O1']`) with a note, and never answer it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------------------------------------------------------
 *
 * No `instance_id`, and no instance dimension. `InstanceId` appears as ONE row
 * because ADR 1 §1 gives it one, and that row's replication is `none`: it is a
 * deployment partition, not a replicated aggregate (D5, restated normatively by
 * Amendment 1 D14 and fenced by Amendment 2 D17/D18). Multi-user is not
 * multi-tenancy.
 */

import {
  asMatrixRowId,
  type GrantRule,
  type MatrixRow,
  type MatrixRowId,
  MATRIX_INDEX_HOLDER,
  OP_STREAM_COMPACTION_CONSTRAINT,
  SYSTEM_WRITER_RULE,
} from './ownership'

const id = asMatrixRowId

// Row ids, declared once so `inherits` edges are checkable.
export const ROW = {
  instanceId: id('instance-id'),
  machine: id('machine'),
  pairingToken: id('pairing-token'),
  daemonIdentityFile: id('daemon-identity-file'),
  enrollmentLedger: id('enrollment-ledger'),

  sessionIdentity: id('session-identity'),
  sessionBinding: id('session-binding'),
  sessionPlacement: id('session-placement'),
  sessionLabels: id('session-labels'),
  sessionReadAt: id('session-read-at'),
  snooze: id('snooze'),
  composerDraft: id('composer-draft'),
  queuedMessages: id('queued-agent-messages'),
  daemonObservedRuntime: id('daemon-observed-runtime'),
  sessionObservationBookkeeping: id('session-observation-bookkeeping'),
  sessionUploads: id('session-uploads'),
  headlessTurnSpool: id('headless-turn-spool'),
  offers: id('agent-offers'),
  sessionLiveEphemeral: id('session-live-ephemeral'),
  hostMetrics: id('host-metrics'),
  provenanceEnvelope: id('provenance-envelope'),

  issueCore: id('issue-core'),
  issueDocumentFields: id('issue-document-fields'),
  needsHuman: id('needs-human-group'),
  issueGraph: id('issue-graph'),
  issueComments: id('issue-comments'),
  activityEvents: id('activity-events'),
  eventSubscriptions: id('event-subscriptions'),
  subscriptionDeliveries: id('subscription-deliveries'),
  issueMessages: id('issue-messages'),
  issueMessageReadAt: id('issue-message-read-at'),
  artifacts: id('artifacts'),

  conversationRegistry: id('conversation-registry'),
  segments: id('segments'),
  blobs: id('blobs'),

  repoPrefix: id('repo-prefix'),
  harnessDiscoveryCache: id('harness-discovery-cache'),
  harnessHookSettings: id('harness-hook-settings'),
  /** The living project spec (pspec v1) — files in a repo, NOT a replicated
   *  table. Added by POD-385; see the row for why it is `owned-compute`. */
  pspecComponent: id('pspec-component'),
  pins: id('pins'),
  tabOrder: id('tab-order'),
  /** Sidebar/tab layout shell chrome (POD-1350) — distinct from tab_order's
   *  session order per worktree. */
  sidebarTabLayout: id('sidebar-tab-layout'),
  /** How far a person has read an event stream (POD-1380) — a POSITION in an
   *  ordered log, not the per-entity `readAt` markers above it. */
  feedReadCursor: id('feed-read-cursor'),

  preferencesPersonal: id('preferences-personal-keys'),
  preferencesInstance: id('preferences-instance-keys'),
  serverSecrets: id('server-owned-secrets'),
  managedCredentials: id('managed-credentials'),
  configFeatures: id('config-features'),
  settingsAuditTrail: id('settings-audit-trail'),

  locks: id('advisory-locks'),
  approvals: id('approval-requests'),
  automations: id('automations-and-runs'),
  // POD-1211's coordination-shaped adoptions. Each is server-internal
  // bookkeeping the SWEEP found with no row at all; see `serverBookkeeping`
  // for why they are `personal`-with-no-owner rather than substrate.
  maintenanceLease: id('maintenance-lease'),
  maintenanceCommandReceipts: id('maintenance-command-receipts'),
  stewardState: id('steward-state'),
  notificationFacts: id('notification-facts'),
  wakeCooldowns: id('message-wake-cooldowns'),
  idAllocationCounters: id('id-allocation-counters'),
  // The workflow surface, as FIVE classes rather than the one row it used to
  // be (POD-731). The split is not cosmetic: revisions inherit their definition
  // while runs inherit the ISSUE they advance, and one row cannot carry two
  // owner rules. See the rows themselves for the rest.
  workflowDefinitions: id('workflow-definitions'),
  workflowRevisions: id('workflow-revisions'),
  workflowBindings: id('workflow-bindings'),
  workflowExecutionProfiles: id('workflow-execution-profiles'),
  workflowRuns: id('workflow-runs'),

  messages: id('messages-substrate'),
  messagingTopics: id('messaging-issue-topics'),
  superagentState: id('superagent-state'),

  handoffBundle: id('handoff-bundle'),

  changeLog: id('change-log'),
  feedIdentity: id('feed-identity'),
  appliedMutations: id('applied-mutations'),
  clientOutbox: id('client-outbox'),
  replicaCursor: id('replica-cursor'),

  userAccount: id('user-account'),
  accountCredential: id('account-credential'),
  perUserClientSession: id('per-user-client-session'),
  grantEdge: id('grant-edge'),
  delegationRecord: id('delegation-record'),
  telegramChatBinding: id('telegram-chat-binding'),
  perUserStateFamily: id('per-user-state-family'),
  recapWatermark: id('recap-watermark'),
} as const

// ---------------------------------------------------------------------------
// Shared cell values, so a repeated rule cannot drift between rows.
// ---------------------------------------------------------------------------

const PERSONAL_GRANTS: GrantRule = { kind: 'verbs', verbs: ['read', 'write'] }
const MACHINE_GRANTS: GrantRule = {
  kind: 'verbs',
  verbs: ['see', 'use', 'manage'],
  note: '`use` is a CODE-EXECUTION boundary, not a personal `read` (ADR 9 D6 M2). Never conflate.',
}
const NO_GRANTS_PER_USER: GrantRule = {
  kind: 'none',
  reason: 'per-user-state-non-grantable',
  note: 'ADR 9 D3 rule 4: there is no "share my read state" verb. Sharing an entity never shares anybody’s per-user rows.',
}
const NO_GRANTS_SUBSTRATE: GrantRule = { kind: 'none', reason: 'substrate' }
const NO_GRANTS_SECRET: GrantRule = {
  kind: 'none',
  reason: 'secret-admin-grade',
  note: 'ADR 1 D15: `manage` is gated on the instance admin ROLE, not on ownership and not on grants.',
}

/** The per-user-state family's shape, identical for every member (D10). */
const perUserState = (
  row: Pick<MatrixRow, 'id' | 'section' | 'title' | 'sites'> & Partial<MatrixRow>,
): MatrixRow => ({
  home: 'server',
  idMinting: 'composite `(userId, entityId)` — one shared key fragment (ADR 4 Amendment 1 D10.2)',
  writers: ['operator'],
  replication: 'client-to-server-to-clients',
  replicationNote: 'Only to the owning user’s own replicas: a per-user row is not another reader’s row.',
  conflict: 'single-writer',
  conflictNote:
    'With the user IN THE KEY there is exactly one writer per row, so the conflict does not exist to resolve (D10). This is why the family is cheap.',
  tombstone: 'hard-delete',
  tombstoneNote: 'Rows follow the USER and cascade on user deletion; they are not the entity’s rows, so deleting or transferring the entity does not transfer them (D10).',
  offline: 'offline-eligible',
  secret: 'preference',
  owner: { kind: 'user', resolves: 'the-user-in-the-key' },
  visibility: 'per-user-state',
  grants: NO_GRANTS_PER_USER,
  attribution: {
    actor: 'required',
    onBehalfOf: 'required',
    note: 'The owning user is both halves; an agent may not write another person’s per-user row on their behalf.',
  },
  systemWriter: 'never-writes',
  inheritanceOnCreate: {
    kind: 'the-user-in-the-key',
    note: 'DECLARED, not inherited from the entity: the row is created by and for the user in its key.',
  },
  visibilityMutability: {
    mutable: false,
    verbs: [],
    note: 'Non-grantable by construction, so no verb can change who sees it. The only lifecycle event is the owner’s account being removed.',
  },
  open: [],
  ...row,
})

/**
 * SERVER-INTERNAL BOOKKEEPING — POD-1211's shape, declared once.
 *
 * The sweep (POD-385, `docs/agents/pod-385-matrix-coverage-sweep.md`) found a
 * family of durable classes that are (a) written only by the Authority itself as
 * `system`, (b) never replicated to any replica, and (c) owned by nobody:
 * janitor leases and their idempotency receipts, the steward's cursor KV, the
 * notification arbiter's once-until-ack claims, wake cooldowns, subscription
 * delivery receipts, id allocation counters, the feed's identity row.
 *
 * WHY `personal` AND NOT `deployment-substrate`, WHICH IS WHAT THEY LOOK LIKE.
 * `advisory-locks` and `applied-mutations` are the two neighbours these most
 * resemble, and both are substrate — so substrate is the obvious reading, and it
 * is the one this pass deliberately does NOT take. ADR 1 Amendment 1 D9.3 makes
 * the classification ratchet ONE-WAY: moving a class *toward* privacy is
 * per-feature policy, moving anything INTO `deployment-substrate` requires an
 * ADR 1 amendment, because substrate means TENANT-VISIBLE and widening is always
 * reviewed (ADR 9 D4 rule 4). POD-1211 is chartered to classify classes that had
 * no row; it is not chartered to widen the tenant-visible floor, and it ran with
 * no human available to take that decision. So each row here is classified in
 * the direction that is free — private — and says on its face that substrate is
 * its plausible eventual home. Nothing is lost by waiting: none of these rows
 * reaches a client at all, so `personal` and `deployment-substrate` are
 * indistinguishable at every surface that exists today. What IS gained is that
 * the class is now DECLARED, which is the whole point: before this, an
 * unclassified class and a deliberately-private one returned the same value from
 * `visibilityClassOf` and both read green.
 *
 * `owner: none / substrate` with `visibility: 'personal'` is therefore exact
 * rather than contradictory: nobody owns the row, AND no principal may see it
 * through a scoped feed. `blobs` already carries the same pairing (no owner,
 * `personal`) for a different reason.
 */
const serverBookkeeping = (
  row: Pick<MatrixRow, 'id' | 'section' | 'title' | 'sites' | 'idMinting'> & Partial<MatrixRow>,
): MatrixRow => ({
  home: 'server',
  writers: ['system'],
  replication: 'none',
  replicationNote:
    'Never replicated and never projected onto the wire. It is in this matrix for its ADR 9 D4 visibility declaration, which every durable class owes whether or not it replicates (the `pspec-component` and `instance-id` precedent).',
  conflict: 'single-writer',
  conflictNote:
    'The Authority is the only writer, so there is no second copy to arbitrate against.',
  tombstone: 'hard-delete',
  tombstoneNote: 'Swept by retention or by the lifecycle of whatever it is bookkeeping for.',
  offline: 'n/a',
  secret: 'public',
  owner: {
    kind: 'none',
    reason: 'substrate',
    note:
      'Nobody owns it: it is the Authority’s own bookkeeping, not a row belonging to whoever caused it. ' +
      'Classified `personal` rather than `deployment-substrate` on the ADR 1 Amendment 1 D9.3 ratchet — ' +
      'privacy is free, exposure needs an amendment — and unobservably so, because the class reaches no client.',
  },
  visibility: 'personal',
  grants: {
    kind: 'none',
    reason: 'derived',
    note: 'Nothing to share: there is no surface on which a principal reads this class, so there is no read to grant.',
  },
  attribution: {
    actor: 'required',
    onBehalfOf: 'none-representable',
    note: 'A `system` act with no human behind it — explicitly absent, never defaulted to an operator.',
  },
  systemWriter: 'may-write',
  systemWriterRule: SYSTEM_WRITER_RULE,
  inheritanceOnCreate: {
    kind: 'not-applicable',
    reason: 'Bookkeeping has no parent and no owner to inherit.',
  },
  visibilityMutability: {
    mutable: false,
    verbs: [],
    note: 'Never replicated, so no principal’s view of it can change — the `applied-mutations` combination with nothing for Phase 2 to signal.',
  },
  open: [],
  ...row,
})

// ---------------------------------------------------------------------------
// §1 Identity & deployment scope
// ---------------------------------------------------------------------------

const IDENTITY_ROWS: readonly MatrixRow[] = [
  {
    id: ROW.instanceId,
    section: 'identity-and-deployment-scope',
    title: 'InstanceId (deployment partition)',
    sites: ['`<stateDir>/instance.json` — the state-dir identity marker', 'packages/runtime/src/instance.ts'],
    home: 'runtime-local',
    idMinting:
      'Operator / `PODIUM_INSTANCE` / CLI `--instance`; `INSTANCE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/`, default `default`',
    writers: ['operator', 'system'],
    replication: 'none',
    replicationNote:
      'NOT a replicated aggregate (D5.2). It is the deployment partition of an entire Authority; two instances are two isolated product universes. Amendment 2 D17 confines the brand to CONFIGURATION positions — never a field on a table, projection or payload.',
    conflict: 'n/a',
    conflictNote: 'A wrong instance marker in a state dir is a HARD FAIL, not a merge (`assertInstanceStateIdentity`).',
    tombstone: 'n/a',
    tombstoneNote: 'Marker lifetime = state dir lifetime.',
    offline: 'n/a',
    secret: 'public',
    secretNote: 'The id string is public within the instance; the marker file is mode `0600`. Pairing TOKENS are a different row.',
    owner: {
      kind: 'none',
      reason: 'substrate',
      note: 'A deployment partition belongs to the deployment, not to a person (Amendment 1 D14; Amendment 2 D19 classifies instance identity as deployment-substrate, human-minted at deploy time).',
    },
    visibility: 'deployment-substrate',
    grants: { kind: 'none', reason: 'substrate', note: 'Selection is a deploy-time act.' },
    attribution: {
      actor: 'not-applicable',
      onBehalfOf: 'not-applicable',
      note: 'Claiming a state dir is a process act, not a durable write with a principal.',
    },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'not-applicable', reason: 'Substrate: there is no owner or grant to inherit.' },
    visibilityMutability: {
      mutable: false,
      verbs: [],
      note: 'Tenant-visible from creation and never narrows.',
    },
    open: [],
  },
  {
    id: ROW.machine,
    section: 'identity-and-deployment-scope',
    title: 'Machine (fleet row / `machines`)',
    sites: ['apps/server/src/migrations/schema.ts (`machines`)', 'apps/daemon/src/identity.ts', 'packages/runtime/src/local-machine.ts'],
    home: 'server',
    idMinting: 'Daemon mints `machineId` UUID once into per-instance `daemon.json`; server registers on pair/hello',
    writers: ['daemon', 'operator'],
    replication: 'server-to-clients',
    replicationNote: 'Public fields only.',
    conflict: 'exp-rev',
    conflictNote: 'exp-rev on admin rename; the JOIN KEY is single-writer (the daemon mints it once and the server never re-mints it).',
    tombstone: 'soft-delete',
    tombstoneNote: 'Soft remove / token revoke — a new secret for the same MachineId, so the fleet identity survives rotation.',
    offline: 'online-only',
    secret: 'public',
    secretNote: 'Public: id, name, hostname, lastSeen, inventory. The pairing token is `secret-value`; "is it paired?" is `secret-presence`.',
    owner: {
      kind: 'user',
      resolves: 'pairer',
      note: 'ADR 9 D6 M3: pairing runs from that person’s laptop with their join code, so they own it. For the HOST machine the owner is the instance installer (Amendment 1 D13.4): the server’s own host is a fleet member like any other (POD-318 gave it a minted id and a real row), so without an owner anyone who can authenticate would inherit EXECUTE on it. Existing machines need a one-time ownership migration at the cutover.',
    },
    visibility: 'owned-compute',
    grants: MACHINE_GRANTS,
    attribution: {
      actor: 'required',
      onBehalfOf: 'required',
      note: 'Daemon-originated identity writes are a MACHINE principal: actor = the machine, on-behalf-of NONE (never defaulted to the owner).',
    },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: {
      kind: 'on-behalf-of-human',
      note: 'DECLARED as the pairer rather than the parent, because a machine has no parent entity. Pairing must RECORD who paired it (ADR 9 D6 M3).',
    },
    visibilityMutability: {
      mutable: true,
      verbs: ['grant-see', 'grant-use', 'grant-manage', 'revoke', 'transfer-owner', 'pair', 'unpair'],
      note: 'PHASE 2 MUST HANDLE: granting `see` makes a machine and every per-machine fact appear for a principal with no revision moving. Revoking `use` must not read as "machine deleted" — and per ADR 9 D6 M5 a machine outside the `see` set is ABSENT, so an evict/rescope signal (not `remove`) is the only correct expression.',
    },
    open: ['O1'],
    openNote:
      'O1: machine EXISTENCE for admins is deployment-substrate (Amendment 1 D13.6) while everything else on the row is owned — so "which existence facts leak" (machine session lists, "this worktree is in use") becomes concrete here. Not resolved.',
  },
  {
    id: ROW.pairingToken,
    section: 'identity-and-deployment-scope',
    title: 'Pairing token / client session token',
    sites: [
      '`machines.token_hash`',
      '`client_sessions.token_hash`',
      'Telegram claim code (`TelegramClaimCode.code`, POD-1080) — a third preimage of the same kind, added to this row rather than given its own: every cell here is already the right answer for it (server-minted, hashed or held server-side, never replicated, never queued, no owner because a secret has none), and a second row would be a second place to keep those five answers in sync.',
    ],
    home: 'server',
    idMinting: 'Server mints at pair / login; hashed at rest',
    writers: ['system'],
    replication: 'none',
    conflict: 'n/a',
    tombstone: 'hard-delete',
    tombstoneNote: 'Revoke rotates.',
    offline: 'never-enqueue',
    secret: 'secret-value',
    owner: { kind: 'none', reason: 'secret', note: 'ADR 1 D6 unchanged: server-local only, never replicated, never queued.' },
    visibility: 'secret',
    grants: NO_GRANTS_SECRET,
    attribution: { actor: 'required', onBehalfOf: 'none-representable', note: 'Minted by the server as `system`.' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'not-applicable', reason: 'Secret: no owner and no grants exist to inherit (D15).' },
    visibilityMutability: { mutable: false, verbs: [], note: 'Never visible to any replica, so there is nothing to change.' },
    open: [],
  },
  {
    id: ROW.daemonIdentityFile,
    section: 'identity-and-deployment-scope',
    title: 'Daemon local identity file',
    sites: ['apps/daemon/src/identity.ts (`daemon.json`)'],
    home: 'runtime-local',
    idMinting: 'Daemon mints MachineId',
    writers: ['daemon'],
    replication: 'none',
    conflict: 'n/a',
    tombstone: 'n/a',
    tombstoneNote: 'Lives and dies with the instance state dir.',
    offline: 'n/a',
    secret: 'credential-local',
    secretNote: 'MachineId is public; the pairing token in the file is `credential-local`.',
    owner: { kind: 'inherits', from: ROW.machine },
    visibility: 'owned-compute',
    grants: { kind: 'inherits', from: ROW.machine },
    attribution: { actor: 'required', onBehalfOf: 'none-representable', note: 'A machine principal writing its own identity file.' },
    systemWriter: 'never-writes',
    inheritanceOnCreate: { kind: 'parent', from: ROW.machine },
    visibilityMutability: { mutable: false, verbs: [], note: 'A local file; not replicated, so replica visibility never changes.' },
    open: [],
  },
  {
    id: ROW.enrollmentLedger,
    section: 'identity-and-deployment-scope',
    title: 'Enrollment ledger (`<stateDir>/enrollment.ledger`)',
    sites: [
      'apps/server/src/enrollment-ledger.ts (`<stateDir>/enrollment.ledger`, mode 0600, append-only)',
      'apps/server/src/modules/machines/enrollment.ts (the D19.4 verdict algorithm reads it)',
    ],
    home: 'server',
    idMinting: 'Server mints the instance pairing root once; enrollment serials are monotonic per append',
    writers: ['system'],
    replication: 'none',
    conflict: 'append',
    conflictNote:
      'Append-only with monotonic serials, and it is the COMMIT POINT rather than a projection (Amendment 2 D19.4d): where the ledger and the `machines` table disagree about enrollment, revocation or OWNER, the ledger wins and the row is reconciled from it. There is nothing to arbitrate because nothing else may write the fact first.',
    tombstone: 'never-delete',
    tombstoneNote:
      'Never restored, rewound or reconciled backwards when the database is (D19.4a). A revocation entry that could be deleted or rolled back would be defeated by the exact event the ledger exists to survive.',
    offline: 'never-enqueue',
    secret: 'secret-value',
    secretNote:
      'The instance pairing ROOT is the preimage every pairing token is MACed under — the same material class as `pairing-token`, and one root compromises every machine rather than one. The enrollment serials, recorded owner and revocation entries share the file because sharing ONE durability domain with the root is the correctness condition (D19.4a), so the whole store takes the strictest class present.',
    owner: {
      kind: 'none',
      reason: 'secret',
      note: 'An unclassified store is not a scoped one, so this row is stated rather than inferred: the ledger is server-local credential material with no owner, for the reason `account-credential` and `pairing-token` have none (D15) — it AUTHENTICATES machines but is not anybody’s to grant or transfer. The per-machine facts it records are owned; their owner lives on `machine` (owned-compute), which this ledger is the durable SOURCE of, not a second copy of. Giving the ledger its own owner would create a second answer to "who owns this machine".',
    },
    visibility: 'secret',
    grants: NO_GRANTS_SECRET,
    attribution: {
      actor: 'required',
      onBehalfOf: 'required',
      note: 'An owner transition appended here records the human on whose behalf it happened — that recorded owner is what D19.4b restores after database loss, and it may never be re-derived from whoever is connected.',
    },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'not-applicable', reason: 'Secret: no owner and no grants exist to inherit (D15).' },
    visibilityMutability: {
      mutable: false,
      verbs: [],
      note: 'Never replicated and excluded from every wire projection, so no principal’s view of it can change. Recovery reads it and never RECLASSIFIES what it recovers: the machine it re-enrols returns owned-compute with grants dropped (D19.4b).',
    },
    open: [],
  },
]

// ---------------------------------------------------------------------------
// §2 Sessions
// ---------------------------------------------------------------------------

const SESSION_ROWS: readonly MatrixRow[] = [
  {
    id: ROW.sessionIdentity,
    section: 'sessions',
    title: 'Session identity (`sessionId`, birth display ref / letters)',
    sites: ['apps/server/src/modules/sessions/lifecycle.ts (`randomUUID()`)', '`issue_ref_letters`'],
    home: 'server',
    idMinting: 'Server UUID; ref letter server-allocated per issue. Daemons do NOT coin the registry id — a documented inversion, kept so a daemon cannot bypass the Authority.',
    writers: ['operator', 'agent-session', 'system'],
    replication: 'server-to-clients',
    conflict: 'single-writer',
    conflictNote: 'The id is immutable after mint, so there is nothing to arbitrate.',
    tombstone: 'soft-delete',
    tombstoneNote: 'Soft-delete `deletedAt` + `deletionSource` (+ `deletedByIssueId` on issue cascade); issue-cascade deletes are recoverable.',
    offline: 'live-path-required',
    secret: 'public',
    owner: {
      kind: 'user',
      resolves: 'on-behalf-of-human',
      note: 'ADR 9 D5 A4: owner = the delegating human of the spawning principal, actor = the agent. Otherwise the personal sidebar would not show work your own agent did for you, and retiring an agent session would orphan its work.',
    },
    visibility: 'personal',
    grants: PERSONAL_GRANTS,
    attribution: {
      actor: 'required',
      onBehalfOf: 'required',
      note: '`spawnedBy` is the freeform ancestor of this pair (documented values `user` / `superagent:<id>` / `issue:<id>` / `session:<id>`) and carries at most the actor half. See INTERIM DEFECT.',
    },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: {
      kind: 'on-behalf-of-human',
      note: 'DECLARED: the spawning principal’s human owns it (A4). A session spawned under an issue does NOT take the issue’s owner — an issue shared with you does not make your colleague the owner of the sessions you start on it. Grants, by contrast, follow the issue via `session-placement`.',
    },
    visibilityMutability: {
      mutable: true,
      verbs: ['share', 'unshare', 'revoke', 'transfer-owner'],
      note: 'PHASE 2 MUST HANDLE: the archetypal case. Sharing a session makes it and its whole subtree (placement, labels, draft, queued messages, observed runtime, artifacts, transcripts) appear for the grantee with NO revision moving.',
    },
    open: [],
    interimDefect: {
      defect:
        'Attribution is recorded CONDITIONALLY, so "no actor recorded" and "a human did it" are indistinguishable: `causedBySessionId` is spread on a ternary into the issue event payload and `actorSessionId` is threaded only on the agent path (POD-364 / POD-388 inventory), so an operator-originated write records no attribution at all. The matrix requires the PAIR on every write; the pair’s human half also has no production value until `UserId` exists.',
      expiresWhen:
        'POD-1075 lands `UserId` and the User aggregate, and the attribution pair becomes non-optional at every write site (both halves stamped from the transport principal per ADR 3 D7).',
    },
  },
  {
    id: ROW.sessionBinding,
    section: 'sessions',
    title: 'On-host session binding (agent principal and native-identity observations)',
    sites: ['apps/daemon/src/binding-store.ts (`<stateDir>/session-bindings`)'],
    home: 'runtime-local',
    idMinting: 'Keyed by the server-minted SessionId; observations carry their own immutable observation ids',
    writers: ['daemon', 'agent-session', 'system'],
    replication: 'none',
    replicationNote: 'A per-machine fact that is never tenant-visible and never projected onto the wire. The server remains authoritative for authorization and resolves effective rights live at every apply.',
    conflict: 'single-writer',
    conflictNote: 'One daemon owns a binding record while its machine is claimant; immutable observations retain alias history instead of racing a current-value field.',
    tombstone: 'soft-delete',
    tombstoneNote: 'Retirement is retained in the record with `retiredAt` so the delegation and observation history remain auditable.',
    offline: 'live-path-required',
    secret: 'public',
    secretNote: 'Contains identity references and local paths, but no credential, capability, resolved permission set, or cached authorization result.',
    owner: {
      kind: 'inherits',
      from: ROW.machine,
      note: 'A per-machine fact inherits the machine’s scoping. Bindings on one shared machine can name several humans through `onBehalfOf`; that column scopes reads but does not repartition storage.',
    },
    visibility: 'owned-compute',
    grants: {
      kind: 'inherits',
      from: ROW.machine,
      note: 'Machine grants govern access to host compute. Whether a use-holder may enumerate other humans’ sessions remains an existence-policy question above the owner-scoped store API.',
    },
    attribution: {
      actor: 'required',
      onBehalfOf: 'required',
      note: 'The binding persists the agent delegation reference and its parent chain; system bindings represent delegation as null rather than inventing a human.',
    },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: {
      kind: 'parent',
      from: ROW.machine,
      note: 'The fact is born on the claimant machine while the agent principal’s human is carried separately in the delegation reference.',
    },
    visibilityMutability: {
      mutable: true,
      verbs: ['grant-see', 'grant-use', 'revoke', 'transfer-owner'],
      note: 'Machine grant changes alter who can reach the store without changing or copying any binding record.',
    },
    open: ['O1'],
    openNote: 'O1: whether a machine use-holder may see the full local session list is intentionally unresolved. Callers must query bindings by principal so policy can narrow enumeration without a schema migration.',
  },
  {
    id: ROW.sessionPlacement,
    section: 'sessions',
    title: 'Session placement (`cwd`, `machineId`, `issueId`, `agentKind`, origin, headless, workflow pass-through ids)',
    sites: ['packages/model/src/entities/session.ts'],
    home: 'server',
    idMinting: 'n/a',
    writers: ['operator', 'agent-session', 'system'],
    replication: 'server-to-clients',
    conflict: 'exp-rev',
    conflictNote: 'Handoff accept is `cmd` (a state machine on the target, not a field merge).',
    tombstone: 'n/a',
    tombstoneNote: 'Follows the session tombstone.',
    offline: 'offline-eligible',
    secret: 'public',
    owner: { kind: 'inherits', from: ROW.sessionIdentity },
    visibility: 'personal',
    grants: {
      kind: 'inherits',
      from: ROW.sessionIdentity,
      note: 'ADDITIONALLY gated by the TARGET MACHINE’s `use` (Amendment 1 D13.7): placement is not only a privacy question. Spawn must not offer a machine the principal lacks `use` on, and handoff to one is DENIED, not silently retargeted (ADR 9 D6 M5).',
    },
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'parent', from: ROW.sessionIdentity },
    visibilityMutability: {
      mutable: true,
      verbs: ['share', 'unshare', 'revoke', 'grant-use'],
      note: 'PHASE 2 MUST HANDLE: two independent axes. It appears/disappears with the session’s grants, AND a machine `use` revocation can make a placement unusable without the row changing.',
    },
    open: [],
  },
  {
    id: ROW.sessionLabels,
    section: 'sessions',
    title: 'User-authored labels (`name`/`nameSource`, user `title`, `archived`, `workState`)',
    sites: ['packages/model/src/entities/session.ts', '[spec:SP-eb60]'],
    home: 'server',
    idMinting: 'n/a',
    writers: ['operator', 'agent-session'],
    replication: 'server-to-clients',
    conflict: 'exp-rev',
    conflictNote:
      'AMENDED (Amendment 1 D10): `archived` and `workState` were `field-LWW` in the base matrix and are now SHARED SESSION FACTS at `exp-rev`. `WorkState` is `planning|implementing|testing|done|icebox` — a statement about the WORK, identical for every viewer; a session that is `done` is not `done` only for me. `readAt` LEFT this group entirely and is per-user state. The `name`/`nameSource` rule survives unchanged: a human-set name is not agent-overwritable ([spec:SP-eb60]).',
    tombstone: 'never-delete',
    tombstoneNote: 'Archive is not delete — `archived` sits beside `deletedAt` on the shared row and means "retired".',
    offline: 'offline-eligible',
    secret: 'public',
    owner: { kind: 'inherits', from: ROW.sessionIdentity },
    visibility: 'personal',
    grants: { kind: 'inherits', from: ROW.sessionIdentity },
    attribution: {
      actor: 'required',
      onBehalfOf: 'required',
      note: '`nameSource` is a two-value role enum carrying an AUTHORIZATION rule, which is exactly why actor and on-behalf-of cannot collapse: "a human set this" must stay distinguishable from "an agent set this".',
    },
    systemWriter: 'never-writes',
    inheritanceOnCreate: { kind: 'parent', from: ROW.sessionIdentity },
    visibilityMutability: {
      mutable: true,
      verbs: ['share', 'unshare', 'revoke'],
      note: 'PHASE 2 MUST HANDLE: follows the session.',
    },
    open: [],
  },
  perUserState({
    id: ROW.sessionReadAt,
    section: 'sessions',
    title: 'Session `readAt` (moved out of the labels group by Amendment 1 D10)',
    sites: ['`session_user_state` — keyed `(user_id, session_id)` (POD-1076; it was a SINGLETON `sessions.read_at` column until then)'],
    conflictNote:
      'Read state is a fact about a READER. Keyed `(userId, sessionId)` it is single-writer by construction; POD-1076 removed the former instance-wide column and POD-393 routes reads and writes through the calling human principal.',
  }),
  perUserState({
    id: ROW.snooze,
    section: 'sessions',
    title: 'Snooze (`snoozes` / `snoozedUntil`)',
    sites: ['`snoozes` — keyed `(user_id, session_id)`', 'packages/model/src/predicates/snooze.ts', 'apps/server/src/modules/sessions/session-state/service.ts'],
    conflictNote:
      '"Stop bothering ME until Tuesday" is not a property of the session. Because the stored and wire values stay the strings they already are, the move is a RE-KEY, not a re-representation (model README invariant 2).',
  }),
  {
    id: ROW.composerDraft,
    section: 'sessions',
    title: 'Composer draft (`session_drafts` + `draftUpdatedAt`)',
    sites: ['`session_drafts` (keyed `session_id`)'],
    home: 'server',
    idMinting: 'n/a',
    writers: ['operator'],
    replication: 'server-to-clients',
    replicationNote: 'Body may be lazy.',
    conflict: 'field-LWW',
    reservedConflict: { rule: 'op-stream', constraint: OP_STREAM_COMPACTION_CONSTRAINT },
    conflictNote:
      'Clock: the Authority-assigned event time at commit (ADR 1 D3 condition 1) — client `draftUpdatedAt` is spoofable and non-monotonic across devices, so it is attribution metadata only. Invariant: the WHOLE draft body is one group. NOT a justified carve-out — see INTERIM DEFECT. Deliberately NOT per-user state: readiness §3.3/§4 classify the draft as SHARED-SURFACE state (one message being composed for one session, not five private scratchpads), so making it per-user would quietly delete the collaboration feature rather than defer it.',
    tombstone: 'hard-delete',
    tombstoneNote: 'Empty body deletes the row; the clear participates in the same clock (D3 condition 4).',
    offline: 'offline-eligible',
    secret: 'public',
    owner: { kind: 'inherits', from: ROW.sessionIdentity },
    visibility: 'personal',
    grants: { kind: 'inherits', from: ROW.sessionIdentity },
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'never-writes',
    inheritanceOnCreate: { kind: 'parent', from: ROW.sessionIdentity },
    visibilityMutability: {
      mutable: true,
      verbs: ['share', 'unshare', 'revoke'],
      note: 'PHASE 2 MUST HANDLE: follows the session — and it is the row where a second visible writer turns the interim defect into data loss.',
    },
    open: [],
    interimDefect: {
      defect:
        'Whole-body `field-LWW` between two concurrent authors SILENTLY DISCARDS one author’s text. This is the one row where a documented decision becomes a data-loss bug (Amendment 1 D10).',
      expiresWhen:
        'BEFORE session sharing ships (Phase 3 / POD-290) the draft must either move to `op-stream` or be gated to a single writer using the control model that already exists (`controllerId` / `requestControl`). Shipping NEITHER is out of compliance.',
    },
  },
  {
    id: ROW.queuedMessages,
    section: 'sessions',
    title: 'Queued agent messages (`queued_messages`)',
    sites: ['`queued_messages`'],
    home: 'server',
    idMinting: '`mutationId` (client-minted, deduped by the Authority)',
    writers: ['operator', 'agent-session'],
    replication: 'server-to-clients',
    replicationNote: 'Count on session meta reaches clients; the BODY is not general replica content.',
    conflict: 'append',
    conflictNote: 'Append FIFO per session; dedupe by `mutationId`.',
    tombstone: 'hard-delete',
    tombstoneNote: 'Deleted after delivery toward the daemon.',
    offline: 'offline-eligible',
    secret: 'public',
    owner: { kind: 'inherits', from: ROW.sessionIdentity },
    visibility: 'personal',
    grants: { kind: 'inherits', from: ROW.sessionIdentity },
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'parent', from: ROW.sessionIdentity },
    visibilityMutability: { mutable: true, verbs: ['share', 'unshare', 'revoke'], note: 'PHASE 2 MUST HANDLE: follows the session.' },
    open: [],
  },
  {
    id: ROW.daemonObservedRuntime,
    section: 'sessions',
    title: 'Daemon-observed runtime (status, exitCode, epoch, geometry, resumable, transcriptAvailable, busy, agentState, agentColor, clientCount, activity timestamps)',
    sites: ['packages/model/src/entities/session.ts'],
    home: 'daemon-then-server',
    idMinting: 'n/a',
    writers: ['daemon', 'system'],
    replication: 'daemon-to-server-to-clients',
    conflict: 'single-writer',
    conflictNote:
      'ONE observation stream; clients cannot forge status. This is the row ADR 1 D1’s CRDT rejection is ABOUT: merging "session 12 is busy" is meaningless, and Amendment 1 D12 part 1 keeps that rejection while stating its scope (metadata backbone, NOT a ruling on collaborative text).',
    tombstone: 'n/a',
    tombstoneNote: 'Exited is not a tombstone: a dead session still exists.',
    offline: 'observe-only',
    secret: 'public',
    owner: { kind: 'inherits', from: ROW.sessionIdentity },
    visibility: 'personal',
    grants: {
      kind: 'inherits',
      from: ROW.sessionIdentity,
      note: 'An observation ABOUT a personal entity, produced on owned compute — it inherits the session, not the machine.',
    },
    attribution: {
      actor: 'required',
      onBehalfOf: 'none-representable',
      note: 'A MACHINE principal: a machine is not a person and must never originate a write as one (ADR 9 D1). On-behalf-of is absent, never defaulted to the session owner.',
    },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'parent', from: ROW.sessionIdentity },
    visibilityMutability: { mutable: true, verbs: ['share', 'unshare', 'revoke'], note: 'PHASE 2 MUST HANDLE: follows the session.' },
    open: [],
  },
  {
    id: ROW.sessionLiveEphemeral,
    section: 'sessions',
    title: 'Live-only / ephemeral — PTY handles, controller set, in-flight handoff overlay',
    sites: ['apps/server/src/modules/sessions/session.ts (`controllerId`, `requestControl`)'],
    home: 'runtime-local',
    idMinting: 'n/a',
    writers: ['operator', 'agent-session', 'daemon'],
    replication: 'none',
    replicationNote: 'Live planes only (ADR 7); NOT durable oplog entities.',
    conflict: 'live-ephemeral',
    conflictNote:
      'Two people typing into one terminal is a CONTROL problem, not a text merge: `controllerId` + `requestControl` already model it (first attacher takes control; transfer broadcasts `controllerChanged`). `op-stream` does NOT apply to PTY input and must not be cited for it (Amendment 1 D12). `controllerId` is a CONNECTION id, not a person — putting identity on it is Phase 5.',
    tombstone: 'n/a',
    tombstoneNote: 'Dies with the process.',
    offline: 'live-path-required',
    secret: 'public',
    owner: { kind: 'inherits', from: ROW.sessionIdentity },
    visibility: 'personal',
    grants: { kind: 'inherits', from: ROW.sessionIdentity },
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'never-writes',
    inheritanceOnCreate: { kind: 'parent', from: ROW.sessionIdentity },
    visibilityMutability: {
      mutable: true,
      verbs: ['share', 'unshare', 'revoke'],
      note: 'PHASE 2 MUST HANDLE (as a ROOM, not a feed row): presence/attach membership is derived from live connections, so a revoke must evict an attached principal rather than wait for a revision.',
    },
    open: [],
  },
  {
    id: ROW.hostMetrics,
    section: 'sessions',
    title: 'Live-only / ephemeral — host metrics',
    sites: ['packages/model/src/entities/machine.ts'],
    home: 'daemon-then-server',
    idMinting: 'n/a',
    writers: ['daemon'],
    replication: 'daemon-to-server-to-clients',
    replicationNote: 'Live plane; not durable.',
    conflict: 'live-ephemeral',
    tombstone: 'n/a',
    tombstoneNote: 'Dies with the connection.',
    offline: 'observe-only',
    secret: 'public',
    owner: { kind: 'inherits', from: ROW.machine },
    visibility: 'owned-compute',
    grants: { kind: 'verbs', verbs: ['see'], note: 'Fleet health needs `see` and nothing more (ADR 9 D6 M1).' },
    attribution: { actor: 'required', onBehalfOf: 'none-representable', note: 'Machine principal.' },
    systemWriter: 'never-writes',
    inheritanceOnCreate: { kind: 'parent', from: ROW.machine },
    visibilityMutability: {
      mutable: true,
      verbs: ['grant-see', 'revoke', 'transfer-owner'],
      note: 'PHASE 2 MUST HANDLE: appears/disappears with the machine’s `see` grant.',
    },
    open: [],
  },
  {
    id: ROW.provenanceEnvelope,
    section: 'sessions',
    title: 'Provenance envelope (`viaHub`, `upstreamStale`, `pendingSync`)',
    sites: ['packages/model/src/provenance/envelope.ts'],
    home: 'client-local',
    idMinting: 'n/a',
    writers: ['system'],
    replication: 'none',
    replicationNote:
      'Envelope only (ADR 4 D3.8 / this issue). Computed AT a replica boundary: it answers "how did this row reach this replica", which is different for two replicas holding the same revision.',
    conflict: 'n/a',
    conflictNote: 'Not durable truth; there is nothing to arbitrate. Amendment 1 §3 §2 classifies it `derived` — a per-delivery fact.',
    tombstone: 'n/a',
    offline: 'observe-only',
    secret: 'public',
    owner: {
      kind: 'none',
      reason: 'derived',
      note: 'THE PLACEMENT RULE (obligation 9): owner / visibility / actor / on-behalf-of MUST NOT live on the envelope. They are authoritative facts about the row that must survive bootstrap, export and re-replication, and an authorization input that is droppable at a replica boundary fails OPEN. `envelope.test.ts` enforces this.',
    },
    visibility: 'personal',
    grants: { kind: 'none', reason: 'derived', note: 'Inherits the visibility of whatever it envelopes; it is never independently grantable.' },
    attribution: {
      actor: 'not-applicable',
      onBehalfOf: 'not-applicable',
      note: 'Delivery has no author. This is the row that proves the split: `humanQuestionAskedBy` is server-authoritative ATTRIBUTION and therefore stays ENTITY data on the needs-human group — the envelope is the wrong lifetime for it.',
    },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: {
      kind: 'not-applicable',
      reason: 'Derived per delivery: it inherits the enveloped entity’s visibility and has no owner or grants of its own.',
    },
    visibilityMutability: {
      mutable: true,
      verbs: ['share', 'unshare', 'revoke'],
      note: 'Follows whatever it envelopes; it never changes visibility on its own.',
    },
    open: [],
  },
  // -------------------------------------------------------------------------
  // POD-1211 — the session-adjacent half of POD-385's fourteen, plus the two
  // FILESYSTEM-BACKED session stores its method could not see at all. `uploads`
  // and `headless-turns` are directories under the state dir; no schema
  // mentions them, exactly as no schema mentions pspec.
  // -------------------------------------------------------------------------
  {
    id: ROW.offers,
    section: 'sessions',
    title: 'Agent action offers (`offers`)',
    sites: [
      '`offers` — keyed `session_id`, at most one live offer per session',
      'apps/server/src/store/sessions.ts',
      'apps/server/src/relay.ts',
      '[spec:SP-c7f1]',
    ],
    home: 'server',
    idMinting: 'Key `session_id` — the session IS the id',
    writers: ['agent-session', 'operator', 'system'],
    replication: 'server-to-clients',
    replicationNote: 'The offer bar is a live surface; an offer with no reader is pointless.',
    conflict: 'cmd',
    conflictNote:
      'Post / clear against a single-row-per-session key. A new offer REPLACES the old one — that is the product rule (a stale offer self-clears), not a merge.',
    tombstone: 'hard-delete',
    tombstoneNote:
      'Cleared by the operator’s next turn, by the agent’s own next turn, and cascaded on session delete.',
    offline: 'online-only',
    secret: 'public',
    secretNote: 'Prompt text and issue-artifact paths; no credential material.',
    owner: {
      kind: 'inherits',
      from: ROW.sessionIdentity,
      note: 'An offer is the session speaking to its owner; it has no life apart from the session.',
    },
    visibility: 'personal',
    grants: { kind: 'inherits', from: ROW.sessionIdentity },
    attribution: {
      actor: 'required',
      onBehalfOf: 'required',
      note: 'The posting agent is the actor; the offer is FOR its on-behalf-of human, which is what makes an offer an attention-routing act.',
    },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'parent', from: ROW.sessionIdentity },
    visibilityMutability: {
      mutable: true,
      verbs: ['share', 'unshare', 'revoke'],
      note: 'PHASE 2 MUST HANDLE: follows its session. `offers()` reads EVERY row in one statement today, with no principal in the query.',
    },
    open: [],
  },
  serverBookkeeping({
    id: ROW.sessionObservationBookkeeping,
    section: 'sessions',
    title:
      'Session observation leases, rebinds and terminal candidates (`session_observation_checkpoints`, `session_observation_rebinds`, `session_terminal_candidates`)',
    sites: [
      '`session_observation_checkpoints` — keyed `session_id`',
      '`session_observation_rebinds` — keyed `session_id`, cascades from the checkpoint',
      '`session_terminal_candidates` — keyed `session_id`, cascades from the checkpoint',
      'apps/server/src/store/observation-checkpoints.ts',
      '[spec:SP-cdb2]',
    ],
    idMinting: 'Key `session_id` in all three; the generation counters are server-allocated',
    writers: ['system', 'daemon'],
    conflictNote:
      'ONE row per session in each table, written only by the observation path, with staleness refused by GENERATION rather than merged — a rebind from an old observer generation is rejected, not applied late. All three agree on every column, which is why they are one row and the workflow surface was five: nothing here disagrees.',
    tombstoneNote: 'Cascades with the session (`ON DELETE CASCADE` from the checkpoint row).',
    attribution: {
      actor: 'required',
      onBehalfOf: 'none-representable',
      note: 'The observer is a machine/system principal watching a session; there is no human behind an observation.',
    },
  }),
  {
    id: ROW.sessionUploads,
    section: 'sessions',
    title: 'Session uploads (`<stateDir>/uploads/<sessionId>/`)',
    sites: [
      '`<stateDir>/uploads/<sessionId>/<id><ext>` — files on the daemon host, in NO schema',
      'apps/daemon/src/session-uploads.ts',
      'apps/daemon/src/upload.ts',
    ],
    home: 'runtime-local',
    idMinting: 'Daemon-minted file id under a per-session directory',
    writers: ['operator', 'agent-session'],
    replication: 'none',
    replicationNote:
      'Bytes on the daemon’s disk, referenced by path from the agent’s prompt. Not a replicated aggregate — it is in this matrix for its ADR 9 D4 declaration, on the `pspec-component` precedent.',
    conflict: 'n/a',
    conflictNote: 'Content-per-file with a minted id; two uploads are two files and never contend.',
    tombstone: 'hard-delete',
    tombstoneNote: 'Swept by a 24h TTL (`UPLOADS_TTL_MS`) on an hourly GC, and on session delete.',
    offline: 'online-only',
    secret: 'public',
    secretNote:
      'USER-SUPPLIED BYTES: whatever a person dropped into a session. Public in the matrix’s sense (no credential material by construction) but never public in the product’s.',
    owner: {
      kind: 'inherits',
      from: ROW.sessionIdentity,
      note: 'The session the file was uploaded into.',
    },
    visibility: 'personal',
    grants: { kind: 'inherits', from: ROW.sessionIdentity },
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'never-writes',
    inheritanceOnCreate: { kind: 'parent', from: ROW.sessionIdentity },
    visibilityMutability: {
      mutable: true,
      verbs: ['share', 'unshare', 'revoke'],
      note: 'PHASE 2 MUST HANDLE: follows its session, and the path is GUESSABLE by construction (`uploads/<sessionId>/<id>`), so whatever serves these bytes must check the session grant rather than the path.',
    },
    open: [],
  },
  {
    id: ROW.headlessTurnSpool,
    section: 'sessions',
    title: 'Durable headless turn spool (`<stateDir>/headless-turns/<hash>/`)',
    sites: [
      '`<stateDir>/headless-turns/<sha256(turnId)>/` — `input.txt`, `stdout.jsonl`, `result.json`, `mcp.json`, … in NO schema',
      'apps/daemon/src/durable-headless.ts',
    ],
    home: 'runtime-local',
    idMinting:
      'Directory name is `sha256(turnId)`; the turn id is minted by whoever started the turn',
    writers: ['agent-session', 'system'],
    replication: 'none',
    replicationNote:
      'Daemon-local spool that lets a headless turn survive a daemon restart. Never replicated; in the matrix for its D4 declaration.',
    conflict: 'n/a',
    conflictNote:
      'One directory per turn, written by the one process running that turn, with atomic file replacement.',
    tombstone: 'hard-delete',
    tombstoneNote:
      'Removed when the turn is reaped; a crashed turn leaves its directory until the next sweep, which is what makes the spool durable.',
    offline: 'observe-only',
    secret: 'secret-presence',
    secretNote:
      'THE SHARPEST CELL ON THIS ROW: `input.txt` is the prompt, `stdout.jsonl` is the agent’s whole output, and `mcp.json` is a HARNESS CONFIG that can name credentials. Conversation content and configuration on a plain filesystem path, with no row in any schema to make anyone look.',
    owner: { kind: 'inherits', from: ROW.sessionIdentity, note: 'The session whose turn it is.' },
    visibility: 'personal',
    grants: { kind: 'inherits', from: ROW.sessionIdentity },
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'parent', from: ROW.sessionIdentity },
    visibilityMutability: {
      mutable: true,
      verbs: ['share', 'unshare', 'revoke'],
      note: 'PHASE 2 MUST HANDLE: follows its session. Nothing serves these files over the wire today; the risk is a future diagnostic that does.',
    },
    open: [],
  },
]

// ---------------------------------------------------------------------------
// §3 Issues & tracker
// ---------------------------------------------------------------------------

const ISSUE_ROWS: readonly MatrixRow[] = [
  {
    id: ROW.issueCore,
    section: 'issues-and-tracker',
    title: 'Issue core (title, design, acceptance, type, priority, stage, assignee, due/defer, origin, audience, draft, panel, …)',
    sites: ['apps/server/src/modules/issues/service/crud.ts', 'packages/model/src/entities/issue.ts'],
    home: 'server',
    idMinting: '`iss_<uuid>`; a client-proposed id is accepted ONCE at create (optimistic reconcile) and the Authority still homes the row',
    writers: ['operator', 'agent-session'],
    replication: 'server-to-clients',
    conflict: 'exp-rev',
    conflictNote:
      'Stage transitions may be `cmd`. D2’s "low multi-writer contention (single-operator product)" rationale is VOID (Amendment 1 D11); the DECISION survives on the surviving ground: invariant-heavy graphs break under blind LWW and break HARDER with more writers. Consequence to know: POD-316 reject/rebase is now a NORMAL PATH, not an error screen — a priority change, not a design change.',
    tombstone: 'soft-delete',
    tombstoneNote: 'Soft-delete `deletedAt`; archive is orthogonal.',
    offline: 'offline-eligible',
    secret: 'public',
    owner: {
      kind: 'user',
      resolves: 'on-behalf-of-human',
      note: 'The creating principal’s on-behalf-of human (ADR 9 D5 A4).',
    },
    visibility: 'personal',
    grants: PERSONAL_GRANTS,
    attribution: {
      actor: 'required',
      onBehalfOf: 'required',
      note: 'INVENTORY FINDING (POD-364): the issue CLOSE and UNBLOCK actor is recorded NOWHERE — `closedReason` and `closedAt` exist, there is no actor column — and `deletion_source` is a CODE-PATH label (issue vs standalone) typed as bare text, carrying no principal at all. See the session-identity row’s interim defect for the conditional-spread class.',
    },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: {
      kind: 'on-behalf-of-human',
      note: 'DECLARED: a top-level issue has no parent to inherit from. A SUB-issue is a graph edge, not a containment — see the issue-graph row.',
    },
    visibilityMutability: {
      mutable: true,
      verbs: ['share', 'unshare', 'revoke', 'transfer-owner', 'reparent'],
      note: 'PHASE 2 MUST HANDLE: `reparent` is in this list because subtree scope is a MOVING SET — reparenting under an epic widens a working agent’s visibility with nobody having decided it (O3). That is recorded, not resolved.',
    },
    open: ['O3'],
    openNote: 'O3: whether `reparent` is a permission-affecting operation needing confirmation. Human call, Phase 3.',
  },
  {
    id: ROW.issueDocumentFields,
    section: 'issues-and-tracker',
    title: 'Issue document fields (`description`, `notes` / activity notes)',
    sites: ['packages/model/src/entities/issue.ts'],
    home: 'server',
    idMinting: 'n/a (fields of the issue row)',
    writers: ['operator', 'agent-session'],
    replication: 'server-to-clients',
    conflict: 'exp-rev',
    reservedConflict: { rule: 'op-stream', constraint: OP_STREAM_COMPACTION_CONSTRAINT },
    conflictNote:
      'SPLIT OUT of issue core deliberately: Amendment 1 D12 names composer draft body AND issue description/notes as `op-stream`’s ONLY permitted members, and a reservation that cannot be attached to a row is a reservation nobody can honour. Today’s rule is `exp-rev` (nothing implements op-streams — this issue does not build one). Adding a member to the reserved set requires an ADR 1 amendment, exactly as `field-LWW` does.',
    tombstone: 'n/a',
    tombstoneNote: 'Follows the issue tombstone.',
    offline: 'offline-eligible',
    secret: 'public',
    owner: { kind: 'inherits', from: ROW.issueCore },
    visibility: 'personal',
    grants: { kind: 'inherits', from: ROW.issueCore },
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'parent', from: ROW.issueCore },
    visibilityMutability: { mutable: true, verbs: ['share', 'unshare', 'revoke'], note: 'PHASE 2 MUST HANDLE: follows the issue.' },
    open: [],
  },
  {
    id: ROW.needsHuman,
    section: 'issues-and-tracker',
    title: 'Needs-human group (`needsHuman`, `humanQuestion`, options, `humanQuestionAskedBy`, `humanQuestionAskedAt`)',
    sites: ['packages/model/src/entities/issue.ts', 'apps/server/src/issues.answer-question.test.ts'],
    home: 'server',
    idMinting: 'n/a',
    writers: ['agent-session', 'operator'],
    replication: 'server-to-clients',
    conflict: 'exp-rev',
    conflictNote: 'The group moves together — that is what makes it a group.',
    tombstone: 'n/a',
    tombstoneNote: 'Clearing it is a write, not a tombstone.',
    offline: 'offline-eligible',
    secret: 'public',
    owner: { kind: 'inherits', from: ROW.issueCore },
    visibility: 'personal',
    grants: {
      kind: 'inherits',
      from: ROW.issueCore,
      note: 'Routing is PER-USER: needs-human questions, approvals and notifications reach THEIR human (ADR 9 D8 S3), which is a consequence of the per-user superagent, not extra work.',
    },
    attribution: {
      actor: 'required',
      onBehalfOf: 'required',
      note: 'PLACEMENT DECISION (this issue’s to make): `humanQuestionAskedBy` + `humanQuestionAskedAt` are SERVER-AUTHORITATIVE and stay ENTITY data on this group — NOT envelope data. Reason: server-authoritative attribution is a durable fact about the row that must survive bootstrap, export and re-replication, while the envelope is a droppable per-delivery fact; putting attribution there would make "did a person or an agent ask this?" unanswerable after one boundary hop. It is also the cheapest site to land the PAIR, since `askedBy` is already verified against `actorSessionId` at the write site — today it carries the ACTOR half only.',
    },
    systemWriter: 'never-writes',
    inheritanceOnCreate: { kind: 'parent', from: ROW.issueCore },
    visibilityMutability: { mutable: true, verbs: ['share', 'unshare', 'revoke'], note: 'PHASE 2 MUST HANDLE: follows the issue.' },
    open: [],
  },
  {
    id: ROW.issueGraph,
    section: 'issues-and-tracker',
    title: 'Issue graph (parent, deps, labels, blocked_by, superseded_by, duplicate_of)',
    sites: ['`issue_deps`', '`issue_labels`'],
    home: 'server',
    idMinting: 'n/a (edges keyed by their endpoints)',
    writers: ['operator', 'agent-session'],
    replication: 'server-to-clients',
    conflict: 'exp-rev',
    conflictNote: 'Plus `cmd` invariant checks — explicitly NOT field-LWW: issue core and graph are not independent fields, and blind merge produces states no command could have produced.',
    tombstone: 'remove',
    tombstoneNote: 'Edge removal is explicit.',
    offline: 'offline-eligible',
    secret: 'public',
    owner: { kind: 'inherits', from: ROW.issueCore, note: 'Specifically the EDGE’S OWNING ISSUE (Amendment 1 §3 §3).' },
    visibility: 'personal',
    grants: { kind: 'inherits', from: ROW.issueCore },
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: {
      kind: 'parent',
      from: ROW.issueCore,
      note: 'The edge inherits its OWNING issue, not both endpoints — which is precisely why a cross-boundary edge is possible and O2 exists.',
    },
    visibilityMutability: {
      mutable: true,
      verbs: ['share', 'unshare', 'revoke', 'reparent'],
      note: 'PHASE 2 MUST HANDLE: an edge can become visible while its far endpoint stays invisible, which is the case a scoped feed must not render as a dangling row.',
    },
    open: ['O2'],
    openNote:
      'O2: an issue may be blocked by / parented to / duplicated-with an issue you CANNOT SEE. Hide the edge, or show an opaque "blocked by something you cannot see" reference? The opaque form is usually right — hiding it makes the tracker LIE about why something is blocked — but it leaks EXISTENCE, so it is a human policy call (Phase 3, before any issue-graph wire change). NOT decided here. Dependency edges already carry a scope target and route through `overrideScope` → confirm-required, so the open part is DISPLAY, not authorization.',
  },
  {
    id: ROW.issueComments,
    section: 'issues-and-tracker',
    title: 'Issue comments',
    sites: ['`issue_comments`', 'apps/server/src/modules/issues/service/crud.ts (`cmt_<uuid>`)'],
    home: 'server',
    idMinting: '`cmt_<uuid>` server-minted',
    writers: ['operator', 'agent-session'],
    replication: 'server-to-clients',
    replicationNote: 'Detail may be lazy.',
    conflict: 'append',
    conflictNote: 'Append on create; edit/delete is `exp-rev` where allowed.',
    tombstone: 'never-delete',
    tombstoneNote: 'Retained by default.',
    offline: 'offline-eligible',
    secret: 'public',
    owner: {
      kind: 'user',
      resolves: 'on-behalf-of-human',
      note: 'The COMMENTING principal’s human owns the comment; VISIBILITY inherits the issue (Amendment 1 §3 §3). Owner and visibility genuinely diverge here, which is why they are two columns.',
    },
    visibility: 'personal',
    grants: { kind: 'inherits', from: ROW.issueCore },
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'never-writes',
    inheritanceOnCreate: {
      kind: 'parent',
      from: ROW.issueCore,
      note: 'GRANTS inherit the parent issue (otherwise sharing an issue would not share its discussion); OWNER is the actor’s human. Declared as a split, not assumed.',
    },
    visibilityMutability: { mutable: true, verbs: ['share', 'unshare', 'revoke'], note: 'PHASE 2 MUST HANDLE: follows the issue.' },
    open: [],
  },
  {
    id: ROW.issueMessages,
    section: 'issues-and-tracker',
    title: 'Issue messages (tracker mail, `issue_messages`)',
    sites: ['apps/server/src/modules/issues/registry.ts (`mailSend` / `mailInbox` / `mailClaim`)'],
    home: 'server',
    idMinting: '`msg_<uuid>`',
    writers: ['system', 'agent-session', 'operator'],
    replication: 'server-to-clients',
    conflict: 'append',
    conflictNote: 'Append, with status as `cmd`.',
    tombstone: 'never-delete',
    tombstoneNote: 'Retained for history.',
    offline: 'offline-eligible',
    secret: 'public',
    owner: { kind: 'inherits', from: ROW.issueCore },
    visibility: 'personal',
    grants: {
      kind: 'inherits',
      from: ROW.issueCore,
      note: 'FOR READ ONLY. Send is DELIBERATELY not gated by the reader’s grants: `mailSend` carries `action: write` with NO target, because addressing another issue is the whole point. Multi-user adds exactly two clauses, both ADR 9 D7’s and not restated as policy here: the unscoped send is bounded by the HUMAN CEILING (an agent may mail any issue its delegating human can see, and none it cannot), and mailing an INVISIBLE issue must fail IDENTICALLY to mailing a nonexistent id — divergent errors turn the send path into an existence oracle.',
    },
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'parent', from: ROW.issueCore },
    visibilityMutability: { mutable: true, verbs: ['share', 'unshare', 'revoke'], note: 'PHASE 2 MUST HANDLE: read visibility follows the issue.' },
    open: ['O1'],
    openNote:
      'O1 at a concrete site: the consistent-error rule is the ONE instance of the existence-leak class that is already decided (ADR 9 D7 clause 2). The rest of the class stays open.',
  },
  perUserState({
    id: ROW.issueMessageReadAt,
    section: 'issues-and-tracker',
    title: 'Issue message / issue `readAt` (moved by Amendment 1 D10)',
    sites: ['`issue_user_state` — keyed `(user_id, issue_id)`, carrying `read_at` / `tucked_at` / `pinned_at`', '`issue_message_user_state` — keyed `(user_id, issue_message_id)`', '(both POD-1076; the markers were `issues.read_at` and `issue_messages.read_at` columns until then)'],
    conflictNote: 'Two more SINGLETON `read_at` columns today; the same re-key as the session one.',
  }),
  {
    id: ROW.artifacts,
    section: 'issues-and-tracker',
    title: 'Artifacts (snapshotted files)',
    sites: ['`<stateDir>/artifacts` — IssueArtifactStore (apps/server/src/relay.ts)', 'apps/server (artifact storage)'],
    home: 'server',
    idMinting: 'Server artifact id',
    writers: ['operator', 'agent-session'],
    replication: 'server-to-clients',
    replicationNote: 'Bulk / lazy plane (ADR 7).',
    conflict: 'cmd',
    tombstone: 'hard-delete',
    tombstoneNote: 'Delete the object; the issue may retain references.',
    offline: 'online-only',
    secret: 'public',
    secretNote: 'Public bytes; paths validated.',
    owner: { kind: 'inherits', from: ROW.issueCore, note: 'Inherits its SESSION or ISSUE, whichever it hangs on.' },
    visibility: 'personal',
    grants: { kind: 'inherits', from: ROW.issueCore },
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'parent', from: ROW.issueCore, note: 'An artifact on a session inherits the session; on an issue, the issue.' },
    visibilityMutability: { mutable: true, verbs: ['share', 'unshare', 'revoke'], note: 'PHASE 2 MUST HANDLE: follows its parent.' },
    open: [],
  },
  // -------------------------------------------------------------------------
  // POD-1211 — the issue-adjacent half of POD-385's fourteen.
  // -------------------------------------------------------------------------
  {
    id: ROW.activityEvents,
    section: 'issues-and-tracker',
    title: 'Activity event log (`podium_events`)',
    sites: [
      '`podium_events`',
      'apps/server/src/store/events.ts',
      'apps/server/src/modules/events/retention.ts',
    ],
    home: 'server',
    idMinting: 'Server `id` AUTOINCREMENT; the cursor a reader carries is that id',
    writers: ['system', 'operator', 'agent-session'],
    replication: 'server-to-clients',
    replicationNote:
      'Read through the `issues.events` query with a cursor, NOT through the change log — a second read path over durable rows, which is why it needed its own row rather than riding `change-log`’s.',
    conflict: 'append',
    conflictNote:
      'Append-only, by the server alone. An event is a record that something happened; nothing merges.',
    tombstone: 'hard-delete',
    tombstoneNote:
      'Pruned by age AND by a count cap (`apps/server/src/modules/events/retention.ts`); a cursor older than the retained window silently misses what was pruned, which the store documents on `listEventsSince`.',
    offline: 'online-only',
    secret: 'public',
    secretNote: 'Payloads are free-form JSON per kind and must not carry `secret-value` material.',
    owner: {
      kind: 'none',
      reason: 'derived',
      note: 'An event names a SUBJECT — a session, an issue, a repo path — and derives its reachability from that subject, exactly as `blobs` derives its from every referencing entity. Naming one owner would lie for every kind whose subject is a different class.',
    },
    visibility: 'personal',
    grants: {
      kind: 'none',
      reason: 'derived',
      note: 'Not grantable on its own: an event is readable only VIA a subject the principal may see.',
    },
    attribution: {
      actor: 'required',
      onBehalfOf: 'required',
      note: 'INVENTORY GAP, stated rather than fixed here: the table has `kind` / `subject` / `payload` and NO actor columns, so who caused an event is recoverable only from whatever the payload happened to include. The row declares the obligation; the schema does not yet carry it.',
    },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: {
      kind: 'not-applicable',
      reason:
        'Derived: an event inherits nothing at create, because its reachability is resolved through its subject at read time.',
    },
    visibilityMutability: {
      mutable: true,
      verbs: ['share', 'unshare', 'revoke'],
      note: 'PHASE 2 MUST HANDLE, and this is the row’s sharpest edge: `issues.events` is a CURSOR READ OVER EVERY SUBJECT IN THE INSTANCE with no per-principal filter, so the scoped feed must filter it by subject the way it filters the change log — a filter without a watermark here is a silently short page rather than a protocol break, which makes it easier to get wrong and harder to notice.',
    },
    open: ['O1'],
    openNote:
      'O1: an event row discloses that a subject EXISTS and that something happened to it, ahead of any decision about the subject’s own visibility. Marked at the site where the existence question is concrete, not resolved.',
  },
  {
    id: ROW.eventSubscriptions,
    section: 'issues-and-tracker',
    title: 'Event subscriptions (`subscriptions`)',
    sites: [
      '`subscriptions`',
      'apps/server/src/store/events.ts',
      'apps/server/src/modules/issues/service/crud.ts (`subscriptionSetEnabled`)',
    ],
    home: 'server',
    idMinting: 'Server id',
    writers: ['operator', 'agent-session', 'system'],
    replication: 'server-to-clients',
    conflict: 'cmd',
    conflictNote:
      'Subscribe / unsubscribe / enable are commands against a row keyed by its subscriber; nothing merges.',
    tombstone: 'hard-delete',
    tombstoneNote:
      'Unsubscribe removes the row; `enabled = 0` is the softer state and is a different act.',
    offline: 'online-only',
    secret: 'public',
    owner: {
      kind: 'user',
      resolves: 'on-behalf-of-human',
      note: 'A subscription is a ROUTING INTENT belonging to whoever will be woken by it: the human behind the `(subscriber_kind, subscriber_id)` principal. `origin = auto` rows are created by the server on that principal’s behalf and are owned the same way — the server subscribes you, it does not own your attention.',
    },
    visibility: 'personal',
    grants: {
      kind: 'none',
      reason: 'derived',
      note: 'Not shareable. "Share my subscription" would mean routing MY wakes to someone else, which is a subscription of THEIRS to create, not a grant on this row.',
    },
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: {
      kind: 'on-behalf-of-human',
      note: 'DECLARED as the subscriber’s human rather than the SOURCE entity’s owner: subscribing to somebody else’s issue must not hand them your subscription.',
    },
    visibilityMutability: {
      mutable: true,
      verbs: ['share', 'unshare', 'revoke', 'account-disable'],
      note: 'PHASE 2 MUST HANDLE on TWO axes: the subscription list must be scoped to its subscriber, and a revoke on the SOURCE entity must stop delivery — a subscription that outlives the subscriber’s access to what it watches is a leak with a schedule.',
    },
    open: [],
  },
  serverBookkeeping({
    id: ROW.subscriptionDeliveries,
    section: 'issues-and-tracker',
    title: 'Subscription delivery receipts (`subscription_deliveries`)',
    sites: [
      '`subscription_deliveries` — keyed `(subscription_id, event_id)`',
      'apps/server/src/store/events.ts',
    ],
    idMinting: 'Key `(subscription_id, event_id)` — the pair IS the receipt',
    conflictNote:
      'At-most-once delivery: `INSERT OR IGNORE` returning "did this insert" is the whole mechanism, so the receipt is the dedupe and there is nothing to merge.',
    tombstoneNote:
      'Pruned with the events they reference; a receipt for a pruned event can never be needed again.',
  }),
]

// ---------------------------------------------------------------------------
// §4 Conversations & transcripts
// ---------------------------------------------------------------------------

const CONVERSATION_ROWS: readonly MatrixRow[] = [
  {
    id: ROW.conversationRegistry,
    section: 'conversations-and-transcripts',
    title: 'Conversation registry',
    sites: ['`conversation_identities`', 'packages/model/src/entities/conversation.ts', 'docs/spec/conversation-registry.md'],
    home: 'server',
    idMinting: 'Server-stable Podium conversation id',
    writers: ['system', 'operator'],
    replication: 'server-to-clients',
    conflict: 'exp-rev',
    conflictNote: 'exp-rev on user fields; LINK rules are `cmd`, biased against mis-merge (two conversations wrongly joined is worse than two left apart).',
    tombstone: 'soft-delete',
    tombstoneNote: 'Soft removal from resume lists.',
    offline: 'offline-eligible',
    secret: 'public',
    owner: { kind: 'inherits', from: ROW.sessionIdentity, note: 'The session that produced it.' },
    visibility: 'personal',
    grants: { kind: 'inherits', from: ROW.sessionIdentity },
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: {
      kind: 'parent',
      from: ROW.sessionIdentity,
      note: 'DECLARED as the producing session — but a conversation can SPAN sessions, and the multi-parent case is exactly O4’s open part. Recorded, not resolved.',
    },
    visibilityMutability: { mutable: true, verbs: ['share', 'unshare', 'revoke'], note: 'PHASE 2 MUST HANDLE: follows the session.' },
    open: ['O4'],
    openNote:
      'O4: a conversation spanning several sessions has several candidate parents, so "inherit the parent" does not identify one. The annotation SHAPE is this issue’s (and is above); the VALUE for the multi-parent case is the per-class feature owner’s.',
  },
  {
    id: ROW.segments,
    section: 'conversations-and-transcripts',
    title: 'Segments / native evidence',
    sites: ['`conversation_segments` — keyed `(machine_id, native_id)`', 'packages/transcript', 'the disk lake'],
    home: 'server',
    idMinting: 'Composite `(machine_id, native_id)`',
    writers: ['daemon', 'system'],
    replication: 'daemon-to-server-to-clients',
    replicationNote: 'Metadata to clients; BYTES on the bulk/lazy plane.',
    conflict: 'single-writer',
    conflictNote: 'One writer per segment identity.',
    tombstone: 'hard-delete',
    tombstoneNote: 'Retention / compaction is ADR 2’s.',
    offline: 'observe-only',
    secret: 'public',
    owner: { kind: 'inherits', from: ROW.conversationRegistry },
    visibility: 'personal',
    grants: { kind: 'inherits', from: ROW.conversationRegistry },
    attribution: { actor: 'required', onBehalfOf: 'none-representable', note: 'Machine principal on the mirror path.' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'parent', from: ROW.conversationRegistry },
    visibilityMutability: { mutable: true, verbs: ['share', 'unshare', 'revoke'], note: 'PHASE 2 MUST HANDLE: follows the conversation.' },
    open: [],
  },
  {
    id: ROW.blobs,
    section: 'conversations-and-transcripts',
    title: 'Blobs (content-addressed)',
    sites: ['the content-addressed store', '`<stateDir>/transcripts` — the mirror lake on disk (`mirrorLakeDir`, apps/server/src/server.ts)'],
    home: 'server',
    idMinting: 'sha256 — identity IS the hash',
    writers: ['system'],
    replication: 'server-to-clients',
    replicationNote: 'Bulk / on-view.',
    conflict: 'single-writer',
    conflictNote: 'Content addressing removes the conflict: two writers of the same bytes write the same row.',
    tombstone: 'hard-delete',
    tombstoneNote: 'GC by retention.',
    offline: 'online-only',
    secret: 'public',
    owner: {
      kind: 'none',
      reason: 'derived',
      note: 'Identity is the hash, and ONE blob may back several owners — so a single owner cannot be named without lying.',
    },
    visibility: 'personal',
    grants: {
      kind: 'none',
      reason: 'derived',
      note: 'A blob is readable only VIA a reference the principal may see; it inherits EVERY referencing entity rather than carrying its own grant.',
    },
    attribution: { actor: 'required', onBehalfOf: 'none-representable', note: 'Ingest is a system/machine act.' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: {
      kind: 'not-applicable',
      reason: 'Derived: no owner, and access is mediated by references rather than by grants of its own.',
    },
    visibilityMutability: {
      mutable: true,
      verbs: ['share', 'unshare', 'revoke'],
      note: 'PHASE 2 MUST HANDLE: reachability changes with every referencing entity’s grants, so a blob can become visible without any blob row changing.',
    },
    open: ['O1'],
    openNote:
      'O1 at a concrete site: cross-owner DEDUP is an existence-leak surface — asking for a hash reveals whether someone else already stored those bytes. Marked, not resolved.',
  },
]

// ---------------------------------------------------------------------------
// §5 Repos, pins, tabs
// ---------------------------------------------------------------------------

const REPO_ROWS: readonly MatrixRow[] = [
  {
    id: ROW.repoPrefix,
    section: 'repos-pins-tabs',
    title: 'Repo / prefix (`repos`, `repo_prefixes`)',
    sites: ['`repos` (keyed `(machine_id, path)`)', '`repo_prefixes`'],
    home: 'server',
    idMinting: 'Path key; prefix is server-unique',
    writers: ['operator', 'daemon'],
    replication: 'server-to-clients',
    conflict: 'exp-rev',
    conflictNote: 'exp-rev on prefix rename; removal is `cmd`.',
    tombstone: 'remove',
    offline: 'online-only',
    secret: 'public',
    owner: {
      kind: 'inherits',
      from: ROW.machine,
      note: 'Amendment 1 D13.5: per-machine FACTS inherit the machine’s scoping and carry no owner of their own. Giving them their own owners would create incoherent states — a repo visible to someone with no `see` on its machine.',
    },
    visibility: 'owned-compute',
    grants: { kind: 'inherits', from: ROW.machine, note: '`see` to list, `use` to work in.' },
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'parent', from: ROW.machine },
    visibilityMutability: {
      mutable: true,
      verbs: ['grant-see', 'grant-use', 'revoke', 'transfer-owner'],
      note: 'PHASE 2 MUST HANDLE: the whole per-machine fact set appears/disappears with one machine grant.',
    },
    open: ['O1'],
    openNote: 'O1: "this worktree is in use" is an existence fact about someone else’s work. Marked, not resolved.',
  },
  /**
   * THE PROJECT SPEC (pspec v1), added by POD-385 because it was MISSING.
   *
   * The brief for the spec contracts said "check its ADR 1 matrix row rather
   * than assuming `personal`". There was no row: `visibilityClassOf('pspec-component')`
   * answered `personal` from D4's default-closed backstop, which is the backstop
   * FIRING rather than a declaration, and the spec contracts would have carried a
   * classification the matrix contradicted. ADR 9 D4 enforcement rule 1 is explicit
   * that the declaration lands here, so it does.
   *
   * IT IS NOT `personal`, and that is the whole finding. A pspec component is one
   * HTML file inside a registered repository's `pspec/` directory on the machine
   * that hosts that repo — `[spec:SP-xxxx]` markers across the tracker join code to
   * it, so it is a SHARED artefact, not one person's document. ADR 9 D3 rule 3
   * decides it: facts about a machine (repos, prefixes, worktrees) inherit the
   * machine's scoping and carry no visibility of their own, and a file inside a
   * repo working tree is exactly such a fact. The row therefore mirrors
   * {@link ROW.repoPrefix} — `owned-compute`, inheriting the machine, `see` to read
   * the tree and `use` to write into it.
   *
   * The shipped service already behaves this way and that is the evidence, not the
   * hope: `modules/specs/service.ts` gates every proc on `isAllowedRoot(repoRoots)`
   * — the machine's repo registry, nothing else — and then requires the root to
   * exist ON THIS HOST. There is no owner column anywhere in the store to hang a
   * `personal` classification on.
   */
  {
    id: ROW.pspecComponent,
    section: 'repos-pins-tabs',
    title: 'Project spec component (pspec v1)',
    sites: [
      '`<repo>/pspec/SP-xxxx.html` — files in the repo working tree, on the machine that hosts the repo',
      '`apps/server/src/pspec.ts` (the pure file store); `apps/server/src/modules/specs/service.ts` (the repo-root gate)',
    ],
    home: 'server',
    idMinting:
      'Server-minted `SP-xxxx` (4 hex chars, retried on collision) at `createSpec`; the root is the fixed `SP-root`. The id is the stable join key `[spec:SP-xxxx]` code comments and `<a href="#spec:SP-xxxx">` interlinks resolve against, so it is never reassigned.',
    writers: ['operator', 'agent-session'],
    replication: 'none',
    replicationNote:
      'NOT a replicated aggregate. The bytes live in the repo working tree and are versioned by GIT, not by the change log — no table, no revision, no delta. It is in this matrix for its ADR 9 D4 visibility declaration (enforcement rule 1), which every entity class owes whether or not it replicates, exactly as `instance-id` is here with `replication: none`.',
    conflict: 'n/a',
    conflictNote:
      'No arbitration rule, because there is no replicated copy to arbitrate against: two writers racing on one component is a working-tree write race that git resolves, the same way it resolves two edits to any other file in the repo. Declaring `field-LWW` or `exp-rev` here would claim a kernel behaviour that does not exist for this class.',
    tombstone: 'hard-delete',
    tombstoneNote:
      '`removeSpec` unlinks the file and refuses a component that still has children, so the tree cannot be orphaned. Recovery is git, not a tombstone.',
    offline: 'online-only',
    secret: 'public',
    owner: {
      kind: 'inherits',
      from: ROW.machine,
      note: 'Amendment 1 D13.5 / ADR 9 D3 rule 3: a file in a repo working tree is a per-machine FACT and inherits the machine’s scoping. Giving spec components their own owners would produce the same incoherent state repo rows would — a spec visible to someone with no `see` on the machine holding the only copy.',
    },
    visibility: 'owned-compute',
    grants: {
      kind: 'inherits',
      from: ROW.machine,
      note: '`see` to read the spec tree, `use` to write into it — the same pair as the repo the files live in.',
    },
    attribution: {
      actor: 'not-applicable',
      onBehalfOf: 'not-applicable',
      note: 'THE STORE RECORDS NEITHER HALF. A component file carries `id`, `title`, `parent`, `order`, `status` and `updatedAt` and no writer identity at all; authorship is git’s to answer. Said here rather than left blank so the gap is a declaration and not an omission — and note that the COMMAND contracts still stamp the pair from the transport principal (ADR 3 D7), because who was allowed to write is a different question from what the file remembers.',
    },
    systemWriter: 'never-writes',
    inheritanceOnCreate: {
      kind: 'parent',
      from: ROW.machine,
      note: 'A new component is reachable by exactly whoever could already reach the repo it was created in.',
    },
    visibilityMutability: {
      mutable: true,
      verbs: ['grant-see', 'grant-use', 'revoke', 'transfer-owner'],
      note: 'PHASE 2 MUST HANDLE: like every per-machine fact, the whole spec tree appears or disappears with one machine grant — no per-component act changes who can see it.',
    },
    open: ['O1'],
    openNote:
      'O1: the component TREE is an existence surface — `podium spec tree` names every component of a project, so seeing the tree reveals what work exists even where a body is never opened. Marked, not resolved.',
  },
  perUserState({
    id: ROW.pins,
    section: 'repos-pins-tabs',
    title: 'Pins',
    sites: ['`pins` — keyed `(user_id, kind, id)` (POD-1076; `(kind, id)` and therefore a singleton until then)'],
    conflictNote: 'The sidebar is "my tasks" (readiness header decision), so a pin is mine by definition.',
  }),
  perUserState({
    id: ROW.tabOrder,
    section: 'repos-pins-tabs',
    title: 'Tab order',
    sites: ['`tab_order` — keyed `(user_id, worktree)` (POD-1076; `worktree` alone and therefore a singleton until then)'],
    conflictNote: 'Session order within a worktree is per person by definition. The whole order vector was one field-LWW group; keyed per user it is single-writer instead.',
    tombstoneNote: 'Scrubbed with sessions, and cascades on user deletion.',
  }),
  perUserState({
    id: ROW.sidebarTabLayout,
    section: 'repos-pins-tabs',
    title: 'Sidebar / tab layout',
    sites: [
      '`user_layout` — keyed `(user_id, key)` (POD-1350; client-local ui-state until then)',
      'packages/model/src/user-state/layout-state.ts — closed key vocabulary shared with POD-403',
    ],
    conflictNote:
      'Shell chrome (dock tab, superagent open, panel modes, section collapses) is per person by definition. Key-at-a-time so concurrent multi-device writes of independent keys do not last-writer-wins over the whole shell. Device-local route, selection, focus, pane/split geometry and screen pixel widths are NOT this row — they stay in principal-namespaced client ui-state (POD-403).',
    tombstoneNote: 'Cascades on user deletion. No entity lifecycle owns these rows.',
  }),
  perUserState({
    id: ROW.feedReadCursor,
    section: 'repos-pins-tabs',
    title: 'Event-stream read cursor',
    sites: [
      '`user_read_position` — keyed `(user_id, stream_id)` (POD-1380; device-local ui-state until then)',
      'packages/model/src/user-state/read-position-state.ts — closed stream vocabulary + the monotonic rule',
    ],
    conflictNote:
      'How far a person has read an ordered log, so it is theirs by definition (readiness §3.3). NOT the `readAt` rows above: those are per-ENTITY timestamps and merge last-writer-wins, while a cursor is a POSITION and merges MONOTONICALLY — `max(stored, proposed)`, executed by advanceReadPosition and declared as `readPosition.advance`\'s `cmd` conflict rule. Under LWW a device writing before its hydration lands would move the marker backward and re-mark read events unread.',
    tombstoneNote: 'Cascades on user deletion. No entity lifecycle owns these rows.',
  }),
  // -------------------------------------------------------------------------
  // POD-1211 — two per-machine FILESYSTEM stores. Neither appears in any
  // drizzle schema: `discovery.db` is a SECOND SQLite database, created at
  // runtime with `CREATE TABLE IF NOT EXISTS` under the state dir, and the
  // hooks directory is plain files. Amendment 1 D13.5 / ADR 9 D3 rule 3 puts
  // both with the machine they describe.
  // -------------------------------------------------------------------------
  {
    id: ROW.harnessDiscoveryCache,
    section: 'repos-pins-tabs',
    title: 'Harness discovery cache (`<stateDir>/discovery.db`)',
    sites: [
      '`<stateDir>/discovery.db` — its own SQLite file, tables `conversation_cache` and `meta`, created at runtime and in NO drizzle schema',
      'packages/harness/src/discovery/cache.ts',
    ],
    home: 'runtime-local',
    idMinting: 'Keyed by the provider’s own session/file identity on that host',
    writers: ['daemon', 'system'],
    replication: 'none',
    replicationNote:
      'A per-machine derived index over harness transcript files on that host’s disk. What replicates is the CONVERSATION REGISTRY built from it, not the cache.',
    conflict: 'n/a',
    conflictNote:
      'Derived: it is rebuilt from the files it indexes, so a lost or stale cache is a re-scan and never a merge.',
    tombstone: 'hard-delete',
    tombstoneNote:
      'Deletable at any time; the next discovery pass rebuilds it from the provider files.',
    offline: 'observe-only',
    secret: 'secret-presence',
    secretNote:
      'Indexes CONVERSATION metadata — titles, paths, project directories — for every harness on the host, including sessions Podium never started.',
    owner: {
      kind: 'inherits',
      from: ROW.machine,
      note: 'Amendment 1 D13.5: a per-machine fact inherits the machine’s scoping. It indexes what is on THAT disk and means nothing anywhere else.',
    },
    visibility: 'owned-compute',
    grants: {
      kind: 'inherits',
      from: ROW.machine,
      note: '`see` on the machine; the cache is never separately grantable.',
    },
    attribution: {
      actor: 'required',
      onBehalfOf: 'none-representable',
      note: 'A machine principal indexing its own disk.',
    },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'parent', from: ROW.machine },
    visibilityMutability: {
      mutable: true,
      verbs: ['grant-see', 'revoke', 'transfer-owner'],
      note: 'PHASE 2 MUST HANDLE: appears and disappears with the machine grant, like every other per-machine fact.',
    },
    open: [],
  },
  {
    id: ROW.harnessHookSettings,
    section: 'repos-pins-tabs',
    title: 'Harness hook settings (`<stateDir>/hooks/`)',
    sites: [
      '`<stateDir>/hooks/` — harness settings files written by the daemon, in NO schema',
      'apps/daemon/src/daemon.ts',
    ],
    home: 'runtime-local',
    idMinting: 'Path per harness; the daemon owns the layout',
    writers: ['daemon'],
    replication: 'none',
    replicationNote:
      'Host configuration for the agent CLIs this daemon launches. Never replicated.',
    conflict: 'n/a',
    conflictNote:
      'The daemon rewrites the files it owns; there is no second writer to arbitrate against.',
    tombstone: 'hard-delete',
    tombstoneNote: 'Regenerated on the next daemon boot.',
    offline: 'n/a',
    secret: 'secret-presence',
    secretNote:
      'Harness configuration, not credentials — but it names what the agent may reach, so it is not `public`.',
    owner: {
      kind: 'inherits',
      from: ROW.machine,
      note: 'Configuration OF a machine, inheriting that machine’s scoping (D13.5).',
    },
    visibility: 'owned-compute',
    grants: {
      kind: 'inherits',
      from: ROW.machine,
      note: 'Changing what a host’s agents may do is `manage` on the machine, never a personal write.',
    },
    attribution: {
      actor: 'required',
      onBehalfOf: 'none-representable',
      note: 'The daemon writing its own host configuration.',
    },
    systemWriter: 'never-writes',
    inheritanceOnCreate: { kind: 'parent', from: ROW.machine },
    visibilityMutability: {
      mutable: true,
      verbs: ['grant-see', 'grant-manage', 'revoke', 'transfer-owner'],
      note: 'PHASE 2 MUST HANDLE: follows the machine, and `manage` rather than `see` is the verb that matters — editing hooks changes what every agent on that host does.',
    },
    open: [],
  },
]

// ---------------------------------------------------------------------------
// §6 Settings, secrets, accounts
// ---------------------------------------------------------------------------

const SETTINGS_ROWS: readonly MatrixRow[] = [
  perUserState({
    id: ROW.preferencesPersonal,
    section: 'settings-secrets-accounts',
    title: 'Preferences — PERSONAL keys (session defaults, sidebar, autoContinue, `telegramChatId`, ntfy topic, …)',
    sites: [
      'packages/model/src/settings/preferences.ts (`PersonalPreferences` — keyed `(userId)`, POD-418)',
      "`user_preferences` — the VALUES at rest, keyed `(user_id, key)` (POD-1213). They were members of the instance-wide `meta['settings']` blob until then, which is why this row read as a claim about a shape rather than about storage.",
      'packages/runtime/src/settings.ts (`PodiumSettings` — the blob the wire still uses, COMPOSED from the split groups; its personal members are resolved PER READER and no longer stored on it)',
    ],
    conflictNote:
      'Moved out of field-LWW by Amendment 1 D10. `notifications.telegramChatId` moves here explicitly (ADR 9 D8 S4): it is ROUTING CONFIG, not a secret, and classifying it as a secret would break the per-user notification routing S3 depends on.',
    secret: 'preference',
    secretNote:
      'NON-OBVIOUS CONSEQUENCE, recorded because it is easy to skip: a per-user superagent makes the INBOUND Telegram edge an AUTHENTICATION surface. An arriving message must resolve to a USER before anything acts on it, which needs a real binding ceremony (a claim code, the shape of machine pairing). UNKNOWN CHATS MUST FAIL CLOSED and must never fall back to an operator identity. The ceremony is ADR 3 / ADR 9 territory; this row only records that the fallback is forbidden.',
  }),
  {
    id: ROW.preferencesInstance,
    section: 'settings-secrets-accounts',
    title: 'Preferences — INSTANCE / deployment keys (instance-level settings, feature flags)',
    sites: [
      'packages/model/src/settings/preferences.ts (`InstancePreferences`, POD-418)',
      'packages/runtime/src/settings.ts',
      '[spec:SP-f4b9] `settings.experimental`',
    ],
    home: 'server',
    idMinting: 'Settings singleton / keys',
    writers: ['operator'],
    replication: 'server-to-clients',
    conflict: 'field-LWW',
    conflictNote:
      'THE ONLY SURVIVING field-LWW MEMBER (Amendment 1 D10). Clock: the Authority-assigned event time at commit — client wall clocks never arbitrate (ADR 1 D3 condition 1). Invariant: PER KEY, and keys are genuinely independent of each other; secrets are excluded from the group. All four of D3’s conditions still hold: defined clock, independent group, low semantic risk (admin-written preference toggles), and reset-to-default is a write on the same clock. Kept rather than pushed to `exp-rev` because exp-rev would surface conflicts on preference toggles — worse UX for no invariant gained.',
    tombstone: 'never-delete',
    tombstoneNote: 'Reset-to-default is a write, not a delete.',
    offline: 'offline-eligible',
    secret: 'preference',
    secretNote: '`settings.experimental` is a PREFERENCE, intentionally replicated, and carries no secret annotation (POD-418).',
    owner: {
      kind: 'none',
      reason: 'substrate',
      note: 'A property of the DEPLOYMENT, not of a person (ADR 9 D3 rule 1).',
    },
    visibility: 'deployment-substrate',
    grants: { kind: 'none', reason: 'substrate', note: 'Write is admin-grade.' },
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'not-applicable', reason: 'Substrate: no owner, no grants.' },
    visibilityMutability: {
      mutable: false,
      verbs: [],
      note: 'Tenant-visible from creation. Note the RATCHET: moving a class INTO deployment-substrate, or widening a grant verb set, requires an ADR 1 amendment (D9.3) — privacy is free, exposure is reviewed.',
    },
    open: [],
  },
  {
    id: ROW.serverSecrets,
    section: 'settings-secrets-accounts',
    title: 'Server-owned secrets (`apiKeys.*`, `integrations.linearApiKey`, `notifications.telegramBotToken`)',
    sites: [
      '`server_secrets`',
      'packages/model/src/settings/secrets.ts (`ServerSecret` at rest; `SecretPresenceWire` on the wire, POD-418)',
      'packages/runtime/src/settings.ts (the legacy in-blob groups POD-419 scrubs)',
    ],
    home: 'server',
    idMinting: 'n/a',
    writers: ['operator'],
    replication: 'none',
    replicationNote: 'VALUES never replicate. The wire carries `secret-presence` (+ fingerprint) at most.',
    conflict: 'cmd',
    conflictNote: 'Online replace only.',
    tombstone: 'hard-delete',
    tombstoneNote: 'Cleared server-side.',
    offline: 'never-enqueue',
    secret: 'secret-value',
    secretNote:
      'ADR 1 D6 UNCHANGED: server-local only, never replicated, never queued. The Outbox must refuse the class outright — a generic offline `settings.set` would persist secrets into browser/mobile replica storage AND into the outbox (POD-352).',
    owner: {
      kind: 'none',
      reason: 'secret',
      note: 'D15: the material is the INSTANCE’s, not personal. Giving secrets an owner would multiply the surface D6 exists to minimise and would imply transfer semantics for credentials.',
    },
    visibility: 'secret',
    grants: NO_GRANTS_SECRET,
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'never-writes',
    inheritanceOnCreate: { kind: 'not-applicable', reason: 'Secret: no owner and no grants (D15).' },
    visibilityMutability: {
      mutable: false,
      verbs: [],
      note: 'Never replicated, so replica visibility cannot change. What multi-user changes is WHO MAY ROTATE: management is ADMIN-GRADE once there is more than one human (D15) — "any authenticated principal may replace the org’s provider key" is a privilege escalation with a billing blast radius.',
    },
    open: [],
  },
  {
    id: ROW.managedCredentials,
    section: 'settings-secrets-accounts',
    title: 'Managed credentials / accounts (`accounts`)',
    sites: ['`accounts.credential`'],
    home: 'server',
    idMinting: 'Server account id',
    writers: ['operator', 'system'],
    replication: 'none',
    replicationNote: 'Presence / identity reach clients; VALUES never do. Injection at spawn is server→daemon.',
    conflict: 'exp-rev',
    tombstone: 'hard-delete',
    tombstoneNote: 'Delete the row.',
    offline: 'never-enqueue',
    secret: 'secret-value',
    secretNote: '`secret-value` at rest.',
    owner: { kind: 'none', reason: 'secret', note: '`secret` at rest (D15).' },
    visibility: 'secret',
    grants: {
      kind: 'none',
      reason: 'secret-admin-grade',
      note: '`manage` is admin-grade; INJECTION at spawn is bounded by the spawning principal’s rights. O5 is adjacent and open: server-injected material is separable from a host and should plausibly bill the DELEGATING human rather than the machine owner — that is a per-feature call and must not be modelled speculatively.',
    },
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'not-applicable', reason: 'Secret: no owner and no grants (D15).' },
    visibilityMutability: { mutable: false, verbs: [], note: 'Values never replicate; `manage` is admin-grade.' },
    open: ['O5'],
    openNote:
      'O5: with `use` granted on a machine, LOCAL credentials remain the machine owner’s and are not separable from the host — the model does not close this, and readiness leans to product copy rather than a speculative model. Recorded so it stays visible.',
  },
  {
    id: ROW.configFeatures,
    section: 'settings-secrets-accounts',
    title: 'Operator `config.features` (feature flags)',
    sites: ['the process config'],
    home: 'runtime-local',
    idMinting: 'n/a',
    writers: ['operator'],
    replication: 'none',
    replicationNote: 'Not an entity-sync surface at all; deploy-time.',
    conflict: 'n/a',
    tombstone: 'n/a',
    offline: 'n/a',
    secret: 'public',
    secretNote: 'Public flags / deploy config.',
    owner: { kind: 'none', reason: 'substrate', note: 'A property of the deployment.' },
    visibility: 'deployment-substrate',
    grants: { kind: 'none', reason: 'substrate', note: 'Deploy-time.' },
    attribution: { actor: 'not-applicable', onBehalfOf: 'not-applicable', note: 'Deploy-time configuration has no durable write principal.' },
    systemWriter: 'never-writes',
    inheritanceOnCreate: { kind: 'not-applicable', reason: 'Substrate: no owner, no grants.' },
    visibilityMutability: { mutable: false, verbs: [], note: 'Tenant-visible from creation.' },
    open: [],
  },
  // -------------------------------------------------------------------------
  // POD-1211, second pass. POD-421 merged to the integration branch AFTER this
  // issue branched and brought a new durable table with it; the membership gate
  // built here caught it on its first contact with the world. Classified to the
  // same standard as the fourteen rather than to make the gate go green.
  // -------------------------------------------------------------------------
  {
    id: ROW.settingsAuditTrail,
    section: 'settings-secrets-accounts',
    title: 'Settings audit trail (`settings_audit_events`) — who changed what, and who was refused',
    sites: ['`settings_audit_events`', 'apps/server/src/store/settings-audit.ts', 'apps/server/src/modules/settings/audit.ts', 'POD-421'],
    home: 'server',
    idMinting: 'Server `id` AUTOINCREMENT — append order is the only order it has',
    writers: ['system'],
    replication: 'none',
    replicationNote:
      'NEVER REPLICATED, and that is a PROHIBITION here rather than a description of today. The class is `secret`, so `packages/sync/src/feed/visibility.ts` refuses it with `secret-never-replicates` — a reader added to this table later cannot reach it through the feed by accident, which is the property the trail most needs and the one a `personal` declaration would not have given it.',
    conflict: 'append',
    conflictNote: 'Append-only, by the server alone, including the REFUSALS — a trail that recorded only successes could not answer "who tried to rotate this key", which is among the first questions asked of one. Nothing merges and nothing is amended.',
    tombstone: 'never-delete',
    tombstoneNote:
      'An audit trail that can be pruned by the principals it audits is not one. No retention policy exists yet; when one is written it is an ADMIN-GRADE act (D15) and belongs with the same governance as secret rotation, not with the event-log retention sweep.',
    offline: 'never-enqueue',
    secret: 'secret-presence',
    secretNote:
      'Values never reach it: `detail_json` is written through the CONTRACT’s own `redaction` metadata and `redacted_paths` records what was withheld, so a redaction is a stated fact rather than an absence a reader must infer. What the row DOES hold is secret IDENTITY — which key was rotated, by whom, when — which is `secret-presence` exactly, and is precisely what the row is for.',
    owner: {
      kind: 'none',
      reason: 'secret',
      note:
        'THE REASON THIS IS NOT `personal`: there is no owner to be private TO. A row names an ACTOR and an ON-BEHALF-OF, and describes a write to a setting that may be instance-scoped or another person’s — three different principals, none of which owns the record of the act. `personal` would additionally have made it grantable, and "share my audit trail" is not a thing anybody should be able to do. Reading an audit trail is an ADMIN act (D15), which is the governance `secret` carries and `personal` does not.',
    },
    visibility: 'secret',
    grants: NO_GRANTS_SECRET,
    attribution: {
      actor: 'required',
      onBehalfOf: 'required',
      note: 'THE ROW IS THE PAIR. Both halves are stamped from the authenticated transport and neither is reachable from an input (ADR 3 D7), and `on_behalf_of` is NULL for a `system` principal BY CONSTRUCTION — enforced twice, in the writer and by a CHECK constraint, because ADR 9 D8 S5 says a system act must never acquire a human.',
    },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'not-applicable', reason: 'Secret: no owner and no grants to inherit (D15). A trail entry inherits nothing from the setting it records — that is what keeps a refused write auditable when the target was never touched.' },
    visibilityMutability: {
      mutable: false,
      verbs: [],
      note: 'Never replicated and not grantable, so no principal’s view of it can change. What multi-user changes is WHO MAY READ IT, which is admin-grade and is the open item below rather than a mutability event.',
    },
    open: ['O1'],
    openNote:
      'O1, AND THE PART THAT IS NOT THIS ISSUE’S TO DECIDE. The table has NO READER today, deliberately and in writing (POD-421, the `workflow_events` standing). WHO may read it when a reader is added — instance admins only, or also the person whose setting was changed, or the actor — is a D15 governance call with an existence-leak edge: the trail discloses which secrets exist and whose preferences changed, to whoever can see it. This row makes the surface impossible to add unnoticed (the class refuses replication) and answers none of it. POD-421 also recorded the coupled condition: if a reader is added, the per-user rows become a cross-user surface and `PREFERENCE_REDACTION` must be revisited before it ships.',
  },
]

// ---------------------------------------------------------------------------
// §7 Coordination
// ---------------------------------------------------------------------------

const COORDINATION_ROWS: readonly MatrixRow[] = [
  {
    id: ROW.locks,
    section: 'coordination',
    title: 'Advisory locks (`locks`, `lock_waiters`)',
    sites: ['`locks`', '`lock_waiters`', '[spec:SP-85d1]'],
    home: 'server',
    idMinting: 'Key `(repo_id, name)`',
    writers: ['operator', 'agent-session'],
    replication: 'server-to-clients',
    conflict: 'cmd',
    conflictNote: 'A lease machine: grant / renew / steal / FIFO / expiry. Nothing merges.',
    tombstone: 'remove',
    tombstoneNote: 'Expiry releases the lease.',
    offline: 'online-only',
    secret: 'public',
    owner: {
      kind: 'none',
      reason: 'substrate',
      note: 'A lock is a COORDINATION NAME every principal must resolve identically (ADR 9 D3 rule 1) — "everything private" taken literally would break it on day one. This is the tenant-visible floor, and it is deliberately small.',
    },
    visibility: 'deployment-substrate',
    grants: NO_GRANTS_SUBSTRATE,
    attribution: {
      actor: 'required',
      onBehalfOf: 'required',
      note: 'The HOLDER is attribution, and whether holder identity is visible is O1.',
    },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'not-applicable', reason: 'Substrate: a coordination name has no owner.' },
    visibilityMutability: { mutable: false, verbs: [], note: 'Tenant-visible from creation — that is the point of a coordination name.' },
    open: ['O1'],
    openNote:
      'O1 at a concrete site: whether the lock HOLDER’s identity is visible is an existence question ("someone you cannot see is working on this"). The lock NAME must be tenant-visible; the holder need not be. Marked, not resolved.',
  },
  {
    id: ROW.approvals,
    section: 'coordination',
    title: 'Approval requests',
    sites: ['`approval_requests`', 'apps/server approvals module'],
    home: 'server',
    idMinting: 'Server id',
    writers: ['daemon', 'agent-session', 'operator'],
    replication: 'server-to-clients',
    conflict: 'cmd',
    conflictNote: 'A state machine.',
    tombstone: 'never-delete',
    tombstoneNote: 'Terminal states retained.',
    offline: 'online-only',
    secret: 'public',
    secretNote: 'Payload redaction is ADR 3’s.',
    owner: {
      kind: 'user',
      resolves: 'routed-to-human',
      note: 'The human the request is ROUTED TO — the requesting agent’s on-behalf-of (Amendment 1 §3 §7). Attention routing is per-user by construction (ADR 9 D8 S3).',
    },
    visibility: 'personal',
    grants: { kind: 'inherits', from: ROW.sessionIdentity, note: 'Inherits the SUBJECT entity, whichever it is.' },
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'never-writes',
    inheritanceOnCreate: {
      kind: 'on-behalf-of-human',
      note: 'DECLARED as the routed-to human rather than the parent: an approval must reach a PERSON, and inheriting a shared subject entity’s owner would route it to the wrong one.',
    },
    visibilityMutability: { mutable: true, verbs: ['share', 'unshare', 'revoke'], note: 'PHASE 2 MUST HANDLE: follows its subject entity.' },
    open: [],
  },
  {
    id: ROW.automations,
    section: 'coordination',
    title: 'Automations / runs',
    sites: ['packages/model/src/entities/automation.ts', '`automations`', '`automation_runs`'],
    home: 'server',
    idMinting: 'Server id',
    writers: ['operator', 'system'],
    replication: 'server-to-clients',
    conflict: 'exp-rev',
    conflictNote: 'exp-rev on definitions; firing needs the server clock.',
    tombstone: 'soft-delete',
    tombstoneNote: 'Disable / delete is `cmd`.',
    offline: 'offline-eligible',
    secret: 'public',
    owner: {
      kind: 'user',
      resolves: 'creating-user',
      note: 'ADR 9 D8 S6: a scheduled automation is DELEGATED like the superagent — it runs as its creator with that creator’s CURRENT rights, so revoking someone stops their cron agents with no reaper to write and none to forget. Attributing them to `system` would hide who caused a write and would survive that person’s revocation.',
    },
    visibility: 'personal',
    grants: PERSONAL_GRANTS,
    attribution: {
      actor: 'required',
      onBehalfOf: 'required',
      note: 'INVENTORY GAP (POD-364 §9.1): `AutomationWire`, `AutomationRunWire` and the `automations` table carry NO CREATOR today, yet S6 requires one. The matrix row exists (owner = creating user); the ABSENCE in the schema is the finding, and the model change is small.',
    },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'on-behalf-of-human', note: 'DECLARED: the creating principal’s human. A run inherits its definition.' },
    visibilityMutability: { mutable: true, verbs: ['share', 'unshare', 'revoke', 'account-disable'], note: 'PHASE 2 MUST HANDLE: and note that disabling the creator’s ACCOUNT must stop the automation — live intersection, not a stored capability.' },
    open: [],
  },
  // -------------------------------------------------------------------------
  // Workflows — FIVE ROWS, not one (POD-731).
  //
  // This was a single row covering "workflows / revisions / bindings / runs /
  // steps / events / execution_profiles", and one row could only carry one
  // answer per column. That was survivable while the whole surface was
  // single-operator; it stops being survivable the moment the columns DISAGREE,
  // and they disagree in three places that matter:
  //
  //   - a REVISION inherits its definition, but a RUN inherits the ISSUE it
  //     advances — different owners, and collapsing them makes "who owns this
  //     run" answerable only by reading handler code;
  //   - a definition is `exp-rev` while the run machine is `cmd` (the old row
  //     said so, in a NOTE, which is not a column a totality test can check);
  //   - an EXECUTION PROFILE names managed credentials and owned compute, so it
  //     is `secret-presence` and `never-enqueue` where the rest is `public` and
  //     `offline-eligible`.
  //
  // Readiness §3.1.1 rule 2 requires the classification to be declared per
  // class with a totality test. Five classes, five rows. What is NOT here is a
  // sixth `deployment-substrate` row for the global library: see
  // `workflowDefinitions`' owner note.
  // -------------------------------------------------------------------------
  {
    id: ROW.workflowDefinitions,
    section: 'coordination',
    title: 'Workflow definitions (`workflows`)',
    sites: ['apps/server `workflows` table (`wf_` prefix); modules/workflows/handlers'],
    home: 'server',
    idMinting: 'Server prefixed ids (`wf_`)',
    writers: ['operator', 'agent-session'],
    replication: 'server-to-clients',
    conflict: 'exp-rev',
    tombstone: 'soft-delete',
    tombstoneNote: 'Archive; a definition is never hard-deleted while a run references one of its revisions.',
    offline: 'offline-eligible',
    secret: 'public',
    owner: { kind: 'user', resolves: 'creating-user', note: 'ADR 9 D8 S6, and the GLOBAL arm is the same rule rather than an exception: a global-scope definition is owned by the ADMIN who created it and shared by an explicit read grant. It is deliberately NOT declared `deployment-substrate` — readiness §3.1.1 says a global library entry is substrate-SHAPED, but the substrate set is ADR 1 Amendment 1 D9.3’s one-way ratchet and POD-1071 owns turning it. Its WRITE path is admin-grade all the same (POD-731 closed the ambient `scope === "global"` early return in `assertCreateScope` and `assertWorkflowWrite`); its READ reaches the same audience through ADR 9 D2’s grant edge, which a reader can be shown and an owner can revoke.' },
    visibility: 'personal',
    grants: PERSONAL_GRANTS,
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'on-behalf-of-human', note: 'DECLARED: the creating principal’s human (ADR 9 D5 A4).' },
    visibilityMutability: { mutable: true, verbs: ['share', 'unshare', 'revoke', 'account-disable'], note: 'PHASE 2 MUST HANDLE: disabling an owner’s ACCOUNT must stop their in-flight runs — a live intersection at every apply (ADR 9 D5 A1), not a stored capability.' },
    open: [],
  },
  {
    id: ROW.workflowRevisions,
    section: 'coordination',
    title: 'Workflow revisions (`workflow_revisions`)',
    sites: ['apps/server `workflow_revisions` table (`wfr_` prefix)'],
    home: 'server',
    idMinting: 'Server prefixed ids (`wfr_`)',
    writers: ['operator', 'agent-session'],
    replication: 'server-to-clients',
    conflict: 'append',
    conflictNote: 'REVISION IMMUTABILITY, as a conflict rule rather than a convention: a revise APPENDS a version and never edits a prior one in place, and publication is not a lock (POD-730 §2). That is why the offline class below is safe — a queued revise replayed after the library moved is a new revision, not a lost edit.',
    tombstone: 'never-delete',
    tombstoneNote: 'A revision a run pinned must remain readable for that run’s whole life.',
    offline: 'offline-eligible',
    secret: 'public',
    owner: { kind: 'inherits', from: ROW.workflowDefinitions, note: 'The DEFINITION’s owner, not the reviser’s — readiness §3.1.2’s parent rule. Otherwise a shared workflow fragments into per-reviser ownership one edit at a time and the person who shared it loses the ability to read what it became.' },
    visibility: 'personal',
    grants: { kind: 'inherits', from: ROW.workflowDefinitions },
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'parent', from: ROW.workflowDefinitions, note: 'DECLARED: owner AND grants follow the definition.' },
    visibilityMutability: { mutable: true, verbs: ['share', 'unshare', 'revoke'], note: 'PHASE 2 MUST HANDLE: follows the definition, so a share on the definition makes every revision appear at once without any revision’s own version moving.' },
    open: [],
  },
  {
    id: ROW.workflowBindings,
    section: 'coordination',
    title: 'Workflow bindings (`workflow_bindings`)',
    sites: ['apps/server `workflow_bindings` table (`(target_kind, target_id)` composite key)'],
    home: 'server',
    idMinting: 'Composite key — `(target_kind, target_id)`, no minted id',
    writers: ['operator', 'agent-session'],
    replication: 'server-to-clients',
    conflict: 'exp-rev',
    tombstone: 'remove',
    tombstoneNote: 'Rebinding replaces the row; there is no binding history.',
    offline: 'offline-eligible',
    secret: 'public',
    owner: { kind: 'inherits', from: ROW.issueCore, note: 'A binding inherits its TARGET, and the edge points at the issue arm because that is the one this matrix has a row for. The other three arms are stated rather than left implicit: a `session` binding inherits that session, a `repository` binding inherits the machine-scoped repo (POD-1079’s model, cited by POD-731’s contract rather than guessed at), and a `global` binding is instance-wide and admin-grade — the shipped `protectedWrite` brake, kept. Sharing an issue must share what runs on it; a binding owned by whoever last changed it would leave the issue’s owner unable to see why their own issue starts the workflow it does.' },
    visibility: 'personal',
    grants: { kind: 'inherits', from: ROW.issueCore },
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'parent', from: ROW.issueCore, note: 'DECLARED: the target’s owner and grants, never the binder’s.' },
    visibilityMutability: { mutable: true, verbs: ['share', 'unshare', 'revoke', 'reparent'], note: 'PHASE 2 MUST HANDLE: `bindings()` is a QUERY and was one of the three read-shaped operator branches POD-730 pinned — it returned every binding in the instance. A scoped feed must filter it per principal.' },
    open: [],
  },
  {
    id: ROW.workflowExecutionProfiles,
    section: 'coordination',
    title: 'Execution profiles (`execution_profiles`)',
    sites: ['apps/server `execution_profiles` table (`wfp_` prefix); the per-run immutable snapshot on `workflow_run_steps`'],
    home: 'server',
    idMinting: 'Server prefixed ids (`wfp_`)',
    writers: ['operator'],
    replication: 'server-to-clients',
    replicationNote: 'The `accountId` REFERENCE replicates; no credential material does. ADR 1 D6 is untouched — this row is `secret-presence`, not `secret-value`.',
    conflict: 'exp-rev',
    tombstone: 'soft-delete',
    tombstoneNote: 'A profile a run pinned survives as that run’s immutable snapshot regardless.',
    offline: 'never-enqueue',
    secret: 'secret-presence',
    secretNote: 'FAIL CLOSED: `accountId` names MANAGED CREDENTIALS (server-only, admin-grade to manage under ADR 1 D6) and `machineId` names OWNED COMPUTE, where `use` is a CODE-EXECUTION boundary and not a privacy one (ADR 9 D6 M2). The row holds neither the credential nor the machine — it holds two references — but which account funds which workflow, and which machine runs it, are disclosures on their own. Never enqueued: a queued profile write would replay a credential-to-compute binding after the grant authorizing it may have been revoked.',
    owner: { kind: 'user', resolves: 'creating-user' },
    visibility: 'personal',
    grants: PERSONAL_GRANTS,
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'never-writes',
    inheritanceOnCreate: { kind: 'on-behalf-of-human', note: 'DECLARED: the creating principal’s human. A RUN does not inherit the live profile — it pins an immutable SNAPSHOT (POD-730 §4), which is correct for reproducibility and must never become the model for authorization: the snapshot is re-authorized at every apply against the CURRENT delegation (ADR 9 D5 A1).' },
    visibilityMutability: { mutable: true, verbs: ['share', 'unshare', 'revoke', 'grant-use', 'account-role-change'], note: 'PHASE 2 MUST HANDLE: two axes that move independently — the profile’s own grants, and `use` on the machine it pins. `profiles()` had NO gate at all and listed every profile, with its `accountId`, to any caller.' },
    open: [],
  },
  {
    id: ROW.workflowRuns,
    section: 'coordination',
    title: 'Workflow runs, run steps and run events (`workflow_runs` / `workflow_run_steps` / `workflow_events`)',
    sites: ['apps/server `workflow_runs`, `workflow_run_steps`, `workflow_events` (`wrun_` prefix)'],
    home: 'server',
    idMinting: 'Server prefixed ids (`wrun_`)',
    writers: ['operator', 'agent-session', 'system'],
    replication: 'server-to-clients',
    conflict: 'cmd',
    conflictNote: 'The run STATE MACHINE, and the reason this could not stay in a note on a definitions row: an advance is a COMMAND against a run, not a field write, and its at-most-once property is the run-scoped idempotency POD-731 landed rather than anything a merge rule could supply.',
    tombstone: 'never-delete',
    tombstoneNote: 'A superseded run keeps its whole step history; `workflow_events` is append-only and is the ONLY durable audit trail this surface has (POD-730 §9 — no reader in the product yet, and it must not be dropped on the assumption nothing reads it).',
    offline: 'online-only',
    secret: 'public',
    owner: { kind: 'inherits', from: ROW.issueCore, note: 'A run inherits the ISSUE or SESSION it advances, NOT the agent that advances it (readiness §3.1.2) — a colleague’s agent checkpointing your issue must not acquire your run. This is where the old single row was most misleading: it declared `creating-user` for the whole surface, which is right for a definition and wrong for a run.' },
    visibility: 'personal',
    grants: { kind: 'verbs', verbs: ['read', 'write'], note: 'Read and write on the run follow the subject. An ADVANCE is ADDITIONALLY gated by `use` on the machine the step is placed on (ADR 9 D6 M5, checked at assign time AND again at apply, with unauthorized distinguishable from unreachable) — a DIFFERENT vocabulary on a different object, never a personal verb on this row.' },
    attribution: { actor: 'required', onBehalfOf: 'required', note: 'ADR 9 D5 A3, and POD-731 landed the pair: `workflow_events.on_behalf_of` records WHICH HUMAN the actor acted for beside WHICH agent or session acted, both stamped from the transport principal and never from payload. The one path still recording a null human is `startRun`, which takes no caller to resolve one from.' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'parent', from: ROW.issueCore, note: 'DECLARED: the subject issue or session, not the actor.' },
    visibilityMutability: { mutable: true, verbs: ['share', 'unshare', 'revoke', 'grant-use', 'account-disable'], note: 'PHASE 2 MUST HANDLE: `runs()` and `runFor()` were the other two read-shaped operator branches — every run in the instance, and any run by id. And `account-disable` is load-bearing here rather than theoretical: runs are long-lived and UNATTENDED, so revoking a person must stop their in-flight runs advancing with no reaper to write.' },
    open: [],
  },
  // -------------------------------------------------------------------------
  // POD-1211 — the coordination-shaped half of POD-385's fourteen.
  //
  // Two rows for the janitor, not one, and the reason is POD-731's test rather
  // than taste: the LEASE is a lease machine (`cmd` — grant / renew / fence /
  // expire) and the COMMAND RECEIPTS are dedupe bookkeeping (`single-writer`,
  // keyed by the run key). One row cannot carry two conflict rules, and a note
  // is not a column a totality test can check.
  // -------------------------------------------------------------------------
  serverBookkeeping({
    id: ROW.maintenanceLease,
    section: 'coordination',
    title: 'Janitor maintenance lease (`maintenance_leases`)',
    sites: [
      '`maintenance_leases`',
      'apps/server/src/store/maintenance.ts',
      'apps/janitor/src/janitor.ts',
      '[spec:SP-c29e]',
    ],
    idMinting: 'Key `name`; the holder is `(generation_id, fencing_token)`',
    conflict: 'cmd',
    conflictNote:
      'A lease machine with a FENCING TOKEN — acquire / renew / expire, and a stale holder is refused by token rather than merged. The token is what makes a paused janitor’s late write refusable, so nothing here is arbitrable.',
    tombstoneNote: 'Expiry releases the lease; the row is overwritten by the next holder.',
    open: [],
  }),
  serverBookkeeping({
    id: ROW.maintenanceCommandReceipts,
    section: 'coordination',
    title: 'Janitor command receipts (`maintenance_commands`)',
    sites: ['`maintenance_commands`', 'apps/server/src/store/maintenance.ts', '[spec:SP-c29e]'],
    idMinting: 'Key `(job_kind, run_key)`, with the fencing token of the holder that applied it',
    conflictNote:
      'Idempotency bookkeeping: the receipt IS the dedupe, so a second apply of the same run key finds the row and returns the recorded result rather than repeating the effect. The `applied-mutations` shape, one layer up.',
  }),
  serverBookkeeping({
    id: ROW.stewardState,
    section: 'coordination',
    title: 'Steward cursor KV (`steward_state`)',
    sites: ['`steward_state`', 'apps/server/src/store/events.ts', 'apps/server/src/steward.ts'],
    idMinting: 'Key `key` — a small closed set of sweep cursors',
    tombstoneNote: 'Overwritten in place; a deleted key simply restarts that sweep from its floor.',
  }),
  serverBookkeeping({
    id: ROW.notificationFacts,
    section: 'coordination',
    title: 'Notification arbiter claims (`notification_facts`)',
    sites: [
      '`notification_facts`',
      'apps/server/src/store/notification-facts.ts',
      'apps/server/src/steward.ts',
      '[spec:SP-ba61]',
    ],
    idMinting: 'Key `(fact_key, target)`; the target is a SESSION or a subscriber, not a user',
    conflictNote:
      'The once-until-ack claim (POD-880): the conflict guard is inside the single INSERT … ON CONFLICT statement, so two concurrent producers cannot both win, and a retired or expired claim is the only one that may be re-claimed.',
    tombstoneNote:
      'Retired on ack, on issue close, and by TTL sweep — `consumed_at` is the retirement, and rows are pruned by the steward.',
    open: ['O1'],
    openNote:
      'O1 at a concrete site: the claim set discloses WHO WAS NOTIFIED ABOUT WHICH ISSUE, which is an existence fact about other people’s work. It reaches no surface today (`replication: none`), so nothing leaks; any future surface that reads it — a "why didn’t I get pinged" diagnostic is the obvious one — must decide that per O1 rather than inheriting this row’s silence.',
  }),
  serverBookkeeping({
    id: ROW.wakeCooldowns,
    section: 'coordination',
    title: 'Message wake cooldowns (`message_wake_cooldowns`)',
    sites: [
      '`message_wake_cooldowns`',
      'apps/server/src/store/messages.ts',
      'apps/server/src/modules/messages/service.ts',
    ],
    idMinting: 'Key `key` — `${waking principal}|${issueId}`',
    conflictNote:
      'Written BEFORE the side effect it suppresses, so a crash between write and wake costs a missed wake rather than a duplicate one. Last write wins by construction because there is one writer.',
    tombstoneNote:
      'Overwritten by the next attempt; nothing accumulates per principal beyond one row per pair.',
  }),
  serverBookkeeping({
    id: ROW.idAllocationCounters,
    section: 'coordination',
    title: 'Id allocation counters (`repo_draft_seq`, `issue_ref_letters`)',
    sites: [
      '`repo_draft_seq` — keyed `repo_id`',
      '`issue_ref_letters` — keyed `issue_id`',
      'apps/server/src/store/repos.ts',
    ],
    idMinting:
      'The counters ARE the minting mechanism; each row is keyed by the scope it allocates within',
    conflictNote:
      'A monotonic allocator: the next value is read and bumped in one statement, and two allocations never return the same number. Merging two counters would hand two entities the same id, which is why there is no conflict rule to state beyond single-writer.',
    tombstone: 'never-delete',
    tombstoneNote:
      'Never reset. A reused draft number or ref letter would collide with a reference someone already wrote down, so the counter outlives every row it numbered.',
  }),
]

// ---------------------------------------------------------------------------
// §8 Messaging bus & superagent
// ---------------------------------------------------------------------------

const MESSAGING_ROWS: readonly MatrixRow[] = [
  {
    id: ROW.messages,
    section: 'messaging-and-superagent',
    title: 'Messages (`messages` substrate)',
    sites: ['`messages`'],
    home: 'server',
    idMinting: 'Server id',
    writers: ['operator', 'agent-session', 'daemon', 'system'],
    replication: 'server-to-clients',
    conflict: 'append',
    conflictNote: 'Append plus a lifecycle `cmd`.',
    tombstone: 'never-delete',
    tombstoneNote: 'Retain / expire per field.',
    offline: 'offline-eligible',
    secret: 'public',
    secretNote: 'Redaction is ADR 3’s.',
    owner: { kind: 'user', resolves: 'on-behalf-of-human', note: 'The SENDER’s human.' },
    visibility: 'personal',
    grants: {
      kind: 'verbs',
      verbs: ['read', 'write'],
      note: 'Visibility to the ADDRESSED party follows the addressing rule; per-feature refinement is deliberately deferred.',
    },
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'on-behalf-of-human', note: 'DECLARED: the sender’s human owns the message.' },
    visibilityMutability: {
      mutable: true,
      verbs: ['share', 'unshare', 'revoke'],
      note: 'PHASE 2 MUST HANDLE: addressing makes a row visible to a second principal at send time, which is a visibility change the addressee’s cursor never saw.',
    },
    open: [],
  },
  {
    id: ROW.messagingTopics,
    section: 'messaging-and-superagent',
    title: 'Messaging issue topics',
    sites: ['`messaging_issue_topics`', 'the Telegram / bridge topic mapping'],
    home: 'server',
    idMinting: 'Composite keys',
    writers: ['system'],
    replication: 'server-to-clients',
    conflict: 'exp-rev',
    tombstone: 'remove',
    tombstoneNote: 'Delete the mapping.',
    offline: 'online-only',
    secret: 'public',
    owner: { kind: 'inherits', from: ROW.issueCore },
    visibility: 'personal',
    grants: { kind: 'inherits', from: ROW.issueCore },
    attribution: { actor: 'required', onBehalfOf: 'none-representable', note: 'Bridge writes are `system`.' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'parent', from: ROW.issueCore },
    visibilityMutability: { mutable: true, verbs: ['share', 'unshare', 'revoke'], note: 'PHASE 2 MUST HANDLE: follows the issue.' },
    open: [],
  },
  {
    id: ROW.superagentState,
    section: 'messaging-and-superagent',
    title: 'Superagent threads / messages / queued inputs / pending turns',
    sites: ['`superagent_threads`', '`superagent_messages`', '`superagent_queued_inputs`', '`superagent_pending_turns`'],
    home: 'server',
    idMinting: 'Server id',
    writers: ['operator', 'agent-session', 'system'],
    replication: 'server-to-clients',
    replicationNote: 'Thread list to clients; turns are often live.',
    conflict: 'exp-rev',
    conflictNote: 'exp-rev on thread fields; `cmd` on the turn machine.',
    tombstone: 'soft-delete',
    tombstoneNote: 'Archive a thread.',
    offline: 'offline-eligible',
    secret: 'public',
    owner: {
      kind: 'user',
      resolves: 'on-behalf-of-human',
      note: 'ADR 9 D8 S1/S2: the superagent is "you, automated" — a BROAD-SCOPE delegation where ceiling and scope coincide, not a fifth principal kind. Its state joins the personal set: MY threads never surface in YOUR sidebar, which is the property that motivated the private default. One shared instance superagent was rejected: its history would be a mixed record of everyone’s private work and its notifications would have no correct destination. These four tables carry NO owner today.',
    },
    visibility: 'personal',
    grants: { kind: 'verbs', verbs: ['read', 'write'], note: 'Not shared by default.' },
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'on-behalf-of-human', note: 'DECLARED: the superagent’s human.' },
    visibilityMutability: { mutable: true, verbs: ['share', 'unshare', 'revoke'], note: 'PHASE 2 MUST HANDLE: private by default, shareable by explicit grant.' },
    open: [],
  },
]

// ---------------------------------------------------------------------------
// §9 Handoff / portable export
// ---------------------------------------------------------------------------

const HANDOFF_ROWS: readonly MatrixRow[] = [
  {
    id: ROW.handoffBundle,
    section: 'handoff',
    title: 'Handoff bundle / HandoffManifest (`sourceMachineId`, `exportedAt`)',
    sites: ['`<stateDir>/handoff` — the staged bundle on disk (apps/server/src/modules/sessions/handoff-transfer.ts)', 'packages/model/src/entities/handoff.ts'],
    home: 'source-server-then-target-server',
    idMinting:
      'The SOURCE server mints the export (bundle / snapshot ids server-side); session ids are PRESERVED as source brands rather than re-minted, which is what makes the moved session the same session. POD-643 owns the manifest vocabulary.',
    writers: ['operator', 'agent-session'],
    replication: 'export-only',
    replicationNote:
      'DIRECTION: source → target, then the target ACCEPTS — a one-shot export followed by an accept, NOT continuous multi-home sync. Nothing makes the two servers co-authorities of the same row.',
    conflict: 'cmd',
    conflictNote: 'Accept is a `cmd` on the target. There is no merge because there is no concurrent second writer: the source stops owning the session when the target accepts.',
    tombstone: 'hard-delete',
    tombstoneNote: 'Export-artifact retention is separate from the session tombstone — deleting a bundle does not delete the session, and vice versa.',
    offline: 'online-only',
    secret: 'public',
    secretNote: 'Public session fields; **no secrets in the manifest** (D6). A bundle leaves the live system, so a secret in it would leave the trust domain entirely.',
    owner: { kind: 'inherits', from: ROW.sessionIdentity, note: 'The exported session’s owner. The manifest carries owner + attribution.' },
    visibility: 'personal',
    grants: {
      kind: 'inherits',
      from: ROW.sessionIdentity,
      note: 'ACCEPT IS DENIED — not retargeted — without `use` on the TARGET machine (Amendment 1 D13.7 / ADR 9 D6 M5). And unreachable must be distinguishable from unauthorized INSIDE the principal’s `see` set only: a machine it cannot `see` is ABSENT and fails identically to a nonexistent id.',
    },
    attribution: {
      actor: 'required',
      onBehalfOf: 'required',
      note: '`sourceMachineId` + `exportedAt` are export PROVENANCE — durable manifest facts, not replica-delivery facts, so they belong on the entity and not on the ReplicatedEnvelope. TWO CONSEQUENCES POD-643 makes normative. (1) The manifest carries IDENTITY AND PROVENANCE ONLY: no serialized capability, effective-rights or scope snapshot, because rights are resolved LIVE at every apply (ADR 9 D5 A1 / ADR 3 D8) and nothing needs copying — the agent principal’s lifecycle IS SessionBinding (D5 A5). `findCapabilitySnapshotKeys` enforces it over the schema. (2) The manifest’s `owner` is PROVENANCE, never an authorization input: a bundle is PAYLOAD from outside this trust domain, so per ADR 3 D7 the import path decides ownership from its OWN transport principal and an imported bundle claiming an owner confers nothing.',
    },
    systemWriter: 'never-writes',
    inheritanceOnCreate: {
      kind: 'parent',
      from: ROW.sessionIdentity,
      note: 'ANSWERED BY POD-643, which owns the manifest vocabulary, in reply to POD-304’s O4 question. Parent-inheritance is UNAMBIGUOUS here because a bundle packages EXACTLY ONE session: `format: 1` carries a single `sessionId`, so there is no second parent to arbitrate between and ADR 9 O4’s multi-parent case does not arise. Recorded as a DECLARATION with a named reopen trigger rather than left open: if the vocabulary ever covers a MULTI-SESSION bundle, this cell must be re-decided before that ships. The trigger cannot fire silently — `entities/handoff.test.ts` locks the manifest key set in wire order, so a second session reference fails a test rather than inheriting an owner by accident.',
    },
    visibilityMutability: {
      mutable: true,
      verbs: ['share', 'unshare', 'revoke', 'grant-use'],
      note: 'PHASE 2 MUST HANDLE: follows the session, plus target-machine `use`. The refusal a denied accept must produce is `HandoffRefusalReason` (POD-643) — `unauthorized` vs `unreachable` vs `unknown-target`, never a generic failure and never a silent retarget.',
    },
    open: [],
  },
]

// ---------------------------------------------------------------------------
// §10 Sync infrastructure (not product entities)
// ---------------------------------------------------------------------------

const SYNC_ROWS: readonly MatrixRow[] = [
  {
    id: ROW.changeLog,
    section: 'sync-infrastructure',
    title: 'Change log (`changes`)',
    sites: ['`changes`'],
    home: 'server',
    idMinting: 'Server `seq` AUTOINCREMENT',
    writers: ['system'],
    replication: 'server-to-clients',
    replicationNote:
      'Substrate AT REST, but DELIVERY is per-principal scoped — ADR 2’s amendment owns scoping, watermarks and rescope. That split is the whole reason this row is not simply "tenant-visible".',
    conflict: 'append',
    conflictNote: 'Append-only, by the Authority alone.',
    tombstone: 'hard-delete',
    tombstoneNote: 'Compaction / retention is ADR 2’s.',
    offline: 'n/a',
    secret: 'public',
    secretNote: 'Payloads are subject to the secret scrub — a change row must never carry `secret-value` material.',
    owner: { kind: 'none', reason: 'substrate', note: 'The feed is the Authority’s ledger, not anybody’s row.' },
    visibility: 'deployment-substrate',
    grants: NO_GRANTS_SUBSTRATE,
    attribution: { actor: 'required', onBehalfOf: 'required', note: 'Each change carries origin / causation / mutation identity (D7’s federation seam), which is where the pair lands.' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'not-applicable', reason: 'Substrate: the ledger has no owner.' },
    visibilityMutability: {
      mutable: true,
      verbs: ['share', 'unshare', 'grant-see', 'revoke'],
      note: 'PHASE 2 MUST HANDLE — THIS IS THE ROW THE WHOLE INVENTORY IS FOR. Per-client filtering without watermarks is a PROTOCOL BREAK, not an optimization: every suppressed row is an invisible permanent gap that triggers an endless heal loop. A grant/revoke must therefore produce a watermark advance plus a rescope/`evict` signal DISTINCT from `remove` — a removal from YOUR VIEW, not a deletion. `remove` cannot be reused: the replica would render it as "deleted".',
    },
    open: [],
  },
  // POD-1211: the row POD-385's method could not have found. Its sweep
  // enumerated `apps/server/src/migrations/schema.ts`, and `feed_identity` is
  // declared in the sync adapter's schema — a SECOND drizzle schema file the
  // one `drizzle.config.ts` unions into the one journal. A gate keyed on one
  // schema file is a gate with a blind spot the size of a package.
  serverBookkeeping({
    id: ROW.feedIdentity,
    section: 'sync-infrastructure',
    title: 'Feed identity (`feed_identity`) — `(feedId, epoch)` beside the log',
    sites: [
      '`feed_identity` — packages/sync/src/adapters/sqlite/schema.ts',
      'ADR 2 D1',
      '[spec:SP-4428]',
    ],
    idMinting:
      'One row, pinned by a constant primary key; `feedId` and `epoch` are minted with the log',
    replication: 'none',
    replicationNote:
      'The ROW never replicates. Its VALUE is published in the handshake — a replica must be told which generation it is reading — so what crosses the wire is a protocol field, not this class, and the epoch is opaque to the client that carries it.',
    conflictNote:
      'One row by construction. Two rows would be two answers to "which generation is this?", and whichever a query returned would be the one clients trusted.',
    tombstone: 'never-delete',
    tombstoneNote:
      'Deleting it loses the epoch that describes the seqs beside it — ADR 2 D1’s whole argument is that identity must travel with the data through a backup restore.',
  }),
  {
    id: ROW.appliedMutations,
    section: 'sync-infrastructure',
    title: 'Applied mutations',
    sites: ['`applied_mutations`'],
    home: 'server',
    idMinting: 'Client `mutationId`',
    writers: ['system'],
    replication: 'none',
    replicationNote: 'Never replicated to the general replica.',
    conflict: 'single-writer',
    conflictNote: 'Dedupe by id.',
    tombstone: 'hard-delete',
    tombstoneNote: 'Pruned against the outbox horizon (ADR 2 / ADR 3).',
    offline: 'n/a',
    secret: 'public',
    secretNote: 'No secret payloads.',
    owner: {
      kind: 'none',
      reason: 'substrate',
      note: 'Idempotency bookkeeping for the Authority’s own apply path — a record THAT a mutation was applied, not a row belonging to whoever sent it. Its retention is coupled to the outbox dedupe horizon rather than to any person’s lifecycle.',
    },
    visibility: 'deployment-substrate',
    grants: NO_GRANTS_SUBSTRATE,
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'not-applicable', reason: 'Substrate: bookkeeping has no owner.' },
    visibilityMutability: {
      mutable: false,
      verbs: [],
      note: 'Never replicated to the general replica, so no principal’s view of it can change. Substrate at rest and invisible on the wire is the one combination with nothing for Phase 2 to signal.',
    },
    open: [],
  },
  {
    id: ROW.clientOutbox,
    section: 'sync-infrastructure',
    title: 'Client outbox',
    sites: ['packages/client-core (replica-side outbox)'],
    home: 'client-local',
    idMinting: 'Client `mutationId`',
    writers: ['operator', 'agent-session'],
    replication: 'client-to-server-to-clients',
    replicationNote: 'Drains TOWARD the server; the outbox itself is device-local and never replicated.',
    conflict: 'single-writer',
    conflictNote: 'Local FIFO partitions. It is durable command DELIVERY, not a second authority (ADR 1 D1).',
    tombstone: 'hard-delete',
    tombstoneNote: 'Dead-letter is a UX state; user work is never silently dropped.',
    offline: 'offline-eligible',
    secret: 'public',
    secretNote: 'MUST NOT hold `secret-value` (D6) — the outbox serializes to device storage.',
    owner: { kind: 'user', resolves: 'authenticated-principal-on-device' },
    visibility: 'per-user-state',
    grants: NO_GRANTS_PER_USER,
    attribution: { actor: 'required', onBehalfOf: 'required', note: 'Re-authorized at APPLY, not at enqueue (ADR 3 D8): rights revoked while offline still apply on reconnect, which is the central multi-user risk and is already designed for.' },
    systemWriter: 'never-writes',
    inheritanceOnCreate: { kind: 'the-user-in-the-key', note: 'DECLARED: the authenticated principal on that device.' },
    visibilityMutability: { mutable: false, verbs: [], note: 'Device-local and never replicated.' },
    open: [],
  },
  {
    id: ROW.replicaCursor,
    section: 'sync-infrastructure',
    title: 'Replica cursor / collections',
    sites: ['packages/client-core (replica store)'],
    home: 'client-local',
    idMinting: 'n/a',
    writers: ['system'],
    replication: 'none',
    replicationNote: 'A device-local cache of that principal’s SLICE.',
    conflict: 'single-writer',
    conflictNote: 'The Authority always wins; a corrupt cursor means a cold start. The Replica never arbitrates — that is D1 and it is unchanged by multi-user.',
    tombstone: 'hard-delete',
    tombstoneNote: 'Corruption → cold start (ADR 2 D9’s demotion to resync).',
    offline: 'offline-eligible',
    secret: 'public',
    secretNote: 'No `secret-value`.',
    owner: { kind: 'user', resolves: 'authenticated-principal-on-device' },
    visibility: 'per-user-state',
    grants: NO_GRANTS_PER_USER,
    attribution: { actor: 'not-applicable', onBehalfOf: 'not-applicable', note: 'Cache maintenance is not an attributable durable write.' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'the-user-in-the-key', note: 'DECLARED: the authenticated principal on that device.' },
    visibilityMutability: {
      mutable: false,
      verbs: [],
      note: 'NOT mutable, and the distinction matters: only its owner ever sees this row, so no verb changes WHO CAN SEE IT. What a grant changes is WHAT THE CURSOR POINTS AT — so this is where a rescope LANDS, not a class whose visibility moves. PHASE 2 (POD-1077) still touches it: a scoped bootstrap reads the principal’s slice at `(feedId, epoch, seq)`, and the shape of ADR 2 D6’s chunked bootstrap is unaffected.',
    },
    open: [],
  },
]

// ---------------------------------------------------------------------------
// §11 Classes the multi-user amendments themselves introduce
// ---------------------------------------------------------------------------

const MULTI_USER_ROWS: readonly MatrixRow[] = [
  {
    id: ROW.userAccount,
    section: 'multi-user-classes',
    title: 'User / account aggregate (identity, display name, role, lifecycle)',
    sites: ['`users`', 'POD-1075 (packages/model/src/identity)'],
    home: 'server',
    idMinting: 'Server-minted `UserId` (the brand is POD-1075’s; it lives transitionally in @podium/protocol’s principal module because L0 may not import it)',
    writers: ['operator', 'system'],
    replication: 'server-to-clients',
    conflict: 'exp-rev',
    tombstone: 'soft-delete',
    tombstoneNote: 'Disable before remove; per-user rows cascade on user deletion, while OWNED entities need a transfer story — flagged, and ADR 9’s lifecycle territory rather than this issue’s.',
    offline: 'online-only',
    secret: 'public',
    secretNote: 'Credential material is a SEPARATE row and is excluded from every wire projection.',
    owner: { kind: 'user', resolves: 'self', note: 'A person owns their own profile.' },
    visibility: 'personal',
    grants: {
      kind: 'none',
      reason: 'secret-admin-grade',
      note: 'Account LIFECYCLE (invite, disable, remove) is admin-grade (D15); the profile is not grantable.',
    },
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'not-applicable', reason: 'An account has no parent and inherits nothing; it is created by an admin invite.' },
    visibilityMutability: {
      mutable: true,
      verbs: ['account-role-change', 'account-disable'],
      note: 'PHASE 2 MUST HANDLE: a role change or disable alters what that principal sees ACROSS THE INSTANCE with no entity revision moving — the widest-blast-radius visibility event there is.',
    },
    open: ['O1'],
    openNote:
      'O1, THE CONTESTED CELL (Amendment 1 §3 §11): whether the MEMBER DIRECTORY — the bare existence of an account — is `deployment-substrate` so that people can be NAMED AS GRANTEES is a policy call. Sharing needs SOME way to name a grantee; which facts that discloses is not decided here. The profile is personal; the directory is marked, not resolved.',
  },
  {
    id: ROW.accountCredential,
    section: 'multi-user-classes',
    title: 'Account credential material',
    sites: ['`user_credentials`', 'POD-1075', 'packages/runtime/src/auth-store.ts (one password per instance today)'],
    home: 'server',
    idMinting: 'n/a',
    writers: ['operator', 'system'],
    replication: 'none',
    conflict: 'cmd',
    tombstone: 'hard-delete',
    offline: 'never-enqueue',
    secret: 'secret-value',
    secretNote: 'ADR 1 D6 unchanged.',
    owner: {
      kind: 'none',
      reason: 'secret',
      note: 'The one case where "no owner" is counter-intuitive and still right (D15): credential material AUTHENTICATES a person but is not theirs to grant or transfer. Giving it an owner would imply transfer semantics for credentials, which is a bad thing to have to define. The ACCOUNT is personal; its credential is `secret`.',
    },
    visibility: 'secret',
    grants: NO_GRANTS_SECRET,
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'not-applicable', reason: 'Secret: no owner, no grants.' },
    visibilityMutability: {
      mutable: false,
      verbs: [],
      note: 'Never replicated and excluded from every wire projection, so no principal’s view of it can change. What multi-user changes is WHO MAY RESET it — an admin-grade action (D15).',
    },
    open: [],
  },
  perUserState({
    id: ROW.perUserClientSession,
    section: 'multi-user-classes',
    title: 'Per-user `client_session` (a device that resolves to a user)',
    sites: ['`client_sessions` — `(token_hash, created_at, expires_at)`, NO user column today'],
    home: 'server',
    idMinting: 'Server-minted at login',
    writers: ['system'],
    replication: 'none',
    conflictNote: 'A client session is a DEVICE, not a person — the principal becomes `(user, device, capability)`, so device and person are two answers rather than one.',
    secret: 'secret-presence',
    secretNote: 'The token material itself is the pairing-token row (`secret-value`).',
    offline: 'online-only',
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    attribution: { actor: 'required', onBehalfOf: 'required', note: 'Existing client sessions are ADOPTED by the first admin at the migration rather than invalidated — nobody is logged out by an upgrade.' },
  }),
  {
    id: ROW.grantEdge,
    section: 'multi-user-classes',
    title: 'Grant edge (`(entityRef, granteeUserId, verb)`)',
    sites: ['POD-1075 (model shape)', 'Phase 3 / POD-290 (share / unshare commands)'],
    home: 'server',
    idMinting: 'Server-minted; the edge is keyed by its triple',
    writers: ['operator'],
    replication: 'server-to-clients',
    conflict: 'cmd',
    conflictNote:
      'Sharing is an EXPLICIT act with its own commands, never a side effect of another operation (ADR 9 D2 rule 3). A grant is NOT a copy of rights: it is evaluated live against the granter’s CURRENT rights, so a frozen grant cannot survive the revocation of the person who issued it. Revocation is immediate and takes effect at the next apply (ADR 3 D8).',
    tombstone: 'remove',
    tombstoneNote: 'Revocation removes the edge, and the removal is itself a durable change with a global `seq` — which is what a visibility event can be anchored on.',
    offline: 'online-only',
    secret: 'public',
    owner: {
      kind: 'user',
      resolves: 'granter',
      note: 'A grant may never exceed its granter’s own rights (ADR 9 D2 rule 4), so the GRANTER is the accountable party.',
    },
    visibility: 'personal',
    grants: {
      kind: 'none',
      reason: 'derived',
      note: 'A grant is not itself grantable. It inherits the visibility of the entity it grants on AND is visible to the GRANTEE — a grantee who cannot see the grant cannot see that they have access.',
    },
    attribution: { actor: 'required', onBehalfOf: 'required' },
    systemWriter: 'never-writes',
    inheritanceOnCreate: { kind: 'not-applicable', reason: 'An edge inherits the entity it grants on; it has no owner to inherit and is not itself grantable.' },
    visibilityMutability: {
      mutable: true,
      verbs: ['share', 'unshare', 'revoke'],
      note: 'PHASE 2 MUST HANDLE: this row IS the visibility event. Its `seq` is the anchor a watermark advance and a rescope signal hang off.',
    },
    open: [],
  },
  {
    id: ROW.delegationRecord,
    section: 'multi-user-classes',
    title: 'Delegation record (`agentIdentity`, `onBehalfOf`, scope, lifecycle)',
    sites: ['packages/protocol/src/planes/principal.ts (`DelegationRef`)', 'POD-323 (`SessionBinding`)'],
    home: 'server',
    idMinting: 'Server-minted; NEVER wire-supplied',
    writers: ['system'],
    replication: 'server-to-clients',
    conflict: 'cmd',
    conflictNote:
      'Effective rights are its own scope INTERSECTED WITH ITS HUMAN’S CURRENT RIGHTS, resolved at EVERY APPLY — never a capability frozen at spawn (ADR 9 D5 A1). A snapshot would leave a revoked person’s unattended agents running with rights they no longer hold, with no cleanup trigger. There must therefore be NO serialized "effective capability" anywhere.',
    tombstone: 'hard-delete',
    tombstoneNote: 'Born and retired with its `SessionBinding` (A5), so delegation survives handoff between machines for free instead of needing a second lifecycle.',
    offline: 'online-only',
    secret: 'public',
    owner: { kind: 'user', resolves: 'on-behalf-of-human', note: 'The delegating human (A1).' },
    visibility: 'personal',
    grants: { kind: 'none', reason: 'derived', note: 'Not grantable: widening an agent’s reach is a scope act, not a share.' },
    attribution: {
      actor: 'required',
      onBehalfOf: 'required',
      note: 'THE ROW THE PAIR EXISTS FOR. Sub-agents delegate from their PARENT agent, never widening, with exactly one human at the root; the intersection is evaluated over the whole chain, so disabling the root human disables the entire tree in one step.',
    },
    systemWriter: 'may-write',
    systemWriterRule: SYSTEM_WRITER_RULE,
    inheritanceOnCreate: { kind: 'on-behalf-of-human', note: 'DECLARED: the delegating human. The default SCOPE is what the agent was spawned for — its session, its issue, that issue’s subtree — not everything its human can see (A2); the human is a CEILING, not the default grant.' },
    visibilityMutability: {
      mutable: true,
      verbs: ['account-disable', 'revoke', 'reparent'],
      note: 'PHASE 2 MUST HANDLE: an agent’s visible set changes when its human’s does, and `reparent` moves a subtree scope under it (O3).',
    },
    open: ['O3'],
    openNote: 'O3: subtree scope is dynamic, so `reparent` widens a working agent’s visibility with nobody having decided it.',
  },
  perUserState({
    id: ROW.telegramChatBinding,
    section: 'multi-user-classes',
    title: 'Telegram chat binding (`chatId → UserId`)',
    sites: ['`telegram_chat_bindings`', 'packages/runtime/src/settings.ts (`notifications.telegramChatId` — one instance-wide string today)'],
    idMinting: 'Keyed `(userId, chatId)` — this is where D10’s move of `telegramChatId` lands',
    conflictNote:
      'A binding CEREMONY, not a preference write: a claim code issued in the web UI and presented to the bot, the same shape as machine pairing. Content-based routing would be PAYLOAD IDENTITY, which ADR 3 D7 declares inert.',
    secret: 'preference',
    secretNote: 'The BOT TOKEN stays `secret` (D15). The chat id is routing config. UNKNOWN CHATS MUST FAIL CLOSED — never fall back to an operator identity, which would turn knowledge of the bot handle into an unauthenticated write path against the whole instance.',
    offline: 'online-only',
  }),
  perUserState({
    id: ROW.recapWatermark,
    section: 'multi-user-classes',
    title: 'Recap watermark (`recap_watermarks`) — per-READER transcript cursor',
    sites: ['`recap_watermarks` — keyed `(reader, session_id)`', 'apps/server/src/store/read-watermarks.ts'],
    idMinting: 'Composite `(reader, sessionId)` — ALREADY keyed per principal; no re-key was needed',
    writers: ['operator', 'agent-session'],
    conflictNote:
      'ONE OF POD-385\u2019s THREE UNCLASSIFIED PER-USER-SHAPED TABLES, ADJUDICATED BY POD-1076 AND ADOPTED. ' +
      '\u201cHow far did I get reading this transcript\u201d is a fact about a READER, never shared and never ' +
      'grantable \u2014 D4\u2019s backstop answered `personal`, which is the WRONG class rather than merely an ' +
      'absent one, because `personal` IS shareable. Declaring it costs a row and no migration: the table ' +
      'is already keyed per principal.',
    replicationNote:
      'The key half is a READER (`ReaderRef`), which may be an AGENT session rather than a human, and that ' +
      'is deliberate \u2014 two agents of the same person hold independent cursors, so collapsing the key onto ' +
      '`userId` would silently merge them. The family\u2019s SHAPE is (principal, entity); `userId` is the ' +
      'common case, not the definition.',
    attribution: {
      actor: 'required',
      onBehalfOf: 'required',
      note: 'The reader is the actor. An agent reading on a human\u2019s behalf still owns its OWN cursor.',
    },
  }),
  perUserState({
    id: ROW.perUserStateFamily,
    section: 'multi-user-classes',
    title: 'Per-user state family (generic)',
    sites: ['packages/model/src/user-state (reserved for POD-1076)'],
    conflictNote:
      'THE FAMILY ITSELF. Keyed `(userId, entityId)`, one row per person per entity, `single-writer` because the user is in the key. PERMITTED WRITER IS THE OWNING USER ONLY — not admins, not `system`, and not agents acting on behalf; any member needing an exception must declare it explicitly rather than being left permissive. Per-user fields must NOT ride a shared entity’s wire projection: a value that differs per reader cannot be a field of a shape broadcast to many readers.',
  }),
]

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

export const OWNERSHIP_MATRIX: readonly MatrixRow[] = [
  ...IDENTITY_ROWS,
  ...SESSION_ROWS,
  ...ISSUE_ROWS,
  ...CONVERSATION_ROWS,
  ...REPO_ROWS,
  ...SETTINGS_ROWS,
  ...COORDINATION_ROWS,
  ...MESSAGING_ROWS,
  ...HANDOFF_ROWS,
  ...SYNC_ROWS,
  ...MULTI_USER_ROWS,
]

export const OWNERSHIP_MATRIX_INDEX: ReadonlyMap<string, MatrixRow> = new Map(
  OWNERSHIP_MATRIX.map((row) => [row.id as string, row]),
)

// Bind the index the default-closed resolvers read.
MATRIX_INDEX_HOLDER.index = OWNERSHIP_MATRIX_INDEX

/**
 * Rows ADR 1's matrix lists that this data deliberately does NOT carry, each
 * with the reason. An undocumented omission is indistinguishable from a
 * forgotten row, so the totality test requires this list to explain every gap
 * between the ADR's sections and the rows above.
 */
export const DECLARED_OMISSIONS: readonly { readonly title: string; readonly reason: string }[] = [
  {
    title: '`upstream_outbox` (legacy hub path)',
    reason:
      'Retired with POD-309, and Amendment 1 §3 §10 marks every one of its cells `n/a`. Annotating a row that is being deleted would create the appearance of a supported class. The forwarder and its per-proc patch switch go with it.',
  },
]

/**
 * The closed membership of the reserved `op-stream` class (Amendment 1 D12 part
 * 2). Adding a member requires an ADR 1 amendment, exactly as `field-LWW` does.
 * Exported so the totality test checks the reservation against a list rather
 * than against whatever the rows happen to say.
 */
export const OP_STREAM_RESERVED_MEMBERS: readonly MatrixRowId[] = [
  ROW.composerDraft,
  ROW.issueDocumentFields,
]

/**
 * The closed membership of the surviving `field-LWW` set (Amendment 1 D10):
 * instance-scope preference keys, plus the composer draft's named interim
 * defect. Everything else that ADR 1 D3 once listed is now per-user state or
 * `exp-rev`.
 */
export const FIELD_LWW_MEMBERS: readonly MatrixRowId[] = [
  ROW.preferencesInstance,
  ROW.composerDraft,
]

/**
 * The per-user state family's permitted writer is the OWNING USER ONLY — not
 * admins, not `system`, and not agents acting on behalf. Members that need an
 * exception must DECLARE it here rather than being left permissive, which is
 * the whole difference between a closed rule and a convention.
 *
 * Each exception is a row whose writes are made by the server ON the user's
 * behalf at a moment when the user cannot write the row themselves. None of
 * them lets a SECOND PERSON write another person's row, which is the property
 * the rule exists to protect.
 */
export const PER_USER_WRITER_EXCEPTIONS: readonly {
  readonly row: MatrixRowId
  readonly reason: string
}[] = [
  {
    row: ROW.perUserClientSession,
    reason:
      'Minted by the server at LOGIN, before there is an authenticated session to write through — the row is what makes the user authenticated. `system` writes it and it is attributed as `system`; no other person may write it.',
  },
  {
    row: ROW.telegramChatBinding,
    reason:
      'Created by the binding CEREMONY (a claim code presented to the bot), so the server completes the row from the bot side after the user initiates it in the web UI. Unknown chats fail closed rather than resolving to anyone.',
  },
  {
    row: ROW.clientOutbox,
    reason:
      'Device-local: written by whichever principal is authenticated on that device, including an agent-session on an agent’s own device. It is never another PERSON’s outbox, and it is never replicated.',
  },
  {
    row: ROW.replicaCursor,
    reason:
      'Device-local cache maintenance, written by the replica apply loop as `system`. Not a user-authored row at all; it exists so the Authority’s order can be applied.',
  },
  {
    row: ROW.recapWatermark,
    reason:
      'The reader in the key MAY BE AN AGENT SESSION, so `agent-session` writes rows it OWNS — not another principal’s. The family rule forbids writing SOMEBODY ELSE’S row; `WriterRole` names a role CLASS, not a principal, so an agent writing its own cursor is inside the rule rather than an exception to its intent. Collapsing the key onto `userId` to avoid declaring this would silently MERGE the cursors of two agents belonging to one person — a data loss, not a tightening.',
  },
]
