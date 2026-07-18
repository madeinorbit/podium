import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { computePriorities } from '@podium/domain'
import {
  AGENT_CAPABILITIES,
  type AgentInstruction,
  AgentKind,
  type AgentRuntimeState,
  type ApprovalWire,
  type AutomationRunWire,
  type AutomationWire,
  agentSupportsEffort,
  agentSupportsInitialPrompt,
  CAP_METADATA_DELTA,
  type ClientMessage,
  type ControlMessage,
  type DaemonMessage,
  formatSessionRef,
  type Geometry,
  type IssueWire,
  type LiveServerMessage,
  MAX_AGENT_TITLE_LENGTH,
  type MetadataChange,
  type ResumeRef,
  type ServerMessage,
  type SessionMeta,
  type SessionOpenUrlMessage,
  type SessionOpenUrlResultMessage,
  type SyncChangesSinceResult,
  type TranscriptItem,
  type WorkState,
} from '@podium/protocol'
import { resolveRole } from '@podium/runtime'
import type { EntityChangeSpec } from '@podium/sync'
import { AutoContinueController } from '../../auto-continue'
import type { Capability } from '../../issue-authz'
import { selectMailNudgeSession, sessionsForIssue } from '../../issue-util'
import { LOCAL_MACHINE_ID, LOCAL_PLACEHOLDER } from '../../local-machine'
import { assertModelSelectionValid } from '../../model-validation'
import type { SessionRow, SessionStore } from '../../store'
import {
  isCommandWrapperText,
  isGenericClaudeTitle,
  isTransientTitle,
  makeTitleDebouncer,
  titleFromPrompt,
} from '../../title-filter'
import type { EventBus } from '../bus'
import type { ConversationsService } from '../conversations/service'
import type { WriteFunnel } from '../funnel'
import type { HostsService } from '../hosts/service'
import type { IssueService } from '../issues/service'
import type { DaemonRpcService } from '../machines/rpc'
import type { MachinesService } from '../machines/service'
import { perf } from '../perf/registry'
import type { HeadlessService } from '../superagent/headless'
import { resolveAccountEnv } from './account-env'
import { transferHandoffPackage, verifiedBundleBases } from './handoff-transfer'
import type { PreparedSessionInstructions } from './instructions'
import {
  type ClientConn,
  type Send,
  Session,
  type SessionDurableState,
  type SessionVolatileField,
} from './session'

export const DEFAULT_GEOMETRY: Geometry = { cols: 80, rows: 24 }
// Delay between a chat message's bracketed paste and its submitting CR, so the CR
// lands in a separate PTY read (the new Claude renderer swallows a CR fused to the
// paste-end marker → the message types in but never submits). See sendText().
const SUBMIT_CR_DELAY_MS = 90
// Resume/spawn readiness (sendTextWhenReady): the PTY binds ('live') BEFORE the
// agent's TUI has finished drawing / loading the resumed conversation. Typing then
// lands in a half-built UI and the message is dropped (codex especially). Deliver
// only once the spawn has SETTLED — live for at least FLOOR, has produced output,
// and that output burst has gone quiet for QUIET. MAX caps the wait for a spawn
// that never produces output, so a message is never held indefinitely.
const READY_FLOOR_MS = 800
const READY_QUIET_MS = 600
const READY_MAX_MS = 6_000
const READY_POLL_MS = 200
// Durable queued sends (docs/spec/outbox-write-path.md §2.2): one drain ATTEMPT
// gives the session this long to come live before parking the loop (the rows
// remain; the next liveness signal re-arms — unlike the old sendTextWhenReady
// deadline, this drops nothing). Successive queued messages are spaced so each
// lands as its own submitted input (CR delay + separate-read margin).
const QUEUE_DRAIN_DEADLINE_MS = 25_000
const QUEUE_MESSAGE_SPACING_MS = 400
// Idempotency records outlive any sane replay horizon, then get pruned.
const APPLIED_MUTATIONS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** Normalize an agent-set session name the same way setAgentName does — trim,
 *  collapse whitespace, reject empty / over-long. Shared by the agent self-title
 *  path and createSession's spawner-prescribed name [spec:SP-4ef9][spec:SP-eb60].
 *  Length cap: MAX_AGENT_TITLE_LENGTH from @podium/protocol/titles. */
function normalizeAgentName(
  name: string,
): { ok: true; name: string } | { ok: false; reason: string } {
  const clean = name.trim().replace(/\s+/g, ' ')
  if (!clean) return { ok: false, reason: 'title is empty' }
  if (clean.length > MAX_AGENT_TITLE_LENGTH) {
    return {
      ok: false,
      reason: `title exceeds ${MAX_AGENT_TITLE_LENGTH} characters — a session title is 3–5 words`,
    }
  }
  return { ok: true, name: clean }
}

/** Rejection every command path returns for a hub-mirrored session (spec §2.3). */
export const UPSTREAM_COMMAND_REJECTION = 'remote session — managed via the hub'

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

export interface SessionProjectionEvent {
  generation: number
  changes: MetadataChange[]
  ledgerCursor: number
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

interface SessionsServiceDeps {
  store: SessionStore
  now(): number
  bus: EventBus
  /** THE write funnel (modules/funnel): every broadcast pipeline ends in its
   *  fan-out tail; session deltas ride its ordered pipe via the ledger bridge. */
  funnel: WriteFunnel
  /** The write-seam change log ([spec:SP-3fe2] #256): persist() commits the row
   *  write + declared session change atomically; loadFromStore reconciles. */
  ledger: SessionLedger
  machines: MachinesService
  rpc: DaemonRpcService
  hosts: HostsService
  headless: HeadlessService
  /** Lazy: the conversations service is constructed after this one (post-load slot). */
  conversations(): ConversationsService
  /** Lazy: the issue tracker is constructed after this one. */
  issues(): IssueService
  /** Full issue-list fan-out through the publisher (ledger reconcile + legacy
   *  snapshot). Mutually recursive with the broadcast pipeline by design — the
   *  publisher's own deps point back at fanOutSnapshot/sendMetadataDelta here. */
  publishIssues(): void
  /** Local ∪ upstream issue wire list (attachClient bootstrap + snapshot sync). */
  issuesWire(): IssueWire[]
  /** Durable scheduled definitions and run history for bootstrap/snapshot sync. */
  automationsWire(): AutomationWire[]
  automationRunsWire(): AutomationRunWire[]
  /** Relayed agent op (modules/issues/relay-gate). */
  runAgentRelay(machineId: string, msg: Extract<DaemonMessage, { type: 'agentRelayRequest' }>): void
  /** POD-665: a worktree appeared/vanished out from under connected clients —
   *  nudge them to re-fetch repos. Raw invalidation, no payload. */
  onWorktreesChanged(repoPath: string, machineId?: string): void
  /** Approval broker [spec:SP-edbb]: daemon execution outcome + attach snapshot. */
  onApprovalExecResult(msg: Extract<DaemonMessage, { type: 'approvalExecResult' }>): void
  approvalsPending(): ApprovalWire[]
  /** Prepare every registered source of machine-authored context before spawn.
   * Providers commit side effects only after the session row + command exist. */
  instructionsForStart(input: {
    sessionId: string
    cwd: string
    agentKind: AgentKind
    issueId?: string
    workflowRevisionId?: string
    existingOnly?: boolean
  }): PreparedSessionInstructions
}

// Session fields that DON'T feed issue wire data [POD-722]. IssueWire.sessions
// embeds each member SessionMeta VERBATIM (issue-util sessionsForIssue → toWire),
// so every SessionMeta field is issue-relevant EXCEPT the connection-plumbing trio
// a bare attach/detach/control-transfer moves: clientCount, controllerId, epoch.
// Denylisting (strip these) rather than allow-picking keeps any newly-added
// SessionMeta field issue-relevant by default — over-broadcast is safe, under-
// broadcast leaves a stale issue panel. Interim until POD-308 deletes the
// snapshot fan-out.
const NON_ISSUE_SESSION_FIELDS = ['clientCount', 'controllerId', 'epoch'] as const

/** Stable serialization of the issue-relevant slice of every session — the input
 *  that decides whether a session broadcast must republish issues [POD-722]. */
function issueRelevantSessionProjection(sessions: SessionMeta[]): string {
  return JSON.stringify(
    sessions.map((s) => {
      const proj: Record<string, unknown> = { ...s }
      for (const f of NON_ISSUE_SESSION_FIELDS) delete proj[f]
      return proj
    }),
  )
}

/**
 * Core session lifecycle + PTY frame relay + scheduling (issue #13 Phase 2):
 * the sessions/clients maps, spawn/resume/park/kill command paths, the client
 * and daemon ws data planes, the durable queued-send drain, and the coalesced
 * session broadcast pipeline (metadata oplog + split fan-out). SessionRegistry
 * is the composition root that wires this to the other modules and keeps thin
 * public delegates.
 */
export interface SessionSpawnResult {
  sessionId: string
  agentId: string
  harness: AgentKind
  model: string | null
  effort: string | null
  machine: string
  machineId: string
  accountId: string | null
}

export class SessionsService {
  /** Live maps — public: the composition root's cross-module closures (and the
   *  relay tests, via `(reg as any).sessions/.clients`) reach them directly. */
  readonly sessions = new Map<string, Session>()
  readonly clients = new Map<string, ClientConn>()

  private readonly store: SessionStore
  private readonly now: () => number
  private readonly bus: EventBus
  private readonly machines: MachinesService
  private readonly rpc: DaemonRpcService
  private readonly hosts: HostsService
  private readonly headless: HeadlessService
  /** Backend auto-continue loop — re-arms retryable errored agents. */
  private readonly autoContinue: AutoContinueController
  /** The write funnel — owns the durable metadata oplog (docs/spec/oplog-read-path.md). */
  private readonly funnel: WriteFunnel

  /**
   * In-progress composer/prompt text per session. The live value lives here (read
   * by attachClient to replay on connect); it is also debounced to the store so it
   * survives a server restart and a full web reload with no other client holding it
   * (issue #34). Hydrated from the store at boot in loadFromStore().
   */
  private draftBySession = new Map<string, string>()
  /** Per-session title debouncers — drop transient spinner titles, coalesce bursts. */
  private readonly titleDebouncers = new Map<string, ReturnType<typeof makeTitleDebouncer>>()
  // Pending debounced draft persists, keyed by sessionId — one timer per session
  // coalesces a burst of keystrokes into a single SQLite write.
  private readonly draftWriteTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private static readonly DRAFT_WRITE_DEBOUNCE_MS = 750
  // Server-only dirty generation [spec:SP-c29e]. It schedules projection work and
  // invalidates the legacy snapshot cache; ledger seq remains the sole durable and
  // client-visible ordering/catch-up primitive. Every successful persisted or
  // explicitly captured wire mutation bumps once. The value is never serialized.
  private sessionsGeneration_ = 0
  private readonly sessionProjectionListeners = new Set<(event: SessionProjectionEvent) => void>()
  private volatileSessionMutationVersion = 0
  private readonly pendingVolatileSessions = new Map<
    string,
    { version: number; preserve: Set<SessionVolatileField> }
  >()
  private readonly capturedSessionStates = new Map<string, SessionDurableState>()
  private volatileSessionCaptureTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly VOLATILE_CAPTURE_RETRY_MS = 1_000
  // The generation whose legacy sessionsChanged snapshot completed successfully.
  // Generation equality replaces byte-string equality so A→B→A inside one
  // coalescing window still invalidates work even though the final bytes match.
  private lastSessionsBroadcastGeneration = -1
  // Generation currently being run. It is stamped before fan-out to preserve the
  // old re-entrant same-state guard and restored if any broadcast body step throws.
  private runningSessionsBroadcastGeneration = -1
  // Last issue-relevant session projection published to issue clients [POD-722].
  // runSessionsBroadcast compares this against the current projection to decide
  // whether the O(issues×sessions) publishIssues() rebuild is actually needed —
  // a bare attach/detach/control-transfer moves only clientCount/controllerId/
  // epoch, none of which feed issue wire data, so it can be skipped. Stamped only
  // after a successful publishIssues(), so a throw retries on the next broadcast.
  // Interim until POD-308 deletes the snapshot fan-out.
  private lastIssueSessionProjection = ''
  private nextClientNum = 0
  // Last per-session output-relay priority pushed to the daemon. pushPriorities
  // diffs against this so only CHANGED sessions are re-sent (a viewState/attach
  // churn must not re-flood the daemon with the whole map every time).
  private readonly lastPriority = new Map<string, number>()
  /** Pending remote browser-open requests, parked here when no client is connected. */
  private readonly pendingOpenUrls = new Map<string, SessionOpenUrlMessage>()
  private readonly openUrlExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // Single timer that persists only sessions whose activity counters advanced
  // since the last tick — keeps the per-frame / per-keystroke path off the DB.
  private readonly activityFlushTimer = setInterval(() => this.flushActivity(), 12_000)

  constructor(private readonly deps: SessionsServiceDeps) {
    this.store = deps.store
    this.now = deps.now
    this.bus = deps.bus
    this.machines = deps.machines
    this.rpc = deps.rpc
    this.hosts = deps.hosts
    this.headless = deps.headless
    this.activityFlushTimer.unref?.()
    this.funnel = deps.funnel
    this.autoContinue = new AutoContinueController({
      isEnabled: () => this.store.settings.getSettings().autoContinue.enabled,
      sendContinue: (sessionId) => {
        this.continueSession({ sessionId })
      },
      getSession: (sessionId) => {
        // The controller re-arms off fresh agentState events, so overnight recovery
        // after a daemon reattach relies on reattach re-seeding agentState (seedBootState).
        const s = this.sessions.get(sessionId)
        if (!s) return undefined
        return { live: s.status === 'live' || s.status === 'starting', state: s.agentState }
      },
    })
    // Auto-continue re-arm on the settings flip — the reaction needs the sessions
    // map, so it lives here as a bus subscriber (this service is constructed AFTER
    // NotifyService, so the notification replay keeps firing first).
    this.bus.on('settings.changed', ({ previous, next }) => {
      const wasEnabled = previous.autoContinue.enabled
      const nowEnabled = next.autoContinue.enabled
      if (nowEnabled === wasEnabled) return
      const ids = nowEnabled
        ? [...this.sessions.values()]
            .filter(
              (s) =>
                (s.status === 'live' || s.status === 'starting') &&
                s.agentState?.phase === 'errored' &&
                s.agentState.error?.retryable === true,
            )
            .map((s) => s.sessionId)
        : []
      this.autoContinue.onSettingsChanged(nowEnabled, ids)
    })
    // Agent mail send-time nudge (issue #103): poke the target issue's live agent
    // session so mail is noticed without polling. The nudge carries NO message
    // body — an idempotent "check your inbox" poke. Selection: a single idle
    // live agent gets an immediate sendText; otherwise the most recently active
    // live agent gets a durable queued send; no live agents → nothing (the mail
    // surfaces via prime / the stop-hook).
    this.bus.on('issue.mailSent', ({ seq, worktreePath }) => {
      const members = sessionsForIssue(worktreePath ?? null, this.listSessions())
      const target = selectMailNudgeSession(members)
      if (!target) return
      const text = `You have mail on issue #${seq}: run 'podium issue mail inbox' (claim with 'podium issue mail claim <id>' only if you will act on it).`
      if (target.mode === 'send') this.sendText({ sessionId: target.sessionId, text })
      else void this.queueText({ sessionId: target.sessionId, text })
    })
  }

  private issues(): IssueService {
    return this.deps.issues()
  }

  private conversations(): ConversationsService {
    return this.deps.conversations()
  }

  dispose(): void {
    clearInterval(this.activityFlushTimer)
    for (const timer of this.openUrlExpiryTimers.values()) clearTimeout(timer)
    this.openUrlExpiryTimers.clear()
    this.pendingOpenUrls.clear()
    // Graceful server restarts must not lose a resize that landed inside the
    // coalescing window; persist dirty geometry/activity before closing [spec:SP-1a0b].
    this.flushActivity()
    // Run any coalesced session broadcast + pending delta batch. The durable
    // change log is already complete (commits happen at persist time, #256);
    // this just drains the in-flight fan-out tail deterministically.
    this.flushBroadcasts()
  }

  /** Current server-local session projection generation. Never sent to clients. */
  sessionsGeneration(): number {
    return this.sessionsGeneration_
  }

  /** Ordered post-capture patches for projection workers [spec:SP-c29e]. */
  onSessionProjection(listener: (event: SessionProjectionEvent) => void): () => void {
    this.sessionProjectionListeners.add(listener)
    return () => this.sessionProjectionListeners.delete(listener)
  }

  private publishSessionProjection(
    changes: MetadataChange[],
    ledgerCursor: number | undefined = changes.at(-1)?.seq,
  ): void {
    const sessionChanges = changes.filter((change) => change.entity === 'session')
    if (sessionChanges.length === 0 || ledgerCursor === undefined) return
    const event: SessionProjectionEvent = {
      generation: ++this.sessionsGeneration_,
      changes: sessionChanges,
      ledgerCursor,
    }
    for (const listener of this.sessionProjectionListeners) {
      try {
        listener(event)
      } catch (err) {
        console.error('[sessions] projection listener threw', err)
      }
    }
  }

  /** Explicit non-row capture seam [spec:SP-c29e]. */
  private captureSessionSpecs(specs: EntityChangeSpec[]): MetadataChange[] {
    if (specs.length === 0) return []
    const changes = this.deps.ledger.capture(specs)
    this.publishSessionProjection(changes)
    return changes
  }

  private markVolatileSessionDirty(
    sessionId: string,
    preserve: SessionVolatileField[] = ['geometry', 'handoffTarget'],
  ): void {
    const previous = this.pendingVolatileSessions.get(sessionId)
    this.pendingVolatileSessions.set(sessionId, {
      version: ++this.volatileSessionMutationVersion,
      preserve: new Set([...(previous?.preserve ?? []), ...preserve]),
    })
    this.scheduleVolatileSessionCapture()
  }

  private scheduleVolatileSessionCapture(delayMs = 0): void {
    if (this.volatileSessionCaptureTimer) return
    this.volatileSessionCaptureTimer = setTimeout(() => {
      this.volatileSessionCaptureTimer = null
      try {
        this.flushBroadcasts()
      } catch (err) {
        console.warn('[podium] volatile session capture failed', err)
      }
    }, delayMs)
    this.volatileSessionCaptureTimer.unref?.()
  }

  private clearVolatileSessionCaptureTimer(): void {
    if (!this.volatileSessionCaptureTimer) return
    clearTimeout(this.volatileSessionCaptureTimer)
    this.volatileSessionCaptureTimer = null
  }

