import type {
  AgentKind,
  AgentRuntimeState,
  ControlMessage,
  Geometry,
  ResumeRef,
  ServerMessage,
  SessionMeta,
  SessionOrigin,
  TranscriptItem,
  WorkState,
} from '@podium/protocol'
import { WorkState as WorkStateSchema } from '@podium/protocol'
import type { SessionRow } from './store'

export type Send<T> = (msg: T) => void

export interface ClientConn {
  id: string
  send: Send<ServerMessage>
  viewport: Geometry
  attached: Set<string>
  /** Session ids this client subscribed to the structured transcript of. Lets
   *  detachClient sweep just this client's subscriptions instead of scanning every
   *  session on the host (audit P2-18). */
  transcriptSubs: Set<string>
  /** Page-visibility presence — drives smart notification routing. */
  visible: boolean
}

export interface SessionInit {
  sessionId: string
  agentKind: AgentKind
  cwd: string
  title: string
  origin: SessionOrigin
  createdAt: string
  geometry: Geometry
  toDaemon: Send<ControlMessage>
  resume?: ResumeRef
  durableLabel?: string
  lastActiveAt?: string
  status?: 'starting' | 'live' | 'reconnecting' | 'hibernated' | 'exited'
  exitCode?: number
  name?: string
  archived?: boolean
  workState?: WorkState
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
// Bounded structured-transcript buffer per session — the live window late
// subscribers get as a snapshot. Generous on purpose so the common case loads
// whole, but still bounded (each item is small; ~12k is a few MB per live
// session). Items older than this window are no longer lost: the chat view pages
// them back in on demand straight off disk (sessions.transcriptPage), so this is
// the live-stream window cap, not a hard transcript ceiling. Kept in step with the
// tailer's MAX_INITIAL_ITEMS so a reattach snapshot and the live buffer match.
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
export class Session {
  readonly sessionId: string
  readonly agentKind: AgentKind
  readonly cwd: string
  readonly origin: SessionOrigin
  readonly createdAt: string
  readonly durableLabel: string
  /** How to bring this session back after its process is gone (hibernate→resume).
   *  Set at spawn for resumes; learned later from the daemon for fresh spawns. */
  resume?: ResumeRef
  lastActiveAt: string
  title: string
  /** Live heuristic (not persisted): a real title — the agent's own summary, or
   *  the first-prompt fallback — has been set, so the generic "Claude Code"
   *  placeholder must not overwrite it and the fallback shouldn't re-fire. */
  titleLocked = false
  /** User-set name; empty = fall back to the live title. */
  name = ''
  archived = false
  workState: WorkState | undefined
  cmd = ''
  status: 'starting' | 'live' | 'reconnecting' | 'hibernated' | 'exited' = 'starting'
  exitCode: number | undefined
  agentState: AgentRuntimeState | undefined
  /** The agent's `/color` identity accent (a named colour), learned from the
   *  transcript tail. Undefined = no colour (incl. Claude's 'default'/reset). */
  agentColor: string | undefined
  /** Snooze deadline — orthogonal to agentState. undefined = not snoozed; null =
   *  until next message; ISO string = timed. Lives in its own `snoozes` table, so
   *  it is NOT part of toRow(); the registry seeds it at load and on mutation. */
  snoozedUntil: string | null | undefined = undefined
  /** True once a structured transcript has been seen — drives chat capability. */
  transcriptAvailable = false
  geometry: Geometry
  epoch = 0
  controllerId: string | null = null
  // Wall-clock ms of the last output frame (0 = none yet). Drives the "is a
  // process producing output" signal — the shell busy flag and the hibernation
  // guard that keeps a session with a running background agent awake.
  private outputAtMs = 0
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
  // seq resets to 0 on every daemon reattach, so it can't be a stable client
  // cursor; the server owns the numbering instead. It survives daemon restarts
  // (the Session object outlives the bridge) and only resets on a server restart,
  // where the client's stale-high cursor simply falls back to a full replay.
  private nextSeq = 0
  private readonly toDaemon: Send<ControlMessage>
  private readonly clients = new Map<string, ClientConn>()
  // Recent agent output (base64 frames) for replay-on-attach; bounded by MAX_REPLAY_BYTES.
  private readonly outputLog: { seq: number; data: string }[] = []
  private outputLogBytes = 0
  // Structured transcript buffer (chat view) + which clients want its stream.
  // Holds the connection (not just the id): a chat-only client subscribes
  // without ever attaching to the PTY.
  private transcript: TranscriptItem[] = []
  private readonly transcriptSubscribers = new Map<string, ClientConn>()

