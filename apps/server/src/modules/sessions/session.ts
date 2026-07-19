import type {
  AgentKind,
  AgentRuntimeState,
  ControlMessage,
  Geometry,
  MetadataChange,
  ResumeRef,
  ServerMessage,
  SessionMeta,
  SessionObservationCheckpointV1,
  SessionOffer,
  SessionOrigin,
  TranscriptItem,
  WorkState,
} from '@podium/protocol'
import { WorkState as WorkStateSchema } from '@podium/protocol'
import { durableSessionLabel } from '@podium/runtime/instance'
import type { SessionRow } from '../../store'
import { perf } from '../perf/registry'

export type Send<T> = (msg: T) => void

export interface PublicationAuthoritySnapshot {
  revision: number
  /** Stable, authority-owned identity for this exact allowed-id set. */
  allowedSignature: string
  /** Immutable for the lifetime of this snapshot. */
  allowedSessionIds: readonly string[]
}

/** Main-authority result used to construct and filter a publication ViewKey. */
export interface PublicationAuthority {
  principal: string
  scope: string
  serverRole: string
  protocolVersion: number
  /** Only a proven global authority may receive unfiltered non-session feeds. */
  global: boolean
  snapshot(): PublicationAuthoritySnapshot
}

export interface ClientPublicationAuthority extends PublicationAuthority {
  sendPrepared: Send<string>
}

export interface ClientConn {
  id: string
  send: Send<ServerMessage>
  publication?: ClientPublicationAuthority
  /** A current worker publication has reached this socket. */
  publicationBootstrapped?: boolean
  publicationPending?: boolean
  publicationRequestVersion?: number
  publicationAccepted?: {
    viewKey: string
    viewRevision: number
    allowedSignature: string
    cursor: number
    allowedSessionIds: readonly string[]
  }
  /** A revocation frame was emitted and must be followed by a replacement. */
  publicationReplacementRequired?: boolean
  /** Previously-visible ids already removed while a replacement is pending. */
  publicationRevokedSessionIds?: Set<string>
  /** Global-only funnel frames held behind an in-flight bootstrap/replacement. */
  publicationBufferedChanges?: MetadataChange[][]
  /** Last grid this client measured for each terminal it mounted. Geometry is
   * session-specific: split panes can have different widths, and the 80x24
   * viewport in `hello` is only a transport bootstrap default. Sharing one
   * viewport across sessions can resize the foreground PTY from another pane. */
  viewports: Map<string, Geometry>
  attached: Set<string>
  /** Feature caps from the client's `hello` (e.g. CAP_METADATA_DELTA). Empty until
   *  hello arrives, so a pre-hello client is treated as legacy — it receives
   *  snapshot broadcasts, never deltas it hasn't asked for. */
  caps: Set<string>
  /** Session ids this client subscribed to the structured transcript of. Lets
   *  detachClient sweep just this client's subscriptions instead of scanning every
   *  session on the host (audit P2-18). */
  transcriptSubs: Set<string>
  /** Page-visibility presence — drives smart notification routing. */
  visible: boolean
  /** Sessions this client currently RENDERS on screen (from viewState). */
  viewVisible: Set<string>
  /** The one session that has input focus on this client, or null. */
  focused: string | null
  /** Per-session rendered mode (native terminal vs chat) this client reports for the
   *  sessions it renders (from viewState `modes`). AVAILABLE for inspection but
   *  deliberately UNUSED by output scheduling — computePriorities never reads it, so
   *  relay/coalescing stays mode-agnostic (the terminal stays warm for native bounce-back). */
  viewModes: Record<string, 'native' | 'chat'>
}

export interface SessionInit {
  sessionId: string
  agentKind: AgentKind
  cwd: string
  title: string
  /** Resolved launch configuration, immutable for this session [spec:SP-dae6]. */
  model?: string
  effort?: string
  accountId?: string
  origin: SessionOrigin
  createdAt: string
  geometry: Geometry
  toDaemon: Send<ControlMessage>
  /** The machine (daemon) this session runs on. Defaults to the placeholder
   *  '__local__' until a real machine adopts it (single-machine boot, pre-pairing). */
  machineId?: string
  resume?: ResumeRef
  durableLabel?: string
  lastActiveAt?: string
  /** Persisted completed working/compacting time; absent for legacy sessions. */
  workingMsTotal?: number
  inputCount?: number
  outputCount?: number
  activityCount?: number
  lastOutputAt?: string | null
  lastInputAt?: string | null
  lastResumedAt?: string | null
  status?: 'starting' | 'live' | 'reconnecting' | 'hibernated' | 'exited'
  exitCode?: number
  name?: string
  /** WHO set `name` (#490): 'user' (sovereign) | 'agent' (self-named). */
  nameSource?: 'user' | 'agent'
  archived?: boolean
  workState?: WorkState
  /** WHO created this session (provenance, issue #60): 'user', 'issue:<id>',
   *  'superagent:<threadId>', … Absent = unknown (legacy row). */
  spawnedBy?: string
  /** True for a headless harness session (no PTY; concierge unification). */
  headless?: boolean
  /** Explicit issue attachment (issue-as-workspace). Absent = unattached. */
  issueId?: string
  /** Birth-issue nice-name fields (#474). Absent = not yet named. */
  refIssueId?: string | null
  refLetter?: string | null
  refDraft?: number | null
  /** OPTIONAL workflow pass-through metadata (#285 via #237 [spec:SP-34d7
   *  cross-harness]): stamped at spawn, never interpreted here. */
  workflowRunId?: string
  workflowStepId?: string
  executionProfileId?: string
  /** Email-style read state (issue #124): ISO time the operator last opened this
   *  session. Absent/null = never opened (unread). */
  readAt?: string | null
  stoppedAt?: string | null
  stopReason?: 'self' | 'parent' | 'forced' | 'exited' | null
  /** Called when a meta field changes outside the normal control flow (the
   *  debounced shell `busy` flag) so the registry can rebroadcast the session list. */
  onActivity?: () => void
}

