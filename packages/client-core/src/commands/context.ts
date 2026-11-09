import type {
  IssueId,
  LayoutSnapshot,
  MutationId,
  PersonalPreferences,
  SessionId,
  UserId,
} from '@podium/model'
import type { PodiumClientApi } from '../api'
import type { OutboxSettlements } from '../conversation/sends'
import type { StoreNotices } from '../engine/types'
import type { EngineOutbox, OutboxKinds } from '../runtime-root/outbox/wiring'
import type { SocketHub } from '../socket-transport'
import type {
  LaunchSessionArgs,
  SpawnDraftAgentArgs,
  SpawnIssueAgentArgs,
  StartIssueSession,
  TaskSpawnOutcome,
} from '../spawn-agent'
import type { Router } from '../ui-state'
import type { ScreenState } from '../ui/state'

export interface CommandDeps<TApi extends PodiumClientApi> {
  readonly ui: import('../ui/ui-store').UiStore
  readonly palette: import('../ui/view-models').PaletteViewModel
  readonly autoContinueDialog: import('../ui/view-models').AutoContinueDialogModel
  readonly api: TApi
  readonly hub: SocketHub
  readonly outbox: EngineOutbox
  /**
   * The session's spec revision as the replica holds it (POD-6399): what an
   * edit of its desired state is made against, before this device's own
   * queued edits of it are counted. Absent: 1.
   */
  sessionRevision?(sessionId: SessionId): number | undefined
  /**
   * Dismiss a draft start that failed or expired (POD-6408): its session row
   * never existed, so its Remove takes the launch record off the feed. True when
   * the session was one.
   */
  dismissLaunch?(sessionId: SessionId): boolean
  /** Whether the session is only a start's paint: the server has no row for
   *  it (yet), so its per-user row cannot be written (POD-6622). */
  launchPainted?(sessionId: SessionId): boolean
  /** The person this store writes for: their per-user rows (read marks,
   *  snoozes, tucks) are generic edits of rows keyed by them (POD-6404). */
  readonly userId: UserId
  /** My personal settings as the replica holds them, resolved with defaults
   *  (POD-6673). Absent: the defaults. */
  preferences?(): PersonalPreferences
  /** Resolution waiters for queued entries, by id (POD-4762). */
  readonly outboxSettlements: OutboxSettlements
  readonly router: Router
  readonly notices: StoreNotices
  /** Layout base persisted by an earlier session, for hydrate-first paint
   *  (POD-571). The runtime reads it out of the replica; absent means cold. */
  readonly layoutSeed?: LayoutSnapshot
  state(): Readonly<ScreenState>
  /**
   * S5: the runtime's snapshot batch, exposed so one gesture's synchronous
   * paints (navigation + optimistic overlays + their outbox-size handoff when
   * it fires synchronously) publish once. No semantic change: commands still
   * enqueue, echoes still apply, rollbacks still repaint.
   */
  batch(fn: () => void): void
  /**
   * Every published snapshot, for the actions that must WAIT for replicated
   * state rather than read it once. The runtime publishes on any state change,
   * so a listener that re-reads `state()` sees each delta as it lands.
   */
  onLocals(keys: readonly ('selectedIssueId' | 'navigation')[], listener: () => void): () => void
  /**
   * Queue a write and repaint from it (#263). RESOLVES WHEN THE OVERLAY IS
   * PUBLISHED, not when the call is made (POD-781): the durable enqueue is a real
   * await, and a caller that has to hand a gesture over to the repainted list —
   * the sidebar's drag, which holds its transforms exactly that long — needs a
   * promise that means something. Voiding it here made every issue action resolve
   * a couple of frames before the row moved.
   */
  write<K extends keyof OutboxKinds & string>(kind: K, input: OutboxKinds[K]): Promise<void>
  spawnDraftAgent(args: SpawnDraftAgentArgs): {
    sessionId: SessionId
    issueId: IssueId
    settled: Promise<boolean>
  }
  launchSession(args: LaunchSessionArgs): { sessionId: SessionId; settled: Promise<boolean> }
  startIssueSession: StartIssueSession
  spawnIssueAgent(args: SpawnIssueAgentArgs): {
    sessionId: SessionId
    issueId: IssueId
    mutationId: MutationId
    settled: Promise<boolean>
    outcome: Promise<TaskSpawnOutcome>
    /** True once the task was filed as a proposal (no agent comes). */
    proposed: Promise<boolean>
  }
  /**
   * Hold a first chat send until an optimistic spawn's create has reconciled
   * (or rolled back) through the principal's pool transaction log.
   */
  waitForSpawnConfirmed(sessionId: SessionId): Promise<void>
  setSessionDraft(sessionId: SessionId, text: string): void
}