  private flushVolatileSessionCaptures(): MetadataChange[] {
    this.clearVolatileSessionCaptureTimer()
    if (this.pendingVolatileSessions.size === 0) return []
    const pending = [...this.pendingVolatileSessions]
    const specs: EntityChangeSpec[] = []
    for (const [sessionId] of pending) {
      const session = this.sessions.get(sessionId)
      if (!session) continue
      specs.push({
        entity: 'session',
        id: sessionId,
        op: 'upsert',
        value: this.sessionWire(session),
      })
    }
    try {
      const changes = this.captureSessionSpecs(specs)
      // A volatile A→B→A batch legitimately dedups to no durable patch, but it
      // still invalidates the legacy snapshot pipeline once. Do not fabricate a
      // projection event: patch consumers need only the captured final truth.
      if (!changes.some((change) => change.entity === 'session')) {
        this.sessionsGeneration_++
      }
      for (const [sessionId, pendingState] of pending) {
        const session = this.sessions.get(sessionId)
        if (session) this.capturedSessionStates.set(sessionId, session.captureDurableState())
        if (this.pendingVolatileSessions.get(sessionId)?.version === pendingState.version) {
          this.pendingVolatileSessions.delete(sessionId)
        }
      }
      return changes
    } catch (err) {
      this.scheduleVolatileSessionCapture(SessionsService.VOLATILE_CAPTURE_RETRY_MS)
      throw err
    }
  }

  /** Central volatile Session-view mutation seam. The latest value is captured
   * once per session by the coalesced broadcast flush, keeping interaction paths
   * free of synchronous SQLite writes [spec:SP-c29e]. */
  private mutateSessionView(sessionId: string, mutate: (session: Session) => void): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    mutate(session)
    this.markVolatileSessionDirty(sessionId)
    return true
  }

  /** Machine-owned derived fields changed (machineId and/or machineName). */
  sessionsChangedForMachine(machineId: string): void {
    for (const session of this.sessions.values()) {
      if (session.machineId === machineId)
        this.markVolatileSessionDirty(session.sessionId, ['machineId'])
    }
    this.broadcastSessions()
  }

  /**
   * THE session write seam ([spec:SP-3fe2] #256): every persist commits the
   * row write and its declared session change through the write-seam Ledger —
   * one transact span, so "the row changed" and "the change log says so"
   * commit or roll back together. All ~15 persisting handlers inherit this,
   * including the ones that persist WITHOUT a session broadcast (agentState,
   * title, derived-title, flushActivity): their persisted truth reaches the
   * change log at write time instead of leaking until the next full broadcast.
   *
   * Change volume: the per-frame path never lands here (frames only mark
   * activityDirty; flushActivity persists on a 12s tick), and the ledger's
   * byte-dedup drops persists whose WIRE meta didn't change — notably the
   * frequent counter-only flushes, whose lastOutputAt/lastInputAt live in the
   * row but not in SessionMeta. lastActiveAt IS wire-visible and deliberately
   * NOT projected away (unlike the conversation projection): it advances only
   * on semantic activity (agentState transitions, shell busy flips) and is the
   * authoritative recency delta clients order the sidebar by.
   */
  persist(session: Session, additionalWrite: () => void = () => {}): void {
    const pending = this.pendingVolatileSessions.get(session.sessionId)
    let changes: MetadataChange[]
    try {
      const committed = this.deps.ledger.commit({
        write: () => {
          additionalWrite()
          this.store.sessions.upsertSession(session.toRow())
        },
        changes: () => [
          {
            entity: 'session',
            id: session.sessionId,
            op: 'upsert',
            value: this.sessionWire(session),
          },
        ],
      })
      changes = committed.changes
    } catch (err) {
      const captured = this.capturedSessionStates.get(session.sessionId)
      if (captured) session.restoreDurableState(captured, pending?.preserve)
      else this.sessions.delete(session.sessionId)
      throw err
    }
    if (
      pending !== undefined &&
      this.pendingVolatileSessions.get(session.sessionId)?.version === pending.version
    ) {
      this.pendingVolatileSessions.delete(session.sessionId)
      if (this.pendingVolatileSessions.size === 0) this.clearVolatileSessionCaptureTimer()
    }
    this.capturedSessionStates.set(session.sessionId, session.captureDurableState())
    this.publishSessionProjection(changes)
  }

  /** The exact wire shape broadcasts carry for this session — toMeta() plus the
   *  machineName stamp listSessions() applies. The committed payload and the
   *  legacy snapshot rows must agree byte-for-byte or the ledger's dedup and
   *  the clients' replicas would diverge. */
  private sessionWire(session: Session): SessionMeta {
    return this.stampRef(session, {
      ...session.toMeta(),
      machineName: this.machines.machineName(session.machineId),
    })
  }

  /**
   * Stamp the derived permanent `displayRef` onto a session's wire meta (#474).
   * PURE READ — allocation happens at the deliberate naming points
   * (spawn / first attach / boot backfill), never inside serialization.
   * Upstream/mirrored sessions have no local Session and keep their own ref.
   */
  private stampRef(session: Session, meta: SessionMeta): SessionMeta {
    const displayRef = this.computeSessionDisplayRef(session)
    return {
      ...meta,
      ...(session.refIssueId ? { refIssueId: session.refIssueId } : {}),
      ...(session.refLetter ? { refLetter: session.refLetter } : {}),
      ...(session.refDraft != null ? { refDraft: session.refDraft } : {}),
      ...(displayRef ? { displayRef } : {}),
    }
  }

  /**
   * NAMING POINT (#474): assign the permanent birth ref if this session has
   * none yet. The birth issue is the session's issue AT NAMING TIME; a session
   * with none is named in the per-repo DRAFT namespace. Never reallocates —
   * a later re-attach keeps the birth name.
   *
   * Called only at deliberate moments (never during reads/serialization):
   *   - spawnSession, after issueId resolution completed,
   *   - the first setSessionIssueId on a still-unnamed session,
   *   - the one-shot boot backfill for pre-#474 historical rows.
   */
  private allocateSessionRef(session: Session): void {
    if (session.refIssueId || session.refDraft != null) return
    const birthIssueId = session.issueId ?? null
    if (birthIssueId) {
      const issue = this.store.issues.getIssue(birthIssueId)
      if (issue) {
        session.refLetter = this.store.issues.allocateSessionLetter(birthIssueId)
        session.refIssueId = birthIssueId
        this.persist(session)
        return
      }
    }
    // Truly issueless → per-repo DRAFT counter (`POD-DRAFT-3`). Skip when the
    // cwd resolves to no registered prefix: the name could never render, and
    // the high-water counter makes skipping safe (no ordinal is ever reused).
    const repoId = this.store.repos.resolveRepoIdForPath(session.cwd)
    if (this.store.repos.prefixForRepoId(repoId) === null) return
    session.refDraft = this.store.repos.nextDraftSeq(repoId)
    this.persist(session)
  }

  /** The permanent birth nice name (`POD-13-A` / `POD-DRAFT-3`), or undefined
   *  when its repo prefix / birth issue can't be resolved. Pure. */
  private computeSessionDisplayRef(session: Session): string | undefined {
    if (session.refIssueId && session.refLetter) {
      const issue = this.store.issues.getIssue(session.refIssueId)
      if (!issue) return undefined
      const prefix = this.store.repos.prefixForPath(issue.repoPath)
      return prefix
        ? formatSessionRef({ prefix, seq: issue.seq, letter: session.refLetter })
        : undefined
    }
    if (session.refDraft != null) {
      const prefix = this.store.repos.prefixForPath(session.cwd)
      return prefix ? formatSessionRef({ prefix, draft: session.refDraft }) : undefined
    }
    return undefined
  }

  /** Persist every session whose activity counters advanced since the last flush.
   *  Keeps the per-frame / per-keystroke path off the DB — the timer above calls
   *  this on a coarse interval, so a busy session writes at most once per tick. */
  flushActivity(): void {
    for (const s of this.sessions.values()) {
      if (s.activityDirty) {
        this.persist(s)
        s.clearActivityDirty()
      }
    }
  }

  /** Materialize one persisted row without exposing it until the caller installs it.
   *  Restored tombstones always come back as exited: deletion killed their runtime,
   *  so retaining a prior live/starting status would claim a PTY that no longer exists. */
  private sessionFromStoredRow(r: SessionRow, mode: 'boot' | 'restore'): Session | null {
    const kind = AgentKind.safeParse(r.agentKind)
    if (!kind.success) {
      console.warn(
        `[podium] skipping persisted session ${r.id}: invalid agentKind ${JSON.stringify(r.agentKind)}`,
      )
      return null
    }
    const reloadStatus =
      mode === 'restore'
        ? 'exited'
        : r.headless
          ? r.status
          : r.status === 'live' || r.status === 'starting'
            ? 'reconnecting'
            : r.status
    const exitCode = mode === 'restore' || r.status !== 'exited' ? null : r.exitCode
    if (r.originKind === 'resume' && !r.conversationId) {
      console.warn(`[podium] persisted resume session ${r.id} has no conversationId`)
    }
    const machineId = r.machineId ?? LOCAL_PLACEHOLDER
    let session!: Session
    session = new Session({
      sessionId: r.id,
      agentKind: kind.data,
      cwd: r.cwd,
      title: r.title,
      origin:
        r.originKind === 'resume'
          ? { kind: 'resume', conversationId: r.conversationId ?? '' }
          : { kind: 'spawn' },
      createdAt: r.createdAt,
      geometry: { ...(r.geometry ?? DEFAULT_GEOMETRY) },
      machineId,
      toDaemon: (msg) => this.toMachine(this.sessions.get(r.id)?.machineId ?? machineId, msg),
      onActivity: () => {
        this.persist(session)
        this.broadcastSessions()
      },
      durableLabel: r.durableLabel,
      lastActiveAt: r.lastActiveAt,
      ...(r.workingMsTotal != null ? { workingMsTotal: r.workingMsTotal } : {}),
      lastOutputAt: r.lastOutputAt,
      lastInputAt: r.lastInputAt,
      lastResumedAt: r.lastResumedAt,
      status: reloadStatus,
      exitCode: exitCode ?? undefined,
      ...(r.name ? { name: r.name } : {}),
      // Survives a restart — otherwise a reboot would forget that the USER named this
      // session and the next agent title would sail straight through (#490).
      ...(r.name && r.nameSource ? { nameSource: r.nameSource } : {}),
      ...(r.model ? { model: r.model } : {}),
      ...(r.effort ? { effort: r.effort } : {}),
      ...(r.accountId ? { accountId: r.accountId } : {}),
      ...(r.spawnedBy ? { spawnedBy: r.spawnedBy } : {}),
      ...(r.headless ? { headless: true } : {}),
      ...(r.issueId ? { issueId: r.issueId } : {}),
      ...(r.refIssueId ? { refIssueId: r.refIssueId } : {}),
      ...(r.refLetter ? { refLetter: r.refLetter } : {}),
      ...(r.refDraft != null ? { refDraft: r.refDraft } : {}),
      ...(r.workflowRunId ? { workflowRunId: r.workflowRunId } : {}),
      ...(r.workflowStepId ? { workflowStepId: r.workflowStepId } : {}),
      ...(r.executionProfileId ? { executionProfileId: r.executionProfileId } : {}),
      archived: r.archived,
      readAt: r.readAt ?? null,
      ...(Session.parseWorkState(r.workState)
        ? { workState: Session.parseWorkState(r.workState) }
        : {}),
      ...(r.resumeKind && r.resumeValue
        ? { resume: { kind: r.resumeKind, value: r.resumeValue } }
        : {}),
    })
    return session
  }

  private installStoredSession(
    session: Session,
    snoozes: Record<string, string | null>,
    draftTimes: Record<string, string>,
    drafts: Record<string, string>,
    offers: Record<
      string,
      { message: string; actions: { label: string; prompt: string }[]; createdAt: string }
    >,
  ): void {
    this.sessions.set(session.sessionId, session)
    if (session.sessionId in snoozes) session.snoozedUntil = snoozes[session.sessionId]
    if (session.sessionId in draftTimes) session.draftUpdatedAt = draftTimes[session.sessionId]
    if (session.sessionId in offers) session.offer = offers[session.sessionId] // [spec:SP-c7f1]
    if (session.sessionId in drafts) {
      this.draftBySession.set(session.sessionId, drafts[session.sessionId] ?? '')
    }
    if (session.resume?.value) {
      session.conversationPodiumId = this.store.conversations.conversationPodiumId(
        session.machineId,
        session.resume.value,
      )
    }
    this.capturedSessionStates.set(session.sessionId, session.captureDurableState())
  }

  loadFromStore(): void {
    const drafts = this.store.sessions.loadDrafts()
    // Drafts historically replay independently of session-row existence. Keep
    // that contract for crash/orphan recovery; active rows additionally receive
    // their draft timestamp and runtime metadata below.
    for (const [sessionId, text] of Object.entries(drafts)) {
      this.draftBySession.set(sessionId, text)
    }
    const draftTimes = this.store.sessions.loadDraftTimes()
    const snoozes = this.store.sessions.listSnoozes()
    const offers = this.store.sessions.listOffers() // [spec:SP-c7f1]
    for (const r of this.store.sessions.loadSessions()) {
      const session = this.sessionFromStoredRow(r, 'boot')
      if (!session) continue
      this.installStoredSession(session, snoozes, draftTimes, drafts, offers)
      if (r.status !== session.status) this.persist(session)
    }
    // One-shot boot backfill (#474): name pre-upgrade historical sessions at a
    // deliberate point instead of burst-allocating inside the first listSessions.
    // loadSessions returns created_at order, so allocation is deterministic; the
    // loop is a no-op once every session carries a ref.
    for (const session of this.sessions.values()) this.allocateSessionRef(session)
    // Re-seed the transient queued-send counts from the durable queue — the rows
    // survived the restart (that's their point); delivery re-arms when the daemon
    // reattaches and the sessions bind.
    for (const [sessionId, n] of this.store.sync.queuedMessageCounts()) {
      const session = this.sessions.get(sessionId)
      if (session) session.queuedMessageCount = n
      else this.store.sync.deleteQueuedMessagesForSession(sessionId) // orphaned queue
    }
    this.store.sync.pruneAppliedMutations({
      maxAgeMs: APPLIED_MUTATIONS_MAX_AGE_MS,
      now: this.now(),
    })
    // Boot reconciliation ([spec:SP-3fe2] #256): diff the restored full truth
    // against the ledger baseline — INCLUDING removes (rows deleted or
    // quarantined while the server was down) — so a cursor-holding client that
    // reconnects heals via changesSince instead of silently missing the gap.
    // No fan-out: there are no clients at boot. Conversations are deliberately
    // NOT reconciled at boot: they are daemon-fed, and an empty list at boot
    // means "not scanned yet", not "all gone".
    // Boot ordering (#247): this runs BEFORE server.ts calls ensureLocalMachine,
    // so placeholder rows reconcile here with machineId '__local__'. That stale
    // baseline is unobservable and self-healing: adoption
    // (ensureLocalMachine → adoptPlaceholderRows) explicitly captures affected
    // sessions before its broadcast — all before the server accepts connections.
    const recovered = this.deps.ledger.reconcile(
      'session',
      this.listSessions().map((s) => ({ id: s.sessionId, value: s })),
    )
    this.publishSessionProjection(recovered)
  }

  attachDaemon(machineId: string, send: Send<ControlMessage>): void {
    // Socket bookkeeping (set + machine-cache invalidation) lives in the machines
    // module; the session orchestration around it stays here.
    this.machines.attach(machineId, send)
    // The local machine adopts every lingering `'__local__'` placeholder row/session/
    // queue onto itself as it attaches. ensureLocalMachine already ran this at startup,
    // but a session created in the gap between that and the daemon connecting (the boot
    // race) is still attributed to `'__local__'` — adopting on attach reattributes it and
    // carries its queued spawn over to this machine so it isn't dead-queued. Idempotent.
    if (machineId === LOCAL_MACHINE_ID) this.machines.adoptPlaceholderRows(machineId)
    // Flush control messages buffered while this machine was offline (e.g. a boot
    // session's spawn produced before the local daemon ws connected). AFTER adoption,
    // so messages carried over from the placeholder queue flush too.
    this.machines.flushQueued(machineId)
    // Re-arm queued-send delivery for this machine's sessions: their earlier drain
    // attempts parked while the daemon was away (single-flight + liveness wait make
    // this safe to fire eagerly; reattached sessions also re-trigger via 'bind').
    for (const s of this.sessions.values()) {
      if (s.machineId === machineId && s.queuedMessageCount > 0) {
        this.drainQueuedMessages(s.sessionId)
      }
    }
    // Attach trigger (transcript-mirror spec §2.3): catch-up sweep after server/daemon
    // downtime — re-enqueue this machine's unmirrored segments. No-op without a lake dir.
    this.conversations().triggerLakeSweep(machineId)
    // A freshly-(re)connected daemon knows no session's relay priority. Clear the
    // delta cache so every current session re-sends as a change, then push the full
    // map — otherwise a daemon restart would leave the scheduler at its default
    // until the next viewState/attach happened to flip a session.
    this.lastPriority.clear()
    this.pushPriorities()
    // Re-bind survivor sessions ON THIS MACHINE: ask its daemon to reattach to their
    // live durable host. 'reconnecting' = was live/starting at boot. 'exited' (not
    // archived) is also probed because a row can be wrongly 'exited': its attach
    // client died on a daemon restart while the master + agent survived in their
    // scope (pre-fix orphans, or any residual race). The daemon reattaches a live
    // master (→ a bind → markLive) or replies reattachFailed (→ it stays exited).
    // The durable host, not the persisted row, is the source of truth for liveness.
    // View-priority first, then most-recently-used: the daemon gates its spawn
    // fan-out, so the order we send in decides who reattaches soonest. A session
    // some connected client is focused on / rendering (viewState is
    // server-authoritative — the same tiers the output scheduler uses) must come
    // back typable before the long unwatched tail (POD-612); within a tier,
    // lastActiveAt is an ISO string, so a reverse lexical sort is newest-first.
    const probes = [...this.sessions.values()].filter(
      (s) =>
        s.machineId === machineId &&
        !s.headless &&
        (s.status === 'reconnecting' || (s.status === 'exited' && !s.archived)),
    )
    const viewTiers = computePriorities(
      [...this.clients.values()],
      probes.map((s) => s.sessionId),
    )
    probes.sort(
      (a, b) =>
        (viewTiers.get(a.sessionId) ?? 3) - (viewTiers.get(b.sessionId) ?? 3) ||
        (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''),
    )
    for (const s of probes) {
      this.toMachine(machineId, {
        type: 'reattach',
        sessionId: s.sessionId,
        durableLabel: s.durableLabel,
        agentKind: s.agentKind,
        cwd: s.cwd,
        geometry: s.geometry,
        ...(s.resume ? { resume: s.resume } : {}),
        ...(this.rpc.transcriptPathHint(s) ?? {}),
        // Spawn-time floor for observer-based harnesses (codex): lets a reattached
        // observer discover a lazily-created rollout it never saw before the restart.
        ...(Number.isFinite(Date.parse(s.createdAt))
          ? { createdAtMs: Date.parse(s.createdAt) }
          : {}),
      })
    }
    // Headless sessions have no PTY to reattach; instead re-establish their
    // daemon-side transcript tails (fire-and-forget — re-issued on every daemon
    // connect, so a missed bind self-heals on the next attach).
    for (const s of this.sessions.values()) {
      if (s.machineId !== machineId || !s.headless || !s.resume?.value) continue
      void this.headless
        .headlessBind({
          sessionId: s.sessionId,
          agentKind: s.agentKind,
          cwd: s.cwd,
          resumeValue: s.resume.value,
        })
        .then((r) => {
          if (!r.ok) {
            console.warn(
              `[podium] headless bind failed for ${s.sessionId}: ${r.error ?? 'unknown'}`,
            )
          }
        })
    }
    this.machines.broadcastMachines()
    this.bus.emit('machine.connected', { machineId })
  }