// Replay-on-attach: keep a bounded buffer of recent agent output so a freshly attached
// or re-mounted client reconstructs the screen instead of starting blank. Redraw (a
// SIGWINCH nudge) covers alt-screen TUIs that fully repaint; this covers normal-buffer
// apps (shells, Ink) whose scrollback a redraw cannot recreate. Reset on a screen clear
// or alt-screen transition keeps the buffer small and aligned to the current screen.
const MAX_REPLAY_BYTES = 256 * 1024
// Bounded recent-delta cache per session — the live window a late subscriber gets
// to bridge the gap between its last on-disk read and the live tail. It is NOT the
// source of truth (disk is): the chat view reads its history off disk via
// sessions.transcriptRead, and this cache only carries forward items streamed since.
// Generous on purpose so a freshly-subscribing client usually catches up whole, but
// still bounded (each item is small; ~12k is a few MB per live session). Items older
// than this window fall off — the client already has them from its disk read. Kept in
// step with the tailer's MAX_INITIAL_ITEMS so a reattach delta and the cache match.
const MAX_TRANSCRIPT_ITEMS = 12_000
// How long after the last output frame a running shell command still reads as
// "busy". A command keeps resetting it; once output goes quiet for this long the
// shell is back at its prompt (idle). Long enough to bridge the gaps between a
// command's output bursts.
const SHELL_BUSY_WINDOW_MS = 4000

/** Did a controller keystroke chunk (base64) submit a line — i.e. press Enter?
 *  CR/LF is the one signal that a shell *command was actually run*, as opposed to
 *  the prompt being drawn or keystrokes echoing. Gating busy on this is why a
 *  freshly-opened or sit-at-the-prompt shell reads idle instead of active. */
