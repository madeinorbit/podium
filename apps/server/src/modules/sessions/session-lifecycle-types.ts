/**
 * Session lifecycle composition types (POD-1396).
 * Hoisted from lifecycle.ts so the service file can fall under the 600-line signal.
 */

import type {
  AccountId,
  Attribution,
  Geometry,
  IssueId,
  ResumeRef,
  SessionId,
  SessionMeta,
  TranscriptItem,
  WorkState,
} from '@podium/model'
import type { AgentKind, UserId } from '@podium/model'
import type {
  MetadataChange,
  SubscriptionRegistry,
} from '@podium/protocol'
import type { EntityChangeSpec, MutationLedgerPort } from '@podium/sync'
import type { ClientRegistry } from '../../gateway/client-registry'
import type { ClientConn } from '../../gateway/client-registry'
import type { EventBus } from '../bus'
import type { WriteFunnel } from '../funnel'
import type { DurableIssueAccessIndex } from '../issues/access-index'
import type { DaemonRpcService } from '../machines/rpc'
import type { MachinesService } from '../machines/service'
import type { MemoryService } from '../memory/service'
import type { SessionStore } from '../../store'
import type { PublishWorkerClient } from './publish-worker-client'
import type { SnapshotTail } from './publication/coordinator'
import type { PreparedSessionInstructions } from './instructions'
import type { Session } from './session'

/** Re-exported from session-shared so receipt-retention tests keep a stable site. */
export { APPLIED_MUTATIONS_MAX_AGE_MS } from './session-shared'

/** The write-seam change log face sessions run through ([spec:SP-3fe2] #256):
 *  `commit` binds a session row write and its declared change into one
 *  transaction; `reconcile` diffs the full restored truth at boot (including
 *  removes). Structurally satisfied by {@link @podium/sync.Ledger}; narrow so
 *  tests can fake it. */
export interface SessionLedger {
  commit<T>(op: { write: () => T; changes: (result: T) => EntityChangeSpec[] }): {
    result: T
    changes: MetadataChange[]
  }
  capture(specs: EntityChangeSpec[]): MetadataChange[]
  reconcile(entity: 'session', rows: { id: string; value: unknown }[]): MetadataChange[]
}

/** Prepared half of a cross-aggregate issue/session deletion transaction. */
export interface SessionDeletePlan {
  sessionIds: string[]
  write(): void
  changes(): EntityChangeSpec[]
  apply(changes: MetadataChange[], ledgerCursor: number): void
}

/** Prepared half of restoring issue-owned session tombstones. */
export interface SessionRestorePlan {
  sessionIds: string[]
  restoredSessions: SessionMeta[]
  write(): void
  changes(): EntityChangeSpec[]
  apply(changes: MetadataChange[], ledgerCursor: number): void
}

export interface SessionLifecycleDeps {
  /** Deployment-qualified durable namespace, injected by the composition root. */
  durableLabelFor(sessionId: SessionId): string
  store: SessionStore
  now(): number
  bus: EventBus
  /** Lazy source-message re-authorization; resolved on every inbox drain. */
  authorizeQueuedMessage?(messageId: string): { ok: true } | { ok: false; reason: string }
  /** Dead-letter the durable source intent after a drain-time refusal. */
  rejectQueuedMessage?(messageId: string, reason: string): void
  /**
   * FRAMEWORK IDEMPOTENCY (POD-382): the composition root's ONE
   * `MutationLedger`. Threaded through rather than constructed here — the service
   * owns no dedup of its own since `withMutation` was deleted, and a
   * service-built ledger would be a second in-flight map over one durable table.
   *
   * Optional so the ~40 test fixtures that build a bare service literal keep
   * compiling; absent means a private ledger over the same store, which is
   * behaviourally identical for the synchronous session-state writes that reach it and
   * is the only path that can be reached without the composition root.
   */
  mutations?: MutationLedgerPort
  /** THE write funnel (modules/funnel): every broadcast pipeline ends in its
   *  fan-out tail; session deltas ride its ordered pipe via the ledger bridge. */
  funnel: WriteFunnel
  /** The write-seam change log ([spec:SP-3fe2] #256): persist() commits the row
   *  write + declared session change atomically; loadFromStore reconciles. */
  ledger: SessionLedger
  /**
   * THE GATEWAY's client connection set (POD-390). Threaded in rather than
   * constructed here: the mux owns the lifecycle, and a service-built registry
   * would be a second connection set.
   *
   * Optional for the same reason `mutations` is — the ~40 test fixtures that
   * build a bare service literal keep compiling, and absent means a private
   * registry that only this service can reach (no socket can ever enter it), the
   * client-plane mirror of the daemon mux's in-process peer form.
   */
  clients?: ClientRegistry
  /** The gateway's ONE routing registry, shared by the feed and room stream. */
  subscriptions: SubscriptionRegistry
  /** Shared live-session registry, constructed before every reader. Lifecycle
   * remains its sole mutation owner. */
  sessions?: Map<SessionId, Session>
  /** Test/fault-injection seam; production owns the default daemon client. */
  publicationWorker?: PublishWorkerClient
  /** Rollout-only old/new semantic comparison; never changes delivered bytes. */
  publicationShadowCompare?: boolean
  machines: MachinesService
  rpc: DaemonRpcService
  /** Start-path notification; the propagation service decides whether login is needed. */
  onSpawnTargetLogin?(input: {
    machineId: string
    agentKind: AgentKind
    ownerUserId: UserId
  }): void
  memory: MemoryService
  /** Live repository-backed issue access; re-read on every apply and replay. */
  issueAccess: DurableIssueAccessIndex
  /** Cross-feature snapshot material read from the already-constructed durable authority. */
  snapshotTail(): SnapshotTail
  /** POD-665: a worktree appeared/vanished out from under connected clients —
   *  nudge them to re-fetch repos. Raw invalidation, no payload. */
  onWorktreesChanged(repoPath: string, machineId?: string): void
  /** Prepare every registered source of machine-authored context before spawn.
   * Providers commit side effects only after the session row + command exist. */
  instructionsForStart(input: {
    sessionId: SessionId
    cwd: string
    agentKind: AgentKind
    issueId?: IssueId
    workflowRevisionId?: string
    existingOnly?: boolean
  }): PreparedSessionInstructions
  /**
   * Presence-room occupancy for a session (POD-1081). When provided,
   * `clientCount` is derived from it and attach/watch policy can consult the
   * same room world. Optional so unit fixtures without the stream plane keep
   * using the attach-set size.
   */
  sessionOccupancyCount?(sessionId: SessionId): number | undefined
  /**
   * Join/leave the session presence room when a PTY attaches or detaches so
   * occupancy and attach stay one mechanism (POD-1081 §5).
   */
  sessionRoomJoin?(client: ClientConn, sessionId: SessionId): void
  sessionRoomLeave?(client: ClientConn, sessionId: SessionId): void
}