  detachDaemon(machineId: string, send?: Send<ControlMessage>): void {
    // A superseded socket's late close must not tear down the live registration, nor
    // knock this machine's sessions back to 'reconnecting' behind the daemon's back.
    if (!this.machines.detach(machineId, send)) return
    // Emitted HERE (not at the end) to preserve the pre-module ordering: the hosts
    // module drops this machine's health sample + rebroadcasts BEFORE the session
    // sweep below, exactly where the inline delete used to sit.
    this.bus.emit('machine.disconnected', { machineId })
    // The daemon that held THIS machine's sessions' PTY bridges is gone (daemon
    // restart/crash; durable masters survive in their own scopes). Drop only THIS
    // machine's live/starting sessions to 'reconnecting' so the next daemon to attach
    // re-binds them — attachDaemon only probes 'reconnecting'/'exited'. Sessions on
    // OTHER machines are untouched. Without this a daemon-only restart leaves sessions
    // 'live' but unattached: the server never re-asks and they orphan until a server
    // restart. (In the old single-process world the daemon never restarted alone, so
    // this gap couldn't surface.)
    const changed: Session[] = []
    for (const s of this.sessions.values()) {
      if (s.machineId !== machineId) continue
      // Headless sessions stay 'live' across daemon restarts — no PTY bridge to
      // lose; their tails re-establish via headlessBind on the next attach.
      if (s.headless) continue
      if (s.markReconnecting()) changed.push(s)
    }
    if (changed.length > 0) {
      for (const session of changed) this.markVolatileSessionDirty(session.sessionId, ['status'])
      this.broadcastSessions()
    }
    this.machines.broadcastMachines()
  }

  /** Route a control message to the daemon that owns `machineId` (modules/machines);
   *  queued if that machine is briefly offline. Kept as a property so Session
   *  toDaemon closures and every internal call site bind through one seam. */
  private readonly toMachine = (machineId: string, msg: ControlMessage): void =>
    this.machines.toMachine(machineId, msg)

  /**
   * Recompute per-session output-relay priority across every client and push the
   * deltas to the daemon. computePriorities re-iterates its `clients` argument
   * ONCE PER SESSION, so a single-use iterator (this.clients.values()) would
   * exhaust after the first session and read every later session as tier 3 —
   * materialize it to an array. Only CHANGED sessions are sent (diffed against
   * lastPriority) so a viewState/attach churn never re-floods the whole map.
   */
  private pushPriorities(): void {
    const priorities = computePriorities([...this.clients.values()], this.sessions.keys())
    for (const [sessionId, priority] of priorities) {
      if (this.lastPriority.get(sessionId) === priority) continue
      this.lastPriority.set(sessionId, priority)
      // Route the priority to the daemon that actually runs this session (multi-machine).
      const machineId = this.sessions.get(sessionId)?.machineId ?? LOCAL_PLACEHOLDER
      this.toMachine(machineId, { type: 'sessionPriority', sessionId, priority })
    }
  }

  // ---- tRPC control plane ----
  listSessions(): SessionMeta[] {
    const local: SessionMeta[] = [...this.sessions.values()].map((s) =>
      this.stampRef(s, { ...s.toMeta(), machineName: this.machines.machineName(s.machineId) }),
    )
    if (this.upstreamSessions.size === 0) return local
    // Local ∪ upstream (docs/spec/node-hub-sync.md §2.3). Upstream entries carry
    // viaHub (set at ingest) and, while the hub link is down, upstreamStale —
    // applied at read time so a staleness flip needs no rewrite of the mirror.
    // A local id always wins a collision; the retained upstream entry is revealed
    // if that local session is later removed.
    const localIds = new Set(local.map((s) => s.sessionId))
    const upstream = [...this.upstreamSessions.values()]
      .filter((s) => !localIds.has(s.sessionId))
      .map((s) => (this.upstreamStale ? { ...s, upstreamStale: true } : s))
    return [...local, ...upstream]
  }

  // ---- upstream mirror (node⇄hub sync, docs/spec/node-hub-sync.md §2.3) ----
  // Entities mirrored FROM the hub this node syncs against. They are display/read
  // surfaces: never in this.sessions (so PTY/command paths can't touch them), never
  // pushed back upstream (viaHub provenance), and retained-but-stale on hub loss.
  private readonly upstreamSessions = new Map<string, SessionMeta>()
  private upstreamStale = false
  /** machineIds that ARE this node (its daemon may also be paired with the hub in
   *  some topologies) — hub entries for them are echoes and are dropped at ingest. */
  private upstreamOwnMachineIds = new Set<string>()

  setUpstreamOwnMachineIds(ids: Iterable<string>): void {
    this.upstreamOwnMachineIds = new Set(ids)
  }

  /** True when `sessionId` is a hub-mirrored (read-only) session. */
  isUpstreamSession(sessionId: string): boolean {
    return !this.sessions.has(sessionId) && this.upstreamSessions.has(sessionId)
  }

  /** `{ ok: false, reason }` for a hub-mirrored session, else null — the shared
   *  guard every ok/reason command path checks first. */
  private upstreamRejection(sessionId: string): { ok: false; reason: string } | null {
    if (this.sessions.has(sessionId) || !this.upstreamSessions.has(sessionId)) return null
    return { ok: false, reason: UPSTREAM_COMMAND_REJECTION }
  }

  /**
   * Replace the mirrored session list with the hub's truth. Own-machine entries are
   * excluded (echo filter — this node's daemon registered with the hub would reflect
   * its own sessions back). Entries colliding with a local session id are retained
   * behind the local value so the latest upstream truth can be revealed later.
   * Entries are stamped `viaHub` at ingest so provenance travels with the value —
   * the P7b push path and the UI both key off it. Flows through the normal
   * broadcast/oplog pipeline so node clients see hub sessions live.
   */
  private upstreamWire(session: SessionMeta): SessionMeta {
    return this.upstreamStale ? { ...session, upstreamStale: true } : session
  }

  setUpstreamSessions(list: SessionMeta[]): void {
    const previous = new Map(this.upstreamSessions)
    this.upstreamSessions.clear()
    for (const session of list) {
      if (session.machineId !== undefined && this.upstreamOwnMachineIds.has(session.machineId)) {
        continue
      }
      this.upstreamSessions.set(session.sessionId, { ...session, viaHub: true })
    }
    const specs: EntityChangeSpec[] = [...this.upstreamSessions.values()]
      .filter((session) => !this.sessions.has(session.sessionId))
      .map((session) => ({
        entity: 'session',
        id: session.sessionId,
        op: 'upsert',
        value: this.upstreamWire(session),
      }))
    for (const id of previous.keys()) {
      if (!this.upstreamSessions.has(id) && !this.sessions.has(id)) {
        specs.push({ entity: 'session', id, op: 'remove' })
      }
    }
    try {
      this.captureSessionSpecs(specs)
    } catch (err) {
      this.upstreamSessions.clear()
      for (const [id, session] of previous) this.upstreamSessions.set(id, session)
      throw err
    }
    this.broadcastSessions()
  }

  /**
   * Hub reachability flip for the SESSION mirror. Unreachable → mirrored entries
   * are KEPT and marked stale (spec §2.3: degrade to stale-visible, never to
   * blank); local entities are never affected. Returns false when the flag did
   * not change — the composition root uses that to skip the conversation/issue
   * mirror rebroadcasts (they read the flag via isUpstreamStale()).
   */
  setUpstreamStale(stale: boolean): boolean {
    if (this.upstreamStale === stale) return false
    const previous = this.upstreamStale
    this.upstreamStale = stale
    try {
      this.captureSessionSpecs(
        [...this.upstreamSessions.values()]
          .filter((session) => !this.sessions.has(session.sessionId))
          .map((session) => ({
            entity: 'session',
            id: session.sessionId,
            op: 'upsert',
            value: this.upstreamWire(session),
          })),
      )
    } catch (err) {
      this.upstreamStale = previous
      throw err
    }
    if (this.upstreamSessions.size > 0) this.broadcastSessions()
    // The conversation/issue mirrors follow via the bus (they read the flag
    // through isUpstreamStale() at publish time and rebroadcast on the flip).
    this.bus.emit('upstream.staleChanged', { stale })
    return true
  }

  /** Current hub-staleness flag — read by the conversation/issue mirrors at publish time. */
  isUpstreamStale(): boolean {
    return this.upstreamStale
  }