function submitsCommandLine(base64: string): boolean {
  const bytes = Buffer.from(base64, 'base64')
  return bytes.includes(0x0d) || bytes.includes(0x0a)
}
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
const SCREEN_RESET = /\x1b\[[23]J|\x1bc|\x1b\[\?1049[hl]/

/** One agent's relay state: controller gating, geometry/epoch, and its attached clients. */
export type SessionVolatileField = 'geometry' | 'status' | 'machineId' | 'handoffTarget'

export interface SessionDurableState {
  cwd: string
  issueId: string | undefined
  refIssueId: string | null
  refLetter: string | null
  refDraft: number | null
  machineId: string
  resume: ResumeRef | undefined
  lastActiveAt: string
  title: string
  titleLocked: boolean
  name: string
  nameSource: 'user' | 'agent' | undefined
  archived: boolean
  readAt: string | null
  stoppedAt: string | undefined
  stopReason: 'self' | 'parent' | 'forced' | 'exited' | undefined
  workState: WorkState | undefined
  cmd: string
  status: 'starting' | 'live' | 'reconnecting' | 'hibernated' | 'exited'
  exitCode: number | undefined
  agentState: AgentRuntimeState | undefined
  workingMsTotal: number | undefined
  incomingWorkingMsTotal: number | undefined
  agentColor: string | undefined
  snoozedUntil: string | null | undefined
  queuedMessageCount: number
  handoffTarget: string | undefined
  conversationPodiumId: string | undefined
  draftUpdatedAt: string | undefined
  offer: SessionOffer | undefined
  transcriptAvailable: boolean
  geometry: Geometry
  outputAtMs: number
  inputAtMs: number
  resumedAtMs: number
  inputCount: number
  outputCount: number
  activityCount: number
  activityDirty: boolean
  shellBusy: boolean
  shellCommandRunning: boolean
}

export class Session {
  readonly sessionId: string
  readonly agentKind: AgentKind
  // Mutable: an agent can move into a worktree mid-session (EnterWorktree / cd),
  // reported via the hook payload's cwd; the relay restamps this so the sidebar
  // re-groups the session under the directory it actually moved into.
  cwd: string
  readonly origin: SessionOrigin
  readonly createdAt: string
  readonly durableLabel: string
  /** Creation provenance (issue #60) — immutable for the life of the row. */
  readonly spawnedBy: string | undefined
  /** Actual launch configuration captured once at spawn [spec:SP-dae6]. */
  readonly model: string | undefined
  readonly effort: string | undefined
  readonly accountId: string | undefined
  /** Workflow pass-through metadata (#285) — immutable, uninterpreted. */
  readonly workflowRunId: string | undefined
  readonly workflowStepId: string | undefined
  readonly executionProfileId: string | undefined
  /** True for a headless harness session (no PTY) — immutable for the row's life. */
  readonly headless: boolean
  /** Explicit issue attachment (issue-as-workspace) — mutable: the agent can
   *  re-home itself (attach) and the user can move a session between issues. */
  issueId: string | undefined
  /** BIRTH issue for the permanent human-facing nice name (#474). Set once at
   *  naming time; never changes on re-attach. */
  refIssueId: string | null
  /** Column letter within refIssueId (`POD-13-A`). */
  refLetter: string | null
  /** Per-repo DRAFT ordinal for a truly issueless session (`POD-DRAFT-3`). */
  refDraft: number | null
  /** The machine (daemon) this session runs on. The registry routes this
   *  session's control messages to it; '__local__' until a real machine adopts
   *  it (see SessionRegistry.ensureLocalMachine), so it is reassignable, not readonly. */
  machineId: string
  /** How to bring this session back after its process is gone (hibernate→resume).
   *  Set at spawn for resumes; learned later from the daemon for fresh spawns. */
  resume?: ResumeRef
  lastActiveAt: string
  title: string
  /** Live heuristic (not persisted): a real title — the agent's own summary, or
   *  the first-prompt fallback — has been set, so the generic "Claude Code"
   *  placeholder must not overwrite it and the fallback shouldn't re-fire. */
  titleLocked = false
  /** Curated name; empty = fall back to the live title. */
  name = ''
  /** WHO set `name` (#490). 'user' is sovereign: an agent title is REFUSED against
   *  it, so a hand-picked name is never silently overwritten. 'agent' = the session
   *  named itself and may re-title itself. undefined = nobody named it yet. */
  nameSource: 'user' | 'agent' | undefined = undefined
  archived = false
  /** Email-style read state (issue #124): ISO time the operator last opened this
   *  session; null = never opened. Persisted via toRow() (read_at column). */
  readAt: string | null = null
  /** Set only by the explicit stop lifecycle, not ordinary hibernation/exits. [spec:SP-6144] */
  stoppedAt: string | undefined
  stopReason: 'self' | 'parent' | 'forced' | 'exited' | undefined
  workState: WorkState | undefined
  cmd = ''
  status: 'starting' | 'live' | 'reconnecting' | 'hibernated' | 'exited' = 'starting'
  exitCode: number | undefined
  agentState: AgentRuntimeState | undefined
  private workingMsTotal: number | undefined
  private incomingWorkingMsTotal: number | undefined
  /** The agent's `/color` identity accent (a named colour), learned from the
   *  transcript tail. Undefined = no colour (incl. Claude's 'default'/reset). */
  agentColor: string | undefined
  /** Snooze deadline — orthogonal to agentState. undefined = not snoozed; null =
   *  until next message; ISO string = timed. Lives in its own `snoozes` table, so
   *  it is NOT part of toRow(); the registry seeds it at load and on mutation. */
  snoozedUntil: string | null | undefined = undefined
  /** Count of durable queued messages awaiting delivery (queued_messages table).
   *  Transient mirror maintained by the registry (enqueue/deliver/boot) — the
   *  table is the truth; this exists so toMeta() stays synchronous. */
  queuedMessageCount = 0
  /** Transient UI overlay while the canonical row moves machines ([spec:SP-3f7a]). */
  handoffTarget: string | undefined
  /** Stable Podium conversation identity (conversation registry). Stamped by the
   *  registry when the linkage is learned (resume ref observed/rolled, boot
   *  lookup); transient here — the conversation_segments table is the truth. */
  conversationPodiumId: string | undefined = undefined
  /** Last-edit time of a non-empty unsent composer draft (undefined = no draft).
   *  Lives in its own `session_drafts` table (not toRow()); the registry seeds it
   *  at load and on every setSessionDraft. Surfaced so the client can show DRAFT
   *  and lift the session in NEEDS YOUR ATTENTION by when its prompt was edited. */
  draftUpdatedAt: string | undefined = undefined
  /** Draft Sync v2 (POD-859): true when this session's daemon runs the composer
   *  scrape/inject engine (reported on bind). Transient — not persisted; re-set on
   *  every (re)bind. Surfaced in toMeta so a client retires its own sampler/flush. */
  draftSyncEngine = false
  /** Agent action offer [spec:SP-c7f1] — a freeform message + action buttons the
   *  agent offers the user as next steps. Lives in its own `offers` table (not
   *  toRow()); the registry seeds it at load and on set/clear. undefined = none.
   *  Cleared on the next user-submitted turn (a button click counts). */
  offer: SessionOffer | undefined = undefined
  /** True once a structured transcript has been seen — drives chat capability. */
  transcriptAvailable = false
  geometry: Geometry
  epoch = 0
  controllerId: string | null = null
  // Wall-clock ms of the last output frame (0 = none yet). Drives the "is a
  // process producing output" signal — the shell busy flag and the hibernation
  // guard that keeps a session with a running background agent awake.
  private outputAtMs = 0
  private inputAtMs = 0
  private resumedAtMs = 0
  private inputCount_ = 0
  private outputCount_ = 0
  private activityCount_ = 0
  // Set when any of the three counters above advances; the registry's periodic
  // flush persists dirty sessions and clears this. Keeps the hot path off the DB.
  private activityDirty_ = false
  // Debounced "writing to the PTY right now" flag, maintained for shells only —
  // their activity signal, since they have no harness instrumentation.
  private shellBusy = false
  private shellBusyTimer: ReturnType<typeof setTimeout> | undefined
  // A shell command is "running" from when the controller submits a line (Enter)
  // until its output goes quiet — NOT while the shell merely draws its prompt or
  // echoes typed characters. Output frames only count toward `busy` while this is
  // set, so opening a shell (which draws a prompt) no longer reads as active.
  private shellCommandRunning = false
  private readonly onActivity: (() => void) | undefined
  // Server-assigned, monotonic per-session output sequence. The PTY bridge's own
  // seq resets to 0 on every daemon reattach, so it cannot be a stable client
  // cursor; the server owns the numbering instead. It survives daemon restarts
  // (the Session object outlives the bridge) and only resets on a server restart.
  // A stale-high browser cursor identifies that generation reset in attachClient.
  private nextSeq = 0
  private readonly toDaemon: Send<ControlMessage>
  private readonly clients = new Map<string, ClientConn>()
  // Recent agent output (base64 frames) for replay-on-attach; bounded by MAX_REPLAY_BYTES.
  private readonly outputLog: { seq: number; data: string }[] = []
  private outputLogBytes = 0
  // Bounded recent-delta cache (chat view) + which clients want its stream.
  // Holds the connection (not just the id): a chat-only client subscribes
  // without ever attaching to the PTY. This is a gap-bridging window, not the
  // transcript source of truth — disk is.
  private transcript: TranscriptItem[] = []
  private readonly transcriptSubscribers = new Map<string, ClientConn>()

  constructor(init: SessionInit) {
    this.sessionId = init.sessionId
    this.agentKind = init.agentKind
    this.cwd = init.cwd
    this.title = init.title
    this.origin = init.origin
    this.createdAt = init.createdAt
    this.spawnedBy = init.spawnedBy
    this.model = init.model
    this.effort = init.effort
    this.accountId = init.accountId
    this.workflowRunId = init.workflowRunId
    this.workflowStepId = init.workflowStepId
    this.executionProfileId = init.executionProfileId
    this.headless = init.headless ?? false
    this.issueId = init.issueId
    this.refIssueId = init.refIssueId ?? null
    this.refLetter = init.refLetter ?? null
    this.refDraft = init.refDraft ?? null
    this.geometry = { ...init.geometry }
    this.toDaemon = init.toDaemon
    this.machineId = init.machineId ?? '__local__'
    this.durableLabel = init.durableLabel ?? durableSessionLabel(init.sessionId)
    this.resume = init.resume
    this.lastActiveAt = init.lastActiveAt ?? init.createdAt
    this.workingMsTotal = init.workingMsTotal
    // A malformed stored ISO string parses to NaN, and Math.max(..., NaN) is NaN —
    // which makes the session never hibernation-eligible (stuck awake forever). Fall
    // back to 0 so a bad value behaves like "no activity yet".
    const seedMs = (iso: string | null | undefined): number => {
      const ms = iso ? Date.parse(iso) : 0
      return Number.isNaN(ms) ? 0 : ms
    }
    this.outputAtMs = seedMs(init.lastOutputAt)
    this.inputAtMs = seedMs(init.lastInputAt)
    this.resumedAtMs = seedMs(init.lastResumedAt)
    this.inputCount_ = init.inputCount ?? 0
    this.outputCount_ = init.outputCount ?? 0
    this.activityCount_ = init.activityCount ?? 0
    if (init.status) this.status = init.status
    if (init.exitCode !== undefined) this.exitCode = init.exitCode
    if (init.name) this.name = init.name
    if (init.nameSource) this.nameSource = init.nameSource
    if (init.archived) this.archived = init.archived
    if (init.readAt != null) this.readAt = init.readAt
    this.stoppedAt = init.stoppedAt ?? undefined
    this.stopReason = init.stopReason ?? undefined
    if (init.workState) this.workState = init.workState
    this.onActivity = init.onActivity
  }

  get clientCount(): number {
    return this.clients.size
  }

  /** Epoch ms of the last PTY output frame (0 = none). */
  get lastOutputAtMs(): number {
    return this.outputAtMs
  }
  /** Epoch ms of the last controller input — any keys/mouse/paste (0 = none). */
  get lastInputAtMs(): number {
    return this.inputAtMs
  }
  /** Epoch ms of the last resume/resurrect (0 = never). */
  get lastResumedAtMs(): number {
    return this.resumedAtMs
  }
  get inputCount(): number {
    return this.inputCount_
  }
  get outputCount(): number {
    return this.outputCount_
  }
  get activityCount(): number {
    return this.activityCount_
  }
  get activityDirty(): boolean {
    return this.activityDirty_
  }

  clearActivityDirty(): void {
    this.activityDirty_ = false
  }

  /**
   * Mark the session as just resumed/resurrected. Resets the hibernation idle
   * timer (the eligibility check maxes this with lastActiveAt) WITHOUT touching
   * lastActiveAt, which is authoritative for recency ordering.
   */
  markResumed(): void {
    this.stoppedAt = undefined
    this.stopReason = undefined
    this.resumedAtMs = Date.now()
    this.activityCount_ += 1
    this.activityDirty_ = true
  }

  attachClient(client: ClientConn, sinceSeq?: number): void {
    this.clients.set(client.id, client)
    // First attacher takes the controller role. A non-rendering controller is
    // harmless: the size operations are independently gated on per-session
    // viewState (handleResize / requestControl below), so it can't move the PTY
    // off a stale grid until it actually renders the session.
    if (this.controllerId === null) this.controllerId = client.id
    // Resume vs full replay. On a reconnect the client passes the last seq it
    // rendered; if that point is still inside our bounded buffer, replay only the
    // frames it missed and flag the attach `resumed` so it appends to the screen it
    // kept (no flicker). A fresh mount (no sinceSeq) or a gap larger than the buffer
    // falls back to a full replay, which the client clears the screen for. The
    // `oldest - 1` floor lets a client that was exactly caught up resume with zero
    // frames instead of needlessly wiping. A restarted server has an empty log or
    // a new low sequence generation; a stale-high cursor in those cases keeps the
    // browser's surviving xterm intact and appends every new-generation frame
    // instead of clearing it [spec:SP-1a0b].
    const oldest = this.outputLog[0]?.seq
    const newest = this.outputLog.at(-1)?.seq
    let frames = this.outputLog
    let resumed = false
    if (sinceSeq !== undefined) {
      if (oldest === undefined || newest === undefined) {
        resumed = true
        frames = []
      } else if (sinceSeq > newest) {
        resumed = true
        frames = this.outputLog
      } else if (sinceSeq >= oldest - 1) {
        resumed = true
        frames = this.outputLog.filter((f) => f.seq > sinceSeq)
      }
    }
    client.send({
      type: 'attached',
      sessionId: this.sessionId,
      controllerId: this.controllerId,
      geometry: { ...this.geometry },
      epoch: this.epoch,
      resumed,
    })
    // Replay timing [POD-701]: how long the buffered-output catch-up took and
    // how many payload chars it pushed (string length ≈ bytes).
    const t0 = performance.now()
    let replayBytes = 0
    for (const f of frames) {
      replayBytes += f.data.length
      client.send({
        type: 'outputFrame',
        sessionId: this.sessionId,
        seq: f.seq,
        epoch: this.epoch,
        data: f.data,
      })
    }
    perf.record('phase', 'attach.replay', performance.now() - t0, replayBytes)
  }

  /**
   * Hand the controller role from a stale (dropped/half-open) client to its
   * reconnected self. Called during reconnect reclaim BEFORE the old client is
   * evicted, so a blip doesn't demote the user to a muted spectator of their own
   * session. No-op when the stale client wasn't the controller.
   */
  reassignController(fromId: string, toId: string): void {
    if (this.controllerId === fromId) this.controllerId = toId
  }

  /**
   * Subscribe a client to the live transcript stream and replay the recent-delta
   * cache so it bridges the gap between the client's last on-disk read and the live
   * tail. The client already loaded its history off disk (sessions.transcriptRead);
   * `since` is the cursor of the newest item it holds, so we replay only the cached
   * items AFTER it. If `since` isn't in the cache (the client read an older cursor,
   * or the cache rolled past it) we replay the WHOLE cache and let the client's
   * cursor-dedup drop overlaps — better an overlap than a gap. No reset: the client
   * keeps its read history. An empty replay sends nothing.
   */
  subscribeTranscript(client: ClientConn, since?: string): void {
    this.transcriptSubscribers.set(client.id, client)
    let replay = this.transcript
    if (since !== undefined) {
      const idx = this.transcript.findIndex((it) => it.cursor === since)
      // Found `since` in the cache → replay strictly after it. Not found → replay all.
      replay = idx >= 0 ? this.transcript.slice(idx + 1) : this.transcript
    }
    if (replay.length > 0) {
      client.send({ type: 'transcriptDelta', sessionId: this.sessionId, items: replay })
    }
  }

  unsubscribeTranscript(clientId: string): void {
    this.transcriptSubscribers.delete(clientId)
  }

  /** The cached recent transcript items (superagent + first-prompt title read this). */
  transcriptItems(): TranscriptItem[] {
    return this.transcript
  }

  /** Daemon pushed parsed transcript items (a live delta); update the bounded cache
   *  and fan out to subscribers as a transcriptDelta. `reset` (tailer switched files)
   *  clears the cache first; `tail` is the cursor of the last item, forwarded so a
   *  subscriber can resume from it. Returns true the first time a transcript is
   *  observed (the chat-capability transition), so the registry can broadcast meta. */
  applyDelta(items: TranscriptItem[], opts: { reset?: boolean; tail?: string }): boolean {
    const becameAvailable =
      !this.transcriptAvailable && (items.length > 0 || this.transcript.length > 0)
    if (becameAvailable) this.transcriptAvailable = true
    if (opts.reset) this.transcript = []
    this.transcript = this.transcript.concat(items)
    if (this.transcript.length > MAX_TRANSCRIPT_ITEMS) {
      this.transcript = this.transcript.slice(-MAX_TRANSCRIPT_ITEMS)
    }
    const delta: ServerMessage = {
      type: 'transcriptDelta',
      sessionId: this.sessionId,
      items,
      ...(opts.tail !== undefined ? { tail: opts.tail } : {}),
      ...(opts.reset ? { reset: true } : {}),
    }
    for (const client of this.transcriptSubscribers.values()) client.send(delta)
    return becameAvailable
  }

  detachClient(clientId: string): void {
    const client = this.clients.get(clientId)
    client?.viewports.delete(this.sessionId)
    this.clients.delete(clientId)
    this.transcriptSubscribers.delete(clientId)
    if (this.controllerId === clientId) {
      // Hand the role to any remaining client (or null when none are left). A
      // non-rendering inheritor is harmless — the size operations are gated on
      // per-session viewState, so geometry stays put until it renders the session.
      this.controllerId = this.clients.keys().next().value ?? null
      if (this.controllerId !== null) {
        this.broadcast({
          type: 'controllerChanged',
          sessionId: this.sessionId,
          controllerId: this.controllerId,
          geometry: { ...this.geometry },
        })
      }
    }
  }

  detachAll(): void {
    for (const client of this.clients.values()) client.viewports.delete(this.sessionId)
    this.clients.clear()
    this.controllerId = null
  }

  handleInput(clientId: string, data: string): void {
    if (clientId === this.controllerId) {
      // Submitting a line at a shell prompt is what starts a command running —
      // mark busy now (before any output) and let onFrame keep it lit while the
      // command produces output. Prompt-draw and bare keystrokes never reach here
      // as a CR/LF, so they no longer flip the shell to active.
      if (this.agentKind === 'shell' && submitsCommandLine(data)) {
        this.shellCommandRunning = true
        this.markShellBusy()
      }
      this.recordInputActivity()
      this.toDaemon({ type: 'input', sessionId: this.sessionId, data, inputOrigin: 'human' })
    }
  }

  /** Every server-authorized PTY input path calls this before enqueueing bytes. */
  recordInputActivity(at = Date.now()): void {
    this.inputAtMs = at
    this.inputCount_ += 1
    this.activityCount_ += 1
    this.activityDirty_ = true
  }

  /** Count one accepted live provider observation; bootstrap/replay never call this. */
  recordObservationActivity(): void {
    this.activityCount_ += 1
    this.activityDirty_ = true
  }

  handleResize(clientId: string, cols: number, rows: number): void {
    const client = this.clients.get(clientId)
    if (client) client.viewports.set(this.sessionId, { cols, rows })
    // Only apply a resize from a client that is actually RENDERING this session on
    // screen (per-session viewState). A backgrounded tab/page reports an empty
    // viewVisible, so its stale grid can never move the shared PTY.
    if (clientId === this.controllerId && client?.viewVisible.has(this.sessionId)) {
      this.setGeometry(cols, rows)
      this.toDaemon({ type: 'resize', sessionId: this.sessionId, cols, rows })
      // Tell every client the new authoritative size. Without this broadcast a
      // client only has its own optimistic sendResize value, which requestControl's
      // (stale) geometry broadcast clobbers back to the old grid — leaving the xterm
      // snapped to 80x24 by onState even though the PTY was resized (quarter-size).
      this.broadcast({ type: 'geometry', sessionId: this.sessionId, cols, rows })
    }
  }

  /**
   * Re-apply the controller's last-known viewport if it now renders this session.
   * A foreground resize can reach {@link handleResize} BEFORE the client's
   * viewState message lands — the panel's React effect sends the resize before the
   * store's (ancestor) effect sends viewState, so child-before-parent effect order
   * puts the resize first and the viewVisible gate drops it. Calling this when a
   * viewState marks the session visible heals that dropped resize; without it the
   * PTY stays stuck at the 80x24 default (the "quarter-size window" bug). No-op when
   * the client isn't the controller, isn't rendering the session, or already matches.
   */
  reconcileGeometry(clientId: string): void {
    const client = this.clients.get(clientId)
    if (!client) return
    if (clientId !== this.controllerId || !client.viewVisible.has(this.sessionId)) return
    // Only an explicit resize for THIS session can heal the resize/viewState
    // race. A hello/default viewport or another pane's last resize must not.
    const viewport = client.viewports.get(this.sessionId)
    if (!viewport) return
    if (this.geometry.cols === viewport.cols && this.geometry.rows === viewport.rows) {
      return
    }
    this.setGeometry(viewport.cols, viewport.rows)
    this.toDaemon({
      type: 'resize',
      sessionId: this.sessionId,
      cols: this.geometry.cols,
      rows: this.geometry.rows,
    })
    this.broadcast({
      type: 'geometry',
      sessionId: this.sessionId,
      cols: this.geometry.cols,
      rows: this.geometry.rows,
    })
  }

  requestControl(clientId: string): void {
    const client = this.clients.get(clientId)
    if (!client) return
    // Re-claiming control you already hold is a no-op. Bumping the epoch here would make
    // every client treat it as a takeover and view.clear() the screen — so a client that
    // re-requests control on every reveal (becomeEligible on a tab switch / page refocus,
    // where it's usually already the controller) would BLANK the terminal on each switch:
    // a shell loses its scrollback, an alt-screen app flashes black until the agent
    // redraws. Only a genuine controller CHANGE bumps the epoch.
    if (this.controllerId === clientId) return
    this.controllerId = clientId
    this.epoch += 1
    // Only snap geometry to the requester's viewport + resize the agent if the
    // requester is actually rendering this session (per-session viewState). If not
    // (e.g. a viewState update hasn't landed yet), transfer control without sizing;
    // {@link reconcileGeometry} re-applies it when viewState lands (the panel's fit
    // may also re-drive it through handleResize once viewVisible is populated).
    const viewport = client.viewports.get(this.sessionId)
    if (client.viewVisible.has(this.sessionId) && viewport) {
      this.setGeometry(viewport.cols, viewport.rows)
      this.toDaemon({
        type: 'resize',
        sessionId: this.sessionId,
        cols: this.geometry.cols,
        rows: this.geometry.rows,
      })
      this.toDaemon({ type: 'redraw', sessionId: this.sessionId })
    }
    this.broadcast({
      type: 'controllerChanged',
      sessionId: this.sessionId,
      controllerId: clientId,
      geometry: { ...this.geometry },
    })
    this.broadcast({
      type: 'geometry',
      sessionId: this.sessionId,
      cols: this.geometry.cols,
      rows: this.geometry.rows,
    })
  }

  redraw(): void {
    this.toDaemon({ type: 'redraw', sessionId: this.sessionId })
  }

  onFrame(data: string): void {
    const seq = this.nextSeq++
    this.bufferFrame(seq, data)
    this.broadcast({ type: 'outputFrame', sessionId: this.sessionId, seq, epoch: this.epoch, data })
    this.outputAtMs = Date.now()
    this.outputCount_ += 1
    this.activityDirty_ = true
    // Shells have no harness instrumentation, so output is our only progress
    // signal — but only *after* a command was submitted. Output that arrives
    // while no command is running (the prompt redrawing, keystroke echo) must not
    // light the shell up; that's the "active on open" bug. A running command's
    // output keeps resetting the decay window below.
    if (this.agentKind === 'shell' && this.shellCommandRunning) this.markShellBusy()
  }

  private markShellBusy(): void {
    // A shell has no harness instrumentation, so a running command's output (and the
    // Enter that started it) is its only activity signal — the event-time IS now (the
    // frame just arrived). This is what lets shells participate in recency ordering
    // instead of being frozen at spawn/bind time. Reattach produces no input/output
    // unless a command is genuinely still running, so it can't restamp a quiet shell.
    this.lastActiveAt = new Date().toISOString()
    if (!this.shellBusy) {
      this.shellBusy = true
      this.onActivity?.()
    }
    if (this.shellBusyTimer) clearTimeout(this.shellBusyTimer)
    this.shellBusyTimer = setTimeout(() => {
      // Output went quiet — the command finished and the shell is back at its
      // prompt. Clear both flags so the next prompt-draw/echo stays idle until
      // another line is submitted.
      this.shellBusy = false
      this.shellCommandRunning = false
      this.onActivity?.()
    }, SHELL_BUSY_WINDOW_MS)
    this.shellBusyTimer.unref?.()
  }

  private bufferFrame(seq: number, data: string): void {
    // A screen clear / alt-screen switch makes prior frames irrelevant: drop them so the
    // buffer stays aligned to the current screen (and bounded for full-screen TUIs).
    if (SCREEN_RESET.test(Buffer.from(data, 'base64').toString('latin1'))) {
      this.outputLog.length = 0
      this.outputLogBytes = 0
    }
    this.outputLog.push({ seq, data })
    this.outputLogBytes += data.length
    while (this.outputLogBytes > MAX_REPLAY_BYTES && this.outputLog.length > 1) {
      const dropped = this.outputLog.shift()
      if (dropped) this.outputLogBytes -= dropped.data.length
    }
  }

  onExit(code: number): void {
    // The PTY is gone — no more output, so it can't be "busy".
    if (this.shellBusyTimer) clearTimeout(this.shellBusyTimer)
    this.shellBusy = false
    this.shellCommandRunning = false
    // A hibernated session's process exit is the *expected* result of the
    // hibernate kill — don't let it overwrite the hibernated state.
    if (this.status === 'hibernated') return
    this.status = 'exited'
    this.exitCode = code
    // EVERY terminal transition stamps stop metadata and re-arms unread — a
    // daemon-observed death decays (and badges) exactly like an explicit stop.
    // The explicit-stop path may already have stamped a richer reason; keep it.
    // [spec:SP-6144]
    this.stoppedAt ??= new Date().toISOString()
    this.stopReason ??= 'exited'
    this.readAt = null
    // Preserve the final turn diagnosis; lifecycle status owns liveness while
    // the causal checkpoint remains inspectable [spec:SP-cdb2].
    this.broadcast({ type: 'agentExit', sessionId: this.sessionId, code })
  }

  /** A spawn that never started — surface as an exit so attached clients stop waiting. */
  markSpawnError(message: string): void {
    this.status = 'exited'
    this.exitCode = -1
    this.agentState = undefined
    // Terminal transition — same stop metadata as onExit [spec:SP-6144].
    this.stoppedAt ??= new Date().toISOString()
    this.stopReason ??= 'exited'
    this.readAt = null
    console.warn(`[podium] spawn failed for ${this.sessionId}: ${message}`)
    this.broadcast({ type: 'agentExit', sessionId: this.sessionId, code: -1 })
  }

  /** Adopt a live terminal title the agent set (OSC). Replaces the cwd-derived default. */
  /** Harness-observed runtime state (hooks-driven). The cumulative compute base is persisted. */
  applyObservationCheckpoint(checkpoint: SessionObservationCheckpointV1): void {
    const state = checkpoint.turnState
    this.workingMsTotal = state.workingMsTotal
    this.incomingWorkingMsTotal = undefined
    this.agentState = state
    const providerAt = checkpoint.providerAt
    if (providerAt && providerAt > this.lastActiveAt) this.lastActiveAt = providerAt
  }

  /**
   * Legacy unfenced state path. Kept during mixed deployment only; causal v1
   * sessions bypass its daemon-counter reset heuristic.
   */
  setAgentState(state: AgentRuntimeState): void {
    // The daemon reducer's total restarts at zero with each tracker. Persist only
    // positive deltas within one tracker epoch on top of our durable total; a
    // lower/reset incoming value becomes the next epoch's baseline.
    const incomingTotal = state.workingMsTotal
    if (incomingTotal !== undefined) {
      if (this.workingMsTotal === undefined) {
        this.workingMsTotal = incomingTotal
      } else if (
        this.incomingWorkingMsTotal !== undefined &&
        incomingTotal >= this.incomingWorkingMsTotal
      ) {
        this.workingMsTotal += incomingTotal - this.incomingWorkingMsTotal
      }
      this.incomingWorkingMsTotal = incomingTotal
    }
    this.agentState =
      this.workingMsTotal === undefined ? state : { ...state, workingMsTotal: this.workingMsTotal }
    // Recency = the phase event-time (state.since), which is the real source-record
    // time (transcript timestamp), never "now" — but MONOTONIC: a boot re-seed that
    // read the wrong transcript (a subagent jsonl registered under the parent's
    // native id, issue #94) carries a stale event-time; an authoritative set let it
    // sink the session below genuinely-older ones and every reattach re-asserted
    // it. The old stale-HIGH poisoning this could correct (mtime-derived stamps) is
    // gone since seeds stamp the last DATED record, so regression buys nothing.
    if (state.since > this.lastActiveAt) this.lastActiveAt = state.since
  }

  /** Adopt a `/color` value from the transcript. Treats Claude's "no colour"
   *  spellings as cleared. Returns true when it actually changed (so the caller
   *  can skip a redundant broadcast). */
  setAgentColor(color: string): boolean {
    const lower = color.trim().toLowerCase()
    const next = Session.NO_COLOR.has(lower) ? undefined : lower
    if (next === this.agentColor) return false
    this.agentColor = next
    return true
  }

  /** Un-snooze. Returns true if it actually changed (lets the caller skip a
   *  redundant broadcast). */
  clearSnooze(): boolean {
    if (this.snoozedUntil === undefined) return false
    this.snoozedUntil = undefined
    return true
  }

  /** Clear the agent action offer [spec:SP-c7f1]. Returns true if it actually
   *  changed (lets the caller skip a redundant broadcast/persist). */
  clearOffer(): boolean {
    if (this.offer === undefined) return false
    this.offer = undefined
    return true
  }

  private static readonly NO_COLOR = new Set(['default', 'none', 'reset', 'gray', 'grey'])

  setTitle(title: string): void {
    // A title change is not activity (spinner frames are filtered upstream, but even
    // a stable rename isn't the agent doing work) — it must not move recency. Agent
    // activity flows through setAgentState; shells through the busy path.
    this.title = title
  }

  markLive(cmd: string, geometry: Geometry): void {
    // Reattaching to a surviving PTY is NOT activity — it must not restamp recency
    // (that reshuffled the whole ordering on every daemon redeploy). The persisted
    // lastActiveAt is authoritative; genuine activity (agentState/output) advances it.
    this.cmd = cmd
    // 'exited' is included on purpose: a reattach only produces a bind when the
    // daemon found the durable master alive. That means the row was wrongly
    // marked exited — its attach client died on a daemon restart while the agent
    // survived in its scope. The live master is authoritative, so clear the stale
    // exit and bring the session back.
    if (this.status === 'starting' || this.status === 'reconnecting' || this.status === 'exited') {
      this.status = 'live'
      this.exitCode = undefined
    }
    // Adopt the daemon's geometry only if no controller has resized us yet.
    if (this.controllerId === null) this.setGeometry(geometry.cols, geometry.rows)
  }

  /**
   * The daemon holding this session's PTY bridge went away (daemon restart/crash —
   * the durable master survives in its own scope). Drop a live/starting session to
   * 'reconnecting' so the next daemon to attach re-binds it (markLive brings it back
   * on the resulting bind). Returns true if the status changed.
   */
  markReconnecting(): boolean {
    if (this.status === 'live' || this.status === 'starting') {
      this.status = 'reconnecting'
      return true
    }
    return false
  }

  /** Snapshot of all non-connection state represented by a successful session
   * ledger capture. Used to roll live truth back when a durable append fails. */
  captureDurableState(): SessionDurableState {
    return {
      cwd: this.cwd,
      issueId: this.issueId,
      refIssueId: this.refIssueId,
      refLetter: this.refLetter,
      refDraft: this.refDraft,
      machineId: this.machineId,
      resume: this.resume ? { ...this.resume } : undefined,
      lastActiveAt: this.lastActiveAt,
      title: this.title,
      titleLocked: this.titleLocked,
      name: this.name,
      nameSource: this.nameSource,
      archived: this.archived,
      readAt: this.readAt,
      stoppedAt: this.stoppedAt,
      stopReason: this.stopReason,
      workState: this.workState,
      cmd: this.cmd,
      status: this.status,
      exitCode: this.exitCode,
      agentState: this.agentState ? structuredClone(this.agentState) : undefined,
      workingMsTotal: this.workingMsTotal,
      incomingWorkingMsTotal: this.incomingWorkingMsTotal,
      agentColor: this.agentColor,
      snoozedUntil: this.snoozedUntil,
      queuedMessageCount: this.queuedMessageCount,
      handoffTarget: this.handoffTarget,
      conversationPodiumId: this.conversationPodiumId,
      draftUpdatedAt: this.draftUpdatedAt,
      offer: this.offer ? structuredClone(this.offer) : undefined,
      transcriptAvailable: this.transcriptAvailable,
      geometry: { ...this.geometry },
      outputAtMs: this.outputAtMs,
      inputAtMs: this.inputAtMs,
      resumedAtMs: this.resumedAtMs,
      inputCount: this.inputCount_,
      outputCount: this.outputCount_,
      activityCount: this.activityCount_,
      activityDirty: this.activityDirty_,
      shellBusy: this.shellBusy,
      shellCommandRunning: this.shellCommandRunning,
    }
  }

  restoreDurableState(
    state: SessionDurableState,
    preserve: ReadonlySet<SessionVolatileField> = new Set(),
  ): void {
    this.cwd = state.cwd
    this.issueId = state.issueId
    this.refIssueId = state.refIssueId
    this.refLetter = state.refLetter
    this.refDraft = state.refDraft
    if (!preserve.has('machineId')) this.machineId = state.machineId
    this.resume = state.resume ? { ...state.resume } : undefined
    this.lastActiveAt = state.lastActiveAt
    this.title = state.title
    this.titleLocked = state.titleLocked
    this.name = state.name
    this.nameSource = state.nameSource
    this.archived = state.archived
    this.readAt = state.readAt
    this.stoppedAt = state.stoppedAt
    this.stopReason = state.stopReason
    this.workState = state.workState
    this.cmd = state.cmd
    if (!preserve.has('status')) this.status = state.status
    this.exitCode = state.exitCode
    this.agentState = state.agentState ? structuredClone(state.agentState) : undefined
    this.workingMsTotal = state.workingMsTotal
    this.incomingWorkingMsTotal = state.incomingWorkingMsTotal
    this.agentColor = state.agentColor
    this.snoozedUntil = state.snoozedUntil
    this.queuedMessageCount = state.queuedMessageCount
    if (!preserve.has('handoffTarget')) this.handoffTarget = state.handoffTarget
    this.conversationPodiumId = state.conversationPodiumId
    this.draftUpdatedAt = state.draftUpdatedAt
    this.offer = state.offer ? structuredClone(state.offer) : undefined
    this.transcriptAvailable = state.transcriptAvailable
    if (!preserve.has('geometry')) this.geometry = { ...state.geometry }
    this.outputAtMs = state.outputAtMs
    this.inputAtMs = state.inputAtMs
    this.resumedAtMs = state.resumedAtMs
    this.inputCount_ = state.inputCount
    this.outputCount_ = state.outputCount
    this.activityCount_ = state.activityCount
    this.activityDirty_ = state.activityDirty
    this.shellBusy = state.shellBusy
    this.shellCommandRunning = state.shellCommandRunning
  }

  toRow(): SessionRow {
    return {
      id: this.sessionId,
      agentKind: this.agentKind,
      model: this.model ?? null,
      effort: this.effort ?? null,
      accountId: this.accountId ?? null,
      cwd: this.cwd,
      title: this.title,
      name: this.name || null,
      nameSource: this.nameSource ?? null,
      archived: this.archived,
      workState: this.workState ?? null,
      originKind: this.origin.kind,
      conversationId: this.origin.kind === 'resume' ? this.origin.conversationId : null,
      resumeKind: this.resume?.kind ?? null,
      resumeValue: this.resume?.value ?? null,
      status: this.status,
      exitCode: this.exitCode ?? null,
      durableLabel: this.durableLabel,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      geometry: { ...this.geometry },
      ...(this.workingMsTotal !== undefined ? { workingMsTotal: this.workingMsTotal } : {}),
      inputCount: this.inputCount_,
      outputCount: this.outputCount_,
      activityCount: this.activityCount_,
      lastOutputAt: Session.msToIso(this.outputAtMs),
      lastInputAt: Session.msToIso(this.inputAtMs),
      lastResumedAt: Session.msToIso(this.resumedAtMs),
      spawnedBy: this.spawnedBy ?? null,
      machineId: this.machineId,
      headless: this.headless,
      issueId: this.issueId ?? null,
      refIssueId: this.refIssueId,
      refLetter: this.refLetter,
      refDraft: this.refDraft,
      readAt: this.readAt,
      stoppedAt: this.stoppedAt ?? null,
      stopReason: this.stopReason ?? null,
      workflowRunId: this.workflowRunId ?? null,
      workflowStepId: this.workflowStepId ?? null,
      executionProfileId: this.executionProfileId ?? null,
    }
  }

  /** Install an authoritative grid and enqueue its durable row update. Geometry
   * changes are coalesced with activity writes so pane-drag resize bursts do not
   * turn into a database write per SIGWINCH [spec:SP-1a0b]. */
  private setGeometry(cols: number, rows: number): void {
    if (this.geometry.cols === cols && this.geometry.rows === rows) return
    this.geometry = { cols, rows }
    this.activityDirty_ = true
  }

  private static msToIso(ms: number): string | null {
    return ms > 0 ? new Date(ms).toISOString() : null
  }

  toMeta(): SessionMeta {
    return {
      sessionId: this.sessionId,
      agentKind: this.agentKind,
      ...(this.model ? { model: this.model } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
      ...(this.accountId ? { accountId: this.accountId } : {}),
      title: this.title,
      ...(this.name ? { name: this.name } : {}),
      ...(this.name && this.nameSource ? { nameSource: this.nameSource } : {}),
      cwd: this.cwd,
      status: this.status,
      ...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
      ...(this.agentState ? { agentState: this.agentState } : {}),
      controllerId: this.controllerId,
      geometry: { ...this.geometry },
      epoch: this.epoch,
      clientCount: this.clients.size,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      origin: this.origin,
      archived: this.archived,
      // Email-style read state (issue #124). unread = there is activity the operator
      // hasn't seen: never opened (readAt null), or lastActiveAt postdates readAt.
      // Both are ISO-8601, so the lexical compare is chronological.
      readAt: this.readAt,
      ...(this.stoppedAt ? { stoppedAt: this.stoppedAt } : {}),
      ...(this.stopReason ? { stopReason: this.stopReason } : {}),
      unread: this.readAt == null || this.lastActiveAt > this.readAt,
      // The registry overwrites machineName in listSessions() from the machines
      // table; an empty default keeps toMeta() self-contained for callers that
      // read it directly (e.g. tests on a Session in isolation).
      machineId: this.machineId,
      machineName: '',
      ...(this.workState ? { workState: this.workState } : {}),
      ...(this.resume ? { resumable: true, resume: this.resume } : {}),
      ...(this.transcriptAvailable ? { transcriptAvailable: true } : {}),
      ...(this.shellBusy ? { busy: true } : {}),
      ...(this.agentColor ? { agentColor: this.agentColor } : {}),
      ...(this.snoozedUntil !== undefined ? { snoozedUntil: this.snoozedUntil } : {}),
      ...(this.draftUpdatedAt !== undefined ? { draftUpdatedAt: this.draftUpdatedAt } : {}),
      ...(this.draftSyncEngine ? { draftSyncEngine: true } : {}),
      ...(this.offer !== undefined ? { offer: this.offer } : {}), // [spec:SP-c7f1]
      ...(this.handoffTarget ? { handoffTarget: this.handoffTarget } : {}),
      ...(this.queuedMessageCount > 0 ? { queuedMessageCount: this.queuedMessageCount } : {}),
      ...(this.conversationPodiumId ? { conversationPodiumId: this.conversationPodiumId } : {}),
      ...(this.spawnedBy ? { spawnedBy: this.spawnedBy } : {}),
      ...(this.headless ? { headless: true } : {}),
      ...(this.issueId ? { issueId: this.issueId } : {}),
      ...(this.refIssueId ? { refIssueId: this.refIssueId } : {}),
      ...(this.refLetter ? { refLetter: this.refLetter } : {}),
      ...(this.refDraft != null ? { refDraft: this.refDraft } : {}),
      ...(this.workflowRunId ? { workflowRunId: this.workflowRunId } : {}),
      ...(this.workflowStepId ? { workflowStepId: this.workflowStepId } : {}),
      ...(this.executionProfileId ? { executionProfileId: this.executionProfileId } : {}),
    }
  }

  /** Parse a persisted work_state column; unknown strings read as unsorted. */
  static parseWorkState(raw: string | null): WorkState | undefined {
    if (raw === null) return undefined
    const parsed = WorkStateSchema.safeParse(raw)
    return parsed.success ? parsed.data : undefined
  }

  private broadcast(msg: ServerMessage): void {
    for (const c of this.clients.values()) c.send(msg)
  }
}
