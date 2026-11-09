/**
 * THE OWNERSHIP MATRIX'S ROW IDS, apart from the rows themselves (POD-6423).
 *
 * A synced kind's declaration names the matrix row each of its fields belongs to
 * (`@podium/commands/records`), and clients read those declarations at startup.
 * The ids are all they need. The rows, in `matrix.ts`, are thousands of lines of
 * transcribed policy that no browser chunk carries (the web bundle check fails
 * the build if one does), so the ids live here and `matrix.ts` imports them.
 */

import { asMatrixRowId } from './ownership'

const id = asMatrixRowId

// Row ids, declared once so `inherits` edges are checkable.
export const ROW = {
  instanceId: id('instance-id'),
  machine: id('machine'),
  /** A machine's spec, the fields a manager writes (POD-6644, ADR 12 D3): its
   *  name and its update-channel pin, each its own field-LWW group. */
  machineSpec: id('machine-spec'),
  pairingToken: id('pairing-token'),
  daemonIdentityFile: id('daemon-identity-file'),
  enrollmentLedger: id('enrollment-ledger'),

  sessionIdentity: id('session-identity'),
  sessionBinding: id('session-binding'),
  sessionPlacement: id('session-placement'),
  sessionLabels: id('session-labels'),
  sessionDesiredState: id('session-desired-state'),
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
  /** The plain fields of an issue (POD-6405, ADR 12 D3): per-field LWW. */
  issuePlainFields: id('issue-plain-fields'),
  shippingAggregate: id('shipping-aggregate-family'),
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
  /** Which shell belongs to a person's worktree (POD-4436) — the server-owned
   *  dock-shell mapping, one row per (user, worktree). */
  dockShellMapping: id('dock-shell-mapping'),

  preferencesPersonal: id('preferences-personal-keys'),
  preferencesInstance: id('preferences-instance-keys'),
  serverSecrets: id('server-owned-secrets'),
  managedCredentials: id('managed-credentials'),
  configFeatures: id('config-features'),
  settingsAuditTrail: id('settings-audit-trail'),

  locks: id('advisory-locks'),
  approvals: id('approval-requests'),
  pendingInteractions: id('pending-interactions'),
  automations: id('automations-and-runs'),
  /** One-shot effects as data (ADR 12 D5 E2, POD-6357): merge, file write,
   *  scans, clone, interrupt, each with the standard effect status. */
  effectRecords: id('effect-records'),
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
  agentProfiles: id('agent-profiles'),
  workflowRuns: id('workflow-runs'),

  messages: id('messages-substrate'),
  messagingTopics: id('messaging-issue-topics'),
  superagentState: id('superagent-state'),
  superagentThreadFields: id('superagent-thread-fields'),

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
