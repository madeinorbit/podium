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

  sessionIdentity: id('session-identity'),
  sessionPlacement: id('session-placement'),
  sessionLabels: id('session-labels'),
  sessionReadAt: id('session-read-at'),
  snooze: id('snooze'),
  composerDraft: id('composer-draft'),
  queuedMessages: id('queued-agent-messages'),
  daemonObservedRuntime: id('daemon-observed-runtime'),
  sessionLiveEphemeral: id('session-live-ephemeral'),
  hostMetrics: id('host-metrics'),
  provenanceEnvelope: id('provenance-envelope'),

  issueCore: id('issue-core'),
  issueDocumentFields: id('issue-document-fields'),
  needsHuman: id('needs-human-group'),
  issueGraph: id('issue-graph'),
  issueComments: id('issue-comments'),
  issueMessages: id('issue-messages'),
  issueMessageReadAt: id('issue-message-read-at'),
  artifacts: id('artifacts'),

  conversationRegistry: id('conversation-registry'),
  segments: id('segments'),
  blobs: id('blobs'),

  repoPrefix: id('repo-prefix'),
  /** The living project spec (pspec v1) — files in a repo, NOT a replicated
   *  table. Added by POD-385; see the row for why it is `owned-compute`. */
  pspecComponent: id('pspec-component'),
  pins: id('pins'),
  tabOrder: id('tab-order'),

  preferencesPersonal: id('preferences-personal-keys'),
  preferencesInstance: id('preferences-instance-keys'),
  serverSecrets: id('server-owned-secrets'),
  managedCredentials: id('managed-credentials'),
  configFeatures: id('config-features'),

  locks: id('advisory-locks'),
  approvals: id('approval-requests'),
  automations: id('automations-and-runs'),
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

// ---------------------------------------------------------------------------
// §1 Identity & deployment scope
// ---------------------------------------------------------------------------

const IDENTITY_ROWS: readonly MatrixRow[] = [
  {
    id: ROW.instanceId,
    section: 'identity-and-deployment-scope',
    title: 'InstanceId (deployment partition)',
    sites: ['packages/runtime/src/instance.ts'],
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
      note: 'ADR 9 D6 M3: pairing runs from that person’s laptop with their join code, so they own it. For `local` the owner is the instance installer (Amendment 1 D13.4) — `LOCAL_MACHINE_ID = "local"` makes the server’s host a fleet member, so without an owner anyone who can authenticate inherits EXECUTE on it. Existing machines need a one-time ownership migration at the cutover.',
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
    sites: ['`machines.token_hash`', '`client_sessions.token_hash`'],
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
]

// ---------------------------------------------------------------------------
// §2 Sessions
// ---------------------------------------------------------------------------

const SESSION_ROWS: readonly MatrixRow[] = [
  {
    id: ROW.sessionIdentity,
    section: 'sessions',
    title: 'Session identity (`sessionId`, birth display ref / letters)',
    sites: ['apps/server/src/modules/sessions/service.ts (`randomUUID()`)', '`issue_ref_letters`'],
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
    sites: ['`sessions.read_at` (a SINGLETON column today — the non-compliance)'],
    conflictNote:
      'Read state is a fact about a READER. Keyed `(userId, sessionId)` it is single-writer by construction; today it is one instance-wide column, which asserts that exactly one person exists.',
  }),
  perUserState({
    id: ROW.snooze,
    section: 'sessions',
    title: 'Snooze (`snoozes` / `snoozedUntil`)',
    sites: ['`snoozes` (keyed `session_id` today)', 'packages/model/src/predicates/snooze.ts'],
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
    sites: ['apps/server/src/modules/issues/service/crud.ts (`cmt_<uuid>`)'],
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
    sites: ['`issue_messages.read_at`', '`issues.read_at`'],
    conflictNote: 'Two more SINGLETON `read_at` columns today; the same re-key as the session one.',
  }),
  {
    id: ROW.artifacts,
    section: 'issues-and-tracker',
    title: 'Artifacts (snapshotted files)',
    sites: ['apps/server (artifact storage)'],
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
]

// ---------------------------------------------------------------------------
// §4 Conversations & transcripts
// ---------------------------------------------------------------------------

const CONVERSATION_ROWS: readonly MatrixRow[] = [
  {
    id: ROW.conversationRegistry,
    section: 'conversations-and-transcripts',
    title: 'Conversation registry',
    sites: ['packages/model/src/entities/conversation.ts', 'docs/spec/conversation-registry.md'],
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
    sites: ['packages/transcript', 'the disk lake'],
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
    sites: ['the content-addressed store'],
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
    sites: ['`pins` (keyed `(kind, id)` today — a singleton)'],
    conflictNote: 'The sidebar is "my tasks" (readiness header decision), so a pin is mine by definition.',
  }),
  perUserState({
    id: ROW.tabOrder,
    section: 'repos-pins-tabs',
    title: 'Tab order / sidebar layout',
    sites: ['`tab_order` (keyed `worktree` today — a singleton)'],
    conflictNote: 'Layout is per person by definition. The whole order vector was one field-LWW group; keyed per user it is single-writer instead.',
    tombstoneNote: 'Scrubbed with sessions, and cascades on user deletion.',
  }),
]

// ---------------------------------------------------------------------------
// §6 Settings, secrets, accounts
// ---------------------------------------------------------------------------

const SETTINGS_ROWS: readonly MatrixRow[] = [
  perUserState({
    id: ROW.preferencesPersonal,
    section: 'settings-secrets-accounts',
    title: 'Preferences — PERSONAL keys (session defaults, sidebar, autoContinue, `telegramChatId`, ntfy topic, …)',
    sites: ['packages/runtime/src/settings.ts (`PodiumSettings` — one instance-wide blob today)'],
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
    sites: ['packages/runtime/src/settings.ts', '[spec:SP-f4b9] `settings.experimental`'],
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
    sites: ['packages/runtime/src/settings.ts'],
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
    sites: ['apps/server approvals module'],
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
    sites: ['packages/model/src/entities/automation.ts', '`automations`'],
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
    sites: ['the Telegram / bridge topic mapping'],
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
    sites: ['packages/model/src/entities/handoff.ts'],
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
    sites: ['POD-1075 (packages/model/src/identity)'],
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
    sites: ['POD-1075', 'packages/runtime/src/auth-store.ts (one password per instance today)'],
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
    sites: ['packages/runtime/src/settings.ts (`notifications.telegramChatId` — one instance-wide string today)'],
    idMinting: 'Keyed `(userId, chatId)` — this is where D10’s move of `telegramChatId` lands',
    conflictNote:
      'A binding CEREMONY, not a preference write: a claim code issued in the web UI and presented to the bot, the same shape as machine pairing. Content-based routing would be PAYLOAD IDENTITY, which ADR 3 D7 declares inert.',
    secret: 'preference',
    secretNote: 'The BOT TOKEN stays `secret` (D15). The chat id is routing config. UNKNOWN CHATS MUST FAIL CLOSED — never fall back to an operator identity, which would turn knowledge of the bot handle into an unauthenticated write path against the whole instance.',
    offline: 'online-only',
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
]
