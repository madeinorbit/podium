import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { computePriorities } from '@podium/domain'
import { resolveRole } from '@podium/runtime'
import {
  AGENT_CAPABILITIES,
  AgentKind,
  type AgentRuntimeState,
  agentSupportsEffort,
  agentSupportsInitialPrompt,
  CAP_METADATA_DELTA,
  type ClientMessage,
  type ControlMessage,
  type DaemonMessage,
  type Geometry,
  type IssueWire,
  type LiveServerMessage,
  type MetadataChange,
  type MetadataEntityKind,
  type ResumeRef,
  type ServerMessage,
  type SessionMeta,
  type SyncChangesSinceResult,
  type TranscriptItem,
  type WorkState,
} from '@podium/protocol'
import { AutoContinueController } from '../../auto-continue'
import type { Capability } from '../../issue-authz'
import { selectMailNudgeSession, sessionsForIssue } from '../../issue-util'
import { LOCAL_MACHINE_ID, LOCAL_PLACEHOLDER } from '../../local-machine'
import { type ClientConn, type Send, Session } from './session'
import type { SessionStore } from '../../store'
import {
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
import type { HeadlessService } from '../superagent/headless'

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

/** Rejection every command path returns for a hub-mirrored session (spec §2.3). */
export const UPSTREAM_COMMAND_REJECTION = 'remote session — managed via the hub'

interface SessionsServiceDeps {
  store: SessionStore
  now(): number
  bus: EventBus
  /** THE write funnel (modules/funnel): every broadcast pipeline ends in its
   *  oplog-append → fan-out tail. */
  funnel: WriteFunnel
  machines: MachinesService
  rpc: DaemonRpcService
  hosts: HostsService
  headless: HeadlessService
  /** Lazy: the conversations service is constructed after this one (post-load slot). */
  conversations(): ConversationsService
  /** Lazy: the issue tracker is constructed after this one. */
  issues(): IssueService
  /** Full issue-list fan-out through the publisher (oplog record + split fan-out).
   *  Mutually recursive with the broadcast pipeline by design — the publisher's
   *  own deps point back at fanOutMetadata/oplogRecord here. */
  publishIssues(): void
  /** Local ∪ upstream issue wire list (attachClient bootstrap + snapshot sync). */
  issuesWire(): IssueWire[]
  /** Relayed agent issue op (modules/issues/relay-gate). */
  runIssueRelay(machineId: string, msg: Extract<DaemonMessage, { type: 'issueRelayRequest' }>): void
}

/**
 * Core session lifecycle + PTY frame relay + scheduling (issue #13 Phase 2):
 * the sessions/clients maps, spawn/resume/park/kill command paths, the client
 * and daemon ws data planes, the durable queued-send drain, and the coalesced
 * session broadcast pipeline (metadata oplog + split fan-out). SessionRegistry
 * is the composition root that wires this to the other modules and keeps thin
 * public delegates.
 */
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
  // Last session-list payload broadcast to clients. broadcastSessions() fires on many
  // events (activity bumps, attach/detach, resume refs) that often don't change any
  // visible field; skipping a byte-identical re-broadcast avoids re-serializing the
  // whole list and fanning it out to every client for nothing (audit P1-8). Existing
  // clients already hold this state; a NEW client gets the current list via
  // attachClient, so the dedup can never leave a client stale.
  private lastSessionsBroadcast = ''
  private nextClientNum = 0
  // Last per-session output-relay priority pushed to the daemon. pushPriorities
  // diffs against this so only CHANGED sessions are re-sent (a viewState/attach
  // churn must not re-flood the daemon with the whole map every time).
  private readonly lastPriority = new Map<string, number>()
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
    // Run any coalesced session broadcast so the oplog records the final state
    // (clients are going away, but the durable log must not drop the tail).
    this.flushBroadcasts()
  }

  persist(session: Session): void {
    this.store.sessions.upsertSession(session.toRow())
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

  loadFromStore(): void {
    // Restore persisted composer drafts so attachClient can replay them to the
    // first client to connect after a server restart (issue #34).
    for (const [sessionId, text] of Object.entries(this.store.sessions.loadDrafts())) {
      this.draftBySession.set(sessionId, text)
    }
    const draftTimes = this.store.sessions.loadDraftTimes()
    const snoozes = this.store.sessions.listSnoozes()
    for (const r of this.store.sessions.loadSessions()) {
      const kind = AgentKind.safeParse(r.agentKind)
      if (!kind.success) {
        console.warn(
          `[podium] skipping persisted session ${r.id}: invalid agentKind ${JSON.stringify(r.agentKind)}`,
        )
        continue
      }
      // Layer 3: a previously live/starting session may still be running in its tmux
      // server. Reload it as 'reconnecting' so attachDaemon can re-bind it; exited stays
      // exited, hibernated stays hibernated. HEADLESS sessions have no PTY to
      // reconcile: they stay 'live' for as long as their thread exists, and
      // attachDaemon re-establishes their transcript tails via headlessBind.
      const reloadStatus = r.headless
        ? r.status
        : r.status === 'live' || r.status === 'starting'
          ? 'reconnecting'
          : r.status
      const exitCode = r.status === 'exited' ? r.exitCode : null
      if (r.originKind === 'resume' && !r.conversationId) {
        console.warn(`[podium] persisted resume session ${r.id} has no conversationId`)
      }
      // Route this session's control messages to the machine that owns it. Capture
      // the id so the closure binds to the right daemon even as the row's machineId
      // is later rewritten by ensureLocalMachine (it also rewrites the Session's field).
      const machineId = r.machineId ?? LOCAL_PLACEHOLDER
      const session = new Session({
        sessionId: r.id,
        agentKind: kind.data,
        cwd: r.cwd,
        title: r.title,
        origin:
          r.originKind === 'resume'
            ? { kind: 'resume', conversationId: r.conversationId ?? '' }
            : { kind: 'spawn' },
        createdAt: r.createdAt,
        geometry: { ...DEFAULT_GEOMETRY },
        machineId,
        toDaemon: (msg) => this.toMachine(this.sessions.get(r.id)?.machineId ?? machineId, msg),
        onActivity: () => {
          // Shell busy transitions advance lastActiveAt (their only activity signal);
          // persist so that recency is durable across a restart, then rebroadcast.
          this.persist(session)
          this.broadcastSessions()
        },
        durableLabel: r.durableLabel,
        lastActiveAt: r.lastActiveAt,
        lastOutputAt: r.lastOutputAt,
        lastInputAt: r.lastInputAt,
        lastResumedAt: r.lastResumedAt,
        status: reloadStatus,
        exitCode: exitCode ?? undefined,
        ...(r.name ? { name: r.name } : {}),
        ...(r.spawnedBy ? { spawnedBy: r.spawnedBy } : {}),
        ...(r.headless ? { headless: true } : {}),
        ...(r.issueId ? { issueId: r.issueId } : {}),
        archived: r.archived,
        readAt: r.readAt ?? null,
        ...(Session.parseWorkState(r.workState)
          ? { workState: Session.parseWorkState(r.workState) }
          : {}),
        ...(r.resumeKind && r.resumeValue
          ? { resume: { kind: r.resumeKind, value: r.resumeValue } }
          : {}),
      })
      this.sessions.set(r.id, session)
      if (r.id in snoozes) session.snoozedUntil = snoozes[r.id]
      if (r.id in draftTimes) session.draftUpdatedAt = draftTimes[r.id]
      if (r.status !== reloadStatus) this.persist(session)
    }
    // Re-stamp conversation identities from the registry (lookup only — minting
    // happens at the observation seams, never speculatively at boot).
    for (const s of this.sessions.values()) {
      if (s.resume?.value) {
        const podiumId = this.store.conversations.conversationPodiumId(s.machineId, s.resume.value)
        if (podiumId) s.conversationPodiumId = podiumId
      }
    }
    // Re-seed the transient queued-send counts from the durable queue — the rows
    // survived the restart (that's their point); delivery re-arms when the daemon
    // reattaches and the sessions bind.
    for (const [sessionId, n] of this.store.sync.queuedMessageCounts()) {
      const session = this.sessions.get(sessionId)
      if (session) session.queuedMessageCount = n
      else this.store.sync.deleteQueuedMessagesForSession(sessionId) // orphaned queue
    }
    this.store.sync.pruneAppliedMutations({ maxAgeMs: APPLIED_MUTATIONS_MAX_AGE_MS, now: this.now() })
    // Boot reconciliation: record what changed across the restart (the sessions
    // just restored) so a cursor-holding client that reconnects heals via
    // changesSince instead of silently missing the gap. Conversations are
    // deliberately NOT reconciled at boot: they are daemon-fed, and an empty
    // list at boot means "not scanned yet", not "all gone".
    this.funnel.record(
      'session',
      this.listSessions().map((s) => ({ id: s.sessionId, value: s })),
    )
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
    // Most-recently-used first: the daemon gates its spawn fan-out, so the order we
    // send in decides who reattaches soonest. Prioritise the sessions the user most
    // likely has open. lastActiveAt is an ISO string, so a reverse lexical sort is
    // newest-first.
    const probes = [...this.sessions.values()]
      .filter(
        (s) =>
          s.machineId === machineId &&
          !s.headless &&
          (s.status === 'reconnecting' || (s.status === 'exited' && !s.archived)),
      )
      .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''))
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
    let changed = false
    for (const s of this.sessions.values()) {
      if (s.machineId !== machineId) continue
      // Headless sessions stay 'live' across daemon restarts — no PTY bridge to
      // lose; their tails re-establish via headlessBind on the next attach.
      if (s.headless) continue
      if (s.markReconnecting()) changed = true
    }
    if (changed) this.broadcastSessions()
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
    const local: SessionMeta[] = [...this.sessions.values()].map((s) => ({
      ...s.toMeta(),
      machineName: this.machines.machineName(s.machineId),
    }))
    if (this.upstreamSessions.size === 0) return local
    // Local ∪ upstream (docs/spec/node-hub-sync.md §2.3). Upstream entries carry
    // viaHub (set at ingest) and, while the hub link is down, upstreamStale —
    // applied at read time so a staleness flip needs no rewrite of the mirror.
    // A local id always wins a collision (defensive; ingest already excludes them).
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
    return this.upstreamSessions.has(sessionId)
  }

  /** `{ ok: false, reason }` for a hub-mirrored session, else null — the shared
   *  guard every ok/reason command path checks first. */
  private upstreamRejection(sessionId: string): { ok: false; reason: string } | null {
    if (!this.upstreamSessions.has(sessionId)) return null
    return { ok: false, reason: UPSTREAM_COMMAND_REJECTION }
  }

  /**
   * Replace the mirrored session list with the hub's truth. Own-machine entries are
   * excluded (echo filter — this node's daemon registered with the hub would reflect
   * its own sessions back), as is anything colliding with a local session id.
   * Entries are stamped `viaHub` at ingest so provenance travels with the value —
   * the P7b push path and the UI both key off it. Flows through the normal
   * broadcast/oplog pipeline so node clients see hub sessions live.
   */
  setUpstreamSessions(list: SessionMeta[]): void {
    this.upstreamSessions.clear()
    for (const s of list) {
      if (s.machineId !== undefined && this.upstreamOwnMachineIds.has(s.machineId)) continue
      if (this.sessions.has(s.sessionId)) continue
      this.upstreamSessions.set(s.sessionId, { ...s, viaHub: true })
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
    this.upstreamStale = stale
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
    this.store.sessions.setSnooze(sessionId, until)
    const session = this.sessions.get(sessionId)
    if (session) session.snoozedUntil = until
    this.broadcastSessions()
  }

  clearSnooze(sessionId: string): void {
    this.store.sessions.clearSnooze(sessionId)
    const session = this.sessions.get(sessionId)
    if (session) session.clearSnooze()
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
   *  `initialPrompt` hands the fresh session a first prompt: for argv-capable agents
   *  (claude/codex/grok) it rides the launch command (`claude "<prompt>"`, race-free);
   *  for the rest it's seeded into the composer draft so the text still appears. */
  createSession(input: {
    agentKind?: AgentKind
    cwd: string
    title?: string
    machineId?: string
    initialPrompt?: string
    /** Per-ticket model/effort override; absent = use the settings defaults. */
    model?: string
    effort?: string
    /** Creation provenance (issue #60). Deliberately NOT defaulted here — the tRPC
     *  router stamps 'user' (its callers are the human seams); programmatic callers
     *  (issues, superagent) pass their own value. Absent = unknown. */
    spawnedBy?: string
    /** Explicit issue attachment (issue-as-workspace). Absent = derive: a session
     *  spawned inside a worktree owned by exactly one non-archived issue is
     *  "continuing that issue" and gets its id stamped. */
    issueId?: string
    /** Client-supplied id (optimistic UI): use this verbatim instead of minting a
     *  fresh uuid, so an optimistic client row reconciles onto the real session
     *  without a swap. Absent = mint one (unchanged default behavior). */
    sessionId?: string
  }): {
    sessionId: string
  } {
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
    const prompt = input.initialPrompt?.trim() ? input.initialPrompt : undefined
    // argv delivery is race-free (the CLI reads the prompt at startup); only
    // argv-capable agents get it that way. Others fall through to a draft seed.
    const useArgv = prompt !== undefined && agentSupportsInitialPrompt(agentKind)
    // Explicit attachment wins; otherwise starting in an issue-owned worktree
    // means continuing that issue (spec: issue-as-workspace).
    const issueId = input.issueId ?? this.issues().soleOwnerForCwd(input.cwd) ?? undefined
    const spawned = this.spawn({
      agentKind,
      cwd: input.cwd,
      ...(input.title !== undefined ? { title: input.title } : {}),
      origin: { kind: 'spawn' },
      machineId: this.machines.resolveMachine(input.machineId, input.cwd),
      ...(useArgv ? { initialPrompt: prompt } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
      ...(issueId ? { issueId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    })
    if (prompt !== undefined && !useArgv) {
      this.setSessionDraft({ sessionId: spawned.sessionId, text: prompt })
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
    return this.spawn({
      agentKind: input.agentKind,
      cwd: input.cwd,
      title: input.title,
      origin: { kind: 'resume', conversationId: input.conversationId },
      resume: input.resume,
      machineId: this.machines.resolveMachine(input.machineId, input.cwd),
      ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
    })
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

  /** The raw typing primitive (bracketed paste + separated CR). Only sendText and
   *  the queue drain call this — everything else must go through them so queued
   *  messages keep their FIFO order. */
  private typeText({ sessionId, text }: { sessionId: string; text: string }): { ok: boolean } {
    const session = this.sessions.get(sessionId)
    if (!session || (session.status !== 'live' && session.status !== 'starting')) {
      return { ok: false }
    }
    // A submitted message re-engages the session — drop any snooze so it returns
    // to the normal attention flow (covers chat send + resumeAndSend paths).
    if (session.snoozedUntil !== undefined) this.clearSnooze(sessionId)
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
    if (input.text) this.draftBySession.set(input.sessionId, input.text)
    else this.draftBySession.delete(input.sessionId)
    // Mirror the draft's last-edit time onto the session so the sidebar can show
    // DRAFT and lift it in the attention ordering. The DRAFT tag / lift only
    // appears or disappears when a draft starts or is cleared, so rebroadcast the
    // session list on that PRESENCE change only — never per keystroke.
    const session = this.sessions.get(input.sessionId)
    const presenceChanged = session && (session.draftUpdatedAt !== undefined) !== !!input.text
    if (session) session.draftUpdatedAt = input.text ? new Date().toISOString() : undefined
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
      // A queued message is fresh user intent on the session — clear any snooze,
      // mirroring sendText, so it returns to the normal attention flow.
      if (session.snoozedUntil !== undefined) this.clearSnooze(sessionId)
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
    this.store.sync.recordAppliedMutation(mutationId, proc, JSON.stringify(result ?? null), this.now())
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

  /** Set (or clear with '') the user-facing session name. */
  renameSession({ sessionId, name }: { sessionId: string; name: string }): void {
    this.mutateSessionMeta(sessionId, (session) => {
      session.name = name.trim()
    })
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
    this.toMachine(session.machineId, { type: 'kill', sessionId })
    this.broadcastSessions()
    return { ok: true }
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
    session.status = 'starting'
    session.exitCode = undefined
    // Waking a session resets its hibernation idle timer — otherwise a stale
    // lastActiveAt makes it immediately eligible to be parked again.
    session.markResumed()
    this.persist(session)
    this.toMachine(session.machineId, {
      type: 'spawn',
      sessionId,
      agentKind: session.agentKind,
      cwd: session.cwd,
      ...(session.resume ? { resume: session.resume } : {}),
      geometry: session.geometry,
      ...this.modelDefaults(session.agentKind),
    })
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

  killSession(input: { sessionId: string }): void {
    // Read-only surface (node-hub-sync §2.3): killing a hub-mirrored session here
    // would fabricate a kill for a PTY this server doesn't own — reject loudly.
    if (this.isUpstreamSession(input.sessionId)) {
      throw new Error(UPSTREAM_COMMAND_REJECTION)
    }
    const session = this.sessions.get(input.sessionId)
    // Capture before the row is deleted — the reap after cleanup needs it.
    const issueId = session?.issueId
    this.toMachine(session?.machineId ?? LOCAL_PLACEHOLDER, {
      type: 'kill',
      sessionId: input.sessionId,
    })
    this.autoContinue.onSessionGone(input.sessionId)
    session?.detachAll()
    this.sessions.delete(input.sessionId)
    this.draftBySession.delete(input.sessionId)
    this.titleDebouncers.get(input.sessionId)?.dispose()
    this.titleDebouncers.delete(input.sessionId)
    // Cancel any pending debounced draft write before deleteSession removes the
    // row, so a late timer can't resurrect a draft for a now-dead session.
    const draftTimer = this.draftWriteTimers.get(input.sessionId)
    if (draftTimer) {
      clearTimeout(draftTimer)
      this.draftWriteTimers.delete(input.sessionId)
    }
    this.store.sessions.deleteSession(input.sessionId)
    // A killed session can never deliver: drop its queued sends now rather than
    // leaving orphan rows for the next boot's sweep.
    this.store.sync.deleteQueuedMessagesForSession(input.sessionId)
    for (const c of this.clients.values()) c.attached.delete(input.sessionId)
    this.broadcastSessions()
    // The killed session may have been the last living occupant of an empty
    // draft issue — reap the vessel so "x" doesn't leak orphaned Drafts.
    this.maybeReapDraftIssue(issueId)
  }

  private spawn(input: {
    agentKind: AgentKind
    cwd: string
    title?: string
    origin: SessionMeta['origin']
    resume?: ResumeRef
    machineId?: string
    initialPrompt?: string
    /** Per-ticket model/effort override; absent = use the settings defaults. */
    model?: string
    effort?: string
    spawnedBy?: string
    issueId?: string
    /** Client-supplied id (optimistic UI); absent = mint one (unchanged default). */
    sessionId?: string
  }): { sessionId: string } {
    // A server-minted uuid was unique by construction; a client-supplied id is
    // not. Reject a collision rather than let `sessions.set` overwrite the live
    // Session (orphaning its PTY/daemon binding) or re-fire a spawn. `withMutation`
    // already dedupes a genuine retry before we get here, so a hit is a real clash.
    if (input.sessionId && this.sessions.has(input.sessionId)) {
      throw new Error(`refusing to reuse an existing session id: ${input.sessionId}`)
    }
    const sessionId = input.sessionId ?? randomUUID()
    const machineId = input.machineId ?? LOCAL_PLACEHOLDER
    const session = new Session({
      sessionId,
      agentKind: input.agentKind,
      cwd: input.cwd,
      title: input.title || basename(input.cwd) || input.cwd,
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
      durableLabel: `podium-${sessionId}`,
      ...(input.resume ? { resume: input.resume } : {}),
      ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
      ...(input.issueId ? { issueId: input.issueId } : {}),
    })
    this.sessions.set(sessionId, session)
    this.persist(session)
    this.toMachine(machineId, {
      type: 'spawn',
      sessionId,
      agentKind: input.agentKind,
      cwd: input.cwd,
      ...(input.resume ? { resume: input.resume } : {}),
      ...(input.initialPrompt ? { initialPrompt: input.initialPrompt } : {}),
      geometry: { ...DEFAULT_GEOMETRY },
      ...this.modelDefaults(
        input.agentKind,
        input.model !== undefined || input.effort !== undefined
          ? { model: input.model, effort: input.effort }
          : undefined,
      ),
    })
    this.broadcastSessions()
    return { sessionId }
  }

  /**
   * Model + effort flags for a spawn message; 'auto' means no override.
   * Shared by every spawn path (fresh spawn AND resurrect) so a resumed session
   * keeps the configured model instead of silently dropping to the CLI default.
   * `override` (from an issue's per-ticket model/effort) wins over the settings
   * defaults — an explicit 'auto' override still means "no flag" (not "fall back
   * to settings"), so an issue snapshots its own choice at create time.
   */
  private modelDefaults(
    agentKind: AgentKind,
    override?: { model?: string; effort?: string },
  ): { model?: string; subagentModel?: string; effort?: string } {
    const coding = this.store.settings.getSettings().roles.coding
    const model = override?.model ?? coding.model
    const effort = override?.effort ?? coding.effort
    const subagentModel = coding.subagentModel
    return {
      ...(model !== 'auto' && agentKind !== 'shell' ? { model } : {}),
      ...(subagentModel !== 'auto' && AGENT_CAPABILITIES[agentKind].subagentModelEnv
        ? { subagentModel }
        : {}),
      // Cursor + shell have no effort flag; agentLaunchCommand also drops it, but
      // gating here keeps the spawn message clean (capability lookup, #158).
      ...(effort !== 'auto' && agentSupportsEffort(agentKind) ? { effort } : {}),
    }
  }

  // ---- ws data plane: clients ----
  attachClient(send: Send<ServerMessage>): string {
    const id = `c${this.nextClientNum++}`
    this.clients.set(id, {
      id,
      send,
      viewport: { ...DEFAULT_GEOMETRY },
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
    for (const [sessionId, text] of this.draftBySession) {
      send({ type: 'sessionDraftChanged', sessionId, text })
    }
    send({
      type: 'conversationsChanged',
      conversations: this.conversations().allConversations(),
      diagnostics: this.conversations().diagnostics(),
    })
    send({ type: 'machinesChanged', machines: this.machines.listMachines() })
    this.hosts.snapshotFor(send)
    return id
  }

  detachClient(id: string): void {
    const client = this.clients.get(id)
    if (!client) return
    for (const sessionId of client.attached) this.sessions.get(sessionId)?.detachClient(id)
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
        client.viewport = { cols: msg.viewport.cols, rows: msg.viewport.rows }
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
        const session = this.sessions.get(msg.sessionId)
        if (!session) return
        client.attached.add(msg.sessionId)
        session.attachClient(client, msg.sinceSeq)
        this.broadcastSessions()
        this.pushPriorities()
        break
      }
      case 'detach':
        client.attached.delete(msg.sessionId)
        this.sessions.get(msg.sessionId)?.detachClient(id)
        this.broadcastSessions()
        this.pushPriorities()
        break
      case 'input':
        this.sessions.get(msg.sessionId)?.handleInput(id, msg.data)
        break
      case 'resize':
        this.sessions.get(msg.sessionId)?.handleResize(id, msg.cols, msg.rows)
        break
      case 'requestControl':
        this.sessions.get(msg.sessionId)?.requestControl(id)
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
          this.sessions.get(sid)?.reconcileGeometry(id)
        }
        this.pushPriorities()
        break
      case 'setSessionDraft':
        this.setSessionDraft(msg, id)
        break
      case 'ping':
        client.send({ type: 'pong' })
        break
    }
  }

  // ---- ws data plane: daemon ----
  /** Inbound daemon message, tagged with the machine it came from. Session-keyed
   *  handlers (bind/agentFrame/agentExit/…) look up by sessionId and are machine-
   *  agnostic; host-scoped ones (hostMetrics, conversation discovery) use machineId
   *  to scope/tag their data; `*Result` replies settle in the RPC module. */
  onDaemonMessageFrom(machineId: string, msg: DaemonMessage): void {
    switch (msg.type) {
      case 'issueRelayRequest': {
        this.deps.runIssueRelay(machineId, msg)
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
        break
      }
      case 'spawnError': {
        this.sessions.get(msg.sessionId)?.markSpawnError(msg.message)
        const s = this.sessions.get(msg.sessionId)
        if (s) this.persist(s)
        this.broadcastSessions()
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
        }
        this.broadcastSessions()
        break
      }
      case 'agentState': {
        const session = this.sessions.get(msg.sessionId)
        if (!session) break
        const prev = session.agentState
        session.setAgentState(msg.state)
        this.autoContinue.onStateChange(msg.sessionId, msg.state)
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
          state: msg.state,
        })
        this.issues().onSessionActivity(msg.sessionId)
        // Synchronous fan-out to bus subscribers (NotifyService) — same ordering
        // as the old direct notifyAttention call.
        this.bus.emit('session.stateChanged', { sessionId: msg.sessionId, prev, next: msg.state })
        if (
          session.snoozedUntil !== undefined &&
          SessionsService.isAttentionPhase(prev) &&
          !SessionsService.isAttentionPhase(msg.state)
        ) {
          this.clearSnooze(msg.sessionId)
        }
        break
      }
      case 'agentColor': {
        const session = this.sessions.get(msg.sessionId)
        if (!session) break
        // Identity colour changes rarely (only on /color), so a full session
        // rebroadcast is fine — no need for a dedicated per-session message.
        if (session.setAgentColor(msg.color)) this.broadcastSessions()
        break
      }
      case 'title': {
        const session = this.sessions.get(msg.sessionId)
        if (!session) break
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
      case 'hostMetrics': {
        const { type: _type, ...rest } = msg
        this.hosts.onHostMetrics(machineId, rest)
        break
      }
      case 'sessionResumeRef': {
        const session = this.sessions.get(msg.sessionId)
        if (!session) break
        if (session.resume?.value !== msg.resume.value) {
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
        // An EXPLICIT declaration (`podium worktree`) also stamps the worktree
        // onto the session's attached issue — but only when that issue doesn't
        // own one yet, and never the repo's primary checkout (an issue must not
        // claim live main just because its agent reported from there).
        if (msg.explicit && msg.cwd && session.issueId) {
          const issue = this.issues().get(session.issueId)
          if (
            issue &&
            !issue.archived &&
            issue.worktreePath === null &&
            issue.repoPath !== msg.cwd
          ) {
            this.issues().update(issue.id, { worktreePath: msg.cwd })
          }
        }
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
          // push the updated meta so clients can offer the chat toggle.
          this.broadcastSessions()
        }
        // Fast title for Claude: until a real title is locked in (its own summary,
        // or this fallback), name the session from the first user prompt so it
        // doesn't sit on the cwd/"Claude Code" placeholder for the long stretch
        // before Claude generates its own title.
        if (session && session.agentKind === 'claude-code' && !session.titleLocked) {
          const firstUser = session
            .transcriptItems()
            .find((it) => it.role === 'user' && it.text.trim().length > 0)
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

  /** Run any coalesced (pending) session broadcast NOW. Test seam + dispose. */
  flushBroadcasts(): void {
    if (this.broadcastCooldown) {
      clearTimeout(this.broadcastCooldown)
      this.broadcastCooldown = null
    }
    if (this.broadcastPending) {
      this.broadcastPending = false
      this.runSessionsBroadcast()
    }
  }

  private runSessionsBroadcast(): void {
    const sessions = this.listSessions()
    // Skip a byte-identical re-broadcast (audit P1-8) — every existing client already
    // holds this exact list, and a new client gets it via attachClient, so re-sending
    // it changes nothing and just burns CPU + bandwidth across all clients.
    const key = JSON.stringify(sessions)
    if (key === this.lastSessionsBroadcast) return
    this.lastSessionsBroadcast = key
    // Enter the write funnel's tail: oplog append FIRST (durable before fan-out,
    // spec §2.5), then the split fan-out — delta-cap clients get only the rows
    // that changed, legacy clients get the full list exactly as before.
    this.funnel.publish(
      'session',
      sessions.map((s) => ({ id: s.sessionId, value: s })),
      { type: 'sessionsChanged', sessions },
    )
    // Session changes also change issues' DERIVED member data (sessions/summary),
    // so keep issue clients live. The publisher builds the payload ONCE (allWire()
    // is O(issues × sessions)); sessionsChanged was already sent above, so even if
    // the issues build fails it can't take the session list down with it.
    this.deps.publishIssues()
  }

  /**
   * The split fan-out (spec §2.3): legacy clients always get the full-list snapshot
   * (exactly the pre-oplog behavior); delta-cap clients get a `metadataDelta` batch,
   * and only when something actually changed.
   */
  fanOutMetadata(
    snapshot: ServerMessage,
    changes: MetadataChange[],
    opts: { snapshotToCapClients?: boolean } = {},
  ): void {
    const last = changes[changes.length - 1]
    const delta: ServerMessage | null = last
      ? { type: 'metadataDelta', seq: last.seq, changes }
      : null
    for (const c of this.clients.values()) {
      if (c.caps.has(CAP_METADATA_DELTA)) {
        if (delta) c.send(delta)
        if (opts.snapshotToCapClients) c.send(snapshot)
      } else {
        c.send(snapshot)
      }
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
      diagnostics: this.conversations().diagnostics(),
      cursor: this.funnel.cursor(),
    }
  }
}