  setSnooze({ sessionId, until }: { sessionId: string; until: string | null }): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      this.store.sessions.setSnooze(sessionId, until)
      this.broadcastSessions()
      return
    }
    session.snoozedUntil = until
    this.persist(session, () => this.store.sessions.setSnooze(sessionId, until))
    this.broadcastSessions()
  }

  clearSnooze(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || !session.clearSnooze()) {
      this.store.sessions.clearSnooze(sessionId)
      this.broadcastSessions()
      return
    }
    this.persist(session, () => this.store.sessions.clearSnooze(sessionId))
    this.broadcastSessions()
  }

  /** Set (replace) a session's agent action offer [spec:SP-c7f1]. A subsequent
   *  offer replaces the previous one. Persisted in the `offers` table (off-row,
   *  like snooze) and broadcast so every client's chat bar updates. */
  setOffer({
    sessionId,
    message,
    actions,
  }: {
    sessionId: string
    message: string
    actions: { label: string; prompt: string }[]
  }): void {
    const offer = { message, actions, createdAt: new Date().toISOString() }
    const session = this.sessions.get(sessionId)
    if (!session) {
      this.store.sessions.setOffer(sessionId, offer)
      this.broadcastSessions()
      return
    }
    session.offer = offer
    this.persist(session, () => this.store.sessions.setOffer(sessionId, offer))
    this.broadcastSessions()
  }

  /** Clear a session's agent action offer [spec:SP-c7f1] (explicit `offer clear`
   *  or auto-clear on the next user turn). Skips work when nothing changes. */
  clearOffer(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || !session.clearOffer()) {
      this.store.sessions.clearOffer(sessionId)
      this.broadcastSessions()
      return
    }
    this.persist(session, () => this.store.sessions.clearOffer(sessionId))
    this.broadcastSessions()
  }

  /** Phases that put a session in the sidebar's attention bucket — mirrors the
   *  web's attentionGroup 'needsYou' branch. Used to clear a snooze when the
   *  agent moves on. */
  private static isAttentionPhase(s: AgentRuntimeState | undefined): boolean {
    const phase = s?.phase
    if (phase === 'needs_user' || phase === 'errored') return true
    if (phase === 'idle') return !!s?.idle && s.idle.kind !== 'done'
    return false
  }

  /** Agent kind may be omitted — the settings default decides ('auto' = Claude Code).
   *  `initialPrompt` hands the fresh session the human's first prompt: for argv-capable
   *  agents (claude/codex/grok) it rides the launch command (`claude "<prompt>"`,
   *  race-free); for the rest it's seeded into the composer draft. */
  createSession(input: {
    agentKind?: AgentKind
    cwd: string
    title?: string
    /** Spawner-prescribed curated name [spec:SP-4ef9][spec:SP-eb60]. Lands in the
     *  `name` slot with `nameSource='agent'` (NOT the derived `title` slot). Same
     *  normalize rules as setAgentName; optional — absent leaves the child unnamed
     *  so it self-titles as today. */
    name?: string
    machineId?: string
    initialPrompt?: string
    /** Per-ticket model/effort override; absent = use the settings defaults. */
    model?: string
    effort?: string
    /** Resolved account selection from an execution profile; never credential material. */
    accountId?: string
    /** Deliberately spawn with a model slug the live catalog doesn't list (bypasses
     *  the unknown-MODEL rejection only) [spec:SP-cc60]. Recorded in events when it
     *  takes effect. */
    forceUnknownModel?: boolean
    /** Creation provenance (issue #60). Deliberately NOT defaulted here — the tRPC
     *  router stamps 'user' (its callers are the human seams); programmatic callers
     *  (issues, superagent) pass their own value. Absent = unknown. */
    spawnedBy?: string
    /** OPTIONAL workflow pass-through metadata (#285 via #237 [spec:SP-34d7
     *  cross-harness]) — persisted verbatim, never interpreted here. */
    workflowRunId?: string
    workflowStepId?: string
    executionProfileId?: string
    /** Explicit issue attachment (issue-as-workspace). Absent = derive: a session
     *  spawned inside a worktree owned by exactly one non-archived issue is
     *  "continuing that issue" and gets its id stamped. */
    issueId?: string
    /** Client-supplied id (optimistic UI): use this verbatim instead of minting a
     *  fresh uuid, so an optimistic client row reconciles onto the real session
     *  without a swap. Absent = mint one (unchanged default behavior). */
    sessionId?: string
    /** Explicit workflow override; absent = issue → repository → global default. */
    workflowRevisionId?: string
  }): SessionSpawnResult {
    // Resolve the agent down to a concrete AgentKind. `agentKind` may be absent,
    // or carry a non-AgentKind sentinel like 'auto' (the issue start-flow casts
    // the issue's `defaultAgent` `as AgentKind` at the boundary). 'auto' is NOT a
    // valid AgentKind: persisting or broadcasting it fails the sessionsChanged
    // zod-parse and silently wipes the whole session list on every client.
    // safeParse anything that isn't a real kind back to the coding role's harness.
    const requested = AgentKind.safeParse(input.agentKind)
    const agentKind = requested.success
      ? requested.data
      : resolveRole(this.store.settings.getSettings(), 'coding').harness
    // Reject an explicit model/effort the live catalog doesn't list BEFORE any spawn
    // side effect [spec:SP-cc60]. The last line of defense for the agent-spawn path
    // (issue start/add-session pre-check earlier, before mutating start state).
    const { forced } = assertModelSelectionValid(this.store.settings.getModelCatalog(), {
      agentKind,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.forceUnknownModel ? { force: true } : {}),
    })
    // Spawner name is validated before any side effect so a bad title never
    // leaves a half-spawned session. Fresh sessions have no user name to refuse.
    let curatedName: string | undefined
    if (input.name !== undefined) {
      const norm = normalizeAgentName(input.name)
      if (!norm.ok) throw new Error(norm.reason)
      curatedName = norm.name
    }
    // Explicit attachment wins; otherwise starting in an issue-owned worktree
    // means continuing that issue (spec: issue-as-workspace).
    const issueId = input.issueId ?? this.issues().soleOwnerForCwd(input.cwd) ?? undefined
    const sessionId = input.sessionId ?? randomUUID()
    const preparedInstructions = this.deps.instructionsForStart({
      sessionId,
      cwd: input.cwd,
      agentKind,
      ...(issueId ? { issueId } : {}),
      ...(input.workflowRevisionId ? { workflowRevisionId: input.workflowRevisionId } : {}),
    })
    const taskPrompt = input.initialPrompt?.trim() ? input.initialPrompt.trim() : undefined
    const useArgv = taskPrompt !== undefined && agentSupportsInitialPrompt(agentKind)
    const spawned = this.spawn({
      agentKind,
      cwd: input.cwd,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(curatedName ? { name: curatedName, nameSource: 'agent' as const } : {}),
      origin: { kind: 'spawn' },
      machineId: this.machines.resolveMachine(input.machineId, input.cwd),
      ...(useArgv ? { initialPrompt: taskPrompt } : {}),
      ...(preparedInstructions.instructions.length
        ? { instructions: preparedInstructions.instructions }
        : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
      ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
      ...(input.workflowStepId ? { workflowStepId: input.workflowStepId } : {}),
      ...(input.executionProfileId ? { executionProfileId: input.executionProfileId } : {}),
      ...(issueId ? { issueId } : {}),
      sessionId,
    })
    preparedInstructions.commit()
    if (taskPrompt !== undefined && !useArgv) {
      this.setSessionDraft({ sessionId: spawned.sessionId, text: taskPrompt })
    }
    // Fire-and-forget notification (post-spawn, so subscribers observe the new
    // world). Its one consumer today is the opt-in telemetry usage counter
    // [spec:SP-f933], which is why the payload carries the harness kind and
    // nothing else — no cwd, no prompt, no issue id.
    this.bus.emit('session.created', { sessionId: spawned.sessionId, agentKind })
    // Forcing an unlisted model is a deliberate override — make it durable and
    // observable across every spawn path [spec:SP-cc60]. Only emitted when the force
    // actually bypassed an unknown model (a known model needs no force).
    if (forced) {
      this.store.events.appendEvent({
        ts: new Date().toISOString(),
        kind: 'agent.model_forced',
        subject: spawned.sessionId,
        payload: {
          sessionId: spawned.sessionId,
          harness: agentKind,
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(issueId ? { issueId } : {}),
          ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
        },
      })
    }
    return spawned
  }

  /** The capability a relayed agent session presents: worker, scoped to the issue whose
   *  worktree it runs in (subtree), else 'none' (may read + create, but writing an existing
   *  issue needs --outside-scope). Unknown session → most-restricted. */
  capabilityForSession(sessionId: string): Capability {
    const s = this.sessions.get(sessionId)
    if (!s) return { role: 'worker', scope: { kind: 'none' } }
    // Explicit attachment wins over cwd containment (issue-as-workspace): an
    // attached / draft-bound session is scoped to ITS issue even when its cwd
    // sits in another issue's worktree (or none).
    const issueId = s.issueId ?? this.issues().issueForCwd(s.cwd)
    return issueId
      ? { role: 'worker', scope: { kind: 'subtree', rootId: issueId }, actorSessionId: sessionId }
      : { role: 'worker', scope: { kind: 'none' }, actorSessionId: sessionId }
  }

  resumeSession(input: {
    agentKind: AgentKind
    cwd: string
    resume: ResumeRef
    conversationId: string
    title?: string
    machineId?: string
    /** Provenance for the FRESH-SPAWN fallback only (issue #60). When the resume
     *  lands on an existing row (reuse/resurrect below), that row's original
     *  spawnedBy is kept — a resume never rewrites who created the session. */
    spawnedBy?: string
  }): { sessionId: string } {
    // One row per conversation. A conversation is identified by its durable
    // resume ref (kind+value); resuming one that already has a row must REUSE
    // that row, never mint a parallel one. Each parallel row spawned its own
    // durable master and forked its own transcript, while the web only HID the
    // siblings (dedupeSessionsByResume) — so closing the visible row revealed a
    // masked duplicate with its own title/transcript/stage. Reuse kills that at
    // the source: a running row is focused as-is; a parked (hibernated/exited)
    // row is resurrected under its same id.
    const existing = this.findLiveByResume(input.resume)
    if (existing) {
      if (existing.status === 'hibernated' || existing.status === 'exited') {
        this.resurrectSession({ sessionId: existing.sessionId })
      } else {
        // Reopening a still-live but long-idle session also resets its hibernation
        // timer — the user is back on it even with no new message. (resurrectSession
        // already stamps this for the parked case above.)
        this.sessions.get(existing.sessionId)?.markResumed()
      }
      return { sessionId: existing.sessionId }
    }
    const issueId = this.issues().soleOwnerForCwd(input.cwd) ?? undefined
    const sessionId = randomUUID()
    const preparedInstructions = this.deps.instructionsForStart({
      sessionId,
      cwd: input.cwd,
      agentKind: input.agentKind,
      ...(issueId ? { issueId } : {}),
    })
    const spawned = this.spawn({
      agentKind: input.agentKind,
      cwd: input.cwd,
      title: input.title,
      origin: { kind: 'resume', conversationId: input.conversationId },
      resume: input.resume,
      machineId: this.machines.resolveMachine(input.machineId, input.cwd),
      ...(preparedInstructions.instructions.length
        ? { instructions: preparedInstructions.instructions }
        : {}),
      ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
      ...(issueId ? { issueId } : {}),
      sessionId,
    })
    preparedInstructions.commit()
    return spawned
  }

  /**
   * The existing session for a resume ref, if any — the canonical row for that
   * conversation. Prefers a still-running row (live/starting/reconnecting) over a
   * parked one, breaking ties toward the most-recently-active so we land on the
   * row the user last touched.
   */
  private findLiveByResume(resume: ResumeRef): Session | undefined {
    const running = (s: Session) =>
      s.status === 'live' || s.status === 'starting' || s.status === 'reconnecting'
    return (
      [...this.sessions.values()]
        // A HEADLESS session shares its harness's resume ref but is not a PTY
        // reuse target — "open in terminal" resumes the same ref as a real PTY
        // session alongside it, so headless rows never satisfy this lookup.
        .filter(
          (s) => !s.headless && s.resume?.kind === resume.kind && s.resume?.value === resume.value,
        )
        .sort((a, b) => {
          if (running(a) !== running(b)) return running(a) ? -1 : 1
          return (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? '')
        })
        .at(0)
    )
  }

  /**
   * The overview "Continue" button: nudge an errored agent to retry by typing
   * `continue⏎` into its PTY. Guarded to the errored phase so a stray click
   * can't inject text into a healthy prompt.
   */
  continueSession({ sessionId }: { sessionId: string }): { ok: boolean } {
    if (this.upstreamRejection(sessionId)) return { ok: false }
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false }
    // Status gate as well as phase: a session can read 'errored' while its
    // process is already gone (hibernated/exited), where typing 'continue' would
    // vanish into a dead PTY yet still report ok. Only a running session can retry.
    if (session.status !== 'live' && session.status !== 'starting') return { ok: false }
    if (session.agentState?.phase !== 'errored') return { ok: false }
    this.toMachine(session.machineId, {
      type: 'input',
      sessionId,
      data: Buffer.from('continue\r').toString('base64'),
    })
    return { ok: true }
  }

  /**
   * Chat-view send: type a message into the agent's input as if pasted. When the
   * session already has queued messages waiting, the new one goes BEHIND them
   * (FIFO) instead of jumping the queue — otherwise a live-chat send would land
   * before messages the user typed earlier while the agent was parked.
   */
  sendText({ sessionId, text }: { sessionId: string; text: string }): {
    ok: boolean
    queued?: boolean
    reason?: string
  } {
    const rejected = this.upstreamRejection(sessionId)
    if (rejected) return rejected
    const session = this.sessions.get(sessionId)
    if (session && (session.queuedMessageCount > 0 || this.activeDrains.has(sessionId))) {
      return this.queueText({ sessionId, text })
    }
    return this.typeText({ sessionId, text })
  }

  /**
   * Hard-interrupt delivery (#237) [spec:SP-34d7]: ESC cancels the target's
   * in-flight turn, then the message rides the durable queue so the drain's
   * settle heuristics land it as the immediate next turn (never mid-cancel).
   * Callers are already authority-gated (superagent/parent/operator only —
   * the clamp matrix downgrades everyone else before reaching here).
   */
  interruptText({ sessionId, text }: { sessionId: string; text: string }): {
    ok: boolean
    queued?: boolean
    reason?: string
  } {
    const rejected = this.upstreamRejection(sessionId)
    if (rejected) return rejected
    const session = this.sessions.get(sessionId)
    if (!session || (session.status !== 'live' && session.status !== 'starting')) {
      return { ok: false, reason: 'session not running' }
    }
    this.toMachine(session.machineId, {
      type: 'input',
      sessionId,
      data: Buffer.from('\x1b').toString('base64'),
    })
    // The ESC has cancelled any on-screen menu; type the text after a short beat
    // so it lands in a separate PTY read. afterEsc bypasses the needs_user guard
    // (this is the one legitimate write into a menu-waiting session) and jumps
    // the queue — an interrupt is meant to.
    setTimeout(() => this.typeText({ sessionId, text, afterEsc: true }), SUBMIT_CR_DELAY_MS)
    return { ok: true }
  }

  /** The raw typing primitive (bracketed paste + separated CR). Only sendText and
   *  the queue drain call this — everything else must go through them so queued
   *  messages keep their FIFO order. */
  private typeText({
    sessionId,
    text,
    afterEsc,
  }: {
    sessionId: string
    text: string
    /** Set ONLY by interruptText, which just sent an ESC that cancels an
     *  on-screen menu — its follow-up text is the one legitimate write into a
     *  needs_user session. */
    afterEsc?: boolean
  }): { ok: boolean } {
    const session = this.sessions.get(sessionId)
    if (!session || (session.status !== 'live' && session.status !== 'starting')) {
      return { ok: false }
    }
    // #473: NEVER paste+CR into a session waiting on an AskUserQuestion menu —
    // the submitting CR answers the highlighted default (making the user's
    // decision for them). This is the airtight backstop: the delivery-layer
    // guard (attemptDelivery/stateOf) reads a phase SNAPSHOT and races the
    // boundary path (onSessionIdle -> deliverBatch -> sendText) and the sweep;
    // the primitive is the only place that can't be raced. A human answering
    // their OWN menu presses keys via handleInput -> toDaemon (raw 'input'),
    // never through here, so this does not block them. interruptText's ESC
    // cancels the menu first, so its follow-up is allowed (afterEsc).
    if (!afterEsc && session.agentState?.phase === 'needs_user') {
      return { ok: false }
    }
    // A submitted message re-engages the session — drop any snooze so it returns
    // to the normal attention flow (covers chat send + resumeAndSend paths).
    if (session.snoozedUntil !== undefined) this.clearSnooze(sessionId)
    // A user turn consumes any pending agent action offer [spec:SP-c7f1] — a
    // button click sends its prompt through this same path, so it self-clears.
    if (session.offer !== undefined) this.clearOffer(sessionId)
    const send = (data: string) =>
      this.toMachine(session.machineId, {
        type: 'input',
        sessionId,
        data: Buffer.from(data).toString('base64'),
      })
    // Bracketed paste so the harness takes the message as one input block (newlines
    // in a multi-line message don't submit early), then a submitting CR.
    send(`\x1b[200~${text}\x1b[201~`)
    // The CR must land in a SEPARATE PTY read from the paste-end marker. Sending it
    // on the same tick — even as its own write — lets the new Claude renderer (2.1.x)
    // swallow it behind the bracketed paste: the message lands in the composer but
    // the turn never starts ("types in but doesn't submit", esp. on longer input).
    // A short delay separates the reads so the CR submits; it's imperceptible next to
    // agent latency. Verified against real claude in the e2e harness.
    setTimeout(() => send('\r'), SUBMIT_CR_DELAY_MS)
    return { ok: true }
  }

  /**
   * Chat-view answer to a live AskUserQuestion prompt. The chat card sends the
   * 1-based option index (per question) and we type the matching digit(s) into
   * the agent's PTY to drive its native multiple-choice selector — the native
   * terminal is unmounted in chat mode, so this is the only path to the prompt.
   *
   * Claude Code's AskUserQuestion menu commits a single-select choice the instant
   * the option's number key is pressed (no Enter), and accepts comma-separated
   * numbers + Enter for multi-select. We send raw digits here (NOT bracketed
   * paste like `sendText`, which would land them as message text rather than
   * menu keystrokes). See the chat card for the option→digit mapping.
   *
   * `choices` is one entry per question being answered, each carrying the
   * question's 1-based option indices (one for single-select, ≥1 for multi).
   * NEEDS IN-BROWSER VERIFICATION against a real Claude prompt — the exact
   * key sequence the TUI expects is documented-but-unconfirmed here.
   */
  answerAskUserQuestion({
    sessionId,
    choices,
  }: {
    sessionId: string
    choices: { optionIndices: number[] }[]
  }): { ok: boolean } {
    const session = this.sessions.get(sessionId)
    if (!session || (session.status !== 'live' && session.status !== 'starting')) {
      return { ok: false }
    }
    const send = (data: string) =>
      this.toMachine(session.machineId, {
        type: 'input',
        sessionId,
        data: Buffer.from(data).toString('base64'),
      })
    for (const choice of choices) {
      const digits = choice.optionIndices.filter((n) => Number.isInteger(n) && n >= 1 && n <= 9)
      if (digits.length === 0) continue
      if (digits.length === 1) {
        // Single-select: the number key alone commits the choice and advances to
        // the next question (no Enter). A multi-question payload chains naturally.
        send(String(digits[0]))
      } else {
        // Multi-select: comma-separated indices, then Enter to confirm the set.
        send(`${digits.join(',')}\r`)
      }
    }
    return { ok: true }
  }

  setSessionDraft(input: { sessionId: string; text: string }, fromClientId?: string): void {
    const previousDraft = this.draftBySession.get(input.sessionId)
    if (input.text) this.draftBySession.set(input.sessionId, input.text)
    else this.draftBySession.delete(input.sessionId)
    // Mirror the draft's last-edit time onto the session so the sidebar can show
    // DRAFT and lift it in the attention ordering. The DRAFT tag / lift only
    // appears or disappears when a draft starts or is cleared, so rebroadcast the
    // session list on that PRESENCE change only — never per keystroke.
    const session = this.sessions.get(input.sessionId)
    const presenceChanged = session && (session.draftUpdatedAt !== undefined) !== !!input.text
    if (session) session.draftUpdatedAt = input.text ? new Date().toISOString() : undefined
    // The DRAFT tag flip is wire-visible meta backed by an off-row table —
    // commit it at the same presence granularity the broadcast below uses
    // (never per keystroke) so delta clients see the lift too [#256].
    if (presenceChanged && session) {
      try {
        this.persist(session)
      } catch (err) {
        if (previousDraft === undefined) this.draftBySession.delete(input.sessionId)
        else this.draftBySession.set(input.sessionId, previousDraft)
        throw err
      }
    }
    // Keep the existing live cross-client sync: push to every OTHER client (the
    // directional guard skips the originator so its own keystrokes don't echo back).
    this.broadcastToClients(
      { type: 'sessionDraftChanged', sessionId: input.sessionId, text: input.text },
      { ...(fromClientId !== undefined ? { exceptClientId: fromClientId } : {}) },
    )
    this.persistDraft(input.sessionId, input.text)
    if (presenceChanged) this.broadcastSessions()
  }

  /**
   * Debounced draft persistence. Keystrokes coalesce per session into one SQLite
   * write after a short idle gap, so typing never hammers the synchronous DB.
   * An empty draft (the composer cleared on send) is flushed immediately and any
   * pending timer cancelled, so a stale draft can't outlive the message that was
   * sent — even if the server restarts in the debounce window.
   */
  private persistDraft(sessionId: string, text: string): void {
    const existing = this.draftWriteTimers.get(sessionId)
    if (existing) {
      clearTimeout(existing)
      this.draftWriteTimers.delete(sessionId)
    }
    if (!text) {
      this.writeDraft(sessionId, '')
      return
    }
    const timer = setTimeout(() => {
      this.draftWriteTimers.delete(sessionId)
      // Write the latest value rather than the captured one: a write that lands
      // after further edits (or a kill) should reflect the current in-memory state.
      this.writeDraft(sessionId, this.draftBySession.get(sessionId) ?? '')
    }, SessionsService.DRAFT_WRITE_DEBOUNCE_MS)
    timer.unref?.()
    this.draftWriteTimers.set(sessionId, timer)
  }

  private writeDraft(sessionId: string, text: string): void {
    try {
      this.store.sessions.setDraft(sessionId, text)
    } catch (e) {
      console.warn(`[podium] failed to persist draft for ${sessionId}:`, e)
    }
  }

  // ---- durable queued sends (docs/spec/outbox-write-path.md §2.2) ----
  // Replaces the old in-memory sendTextWhenReady, which silently dropped its
  // message on a 25s timeout, a failed wake, or a server restart. Messages now
  // live in the queued_messages table until the moment their bytes go toward the
  // daemon; a failed drain attempt keeps the rows and re-arms on the next
  // liveness signal (bind / attachDaemon / resurrect / enqueue).

  /** Sessions with a drain loop in flight — single-flight per session so two
   *  triggers can't interleave deliveries (spec invariant 2). */
  private readonly activeDrains = new Set<string>()

  /**
   * Queue a message for a session, waking it if parked. ALWAYS defers to the
   * drain loop — even for a live session — because the drain's settle heuristics
   * are what keep a message out of a still-booting TUI (the #5b fix); callers
   * that want the instant live-chat path (resumeAndSend, ChatView) use sendText
   * directly. `mutationId` doubles as the durable row id, so a replayed enqueue
   * is a no-op at the storage layer too.
   */
  queueText({
    sessionId,
    text,
    mutationId,
  }: {
    sessionId: string
    text: string
    mutationId?: string
  }): { ok: boolean; queued?: boolean; reason?: string } {
    const rejected = this.upstreamRejection(sessionId)
    if (rejected) return rejected
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false, reason: 'unknown session' }
    // A parked session we can never wake would hold the message forever with no
    // path to delivery — surface that instead of queueing into a void. (Shells
    // resurrect by fresh respawn, agents need a resume ref.)
    const parked = session.status === 'hibernated' || session.status === 'exited'
    if (parked && session.agentKind !== 'shell' && !session.resume) {
      return { ok: false, reason: 'no resume ref' }
    }
    const inserted = this.store.sync.enqueueMessage({
      id: mutationId ?? randomUUID(),
      sessionId,
      text,
      queuedAt: this.now(),
    })
    if (inserted) {
      session.queuedMessageCount += 1
      // queuedMessageCount is wire-visible meta derived from the queue table —
      // commit the new count so delta clients see the badge [#256].
      this.persist(session)
      // A queued message is fresh user intent on the session — clear any snooze,
      // mirroring sendText, so it returns to the normal attention flow.
      if (session.snoozedUntil !== undefined) this.clearSnooze(sessionId)
      // ...and consume any pending agent action offer [spec:SP-c7f1].
      if (session.offer !== undefined) this.clearOffer(sessionId)
      this.broadcastSessions()
    }
    if (parked) this.resurrectSession({ sessionId })
    this.drainQueuedMessages(sessionId)
    return { ok: true, queued: true }
  }

  /**
   * Deliver a session's queued messages FIFO once it is actually ready, reusing
   * the spawn-readiness heuristics (live + produced output + floor/quiet settle,
   * with a MAX fallback for silent spawns). One attempt per trigger: if the
   * session never comes live before the deadline the loop stops and the ROWS
   * REMAIN — the next liveness signal re-arms. Successive messages are spaced so
   * each lands as its own submitted input.
   */
  private drainQueuedMessages(sessionId: string): void {
    if (this.activeDrains.has(sessionId)) return
    const session = this.sessions.get(sessionId)
    if (!session || session.queuedMessageCount === 0) return
    this.activeDrains.add(sessionId)
    const deadline = this.now() + QUEUE_DRAIN_DEADLINE_MS
    let liveAtMs = 0
    let baseOutputMs = 0
    const stop = (): void => {
      this.activeDrains.delete(sessionId)
    }
    const deliverNext = (): void => {
      const s = this.sessions.get(sessionId)
      if (!s || (s.status !== 'live' && s.status !== 'starting')) {
        stop()
        return
      }
      const head = this.store.sync.listQueuedMessages(sessionId)[0]
      if (!head) {
        stop()
        return
      }
      this.store.sync.bumpQueuedAttempts(head.id)
      const sent = this.typeText({ sessionId, text: head.text })
      if (!sent.ok) {
        stop() // status raced to parked — rows remain
        return
      }
      // Delete only AFTER the bytes went toward the daemon (spec invariant 3).
      this.store.sync.deleteQueuedMessage(head.id)
      s.queuedMessageCount = Math.max(0, s.queuedMessageCount - 1)
      this.persist(s) // commit the drained count (see queueText) [#256]
      this.broadcastSessions()
      if (s.queuedMessageCount > 0) {
        const t = setTimeout(deliverNext, QUEUE_MESSAGE_SPACING_MS)
        t.unref?.()
      } else stop()
    }
    const tick = (): void => {
      const s = this.sessions.get(sessionId)
      // Parked/gone: stop WITHOUT touching rows — re-armed on the next wake.
      if (!s || s.status === 'exited' || s.status === 'hibernated') {
        stop()
        return
      }
      const now = this.now()
      if (s.status === 'live') {
        if (!liveAtMs) {
          liveAtMs = now
          baseOutputMs = s.lastOutputAtMs
        }
        const producedOutput = s.lastOutputAtMs > baseOutputMs
        const settled =
          producedOutput &&
          now - liveAtMs >= READY_FLOOR_MS &&
          now - s.lastOutputAtMs >= READY_QUIET_MS
        if (settled || now - liveAtMs >= READY_MAX_MS || now >= deadline) {
          deliverNext()
          return
        }
      } else if (now >= deadline) {
        stop() // never came live this attempt; rows remain for the next one
        return
      }
      const t = setTimeout(tick, READY_POLL_MS)
      t.unref?.()
    }
    const t = setTimeout(tick, READY_POLL_MS)
    t.unref?.()
  }

  /**
   * Idempotency wrapper (docs/spec/outbox-write-path.md §2.1): a mutation carrying
   * an already-seen mutationId returns its recorded result WITHOUT re-running —
   * what makes outbox replays and network retries safe. Check-run-record is one
   * synchronous pass (no await), so replays can't interleave with the original.
   */
  /** Async mutations in flight, so a replay arriving before the original resolves
   *  (e.g. both calls in one tRPC HTTP batch) joins the SAME promise instead of
   *  re-running — the async analogue of the sync check-run-record pass. */
  private readonly inFlightMutations = new Map<string, Promise<unknown>>()

  withMutation<T>(mutationId: string | undefined, proc: string, fn: () => T): T {
    if (!mutationId) return fn()
    const prior = this.store.sync.getAppliedMutation(mutationId)
    if (prior !== undefined) return JSON.parse(prior) as T
    const inFlight = this.inFlightMutations.get(mutationId)
    if (inFlight !== undefined) return inFlight as T
    const result = fn()
    // An async proc (issues.create → createAndMaybeStart) must record its RESOLVED
    // value: stringifying the pending Promise itself would durably record '{}' —
    // poisoning every replay — and would mark a rejected mutation as applied.
    if (result instanceof Promise) {
      const tracked = result.then(
        (value) => {
          this.store.sync.recordAppliedMutation(
            mutationId,
            proc,
            JSON.stringify(value ?? null),
            this.now(),
          )
          this.inFlightMutations.delete(mutationId)
          return value
        },
        (err) => {
          this.inFlightMutations.delete(mutationId)
          throw err
        },
      )
      this.inFlightMutations.set(mutationId, tracked)
      return tracked as T
    }
    this.store.sync.recordAppliedMutation(
      mutationId,
      proc,
      JSON.stringify(result ?? null),
      this.now(),
    )
    return result
  }

  /**
   * The write funnel's session-metadata face: apply the field write, persist the
   * row (repository write), then enter the coalesced broadcast — whose trailing
   * run is the funnel's oplog-append → fan-out tail. Every plain metadata
   * mutation (rename/archive/read/issue attachment/work state) goes through
   * here instead of hand-rolling persist+broadcast.
   */
  private mutateSessionMeta(sessionId: string, write: (session: Session) => void): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.funnel.run({
      write: () => {
        write(session)
        this.persist(session)
      },
    })
    this.broadcastSessions()
  }

  /**
   * A HUMAN names the session (web rename, superagent `rename_session`) — the
   * curated slot, stamped `nameSource = 'user'` (#490). That stamp is sovereign:
   * setAgentName refuses against it forever after, so an agent can never overwrite
   * a name the user picked.
   *
   * Clearing (name = '') also clears the source — the session is unnamed again, so
   * an agent may name it (and the prime will ask it to).
   */
  renameSession({ sessionId, name }: { sessionId: string; name: string }): void {
    this.mutateSessionMeta(sessionId, (session) => {
      const clean = name.trim()
      session.name = clean
      session.nameSource = clean ? 'user' : undefined
    })
  }

  /**
   * The AGENT names its own session (#490) — `podium session title "…"`, relayed as
   * sessions.title and bound to the calling session by the capability.
   *
   * Writes the same curated `name` slot the user writes, so it wins in the UI over
   * the derived `title` — but stamped 'agent', and REFUSED when the user already
   * named it. An agent may overwrite its OWN earlier agent-set name (retitling as
   * the work becomes clear) and may name a session whose name nobody set.
   *
   * Refusal is a returned reason, not a throw: the CLI prints it and the agent
   * carries on. Same persist + broadcast path as renameSession.
   */
  setAgentName({ sessionId, name }: { sessionId: string; name: string }): {
    ok: boolean
    name?: string
    reason?: string
  } {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false, reason: 'session not found' }
    const norm = normalizeAgentName(name)
    if (!norm.ok) return { ok: false, reason: norm.reason }
    // User-set names are sovereign [spec:SP-eb60]: refuse, never throw, never overwrite.
    if (session.nameSource === 'user') {
      return {
        ok: false,
        name: session.name,
        reason: `this session was named by the user ("${session.name}") — an agent cannot rename it`,
      }
    }
    this.mutateSessionMeta(sessionId, (s) => {
      s.name = norm.name
      s.nameSource = 'agent'
    })
    return { ok: true, name: norm.name }
  }

  setArchived({ sessionId, archived }: { sessionId: string; archived: boolean }): void {
    this.mutateSessionMeta(sessionId, (session) => {
      session.archived = archived
    })
    // Archiving can leave its draft issue with no living sessions — reap it.
    if (archived) this.maybeReapDraftIssue(this.sessions.get(sessionId)?.issueId)
  }

  /** Mark a session read (issue #124): stamp read_at = now, persist + broadcast. The
   *  derived `unread` in the session meta flips to false immediately (read_at is now the
   *  latest timestamp) and re-arms on the next activity. Read state is GLOBAL —
   *  single-operator, no per-user row. No-op for an unknown session. */
  markSessionRead(sessionId: string): void {
    this.mutateSessionMeta(sessionId, (session) => {
      // ISO like lastActiveAt/createdAt — the wire contract (readAt: string) and the
      // lexical unread compare both require it (this.now() is epoch ms).
      session.readAt = new Date(this.now()).toISOString()
    })
  }

  /** Mark this session UNREAD again (issue #138, the email-style inverse of
   *  markSessionRead): clear read_at so the derived `unread` (readAt null ⇒ unread)
   *  flips back to true, persist + broadcast. Read state stays GLOBAL —
   *  single-operator, no per-user row. No-op for an unknown session. */
  markSessionUnread(sessionId: string): void {
    this.mutateSessionMeta(sessionId, (session) => {
      session.readAt = null
    })
  }

  /** Set (or clear with null) a session's explicit issue attachment. */
  setSessionIssueId(sessionId: string, issueId: string | null): void {
    this.mutateSessionMeta(sessionId, (session) => {
      session.issueId = issueId ?? undefined
      // Naming point (#474): the first attach on a still-unnamed session brands
      // it with that issue's letter. A detach (null) is NOT a naming point —
      // the session stays unnamed rather than getting a spurious DRAFT ordinal.
      if (issueId) this.allocateSessionRef(session)
    })
  }

  /** The session's explicit issue attachment (issue-as-workspace), if any. */
  getSessionIssueId(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.issueId ?? null
  }

  setWorkState({ sessionId, workState }: { sessionId: string; workState: WorkState | null }): void {
    this.mutateSessionMeta(sessionId, (session) => {
      session.workState = workState ?? undefined
    })
  }

  /**
   * Park a live session: kill its process (and durable host) but keep the row,
   * its transcript, and the resume ref. One click brings it back. Returns false
   * when the session can't come back later (no resume ref) — we refuse rather
   * than silently turn "hibernate" into "kill".
   */
  hibernateSession({ sessionId }: { sessionId: string }): { ok: boolean; reason?: string } {
    const rejected = this.upstreamRejection(sessionId)
    if (rejected) return rejected
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false, reason: 'unknown session' }
    if (session.status !== 'live') return { ok: false, reason: 'not running' }
    if (!session.resume) {
      return { ok: false, reason: 'no resume ref yet — the agent has not reported one' }
    }
    // Never park an agent mid-work: hibernation kills the process, and a
    // working/compacting agent would lose its in-flight turn. Auto-hibernation
    // already filters to idle/ended; enforcing it here makes the primitive (and
    // the manual hibernate button) safe regardless of caller.
    const phase = session.agentState?.phase
    if (phase === 'working' || phase === 'compacting') {
      return { ok: false, reason: 'agent is working — let it reach idle first' }
    }
    session.status = 'hibernated'
    this.autoContinue.onSessionGone(sessionId)
    this.persist(session)
    this.toMachine(session.machineId, {
      type: 'kill',
      sessionId,
      ...(session ? { durableLabel: session.durableLabel } : {}),
    })
    this.broadcastSessions()
    return { ok: true }
  }

  /** Move one resumable worktree session to another machine ([spec:SP-3f7a]). */
  async handoffSession(input: {
    sessionId: string
    machineId: string
  }): Promise<{ ok: true; newCwd: string }> {
    const session = this.sessions.get(input.sessionId)
    if (!session) throw new Error('unknown session')
    if (session.agentKind !== 'claude-code' && session.agentKind !== 'codex') {
      throw new Error('session harness does not support handoff')
    }
    if (!session.resume) throw new Error('session has no resume reference')
    if (session.machineId === input.machineId) throw new Error('session is already on that machine')

    const repos = this.store.repos.listRepos()
    const sourceRepo = repos
      .filter(
        (repo) =>
          repo.machineId === session.machineId &&
          (session.cwd === repo.path || session.cwd.startsWith(`${repo.path}/`)),
      )
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (!sourceRepo?.repoId) throw new Error('source repository is not registered')
    // [spec:SP-3f7a] `session.cwd` drifts — the daemon follows the shell, so an
    // agent that ran a command against the main checkout is stamped at the repo
    // root. Its issue's worktree is still its home, so offer that as a fallback
    // source instead of refusing. Restricted to this repo, so the package's repo
    // identity always matches the tree it carries. Which candidate wins is the
    // exporter's call (it asks git); refuse up front only when neither exists.
    const issue = session.issueId ? this.issues().getMeta(session.issueId) : undefined
    const issueWorktree = issue?.worktreePath?.startsWith(`${sourceRepo.path}/`)
      ? issue.worktreePath
      : undefined
    if (session.cwd === sourceRepo.path && !issueWorktree)
      throw new Error('only worktree sessions can be handed off')
    const targetRepo = repos.find(
      (repo) => repo.machineId === input.machineId && repo.repoId === sourceRepo.repoId,
    )
    if (!targetRepo) throw new Error('target machine does not have this repository')

    const targetMachine = this.machines
      .listMachines()
      .find((machine) => machine.id === input.machineId)
    if (!targetMachine?.online) throw new Error('target machine is offline')
    const harness = targetMachine.inventory?.agents.find(
      (agent) => agent.kind === session.agentKind,
    )
    if (!harness?.installed || harness.login.state === 'out') {
      throw new Error(`target machine cannot run logged-in ${session.agentKind}`)
    }

    this.mutateSessionView(session.sessionId, (current) => {
      current.handoffTarget = targetMachine.name
    })
    this.broadcastSessions()

    const branch = issue?.branch ?? basename(session.cwd)
    const candidates = [
      ...new Set(
        [issue?.parentBranch, 'main', 'origin/main', branch].filter((ref): ref is string =>
          Boolean(ref),
        ),
      ),
    ]
    const verified = await Promise.all(
      candidates.map((ref) =>
        this.rpc.repoOp('revParseVerify', targetRepo.path, { ref }, input.machineId),
      ),
    )
    const baseShas = verifiedBundleBases(verified)
    if (baseShas.length === 0) {
      this.mutateSessionView(session.sessionId, (current) => {
        current.handoffTarget = undefined
      })
      this.broadcastSessions()
      throw new Error('target repository has no verified common bundle base')
    }

    const source = { machineId: session.machineId, cwd: session.cwd, status: session.status }
    const wasRunning =
      session.status === 'live' ||
      session.status === 'starting' ||
      session.status === 'reconnecting'
    if (wasRunning) {
      session.status = 'hibernated'
      this.autoContinue.onSessionGone(session.sessionId)
      this.persist(session)
      this.toMachine(source.machineId, { type: 'kill', sessionId: session.sessionId })
      this.broadcastSessions()
      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    try {
      const exported = await this.rpc.handoffExport(
        {
          sessionId: session.sessionId,
          cwd: source.cwd,
          ...(issueWorktree ? { fallbackCwd: issueWorktree } : {}),
          agentKind: session.agentKind,
          resume: session.resume,
          branch,
          baseShas,
          repoId: sourceRepo.repoId,
          ...(session.name || session.title ? { title: session.name || session.title } : {}),
          ...(session.issueId ? { issueId: session.issueId } : {}),
          sourceMachineId: source.machineId,
        },
        source.machineId,
      )
      if (
        !exported.ok ||
        !exported.stagePath ||
        exported.sizeBytes === undefined ||
        !exported.manifest
      ) {
        throw new Error(exported.error ?? 'source failed to export session')
      }
      await transferHandoffPackage({
        rpc: this.rpc,
        sessionId: session.sessionId,
        sourceMachineId: source.machineId,
        targetMachineId: input.machineId,
        sourceStagePath: exported.stagePath,
        sizeBytes: exported.sizeBytes,
      })
      const imported = await this.rpc.handoffImport(
        session.sessionId,
        targetRepo.path,
        exported.manifest.worktreeName,
        input.machineId,
      )
      if (!imported.ok || !imported.newCwd)
        throw new Error(imported.error ?? 'target failed to import session')

      session.handoffTarget = undefined
      session.machineId = input.machineId
      session.cwd = imported.newCwd
      session.status = 'hibernated'
      this.persist(session)
      // The import just ran `git worktree add` on the target, so `imported.newCwd`
      // names a worktree no client has ever scanned. Clients only re-fetch repos on
      // boot / a machine coming online / this invalidation, and the handoff gate
      // resolves a session's cwd against that list — so without this the moved
      // session has no known worktree and its own Handoff menu disappears until a
      // reload (POD-821). Both sides: the target gained a worktree, and the source
      // keeps its residue but is no longer where this session lives.
      this.deps.onWorktreesChanged(targetRepo.path, input.machineId)
      this.deps.onWorktreesChanged(sourceRepo.path, source.machineId)
      // [spec:SP-3f7a] The issue's home follows its session (POD-824): the target
      // worktree is where this work lives now, and the issue's home is what the
      // user sees — the file-browser root, the sidebar's worktree, and the cwd a
      // new agent on this issue spawns into. Keyed on the worktree ROOT the daemon
      // reports, never `newCwd` (which may be a `cwdSubpath` below it). An older
      // daemon sends no root; leave the issue alone rather than guess its layout.
      if (session.issueId && imported.worktreeRoot) {
        this.issues().rehome(session.issueId, {
          machineId: input.machineId,
          repoPath: targetRepo.path,
          worktreePath: imported.worktreeRoot,
        })
      }
      const resumed = this.resumeSession({
        agentKind: session.agentKind,
        cwd: session.cwd,
        resume: session.resume,
        conversationId:
          session.origin.kind === 'resume' ? session.origin.conversationId : session.resume.value,
        ...(session.name || session.title ? { title: session.name || session.title } : {}),
        machineId: input.machineId,
      })
      if (resumed.sessionId !== session.sessionId || (session.status as string) !== 'starting')
        throw new Error('target session failed to resume')
      return { ok: true, newCwd: imported.newCwd }
    } catch (error) {
      session.handoffTarget = undefined
      session.machineId = source.machineId
      session.cwd = source.cwd
      session.status = 'hibernated'
      this.persist(session)
      const rollback = this.resurrectSession({ sessionId: session.sessionId })
      if (!rollback.ok)
        console.warn(
          `[podium] handoff rollback failed for ${session.sessionId}: ${rollback.reason}`,
        )
      throw error
    }
  }

  /**
   * Lazy cross-machine workspace fetch [spec:SP-6d57]: materialize ANOTHER session's
   * current working state (unpushed commits + dirty + untracked files) on the
   * CALLER's machine as a detached read-only peek worktree. COPY semantics —
   * unlike handoff, the source session is never killed, re-homed, or touched;
   * nothing is published or persisted ahead of time (export → transfer → import
   * all happen inside this one request, refs deleted before it returns).
   */
  async fetchWorkspace(input: { sourceSessionId: string; callerSessionId: string }): Promise<{
    path: string
    sameMachine: boolean
    sourceMachine: string
    branch: string
    headSha: string
    dirty: boolean
  }> {
    const source = this.sessions.get(input.sourceSessionId)
    if (!source) throw new Error('unknown source session')
    const caller = this.sessions.get(input.callerSessionId)
    if (!caller) throw new Error('unknown calling session')
    const sourceMachine = this.machines.listMachines().find((m) => m.id === source.machineId)
    if (source.machineId === caller.machineId) {
      return {
        path: source.cwd,
        sameMachine: true,
        sourceMachine: sourceMachine?.name ?? source.machineId,
        branch: '',
        headSha: '',
        dirty: false,
      }
    }
    if (!sourceMachine?.online) throw new Error('source machine is offline')

    const repos = this.store.repos.listRepos()
    const sourceRepo = repos
      .filter(
        (repo) =>
          repo.machineId === source.machineId &&
          (source.cwd === repo.path || source.cwd.startsWith(`${repo.path}/`)),
      )
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (!sourceRepo?.repoId) throw new Error('source repository is not registered')
    const fetcherRepo = repos.find(
      (repo) => repo.machineId === caller.machineId && repo.repoId === sourceRepo.repoId,
    )
    if (!fetcherRepo) throw new Error('this machine does not have the source repository')

    const issue = source.issueId ? this.issues().getMeta(source.issueId) : undefined
    const branch = issue?.branch ?? basename(source.cwd)
    const candidates = [
      ...new Set(
        [issue?.parentBranch, 'main', 'origin/main', branch].filter((ref): ref is string =>
          Boolean(ref),
        ),
      ),
    ]
    const verified = await Promise.all(
      candidates.map((ref) =>
        this.rpc.repoOp('revParseVerify', fetcherRepo.path, { ref }, caller.machineId),
      ),
    )
    const baseShas = verifiedBundleBases(verified)
    if (baseShas.length === 0)
      throw new Error('no verified common bundle base with the source repository')

    const fetchId = `ws-${randomUUID().slice(0, 13)}`
    const exported = await this.rpc.workspaceExport(
      {
        fetchId,
        cwd: source.cwd,
        baseShas,
        repoId: sourceRepo.repoId,
        sourceMachineId: source.machineId,
      },
      source.machineId,
    )
    if (
      !exported.ok ||
      !exported.stagePath ||
      exported.sizeBytes === undefined ||
      !exported.manifest
    )
      throw new Error(exported.error ?? 'source failed to export its workspace')
    await transferHandoffPackage({
      rpc: this.rpc,
      sessionId: fetchId,
      sourceMachineId: source.machineId,
      targetMachineId: caller.machineId,
      sourceStagePath: exported.stagePath,
      sizeBytes: exported.sizeBytes,
    })
    const imported = await this.rpc.workspaceImport(fetchId, fetcherRepo.path, caller.machineId)
    if (!imported.ok || !imported.path)
      throw new Error(imported.error ?? 'failed to materialize the fetched workspace')
    return {
      path: imported.path,
      sameMachine: false,
      sourceMachine: sourceMachine.name,
      branch: exported.manifest.branch,
      headSha: exported.manifest.headSha,
      dirty: exported.manifest.snapshotSha !== null,
    }
  }

  /** Remove every peek worktree fetch materialized in the caller's repo [POD-658]. */
  async cleanWorkspacePeeks(input: { callerSessionId: string }): Promise<{ removed: string[] }> {
    const caller = this.sessions.get(input.callerSessionId)
    if (!caller) throw new Error('unknown calling session')
    const repo = this.store.repos
      .listRepos()
      .filter(
        (r) =>
          r.machineId === caller.machineId &&
          (caller.cwd === r.path || caller.cwd.startsWith(`${r.path}/`)),
      )
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (!repo) throw new Error('calling session is not inside a registered repository')
    const result = await this.rpc.workspaceClean(repo.path, caller.machineId)
    if (!result.ok) throw new Error(result.error ?? 'workspace clean failed')
    return { removed: result.removed ?? [] }
  }

  /**
   * Chat-compose path for a parked session: if it's live, just send; if it's
   * hibernated/exited (process gone, conversation intact), wake it first and
   * deliver the text once the resumed CLI is ready to receive it. Lets the chat
   * composer accept a message on a sleeping agent instead of refusing input —
   * the message itself becomes the reason to wake.
   */
  resumeAndSend({
    sessionId,
    text,
    mutationId,
  }: {
    sessionId: string
    text: string
    mutationId?: string
  }): {
    ok: boolean
    reason?: string
  } {
    const rejected = this.upstreamRejection(sessionId)
    if (rejected) return rejected
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false, reason: 'unknown session' }
    if (session.status === 'live' && session.queuedMessageCount === 0) {
      return this.sendText({ sessionId, text })
    }
    // Everything else — parked (wakes), starting (waits for settle), reconnecting
    // (waits for the daemon), or live-behind-a-queue (FIFO) — goes through the
    // durable queue instead of the old drop-after-25s in-memory timer.
    return this.queueText({ sessionId, text, mutationId })
  }

  /** Wake a hibernated session: respawn under the same id with its resume ref. */
  resurrectSession({ sessionId }: { sessionId: string }): { ok: boolean; reason?: string } {
    const rejected = this.upstreamRejection(sessionId)
    if (rejected) return rejected
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false, reason: 'unknown session' }
    // Hibernated (parked on purpose) and exited (process died or was killed
    // externally) are the same situation here: no process, but the row and the
    // resume ref are intact — both come back with one spawn.
    if (session.status !== 'hibernated' && session.status !== 'exited') {
      return { ok: false, reason: 'process still running' }
    }
    // A shell has no conversation to lose — a fresh spawn in the same cwd IS
    // full recovery, so it never needs a resume ref. Agents do: respawning one
    // without its ref would silently discard the conversation.
    if (session.agentKind !== 'shell' && !session.resume) {
      return { ok: false, reason: 'no resume ref' }
    }
    const preparedInstructions = this.deps.instructionsForStart({
      sessionId,
      cwd: session.cwd,
      agentKind: session.agentKind,
      ...(session.issueId ? { issueId: session.issueId } : {}),
      existingOnly: true,
    })
    session.status = 'starting'
    session.exitCode = undefined
    // Waking a session resets its hibernation idle timer — otherwise a stale
    // lastActiveAt makes it immediately eligible to be parked again.
    session.markResumed()
    this.persist(session)
    this.toMachine(session.machineId, {
      type: 'spawn',
      sessionId,
      durableLabel: session.durableLabel,
      agentKind: session.agentKind,
      cwd: session.cwd,
      ...(session.resume ? { resume: session.resume } : {}),
      ...(preparedInstructions.instructions.length
        ? { instructions: preparedInstructions.instructions }
        : {}),
      geometry: session.geometry,
      ...this.modelDefaults(session.agentKind),
      ...this.accountEnv(session.agentKind, session.accountId),
    })
    preparedInstructions.commit()
    this.broadcastSessions()
    return { ok: true }
  }

  /** issue-as-workspace draft cleanup: after a session dies (kill/remove/exit/
   *  archive), reap its draft issue if the draft is now empty — draft, no
   *  worktree, no children, and every attached session dead (exited/archived) or
   *  gone. Hibernation does NOT land here via a dead status ('hibernated' blocks
   *  the reap inside reapIfEmptyDraft), so a parked draft survives. */
  private maybeReapDraftIssue(issueId: string | null | undefined): void {
    if (!issueId) return
    try {
      this.issues().reapIfEmptyDraft(issueId)
    } catch (err) {
      console.warn(`[podium:issues] draft-issue reap failed for ${issueId}:`, err)
    }
  }

  /** Durable union transition for removing a local session. A retained upstream
   *  collision is revealed in the same ordered append as the local remove. */
  private sessionRemovalSpecs(sessionId: string): EntityChangeSpec[] {
    const specs: EntityChangeSpec[] = [{ entity: 'session', id: sessionId, op: 'remove' }]
    const revealedUpstream = this.upstreamSessions.get(sessionId)
    if (revealedUpstream) {
      specs.push({
        entity: 'session',
        id: sessionId,
        op: 'upsert',
        value: this.upstreamWire(revealedUpstream),
      })
    }
    return specs
  }

  /** Prepare deletion of every LOCAL session belonging to an issue. The caller
   *  commits `write` + `changes` together with the issue tombstone, then invokes
   *  `apply` only after that durable transaction succeeds. */
  prepareIssueSessionDelete(issueId: string, worktreePath: string | null): SessionDeletePlan {
    const localMetas = [...this.sessions.values()].map((s) => s.toMeta())
    const sessionIds = sessionsForIssue(worktreePath, localMetas, issueId).map((s) => s.sessionId)
    const deletedAt = new Date(this.now()).toISOString()
    return {
      sessionIds,
      write: () => {
        this.store.sessions.softDeleteForIssue(sessionIds, issueId, deletedAt)
        for (const sessionId of sessionIds)
          this.store.sync.deleteQueuedMessagesForSession(sessionId)
      },
      changes: () => sessionIds.flatMap((sessionId) => this.sessionRemovalSpecs(sessionId)),
      apply: (changes, ledgerCursor) => {
        for (const sessionId of sessionIds) this.removeSessionRuntime(sessionId)
        this.publishSessionProjection(changes, ledgerCursor)
      },
    }
  }

  /** Prepare restoration of the sessions tombstoned by one issue deletion. The
   *  durable rows and ledger upserts commit with the issue restore; runtime
   *  installation follows only after that transaction succeeds. */
  prepareIssueSessionRestore(issueId: string): SessionRestorePlan {
    const rows = this.store.sessions.loadDeletedSessionsForIssue(issueId)
    const restored = rows
      .map((row) => ({ row, session: this.sessionFromStoredRow(row, 'restore') }))
      .filter((entry): entry is { row: SessionRow; session: Session } => entry.session !== null)
    return {
      sessionIds: restored.map(({ session }) => session.sessionId),
      restoredSessions: restored.map(({ session }) => this.sessionWire(session)),
      write: () => this.store.sessions.restoreDeletedForIssue(issueId),
      changes: () =>
        restored.map(({ session }) => ({
          entity: 'session' as const,
          id: session.sessionId,
          op: 'upsert' as const,
          value: this.sessionWire(session),
        })),
      apply: (changes, ledgerCursor) => {
        const drafts = this.store.sessions.loadDrafts()
        const draftTimes = this.store.sessions.loadDraftTimes()
        const snoozes = this.store.sessions.listSnoozes()
        const offers = this.store.sessions.listOffers() // [spec:SP-c7f1]
        for (const { session } of restored) {
          this.installStoredSession(session, snoozes, draftTimes, drafts, offers)
        }
        this.publishSessionProjection(changes, ledgerCursor)
      },
    }
  }

  /** Runtime half of a durable session removal. Kept separate so issue deletion
   *  can batch many rows in one transaction and one sessions broadcast. */
  private removeSessionRuntime(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    this.toMachine(session?.machineId ?? LOCAL_PLACEHOLDER, {
      type: 'kill',
      sessionId,
      ...(session ? { durableLabel: session.durableLabel } : {}),
    })
    this.autoContinue.onSessionGone(sessionId)
    session?.detachAll()
    this.sessions.delete(sessionId)
    this.draftBySession.delete(sessionId)
    this.lastPriority.delete(sessionId)
    this.titleDebouncers.get(sessionId)?.dispose()
    this.titleDebouncers.delete(sessionId)
    const draftTimer = this.draftWriteTimers.get(sessionId)
    if (draftTimer) {
      clearTimeout(draftTimer)
      this.draftWriteTimers.delete(sessionId)
    }
    for (const c of this.clients.values()) c.attached.delete(sessionId)
    this.pendingVolatileSessions.delete(sessionId)
    this.capturedSessionStates.delete(sessionId)
    if (this.pendingVolatileSessions.size === 0) this.clearVolatileSessionCaptureTimer()
  }

  killSession(input: { sessionId: string }): void {
    // Read-only surface (node-hub-sync §2.3): killing a hub-mirrored session here
    // would fabricate a kill for a PTY this server doesn't own — reject loudly.
    if (this.isUpstreamSession(input.sessionId)) {
      throw new Error(UPSTREAM_COMMAND_REJECTION)
    }
    const session = this.sessions.get(input.sessionId)
    // Capture before the row is tombstoned — the reap after cleanup needs it.
    const issueId = session?.issueId
    const deletedAt = new Date(this.now()).toISOString()
    // The remove change commits in the SAME transaction as the tombstone (and
    // the queued-send cleanup — a killed session can never deliver, so its rows
    // would only orphan until the next boot's sweep) [spec:SP-3fe2] #256: the
    // durable change log can never say something the sessions table doesn't.
    // Durable tombstone FIRST, live teardown after (#247): a commit throw leaves
    // the session fully alive — still in the map, clients attached, PTY not
    // signalled — and propagates to the caller, instead of tearing down live
    // state for a row the rolled-back transaction still holds.
    const { changes } = this.deps.ledger.commit({
      write: () => {
        this.store.sessions.softDeleteSessions([input.sessionId], deletedAt, 'standalone')
        this.store.sync.deleteQueuedMessagesForSession(input.sessionId)
      },
      changes: () => this.sessionRemovalSpecs(input.sessionId),
    })
    this.removeSessionRuntime(input.sessionId)
    this.publishSessionProjection(changes)
    this.broadcastSessions()
    // The killed session may have been the last living occupant of an empty
    // draft issue — reap the vessel so "x" doesn't leak orphaned Drafts.
    this.maybeReapDraftIssue(issueId)
    // Session-death notification [spec:SP-85d1] (lock auto-release et al.): a
    // kill deletes the row from the map BEFORE the daemon's agentExit arrives,
    // so the agentExit-path emit would be skipped — fire it here. killSession
    // is never the hibernate path (hibernateSession only flips status).
    // Capture spawnedBy before the row is gone so the steward can still resolve
    // a session-spawner parent wake (POD-904 / exit-without-report).
    this.emitSessionExited(input.sessionId, session?.exitCode ?? -1, session?.spawnedBy)
  }

  /**
   * Real process death: bus fan-out (locks, messaging) AND a durable
   * `session.exited` row for the steward's session-parent wake (POD-904).
   * Hibernate does not land here. Best-effort log write — a store throw must
   * not undo the exit side-effects already applied.
   */
  private emitSessionExited(
    sessionId: string,
    code: number,
    spawnedBy?: string | null,
  ): void {
    this.bus.emit('session.exited', { sessionId, code })
    try {
      this.store.events.appendEvent({
        ts: new Date(this.now()).toISOString(),
        kind: 'session.exited',
        subject: sessionId,
        payload: {
          code,
          ...(spawnedBy ? { spawnedBy } : {}),
        },
      })
    } catch {
      // Durable log is best-effort; bus subscribers already ran.
    }
  }

  private spawn(input: {
    agentKind: AgentKind
    cwd: string
    title?: string
    /** Curated name at birth (spawner-prescribed or other); pairs with nameSource. */
    name?: string
    nameSource?: 'user' | 'agent'
    origin: SessionMeta['origin']
    resume?: ResumeRef
    machineId?: string
    initialPrompt?: string
    instructions?: AgentInstruction[]
    /** Per-ticket model/effort override; absent = use the settings defaults. */
    model?: string
    effort?: string
    accountId?: string
    spawnedBy?: string
    workflowRunId?: string
    workflowStepId?: string
    executionProfileId?: string
    issueId?: string
    /** Client-supplied id (optimistic UI); absent = mint one (unchanged default). */
    sessionId?: string
  }): SessionSpawnResult {
    // A server-minted uuid was unique by construction; a client-supplied id is
    // not. Reject a collision rather than let `sessions.set` overwrite the live
    // Session (orphaning its PTY/daemon binding) or re-fire a spawn. `withMutation`
    // already dedupes a genuine retry before we get here, so a hit is a real clash.
    if (input.sessionId && this.sessions.has(input.sessionId)) {
      throw new Error(`refusing to reuse an existing session id: ${input.sessionId}`)
    }
    const sessionId = input.sessionId ?? randomUUID()
    const machineId = input.machineId ?? LOCAL_PLACEHOLDER
    const launch = this.modelDefaults(
      input.agentKind,
      input.model !== undefined || input.effort !== undefined
        ? { model: input.model, effort: input.effort }
        : undefined,
    )
    const accountId =
      input.agentKind === 'shell'
        ? undefined
        : (input.accountId ?? resolveRole(this.store.settings.getSettings(), 'coding').accountId)
    const session = new Session({
      sessionId,
      agentKind: input.agentKind,
      cwd: input.cwd,
      title: input.title || basename(input.cwd) || input.cwd,
      ...(launch.model ? { model: launch.model } : {}),
      ...(launch.effort ? { effort: launch.effort } : {}),
      ...(accountId ? { accountId } : {}),
      origin: input.origin,
      createdAt: new Date().toISOString(),
      geometry: { ...DEFAULT_GEOMETRY },
      machineId,
      // Bind the route to the live machineId (tracks the local-adoption reassignment).
      toDaemon: (msg) => this.toMachine(this.sessions.get(sessionId)?.machineId ?? machineId, msg),
      onActivity: () => {
        // Shell busy transitions advance lastActiveAt (their only activity signal);
        // persist so that recency is durable across a restart, then rebroadcast.
        this.persist(session)
        this.broadcastSessions()
      },
      ...(input.resume ? { resume: input.resume } : {}),
      ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
      ...(input.workflowStepId ? { workflowStepId: input.workflowStepId } : {}),
      ...(input.executionProfileId ? { executionProfileId: input.executionProfileId } : {}),
      ...(input.issueId ? { issueId: input.issueId } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.nameSource ? { nameSource: input.nameSource } : {}),
    })
    this.sessions.set(sessionId, session)
    // Naming point (#474): input.issueId is the resolved birth issue (or absent
    // for a genuinely issueless spawn) — allocate the permanent ref now.
    this.allocateSessionRef(session)
    this.persist(session)
    this.toMachine(machineId, {
      type: 'spawn',
      sessionId,
      durableLabel: session.durableLabel,
      agentKind: input.agentKind,
      cwd: input.cwd,
      ...(input.resume ? { resume: input.resume } : {}),
      ...(input.initialPrompt ? { initialPrompt: input.initialPrompt } : {}),
      ...(input.instructions?.length ? { instructions: input.instructions } : {}),
      geometry: { ...DEFAULT_GEOMETRY },
      ...launch,
      ...this.accountEnv(input.agentKind, accountId),
    })
    this.broadcastSessions()
    return {
      sessionId,
      agentId: sessionId,
      harness: input.agentKind,
      model: launch.model ?? null,
      effort: launch.effort ?? null,
      machine: this.machines.machineName(machineId),
      machineId,
      accountId: accountId ?? null,
    }
  }

  /**
   * Model + effort flags for a spawn message; 'auto' means no override.
   * Shared by every spawn path (fresh spawn AND resurrect) so a resumed session
   * keeps the configured model when it uses the configured coding harness.
   * `override` (from an issue's per-ticket model/effort) wins independently over
   * settings defaults — 'auto' inherits them for the configured coding harness
   * and means "no flag" for any other harness. Missing values follow the same
   * rule; selecting a different harness must not inherit that harness's model or effort
   * [spec:SP-7ff1].
   */
  private modelDefaults(
    agentKind: AgentKind,
    override?: { model?: string; effort?: string },
  ): { model?: string; subagentModel?: string; effort?: string; seedCliTheme?: boolean } {
    const settings = this.store.settings.getSettings()
    const coding = settings.roles.coding
    const useCodingDefaults = agentKind === resolveRole(settings, 'coding').harness
    const explicitModel = override?.model
    const explicitEffort = override?.effort
    const model =
      explicitModel !== undefined && explicitModel !== 'auto'
        ? explicitModel
        : useCodingDefaults
          ? coding.model
          : 'auto'
    const effort =
      explicitEffort !== undefined && explicitEffort !== 'auto'
        ? explicitEffort
        : useCodingDefaults
          ? coding.effort
          : 'auto'
    const subagentModel = coding.subagentModel
    return {
      ...(model !== 'auto' && agentKind !== 'shell' ? { model } : {}),
      ...(subagentModel !== 'auto' && AGENT_CAPABILITIES[agentKind].subagentModelEnv
        ? { subagentModel }
        : {}),
      // Cursor + shell have no effort flag; agentLaunchCommand also drops it, but
      // gating here keeps the spawn message clean (capability lookup, #158).
      ...(effort !== 'auto' && agentSupportsEffort(agentKind) ? { effort } : {}),
      // Per-session CLI theme seeding rides every (re)spawn so a resurrected
      // session keeps the configured behaviour too [spec:SP-a04d].
      ...(agentKind !== 'shell' ? { seedCliTheme: coding.seedCliTheme } : {}),
    }
  }

  /** The managed credential (if any) for the coding role, as spawn env (#216).
   *  Native accounts yield {} — the CLI uses its own login and the frame is
   *  unchanged. Read live at spawn, like modelDefaults.
   *
   *  NEVER injected into a 'shell' pane: a shell is an interactive prompt the user
   *  drives, so the credential would be one `env` away from being streamed to the
   *  browser and written into persisted scrollback. Only an agent harness — which
   *  is what the coding role's credential is FOR — gets it. (modelDefaults()
   *  special-cases shell for the same reason of shape: a shell is not an agent.) */
  private accountEnv(
    agentKind: AgentKind,
    accountId = resolveRole(this.store.settings.getSettings(), 'coding').accountId,
  ): { env?: Record<string, string> } {
    if (agentKind === 'shell') return {}
    return resolveAccountEnv(this.store.accounts, accountId)
  }

  // ---- ws data plane: clients ----
  attachClient(send: Send<ServerMessage>): string {
    const id = `c${this.nextClientNum++}`
    this.clients.set(id, {
      id,
      send,
      viewports: new Map(),
      attached: new Set(),
      // No caps until hello — the bootstrap snapshots below are sent to everyone
      // (a delta client uses them as its initial paint, then takes a cursor via
      // sync.changesSince and rides the metadataDelta stream).
      caps: new Set(),
      transcriptSubs: new Set(),
      // Fail-safe toward notifying: a client counts as NOT watching until it
      // tells us otherwise (every browser client sends `presence` right after
      // connecting). Defaulting to visible:true let one stale/non-browser client
      // silently suppress all mobile push forever.
      visible: false,
      // View-state defaults to "renders nothing, focuses nothing" until the client
      // sends its first `viewState`. A session reads as unwatched (tier 3) until then.
      viewVisible: new Set(),
      focused: null,
      // Rendered-mode map (native/chat) per session. Stored from viewState but NOT
      // consulted by scheduling — see ClientConn.viewModes.
      viewModes: {},
    })
    send({ type: 'welcome', clientId: id })
    send({ type: 'sessionsChanged', sessions: this.listSessions() })
    send({ type: 'issuesChanged', issues: this.deps.issuesWire() })
    send({ type: 'automationsChanged', automations: this.deps.automationsWire() })
    send({ type: 'automationRunsChanged', automationRuns: this.deps.automationRunsWire() })
    for (const [sessionId, text] of this.draftBySession) {
      send({ type: 'sessionDraftChanged', sessionId, text })
    }
    send({
      type: 'conversationsChanged',
      conversations: this.conversations().allConversations(),
      diagnostics: this.conversations().diagnostics(),
    })
    send({ type: 'machinesChanged', machines: this.machines.listMachines() })
    send({ type: 'approvalsChanged', pending: this.deps.approvalsPending() })
    this.hosts.snapshotFor(send)
    // A request captured while no browser was connected remains an explicit
    // needs-attention affordance for the next client. [spec:SP-a43e]
    for (const request of this.pendingOpenUrls.values()) send(request)
    return id
  }

  detachClient(id: string): void {
    const client = this.clients.get(id)
    if (!client) return
    for (const sessionId of client.attached) {
      this.mutateSessionView(sessionId, (session) => session.detachClient(id))
    }
    // Transcript subscriptions are independent of PTY attachment — sweep just the ones
    // THIS client made (audit P2-18), not every session on the host (the old full scan
    // was O(sessions) on every disconnect, and O(clients×sessions) in a reconnect storm).
    for (const sessionId of client.transcriptSubs)
      this.sessions.get(sessionId)?.unsubscribeTranscript(id)
    this.clients.delete(id)
    // A gone client no longer attaches/views/focuses anything — recompute so the
    // sessions it was watching can drop priority (and the daemon stops relaying
    // them live).
    this.pushPriorities()
    this.broadcastSessions()
  }
  private openUrlKey(sessionId: string, requestId: string): string {
    return `${sessionId}:${requestId}`
  }

  private clearPendingOpenUrl(sessionId: string, requestId: string): void {
    const requestKey = this.openUrlKey(sessionId, requestId)
    this.pendingOpenUrls.delete(requestKey)
    const timer = this.openUrlExpiryTimers.get(requestKey)
    if (timer) clearTimeout(timer)
    this.openUrlExpiryTimers.delete(requestKey)
  }

  private expireOpenUrl(sessionId: string, requestId: string): void {
    const requestKey = this.openUrlKey(sessionId, requestId)
    if (!this.pendingOpenUrls.has(requestKey)) return
    this.clearPendingOpenUrl(sessionId, requestId)
    const session = this.sessions.get(sessionId)
    if (session) {
      this.toMachine(session.machineId, { type: 'sessionOpenUrlDismiss', sessionId, requestId })
    }
    this.broadcastToClients({
      type: 'sessionOpenUrlResult',
      sessionId,
      requestId,
      status: 'expired',
    })
  }

  /**
   * Focus-aware fan-out for the typed session.openUrl bus event. The request
   * remains parked until completion/dismissal/expiry, so a later client can
   * still surface it when no browser was connected at capture time. [spec:SP-a43e]
   */
  onOpenUrl(request: SessionOpenUrlMessage): void {
    if (!this.sessions.has(request.sessionId) || request.expiresAt <= this.now()) return
    const requestKey = this.openUrlKey(request.sessionId, request.requestId)
    if (this.pendingOpenUrls.has(requestKey)) return
    this.pendingOpenUrls.set(requestKey, request)
    const timer = setTimeout(
      () => this.expireOpenUrl(request.sessionId, request.requestId),
      Math.max(1, request.expiresAt - this.now()),
    )
    timer.unref?.()
    this.openUrlExpiryTimers.set(requestKey, timer)

    const clients = [...this.clients.values()]
    const focused = clients.filter((client) => client.focused === request.sessionId)
    const visible = clients.filter((client) => client.viewVisible.has(request.sessionId))
    const recipients = focused.length > 0 ? focused : visible.length > 0 ? visible : clients
    for (const client of recipients) client.send(request)
  }

  private onOpenUrlResult(machineId: string, message: SessionOpenUrlResultMessage): void {
    const session = this.sessions.get(message.sessionId)
    if (!session || session.machineId !== machineId) return
    const requestKey = this.openUrlKey(message.sessionId, message.requestId)
    if (!this.pendingOpenUrls.has(requestKey)) return
    if (message.status !== 'failed') {
      this.clearPendingOpenUrl(message.sessionId, message.requestId)
    }
    this.broadcastToClients(message)
  }

  private submitOpenUrlCallback(
    client: ClientConn,
    message: Extract<ClientMessage, { type: 'sessionOpenUrlCallback' }>,
  ): void {
    const requestKey = this.openUrlKey(message.sessionId, message.requestId)
    const request = this.pendingOpenUrls.get(requestKey)
    const session = this.sessions.get(message.sessionId)
    if (!request || !session || request.expiresAt <= this.now()) {
      client.send({
        type: 'sessionOpenUrlResult',
        sessionId: message.sessionId,
        requestId: message.requestId,
        status: 'expired',
      })
      return
    }
    this.toMachine(session.machineId, message)
  }

  private dismissOpenUrl(message: Extract<ClientMessage, { type: 'sessionOpenUrlDismiss' }>): void {
    const requestKey = this.openUrlKey(message.sessionId, message.requestId)
    if (!this.pendingOpenUrls.has(requestKey)) return
    const session = this.sessions.get(message.sessionId)
    this.clearPendingOpenUrl(message.sessionId, message.requestId)
    if (session) this.toMachine(session.machineId, message)
    this.broadcastToClients({
      type: 'sessionOpenUrlResult',
      sessionId: message.sessionId,
      requestId: message.requestId,
      status: 'dismissed',
    })
  }

  /**
   * Reconnect reclaim: a freshly connected client (`next`) presents the id of its
   * previous socket (`priorId`). Move that stale client's controller roles onto
   * `next`, then evict it. Roles are transferred BEFORE eviction so detachClient's
   * "reassign to some other attached client" fallback doesn't hand control to a
   * third party (or drop it) in the window before `next` re-sends its attaches.
   * The client's own `attach` messages (which follow `hello`) then re-establish
   * PTY membership and resume the output stream.
   */
  private reclaimClient(priorId: string, next: ClientConn): void {
    const prior = this.clients.get(priorId)
    if (!prior || prior.id === next.id) return
    for (const sessionId of prior.attached) {
      this.sessions.get(sessionId)?.reassignController(priorId, next.id)
    }
    this.detachClient(priorId)
  }

  onClientMessage(id: string, msg: ClientMessage): void {
    const client = this.clients.get(id)
    if (!client) return
    switch (msg.type) {
      case 'hello':
        // `hello.viewport` is a connection bootstrap hint, not a measured grid
        // for every attached terminal. Session-specific grids arrive through
        // `resize`; using the 80x24 hint for reconciliation can shrink a pane.
        // Feature negotiation (spec §2.3): from here on this client gets metadata
        // deltas instead of full-list snapshot rebroadcasts.
        if (msg.caps) client.caps = new Set(msg.caps)
        // Reconnect identity. A client re-presents the id it was given on its
        // previous socket. Hand that now-stale client's controller roles to this
        // one and evict it, so a dropped or half-open socket doesn't strand the
        // user as a muted spectator of their own sessions (controller-gated input)
        // until the old connection's TCP finally times out. Single-user trust
        // model: a clientId is an identity hint, not a capability to guard.
        if (msg.clientId && msg.clientId !== id) this.reclaimClient(msg.clientId, client)
        break
      case 'attach': {
        const t0 = performance.now()
        const session = this.sessions.get(msg.sessionId)
        if (!session) return
        client.attached.add(msg.sessionId)
        this.mutateSessionView(msg.sessionId, (current) =>
          current.attachClient(client, msg.sinceSeq),
        )
        this.broadcastSessions()
        this.pushPriorities()
        perf.record('phase', 'ws.attach', performance.now() - t0)
        break
      }
      case 'detach': {
        const t0 = performance.now()
        client.attached.delete(msg.sessionId)
        this.mutateSessionView(msg.sessionId, (session) => session.detachClient(id))
        this.broadcastSessions()
        this.pushPriorities()
        perf.record('phase', 'ws.detach', performance.now() - t0)
        break
      }
      case 'input':
        this.sessions.get(msg.sessionId)?.handleInput(id, msg.data)
        break
      case 'resize':
        this.mutateSessionView(msg.sessionId, (session) =>
          session.handleResize(id, msg.cols, msg.rows),
        )
        break
      case 'requestControl':
        this.mutateSessionView(msg.sessionId, (session) => session.requestControl(id))
        this.broadcastSessions()
        break
      case 'redrawRequest':
        this.sessions.get(msg.sessionId)?.redraw()
        break
      case 'transcriptSubscribe':
        client.transcriptSubs.add(msg.sessionId)
        this.sessions.get(msg.sessionId)?.subscribeTranscript(client, msg.since)
        break
      case 'transcriptUnsubscribe':
        client.transcriptSubs.delete(msg.sessionId)
        this.sessions.get(msg.sessionId)?.unsubscribeTranscript(id)
        break
      case 'presence':
        client.visible = msg.visible
        break
      case 'viewState':
        client.viewVisible = new Set(msg.visible)
        client.focused = msg.focused
        // Store the rendered-mode signal (native/chat). Intentionally NOT fed into
        // pushPriorities/computePriorities — it's available server-side but does not
        // alter output relay/coalescing.
        client.viewModes = msg.modes ?? {}
        // Heal the resize/viewState race: a foreground panel sends its fitted resize
        // before this viewState message (panel effect before store effect), so the
        // viewVisible gate in handleResize dropped it. Now that the client declares
        // it renders these sessions, re-apply its last viewport where it's controller
        // — otherwise the PTY stays stuck at the 80x24 default (quarter-size window).
        for (const sid of client.viewVisible) {
          this.mutateSessionView(sid, (session) => session.reconcileGeometry(id))
        }
        this.pushPriorities()
        break
      case 'setSessionDraft':
        this.setSessionDraft(msg, id)
        break
      case 'sessionOpenUrlCallback':
        this.submitOpenUrlCallback(client, msg)
        break
      case 'sessionOpenUrlDismiss':
        this.dismissOpenUrl(msg)
        break
      case 'ping':
        client.send({ type: 'pong' })
        break
    }
  }

  /** Hand an issue the worktree its session is actually working in [spec:SP-4ef9].
   *  Two ways in: the agent DECLARES it (`podium worktree`), or the HARNESS makes its
   *  own worktree and the session's hooks start reporting from it (Claude's
   *  EnterWorktree — POD-664 left the worktree real on disk with the issue holding
   *  neither branch nor path). Podium adopts what the harness did rather than fighting
   *  it; branch and path are stamped together so the issue can never hold half of one.
   *
   *  Every guard earns its place — this stamps a path the AGENT chose, not one podium
   *  created: only a real linked worktree (a main checkout is never a workspace, and an
   *  issue claiming main would swallow every unattached session — [spec:SP-595b]), only
   *  in the issue's own repo, only when the issue owns no worktree yet, and never one
   *  another issue already owns (a `cd` into a sibling's workspace must not steal it).
   *
   *  Declaring (`podium worktree`) vs being observed makes no difference to the stamp:
   *  the guards below decide, and `explicit` only buys a send the daemon would otherwise
   *  dedup away. Both answer the same question — is the session working in a worktree
   *  its issue doesn't know about? */
  private adoptWorktree(
    issueId: string,
    msg: Extract<DaemonMessage, { type: 'sessionCwd' }>,
  ): void {
    const issue = this.issues().getMeta(issueId)
    if (!issue || issue.archived || issue.worktreePath !== null) return
    // Only a POD-665+ daemon may adopt: `kind` is the ONLY trustworthy way to know a
    // path is a real worktree and not main, because it comes from git. An older daemon
    // sends no `kind` and simply does not adopt — its sessions self-heal the instant
    // its binary updates, since any hook cwd from a real worktree then adopts.
    //
    // Its old guard (`explicit && issue.repoPath !== msg.cwd`) is deliberately NOT kept.
    // It identifies "main" by string-comparing against a REGISTERED path, which holds
    // only while that string is byte-identical to git's toplevel: a symlinked repo path
    // resolves to its real path, so the compare says "not main" and the issue gets
    // stamped with live main itself — the swallow-everything failure [spec:SP-595b].
    // Path tests cannot be rescued here either, since worktrees live INSIDE the repo
    // dir (`<repo>/.worktrees/x`) — no prefix separates them from a main subdirectory.
    // That is the whole reason classification moved into git. A nicety that heals on
    // its own is not worth a live-main stamp during a mixed-version rollout.
    if (msg.kind !== 'worktree') return
    // Absent repoRoot means an exotic layout (a bare repo serving worktrees) where no
    // primary checkout exists to compare; the remaining guards still apply.
    if (msg.repoRoot !== undefined && msg.repoRoot !== issue.repoPath) return
    if (this.issues().worktreePaths().includes(msg.cwd)) return
    this.issues().update(issue.id, {
      worktreePath: msg.cwd,
      // Absent on a detached HEAD: take the worktree, leave the branch claim alone.
      ...(msg.branch ? { branch: msg.branch } : {}),
    })
  }

  // ---- ws data plane: daemon ----
  /** Inbound daemon message, tagged with the machine it came from. Session-keyed
   *  handlers (bind/agentFrame/agentExit/…) look up by sessionId and are machine-
   *  agnostic; host-scoped ones (hostMetrics, conversation discovery) use machineId
   *  to scope/tag their data; `*Result` replies settle in the RPC module. */
  onDaemonMessageFrom(machineId: string, msg: DaemonMessage): void {
    switch (msg.type) {
      case 'approvalExecResult': {
        this.deps.onApprovalExecResult(msg)
        return
      }
      case 'agentRelayRequest': {
        this.deps.runAgentRelay(machineId, msg)
        break
      }
      case 'sessionOpenUrl': {
        const session = this.sessions.get(msg.sessionId)
        // A daemon may only originate intents for sessions it owns. The bus is
        // the typed notification seam from capture to client routing. [spec:SP-a43e]
        if (session?.machineId === machineId) this.bus.emit('session.openUrl', msg)
        break
      }
      case 'sessionOpenUrlResult': {
        this.onOpenUrlResult(machineId, msg)
        break
      }
      case 'bind': {
        this.sessions.get(msg.sessionId)?.markLive(msg.cmd, msg.geometry)
        const s = this.sessions.get(msg.sessionId)
        if (s) this.persist(s)
        this.broadcastSessions()
        // The PTY is bound: if messages queued up while this session was parked
        // (or across a server restart), start a delivery attempt — the drain loop
        // itself waits out the boot-settle before typing.
        this.drainQueuedMessages(msg.sessionId)
        break
      }
      case 'agentFrame':
        // The bridge's msg.seq is ignored — the Session assigns its own monotonic
        // seq so the client cursor stays stable across daemon reattaches.
        this.sessions.get(msg.sessionId)?.onFrame(msg.data)
        break
      case 'agentFrameBatch': {
        // The daemon coalesced several PTY frames for a lower-priority session into
        // one batch. Unpack back into per-frame onFrame so each still gets its own
        // server seq + outputFrame broadcast (clients are unchanged by coalescing).
        const session = this.sessions.get(msg.sessionId)
        if (session) for (const data of msg.frames) session.onFrame(data)
        break
      }
      case 'agentExit': {
        this.sessions.get(msg.sessionId)?.onExit(msg.code)
        this.autoContinue.onSessionGone(msg.sessionId)
        // Free the lingering per-session title debouncer when the process ends (audit
        // P1-12) — previously only killSession did, so every exited-but-not-killed
        // session leaked its debouncer closure. The row stays (resurrectable); a new
        // debouncer is created lazily if it ever emits a title again. Drafts are kept
        // (resurrect/chat needs them).
        this.titleDebouncers.get(msg.sessionId)?.dispose()
        this.titleDebouncers.delete(msg.sessionId)
        const s = this.sessions.get(msg.sessionId)
        if (s) this.persist(s)
        this.broadcastSessions()
        this.issues().onSessionActivity(msg.sessionId)
        // If the process death made an empty draft's last session 'exited', reap
        // the draft. A hibernate kill lands here too, but onExit keeps status
        // 'hibernated', which blocks the reap — parked drafts survive.
        this.maybeReapDraftIssue(s?.issueId)
        // Session-death notification [spec:SP-85d1] (lock auto-release et al.).
        // Only a REAL exit fires: a hibernate kill keeps status 'hibernated'
        // and the session's leases with it. Also durable for steward parent-wake
        // (POD-904).
        if (s?.status === 'exited') {
          this.emitSessionExited(msg.sessionId, msg.code, s.spawnedBy)
        }
        break
      }
      case 'spawnError': {
        this.sessions.get(msg.sessionId)?.markSpawnError(msg.message)
        const s = this.sessions.get(msg.sessionId)
        if (s) this.persist(s)
        this.broadcastSessions()
        // markSpawnError sets status 'exited' — notify lock auto-release etc.
        // [spec:SP-85d1] like any other real death.
        if (s) this.emitSessionExited(s.sessionId, -1, s.spawnedBy)
        break
      }
      case 'reattachFailed': {
        const s = this.sessions.get(msg.sessionId)
        // Skip rows already exited: those are the boot-time probes of dead 'exited'
        // sessions (see attachDaemon). Re-running onExit there would re-broadcast a
        // redundant agentExit and churn the row on every restart. A 'reconnecting'
        // survivor that fails to reattach is a real death — mark it exited.
        if (s && s.status !== 'exited') {
          s.onExit(-1) // the durable host is gone; the agent died with it
          this.autoContinue.onSessionGone(s.sessionId) // cancel any armed retry promptly, not at the next backoff tick
          this.persist(s)
          // Real death (not a boot-time probe of an already-exited row) —
          // notify lock auto-release etc. [spec:SP-85d1]. onExit keeps a
          // hibernated row 'hibernated'; only a genuine exit fires. (Fresh
          // lookup: the narrowed `s.status` above would defeat the compare.)
          if (this.sessions.get(msg.sessionId)?.status === 'exited') {
            this.emitSessionExited(s.sessionId, -1, s.spawnedBy)
          }
        }
        this.broadcastSessions()
        break
      }
      case 'agentState': {
        const session = this.sessions.get(msg.sessionId)
        if (!session) break
        const prev = session.agentState
        session.setAgentState(msg.state)
        const next = session.agentState ?? msg.state
        this.autoContinue.onStateChange(msg.sessionId, next)
        // Persist so the advanced recency (lastActiveAt) is durable across a server
        // restart — otherwise the row keeps its stale last-persisted time and the
        // ordering jumps backward on every redeploy until events re-arrive.
        this.persist(session)
        // A dedicated per-session message — not broadcastSessions(). Hook events
        // fire often (TodoWrite mutations, turn boundaries, across all sessions);
        // re-serializing and fanning out the whole session list each time is
        // O(sessions × clients). Late joiners still get state via listSessions().
        this.broadcastToClients({
          type: 'sessionAgentStateChanged',
          sessionId: msg.sessionId,
          state: next,
        })
        this.issues().onSessionActivity(msg.sessionId)
        // Synchronous fan-out to bus subscribers (NotifyService) — same ordering
        // as the old direct notifyAttention call.
        this.bus.emit('session.stateChanged', { sessionId: msg.sessionId, prev, next })
        if (
          session.snoozedUntil !== undefined &&
          SessionsService.isAttentionPhase(prev) &&
          !SessionsService.isAttentionPhase(next)
        ) {
          this.clearSnooze(msg.sessionId)
        }
        // Entering an attention phase = a new message needs the user: end any
        // "until next message" defer on the issue that owns this session.
        if (!SessionsService.isAttentionPhase(prev) && SessionsService.isAttentionPhase(next)) {
          this.issues().onSessionAttention(msg.sessionId)
        }
        break
      }
      case 'agentColor': {
        const session = this.sessions.get(msg.sessionId)
        if (!session) break
        // Identity colour changes rarely (only on /color), so a full session
        // rebroadcast is fine — no need for a dedicated per-session message.
        // Persist so the wire-visible colour reaches the change log too [#256].
        if (session.setAgentColor(msg.color)) {
          this.persist(session)
          this.broadcastSessions()
        }
        break
      }
      case 'title': {
        const session = this.sessions.get(msg.sessionId)
        if (!session) break
        // A `<command-name>/model</command-name>` wrapper is never a title, whichever
        // way it arrives. Refuse it outright rather than letting it be applied and
        // locked in — the real title is still coming.
        if (isCommandWrapperText(msg.title)) break
        // Claude Code's OSC title sits at the generic "Claude Code" placeholder for
        // a while after start. Don't let it overwrite a real title we already have
        // (its own later summary, or the first-prompt fallback below) — that's the
        // "stuck on Claude Code" regression.
        if (
          isGenericClaudeTitle(msg.title) &&
          session.title &&
          !isGenericClaudeTitle(session.title)
        ) {
          break
        }
        // Apply the title to the in-memory session + persist immediately so that
        // write-through tests and late-joining clients always see the current title,
        // even during a rapid burst of transient spinner frames.
        if (!isTransientTitle(msg.title)) {
          session.setTitle(msg.title)
          // A non-generic agent title (Claude's own summary) is the real thing —
          // lock it so the first-prompt fallback won't fire/override.
          if (!isGenericClaudeTitle(msg.title)) session.titleLocked = true
          this.persist(session)
        }
        // The client broadcast is debounced: spinner/braille frames arrive at
        // frame-rate; coalescing them prevents UI flapping and excessive network
        // traffic. The debouncer only broadcasts stable (non-transient) titles.
        // Leading-edge: the debouncer emits on first non-transient title so a single
        // title push still broadcasts synchronously (test-friendly), then coalesces
        // subsequent rapid changes on the trailing edge.
        if (!this.titleDebouncers.has(msg.sessionId)) {
          const sid = msg.sessionId
          this.titleDebouncers.set(
            sid,
            makeTitleDebouncer((stableTitle) => {
              // A dedicated per-session message — not broadcastSessions(). Agents emit
              // titles at spinner frame-rate; rebroadcasting the whole list each time
              // would be wasteful, and late-joining clients still get the title via
              // listSessions() on attach.
              this.broadcastToClients({
                type: 'sessionTitleChanged',
                sessionId: sid,
                title: stableTitle,
              })
            }),
          )
        }
        this.titleDebouncers.get(msg.sessionId)!.push(msg.title)
        break
      }
      case 'scanResult': {
        this.conversations().onDiscovery(machineId, msg.conversations, msg.diagnostics, msg.removed)
        this.rpc.onScanResult(msg)
        break
      }
      case 'conversationsChanged': {
        this.conversations().onDiscovery(machineId, msg.conversations, msg.diagnostics, msg.removed)
        break
      }
      case 'scanReposResult': {
        this.rpc.onScanReposResult(msg)
        break
      }
      case 'browseDirsResult': {
        this.rpc.onBrowseDirsResult(msg)
        break
      }
      case 'hostMetrics': {
        const { type: _type, ...rest } = msg
        this.hosts.onHostMetrics(machineId, rest)
        break
      }
      case 'sessionResumeRef': {
        const session = this.sessions.get(msg.sessionId)
        if (!session) break
        // A daemon may bind only sessions owned by its authenticated machine.
        // This check is especially important for acknowledgements: never tell a
        // foreign instance that its claimed mapping was persisted.
        if (session.machineId !== machineId) {
          console.warn(
            `[podium] ignored resume binding for ${msg.sessionId} from non-owner machine ${machineId}`,
          )
          break
        }
        // [spec:SP-fccf] A native Codex thread belongs to one interactive Podium
        // pane. Timing-only observers from older daemons are never allowed to
        // overwrite an established binding. Exact native-hook or legacy-marker
        // evidence wins and clears stale siblings so the invariant heals in place.
        const conflicts =
          session.agentKind === 'codex' && !session.headless
            ? [...this.sessions.values()].filter(
                (other) =>
                  other.sessionId !== session.sessionId &&
                  !other.headless &&
                  other.agentKind === 'codex' &&
                  other.resume?.kind === msg.resume.kind &&
                  other.resume.value === msg.resume.value,
              )
            : []
        if (conflicts.length > 0) {
          if (msg.confidence !== 'exact') {
            console.warn(
              `[podium] ignored heuristic Codex resume collision ${msg.resume.value} for ${session.sessionId}`,
            )
            break
          }
          for (const conflict of conflicts) {
            conflict.resume = undefined
            conflict.conversationPodiumId = undefined
            this.persist(conflict)
          }
          this.broadcastSessions()
        }
        if (
          session.resume?.kind !== msg.resume.kind ||
          session.resume?.value !== msg.resume.value
        ) {
          const prior = session.resume?.value
          session.resume = msg.resume
          // Conversation registry: this seam is where lineage is OBSERVED. A prior
          // ref rolling to a new one on the same session = same conversation, new
          // native file → link as a segment ('live-roll'). First-ever ref = the
          // session's conversation becomes known → ensure an identity exists.
          // (docs/spec/conversation-registry.md §3.1)
          session.conversationPodiumId = prior
            ? this.store.conversations.linkConversationSegment({
                machineId: session.machineId,
                newNativeId: msg.resume.value,
                priorNativeId: prior,
                providerId: session.agentKind,
              })
            : this.store.conversations.ensureConversationIdentity({
                machineId: session.machineId,
                nativeId: msg.resume.value,
                providerId: session.agentKind,
              })
          this.persist(session)
          // A resume ref makes the session resumable (→ hibernate button). Push the
          // updated meta so already-connected clients see it live, rather than only
          // when a coincident transcriptAppend happens to broadcast or on reconnect.
          this.broadcastSessions()
        }
        // Ack only after the exact mapping is already in durable server state.
        // Delivery is at-least-once, so an unchanged mapping is also acknowledged.
        if (msg.ackRequested && msg.confidence === 'exact') {
          this.toMachine(machineId, {
            type: 'sessionResumeRefAck',
            sessionId: msg.sessionId,
            resume: msg.resume,
          })
        }
        break
      }
      case 'sessionCwd': {
        const session = this.sessions.get(msg.sessionId)
        if (!session) break
        // The agent moved into a new directory (EnterWorktree / cd). Restamp the
        // session cwd so the sidebar re-groups it under the worktree it's now in,
        // and persist + broadcast so the move survives a reload and reaches every
        // connected client immediately. Ignore empty paths defensively.
        if (msg.cwd && session.cwd !== msg.cwd) {
          session.cwd = msg.cwd
          this.persist(session)
          this.broadcastSessions()
        }
        if (msg.cwd && session.issueId) this.adoptWorktree(session.issueId, msg)
        break
      }
      case 'transcriptDelta': {
        const session = this.sessions.get(msg.sessionId)
        if (
          session?.applyDelta(msg.items, {
            ...(msg.reset !== undefined ? { reset: msg.reset } : {}),
            ...(msg.tail !== undefined ? { tail: msg.tail } : {}),
          })
        ) {
          // First transcript for this session → its chat capability flipped on;
          // persist (the flip is wire-visible, one-shot — commit it to the
          // change log, #256) and push the updated meta so clients can offer
          // the chat toggle.
          this.persist(session)
          this.broadcastSessions()
        }
        // Fast title for Claude: until a real title is locked in (its own summary,
        // or this fallback), name the session from the first user prompt so it
        // doesn't sit on the cwd/"Claude Code" placeholder for the long stretch
        // before Claude generates its own title.
        if (session && session.agentKind === 'claude-code' && !session.titleLocked) {
          const firstUser = session.transcriptItems().find(
            (it) =>
              it.role === 'user' &&
              it.text.trim().length > 0 &&
              // A slash command the user typed first (`/model`) reaches the
              // transcript as a `<command-name>…` wrapper, not as a prompt.
              // Skipping it lets the first REAL prompt title the session.
              !isCommandWrapperText(it.text),
          )
          const derived = firstUser ? titleFromPrompt(firstUser.text) : undefined
          if (derived) {
            session.setTitle(derived)
            session.titleLocked = true
            this.persist(session)
            this.broadcastToClients({
              type: 'sessionTitleChanged',
              sessionId: msg.sessionId,
              title: derived,
            })
          }
        }
        break
      }
      case 'handoffExportResult': {
        this.rpc.onHandoffExportResult(msg)
        break
      }
      case 'handoffChunkReadResult': {
        this.rpc.onHandoffChunkReadResult(msg)
        break
      }
      case 'handoffImportChunkResult': {
        this.rpc.onHandoffImportChunkResult(msg)
        break
      }
      case 'handoffImportResult': {
        this.rpc.onHandoffImportResult(msg)
        break
      }
      case 'workspaceExportResult': {
        this.rpc.onWorkspaceExportResult(msg)
        break
      }
      case 'workspaceImportResult': {
        this.rpc.onWorkspaceImportResult(msg)
        break
      }
      case 'workspaceCleanResult': {
        this.rpc.onWorkspaceCleanResult(msg)
        break
      }
      case 'repoOpResult': {
        this.rpc.onRepoOpResult(msg)
        break
      }
      case 'harnessExecResult': {
        this.rpc.onHarnessExecResult(msg)
        break
      }
      case 'headlessTurnEvent': {
        this.headless.onTurnEvent(msg)
        break
      }
      case 'headlessTurnResult': {
        this.headless.onTurnResult(msg)
        break
      }
      case 'headlessBindResult': {
        this.headless.onBindResult(msg)
        break
      }
      case 'usageResult': {
        this.rpc.onUsageResult(msg)
        break
      }
      case 'agentQuotaResult': {
        this.rpc.onAgentQuotaResult(msg)
        break
      }
      case 'transcriptReadResult': {
        this.rpc.onTranscriptReadResult(msg)
        break
      }
      case 'transcriptMirrorResult': {
        this.conversations().onTranscriptMirrorResult(msg)
        break
      }
      case 'imageUploadResult': {
        this.rpc.onImageUploadResult(msg)
        break
      }
      case 'memoryBreakdownResult': {
        this.hosts.onMemoryBreakdownResult(msg)
        break
      }
      case 'fileReadResult': {
        this.rpc.onFileReadResult(msg)
        break
      }
      case 'fileWriteResult': {
        this.rpc.onFileWriteResult(msg)
        break
      }
      case 'fileAssetResult': {
        this.rpc.onFileAssetResult(msg)
        break
      }
      case 'dirListResult': {
        this.rpc.onDirListResult(msg)
        break
      }
    }
  }

  transcriptFor(sessionId: string): TranscriptItem[] {
    return this.sessions.get(sessionId)?.transcriptItems() ?? []
  }

  /** Raw fan-out to every connected client. Typed LIVE-ONLY (modules/
   *  message-class, issue #190): durable entity messages must go through the
   *  write funnel's publish tail instead, so passing one here is a type error.
   *  `exceptClientId` skips the originator (draft echo suppression). */
  broadcastToClients(msg: LiveServerMessage, opts: { exceptClientId?: string } = {}): void {
    for (const c of this.clients.values()) {
      if (c.id === opts.exceptClientId) continue
      c.send(msg)
    }
  }

  // Coalescing state for broadcastSessions() (bind-storm fix). Design: the FIRST
  // call in a burst runs the pipeline synchronously (single-event callers — and
  // the many tests that assert right after one trigger — keep exact ordering);
  // while its setTimeout(0) cooldown is armed, follow-up calls only set a pending
  // flag and fold into ONE trailing run when the timer fires. A 66-bind daemon
  // reattach storm thus runs the full pipeline (dedup + oplog record + issue
  // rebuild + fan-out) ~2× per event-loop turn instead of 66×, which is what
  // burned the systemd watchdog budget on redeploy. flushBroadcasts() is the
  // deterministic seam for tests (and any caller that must observe the trailing
  // run without waiting a tick).
  private broadcastCooldown: ReturnType<typeof setTimeout> | null = null
  private broadcastPending = false

  broadcastSessions(): void {
    // Volatile view changes always cross an event-loop boundary before SQLite.
    // The keyed buffer folds resize/disconnect bursts into one capture batch.
    if (this.pendingVolatileSessions.size > 0) {
      this.broadcastPending = true
      this.scheduleVolatileSessionCapture()
      return
    }
    if (this.broadcastCooldown) {
      this.broadcastPending = true
      return
    }
    this.runSessionsBroadcast()
    this.broadcastCooldown = setTimeout(() => {
      this.broadcastCooldown = null
      if (this.broadcastPending) {
        this.broadcastPending = false
        // The trailing run has no caller to propagate to (timer context): a
        // pipeline throw here would be an uncaught exception and take the whole
        // process down, where the same throw on the synchronous leading run
        // surfaces to the triggering handler exactly as before.
        try {
          this.broadcastSessions() // leading run again + re-arm the cooldown
        } catch (err) {
          console.warn('[podium] coalesced session broadcast failed', err)
        }
      }
    }, 0)
    this.broadcastCooldown.unref?.()
  }

  /** Run any coalesced (pending) session broadcast NOW — and flush the funnel's
   *  pending metadataDelta batch with it, so this stays the one deterministic
   *  "run the whole pending pipeline" seam for tests + dispose. */
  flushBroadcasts(): void {
    if (this.broadcastCooldown) {
      clearTimeout(this.broadcastCooldown)
      this.broadcastCooldown = null
    }
    if (this.broadcastPending || this.pendingVolatileSessions.size > 0) {
      this.broadcastPending = false
      this.runSessionsBroadcast()
    }
    this.funnel.flushDeltas()
  }

  private runSessionsBroadcast(): void {
    const t0 = performance.now()
    if (this.runningSessionsBroadcastGeneration !== -1) {
      this.broadcastPending = true
      perf.record('phase', 'sessionsBroadcast.total', performance.now() - t0)
      return
    }
    // Reserve the runner before capture: projection listeners are synchronous and
    // may request another broadcast while the successful batch is being published.
    this.runningSessionsBroadcastGeneration = -2
    try {
      this.flushVolatileSessionCaptures()
      const generation = this.sessionsGeneration_
      if (generation === this.lastSessionsBroadcastGeneration) {
        perf.record('phase', 'sessionsBroadcast.total', performance.now() - t0)
        return
      }
      this.runningSessionsBroadcastGeneration = generation
      const sessions = this.listSessions()
      const tList = performance.now()
      perf.record('phase', 'sessionsBroadcast.list', tList - t0)
      // Every non-boot mutation was already captured at its owning seam. This hot
      // path only builds the legacy snapshot; full reconcile is boot/recovery-only.
      const key = JSON.stringify(sessions)
      const tStringify = performance.now()
      perf.record('phase', 'sessionsBroadcast.stringify', tStringify - tList, key.length)
      // LEGACY snapshot fan-out only ([spec:SP-3fe2] #256): session deltas were
      // captured at their owning seams and ride the funnel's ordered onAppended
      // pipe — recording here again would double-append.
      const tFanout0 = performance.now()
      this.funnel.publishComputed({ type: 'sessionsChanged', sessions })
      // Snapshot receivers = the non-delta-cap clients (see fanOutSnapshot).
      let receivers = 0
      for (const c of this.clients.values()) {
        if (!c.caps.has(CAP_METADATA_DELTA)) receivers += 1
      }
      perf.record(
        'phase',
        'sessionsBroadcast.fanout',
        performance.now() - tFanout0,
        key.length * receivers,
      )
      // Session changes also change issues' DERIVED member data (sessions/summary),
      // so keep issue clients live. The publisher builds the payload ONCE (allWire()
      // is O(issues × sessions)); sessionsChanged was already sent above, so even if
      // the issues build fails it can't take the session list down with it.
      // IssueWire embeds SessionMeta[]: publishIssues() runs its own issue
      // reconcile (publisher.publishIssueList), so the embedded copies heal at
      // the same cadence as before — no extra mechanism needed (#247).
      //
      // POD-722: skip that O(issues×sessions) rebuild when this broadcast touched
      // no field that feeds issue wire data. The session-switch hot path POD-701
      // measured (attach + detach, ~2 broadcasts) moves only clientCount/
      // controllerId/epoch — stripped from the projection below — so the issue
      // payloads are byte-identical to the last publish and republishing them is
      // pure waste. When a real issue-relevant field DID change (status, workState,
      // activity, membership, …) the projection differs and publishIssues() runs
      // as before. Issue-ROW changes take their own publish path (persist/
      // broadcastList in modules/issues), unaffected by this skip. Interim until
      // POD-308 deletes the snapshot fan-out.
      const tSkip0 = performance.now()
      const issueProjection = issueRelevantSessionProjection(sessions)
      if (issueProjection === this.lastIssueSessionProjection) {
        perf.record('phase', 'sessionsBroadcast.publishIssuesSkipped', performance.now() - tSkip0)
      } else {
        const tIssues0 = performance.now()
        this.deps.publishIssues()
        // Stamp only AFTER a clean publish: a throw leaves this projection unchanged,
        // so the next broadcast re-publishes instead of silently skipping.
        this.lastIssueSessionProjection = issueProjection
        perf.record('phase', 'sessionsBroadcast.publishIssues', performance.now() - tIssues0)
      }
      this.lastSessionsBroadcastGeneration = generation
    } finally {
      this.runningSessionsBroadcastGeneration = -1
    }
    perf.record('phase', 'sessionsBroadcast.total', performance.now() - t0)
  }

  /**
   * The legacy half of the split fan-out (spec §2.3): every non-cap client gets
   * the full-list snapshot (exactly the pre-oplog behavior); delta-cap clients
   * get it only when `snapshotToCapClients` forces it (diagnostics changes) —
   * their normal feed is the ordered metadataDelta pipe (sendMetadataDelta).
   */
  fanOutSnapshot(snapshot: ServerMessage, opts: { snapshotToCapClients?: boolean } = {}): void {
    for (const c of this.clients.values()) {
      if (c.caps.has(CAP_METADATA_DELTA)) {
        if (opts.snapshotToCapClients) c.send(snapshot)
      } else {
        c.send(snapshot)
      }
    }
  }

  /** The delta half of the split fan-out: one `metadataDelta` batch (stamped
   *  with its last change's seq) to every delta-cap client. Called ONLY by the
   *  funnel's ordered pipe ([spec:SP-3fe2] #256) so batches reach every client
   *  in strict append order — the client gap rule (seq !== cursor+1 → heal)
   *  turns any second emitter or reorder into a heal storm. */
  sendMetadataDelta(changes: MetadataChange[]): void {
    const last = changes[changes.length - 1]
    if (!last) return
    const delta: ServerMessage = { type: 'metadataDelta', seq: last.seq, changes }
    for (const c of this.clients.values()) {
      if (c.caps.has(CAP_METADATA_DELTA)) c.send(delta)
    }
  }

  /**
   * Cursor catch-up for `sync.changesSince` (spec §2.3). Bootstrap (null cursor),
   * a compacted-away cursor, or a future cursor (server DB reset) falls back to a
   * full snapshot; the cursor is read in the same synchronous pass as the entity
   * lists, so nothing falls between the snapshot and the subsequent delta stream.
   */
  syncChangesSince(cursor: number | null): SyncChangesSinceResult {
    const changes = this.funnel.changesSince(cursor)
    if (changes) return { kind: 'delta', changes, cursor: this.funnel.cursor() }
    return {
      kind: 'snapshot',
      sessions: this.listSessions(),
      issues: this.deps.issuesWire(),
      conversations: this.conversations().allConversations(),
      automations: this.deps.automationsWire(),
      automationRuns: this.deps.automationRunsWire(),
      diagnostics: this.conversations().diagnostics(),
      cursor: this.funnel.cursor(),
    }
  }
}