  constructor(init: SessionInit) {
    this.sessionId = init.sessionId
    this.agentKind = init.agentKind
    this.cwd = init.cwd
    this.title = init.title
    this.origin = init.origin
    this.createdAt = init.createdAt
    this.geometry = { ...init.geometry }
    this.toDaemon = init.toDaemon
    this.durableLabel = init.durableLabel ?? `podium-${init.sessionId}`
    this.resume = init.resume
    this.lastActiveAt = init.lastActiveAt ?? init.createdAt
    if (init.status) this.status = init.status
    if (init.exitCode !== undefined) this.exitCode = init.exitCode
    if (init.name) this.name = init.name
    if (init.archived) this.archived = init.archived
    if (init.workState) this.workState = init.workState
    this.onActivity = init.onActivity
  }

  get clientCount(): number {
    return this.clients.size
  }

  /** Wall-clock ms of the last PTY output frame (0 = none seen yet). */
  get lastOutputMs(): number {
    return this.outputAtMs
  }

  attachClient(client: ClientConn, sinceSeq?: number): void {
    this.clients.set(client.id, client)
    if (this.controllerId === null) this.controllerId = client.id
    // Resume vs full replay. On a reconnect the client passes the last seq it
    // rendered; if that point is still inside our bounded buffer, replay only the
    // frames it missed and flag the attach `resumed` so it appends to the screen it
    // kept (no flicker). A fresh mount (no sinceSeq) or a gap larger than the buffer
    // falls back to a full replay, which the client clears the screen for. The
    // `oldest - 1` floor lets a client that was exactly caught up resume with zero
    // frames instead of needlessly wiping.
    const oldest = this.outputLog[0]?.seq
    const newest = this.outputLog.at(-1)?.seq
    let frames = this.outputLog
    let resumed = false
    if (
      sinceSeq !== undefined &&
      oldest !== undefined &&
      newest !== undefined &&
      sinceSeq >= oldest - 1 &&
      sinceSeq <= newest
    ) {
      resumed = true
      frames = this.outputLog.filter((f) => f.seq > sinceSeq)
    }
    client.send({
      type: 'attached',
      sessionId: this.sessionId,
      controllerId: this.controllerId,
      geometry: { ...this.geometry },
      epoch: this.epoch,
      resumed,
    })
    for (const f of frames) {
      client.send({
        type: 'outputFrame',
        sessionId: this.sessionId,
        seq: f.seq,
        epoch: this.epoch,
        data: f.data,
      })
    }
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

  /** Subscribe a client to the structured transcript: snapshot now, appends after. */
  subscribeTranscript(client: ClientConn): void {
    this.transcriptSubscribers.set(client.id, client)
    client.send({
      type: 'transcriptSnapshot',
      sessionId: this.sessionId,
      items: this.transcript,
    })
  }

  unsubscribeTranscript(clientId: string): void {
    this.transcriptSubscribers.delete(clientId)
  }

  /** The buffered structured transcript (superagent tools read this). */
  transcriptItems(): TranscriptItem[] {
    return this.transcript
  }

  /** Daemon pushed parsed transcript items; buffer (bounded) and fan out.
   *  Returns true the first time a transcript is observed (the chat-capability
   *  transition), so the registry can broadcast the updated SessionMeta. */
  appendTranscript(items: TranscriptItem[], reset: boolean): boolean {
    const becameAvailable =
      !this.transcriptAvailable && (items.length > 0 || this.transcript.length > 0)
    if (becameAvailable) this.transcriptAvailable = true
    if (reset) this.transcript = []
    this.transcript = this.transcript.concat(items)
    if (this.transcript.length > MAX_TRANSCRIPT_ITEMS) {
      this.transcript = this.transcript.slice(-MAX_TRANSCRIPT_ITEMS)
    }
    for (const client of this.transcriptSubscribers.values()) {
      if (reset) {
        client.send({
          type: 'transcriptSnapshot',
          sessionId: this.sessionId,
          items: this.transcript,
        })
      } else {
        client.send({ type: 'transcriptAppend', sessionId: this.sessionId, items })
      }
    }
    return becameAvailable
  }

  detachClient(clientId: string): void {
    this.clients.delete(clientId)
    this.transcriptSubscribers.delete(clientId)
    if (this.controllerId === clientId) {
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
      this.toDaemon({ type: 'input', sessionId: this.sessionId, data })
    }
  }

  handleResize(clientId: string, cols: number, rows: number): void {
    const client = this.clients.get(clientId)
    if (client) client.viewport = { cols, rows }
    if (clientId === this.controllerId) {
      this.geometry = { cols, rows }
      this.toDaemon({ type: 'resize', sessionId: this.sessionId, cols, rows })
    }
  }

  requestControl(clientId: string): void {
    if (!this.clients.has(clientId)) return
    this.controllerId = clientId
    this.geometry = { ...(this.clients.get(clientId)?.viewport ?? this.geometry) }
    this.epoch += 1
    this.toDaemon({
      type: 'resize',
      sessionId: this.sessionId,
      cols: this.geometry.cols,
      rows: this.geometry.rows,
    })
    this.toDaemon({ type: 'redraw', sessionId: this.sessionId })
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
    // The harness-observed phase described a running agent; that agent is gone.
    // Leaving it set would make the home board / superagent / Continue button
    // keep treating a dead session as 'working' or 'errored'.
    this.agentState = undefined
    this.broadcast({ type: 'agentExit', sessionId: this.sessionId, code })
  }

  /** A spawn that never started — surface as an exit so attached clients stop waiting. */
  markSpawnError(message: string): void {
    this.status = 'exited'
    this.exitCode = -1
    this.agentState = undefined
    console.warn(`[podium] spawn failed for ${this.sessionId}: ${message}`)
    this.broadcast({ type: 'agentExit', sessionId: this.sessionId, code: -1 })
  }

  /** Adopt a live terminal title the agent set (OSC). Replaces the cwd-derived default. */
  /** Harness-observed runtime state (hooks-driven). Not persisted — it's live-only. */
  setAgentState(state: AgentRuntimeState): void {
    this.agentState = state
    // Recency tracks the phase event-time (state.since), not "now". Monotonic max:
    // a reattach replays the recent transcript tail — the last turn_completed can be
    // hours old — and re-seeds boot state; neither must pull recency backward nor
    // restamp it to the reattach moment. Only a genuinely newer event advances it.
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
    if (this.controllerId === null) this.geometry = { ...geometry }
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

  toRow(): SessionRow {
    return {
      id: this.sessionId,
      agentKind: this.agentKind,
      cwd: this.cwd,
      title: this.title,
      name: this.name || null,
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
    }
  }

  toMeta(): SessionMeta {
    return {
      sessionId: this.sessionId,
      agentKind: this.agentKind,
      title: this.title,
      ...(this.name ? { name: this.name } : {}),
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
      ...(this.workState ? { workState: this.workState } : {}),
      ...(this.resume ? { resumable: true, resume: this.resume } : {}),
      ...(this.transcriptAvailable ? { transcriptAvailable: true } : {}),
      ...(this.shellBusy ? { busy: true } : {}),
      ...(this.agentColor ? { agentColor: this.agentColor } : {}),
      ...(this.snoozedUntil !== undefined ? { snoozedUntil: this.snoozedUntil } : {}),
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
