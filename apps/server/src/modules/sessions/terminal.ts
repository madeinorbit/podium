import type {
  AgentKind,
  Attribution,
  Geometry,
  SessionId,
  TranscriptItem,
} from '@podium/model'
import type {
  ControlMessage,
  ObservationInputOrigin,
  PresenceIdentity,
  ServerMessage,
} from '@podium/protocol'
import type { ClientConn } from '../../gateway/client-registry'
import { feedPrincipalOf } from '../../gateway/client-principal'
import { perfPrincipal } from '../perf/principal'
import { perf } from '../perf/registry'
import type { Send } from './session'
import { controlSubjectFromClient, identityOf } from './session-control-policy'

const MAX_REPLAY_BYTES = 256 * 1024
const MAX_TRANSCRIPT_ITEMS = 12_000
const SHELL_BUSY_WINDOW_MS = 4000

function submitsCommandLine(base64: string): boolean {
  const bytes = Buffer.from(base64, 'base64')
  return bytes.includes(0x0d) || bytes.includes(0x0a)
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
const SCREEN_RESET = /\x1b\[[23]J|\x1bc|\x1b\[\?1049[hl]/

export interface SessionTerminalState {
  grid: Geometry
  times: readonly [outputAtMs: number, inputAtMs: number, resumedAtMs: number]
  counts: readonly [inputCount: number, outputCount: number, activityCount: number]
  dirty: boolean
  shell: readonly [busy: boolean, commandRunning: boolean]
}

export interface SessionTerminalInit {
  sessionId: SessionId
  agentKind: AgentKind
  geometry: Geometry
  toDaemon: Send<ControlMessage>
  inputCount?: number
  outputCount?: number
  activityCount?: number
  lastOutputAt?: string | null
  lastInputAt?: string | null
  lastResumedAt?: string | null
  onActivity?: (at: string, changed: boolean) => void
  onTranscriptAvailable?: () => void
}

/**
 * Inbox-owned live terminal state for one session.
 *
 * This collaborator owns the PTY controller, attached clients, replay window,
 * transcript subscriptions, terminal geometry, and input/output activity. None
 * of those are session lifecycle state; lifecycle only snapshots the durable
 * counters and asks the terminal to detach when a session is removed.
 */
export class SessionTerminal {
  geometry: Geometry
  epoch = 0
  /** Websocket connection id of the current controller (device, not person). */
  controllerId: string | null = null
  /**
   * WHO is driving — stamped from the authenticated transport principal
   * (POD-1081 / ADR 3 D7). Null when nobody holds control.
   */
  controllerIdentity: PresenceIdentity | null = null
  /**
   * LIVE-ONLY attribution of the last accepted PTY input (POD-1081 §2).
   * Not durable in the transcript; blank after restart.
   */
  lastInputAttribution: Attribution | null = null

  private outputAtMs_ = 0
  private inputAtMs_ = 0
  private userInputAtMs_ = 0
  private resumedAtMs_ = 0
  private inputCount_ = 0
  private outputCount_ = 0
  private activityCount_ = 0
  private activityDirty_ = false
  private shellBusy_ = false
  private shellBusyTimer: ReturnType<typeof setTimeout> | undefined
  private shellCommandRunning = false
  private nextSeq = 0
  private readonly clients = new Map<string, ClientConn>()
  private readonly outputLog: { seq: number; data: string }[] = []
  private outputLogBytes = 0
  private transcript: TranscriptItem[] = []
  private transcriptAvailable = false
  private readonly transcriptSubscribers = new Map<string, ClientConn>()

  constructor(private readonly init: SessionTerminalInit) {
    this.geometry = { ...init.geometry }
    this.outputAtMs_ = this.seedMs(init.lastOutputAt)
    this.inputAtMs_ = this.seedMs(init.lastInputAt)
    // Only the combined last-input time is durable, so a reload cannot tell a
    // human keystroke from a mail delivery. Seeding both from it keeps the
    // post-restart answer identical to the one the boot offer reconcile
    // already gives (repository.ts), rather than inventing a stricter one.
    this.userInputAtMs_ = this.inputAtMs_
    this.resumedAtMs_ = this.seedMs(init.lastResumedAt)
    this.inputCount_ = init.inputCount ?? 0
    this.outputCount_ = init.outputCount ?? 0
    this.activityCount_ = init.activityCount ?? 0
  }

  get clientCount(): number {
    return this.clients.size
  }

  get lastOutputAtMs(): number {
    return this.outputAtMs_
  }

  get lastInputAtMs(): number {
    return this.inputAtMs_
  }

  /**
   * Last input a PERSON is responsible for — raw keystrokes and controller
   * sends (chat, offer buttons), but not mail delivery, stop-hook continues,
   * steward or automation wakes. The offer staleness rule [spec:SP-c7f1,
   * POD-118] needs that distinction for the harnesses whose observers report
   * no input origin of their own.
   */
  get lastUserInputAtMs(): number {
    return this.userInputAtMs_
  }

  get lastResumedAtMs(): number {
    return this.resumedAtMs_
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

  get busy(): boolean {
    return this.shellBusy_
  }

  clearActivityDirty(): void {
    this.activityDirty_ = false
  }

  recordResumeActivity(): void {
    this.resumedAtMs_ = Date.now()
    this.activityCount_ += 1
    this.activityDirty_ = true
  }

  attachClient(client: ClientConn, sinceSeq?: number): void {
    this.clients.set(client.id, client)
    if (this.controllerId === null) this.setController(client.id, client)
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
        frames = this.outputLog.filter((frame) => frame.seq > sinceSeq)
      }
    }
    client.send({
      type: 'attached',
      sessionId: this.init.sessionId,
      controllerId: this.controllerId,
      controllerIdentity: this.controllerIdentity,
      geometry: { ...this.geometry },
      epoch: this.epoch,
      resumed,
      // The client cannot tell a PTY that has printed nothing since spawn from
      // one whose replay window we no longer hold — both attach onto a blank
      // screen. The durable output counter can, so it travels with the attach
      // and the panel keeps a startup affordance up while this is false
      // [POD-385].
      outputSeen: this.outputCount_ > 0,
    })
    const startedAt = performance.now()
    let replayBytes = 0
    for (const frame of frames) {
      replayBytes += frame.data.length
      client.send({
        type: 'outputFrame',
        sessionId: this.init.sessionId,
        seq: frame.seq,
        epoch: this.epoch,
        data: frame.data,
      })
    }
    perf.record(
      'phase',
      'attach.replay',
      performance.now() - startedAt,
      perfPrincipal(feedPrincipalOf(client.principal)),
      replayBytes,
    )
    // The replay log is a byte stream, not a screen — replaying it only rebuilds the
    // terminal if the window still holds a whole-screen anchor. A full-screen TUI that
    // repaints a small region forever without ever re-anchoring evicts one: grok's idle
    // animation shimmers its logo at ~6.8 KB/s with no clear, turning the 256 KB window
    // over every ~30s, so a client attaching later replayed nothing but partial logo
    // frames and showed a BLANK terminal for a session running fine [POD-379]. So
    // whenever the client is (re)building its screen from replay alone, nudge the PTY
    // into repainting from its own model. Harness-agnostic — it fixes any TUI that does
    // not re-anchor — and the repaint carries a real clear, which re-anchors the log for
    // the next attach too. A clean resume keeps its screen and only needs the delta —
    // including a caught-up one, whose empty delta is "nothing changed", NOT "nothing to
    // rebuild from"; only an EMPTY LOG (a restarted server) means the latter.
    if (!resumed || this.outputLog.length === 0) this.redraw()
  }

  reassignController(fromId: string, toId: string): void {
    // Socket reclaim: the connection id changes while the principal stays the
    // same. The new id may not yet be in `clients` (reclaim runs before re-attach
    // finishes), so we update the id unconditionally and refresh identity when
    // the client record is already present.
    if (this.controllerId !== fromId) return
    this.controllerId = toId
    const next = this.clients.get(toId)
    if (next) this.controllerIdentity = identityOf(controlSubjectFromClient(next.principal))
  }

  subscribeTranscript(client: ClientConn, since?: string): void {
    this.transcriptSubscribers.set(client.id, client)
    let replay = this.transcript
    if (since !== undefined) {
      const index = this.transcript.findIndex((item) => item.cursor === since)
      replay = index >= 0 ? this.transcript.slice(index + 1) : this.transcript
    }
    if (replay.length > 0) {
      client.send({ type: 'transcriptDelta', sessionId: this.init.sessionId, items: replay })
    }
  }

  unsubscribeTranscript(clientId: string): void {
    this.transcriptSubscribers.delete(clientId)
  }

  transcriptItems(): TranscriptItem[] {
    return this.transcript
  }

  applyDelta(items: TranscriptItem[], opts: { reset?: boolean; tail?: string }): boolean {
    const becameAvailable =
      !this.transcriptAvailable && (items.length > 0 || this.transcript.length > 0)
    if (becameAvailable) {
      this.transcriptAvailable = true
      this.init.onTranscriptAvailable?.()
    }
    if (opts.reset) this.transcript = []
    this.transcript = this.transcript.concat(items)
    if (this.transcript.length > MAX_TRANSCRIPT_ITEMS) {
      this.transcript = this.transcript.slice(-MAX_TRANSCRIPT_ITEMS)
    }
    const delta: ServerMessage = {
      type: 'transcriptDelta',
      sessionId: this.init.sessionId,
      items,
      ...(opts.tail !== undefined ? { tail: opts.tail } : {}),
      ...(opts.reset ? { reset: true } : {}),
    }
    for (const client of this.transcriptSubscribers.values()) client.send(delta)
    return becameAvailable
  }

  setTranscriptAvailable(available: boolean): void {
    this.transcriptAvailable = available
  }

  detachClient(clientId: string): void {
    const client = this.clients.get(clientId)
    client?.viewports.delete(this.init.sessionId)
    this.clients.delete(clientId)
    this.transcriptSubscribers.delete(clientId)
    if (this.controllerId !== clientId) return
    // Disconnect: reassign to the next attached client (preemption policy §3).
    // Identity rides with the new controller; no refuse step.
    const nextId = this.clients.keys().next().value ?? null
    if (nextId !== undefined && nextId !== null) {
      const next = this.clients.get(nextId)
      this.setController(nextId, next)
      this.broadcast({
        type: 'controllerChanged',
        sessionId: this.init.sessionId,
        controllerId: this.controllerId,
        controllerIdentity: this.controllerIdentity,
        geometry: { ...this.geometry },
      })
    } else {
      this.clearController()
    }
  }

  detachAll(): void {
    for (const client of this.clients.values()) client.viewports.delete(this.init.sessionId)
    this.clients.clear()
    this.transcriptSubscribers.clear()
    this.clearController()
  }

  handleInput(clientId: string, data: string, attribution?: Attribution): void {
    if (clientId !== this.controllerId) return
    if (this.init.agentKind === 'shell' && submitsCommandLine(data)) {
      this.shellCommandRunning = true
      this.markShellBusy()
    }
    this.recordInputActivity()
    // Live-only keystroke attribution (POD-1081 §2). Durable retention is the
    // inbox/chat path, not the per-keystroke PTY stream.
    if (attribution) this.lastInputAttribution = attribution
    this.init.toDaemon({
      type: 'input',
      sessionId: this.init.sessionId,
      data,
      inputOrigin: 'human',
      ...(attribution ? { attribution } : {}),
    })
  }

  /**
   * Record live attribution for an inbox/daemon-originated input that bypasses
   * controller gating (chat send, answer, agent type). Still live-only for the
   * last-keystroke field; the durable half is the queue row.
   */
  noteInputAttribution(attribution: Attribution | null): void {
    if (attribution) this.lastInputAttribution = attribution
  }

  /**
   * Drop control because the current holder is no longer authorized (revoked
   * human / machine use). Called at the next apply — never by a reaper.
   */
  revokeController(): void {
    if (this.controllerId === null && this.controllerIdentity === null) return
    this.clearController()
    this.broadcast({
      type: 'controllerChanged',
      sessionId: this.init.sessionId,
      controllerId: null,
      controllerIdentity: null,
      geometry: { ...this.geometry },
    })
  }

  /** `origin` defaults to 'human' because the raw-keystroke path below is the
   *  only caller that omits it; every server-originated send states its own. */
  recordInputActivity(at = Date.now(), origin: ObservationInputOrigin = 'human'): void {
    this.inputAtMs_ = at
    if (origin === 'human' || origin === 'controller') this.userInputAtMs_ = at
    this.inputCount_ += 1
    this.activityCount_ += 1
    this.activityDirty_ = true
  }

  recordObservationActivity(): void {
    this.activityCount_ += 1
    this.activityDirty_ = true
  }

  handleResize(clientId: string, cols: number, rows: number): void {
    const client = this.clients.get(clientId)
    if (client) client.viewports.set(this.init.sessionId, { cols, rows })
    if (clientId !== this.controllerId || !client?.viewVisible.has(this.init.sessionId)) return
    this.setGeometry(cols, rows)
    this.init.toDaemon({ type: 'resize', sessionId: this.init.sessionId, cols, rows })
    this.broadcast({ type: 'geometry', sessionId: this.init.sessionId, cols, rows })
  }

  reconcileGeometry(clientId: string): void {
    const client = this.clients.get(clientId)
    if (!client || clientId !== this.controllerId || !client.viewVisible.has(this.init.sessionId)) {
      return
    }
    const viewport = client.viewports.get(this.init.sessionId)
    if (!viewport) return
    if (this.geometry.cols === viewport.cols && this.geometry.rows === viewport.rows) return
    this.setGeometry(viewport.cols, viewport.rows)
    this.init.toDaemon({
      type: 'resize',
      sessionId: this.init.sessionId,
      cols: this.geometry.cols,
      rows: this.geometry.rows,
    })
    this.broadcast({
      type: 'geometry',
      sessionId: this.init.sessionId,
      cols: this.geometry.cols,
      rows: this.geometry.rows,
    })
  }

  requestControl(clientId: string): void {
    const client = this.clients.get(clientId)
    if (!client || this.controllerId === clientId) return
    // Preemptive transfer — current controller cannot refuse (policy §3).
    this.setController(clientId, client)
    this.epoch += 1
    const viewport = client.viewports.get(this.init.sessionId)
    if (client.viewVisible.has(this.init.sessionId) && viewport) {
      this.setGeometry(viewport.cols, viewport.rows)
      this.init.toDaemon({
        type: 'resize',
        sessionId: this.init.sessionId,
        cols: this.geometry.cols,
        rows: this.geometry.rows,
      })
      this.init.toDaemon({ type: 'redraw', sessionId: this.init.sessionId })
    }
    this.broadcast({
      type: 'controllerChanged',
      sessionId: this.init.sessionId,
      controllerId: clientId,
      controllerIdentity: this.controllerIdentity,
      geometry: { ...this.geometry },
    })
    this.broadcast({
      type: 'geometry',
      sessionId: this.init.sessionId,
      cols: this.geometry.cols,
      rows: this.geometry.rows,
    })
  }

  /**
   * Force controller identity to an agent principal (no browser socket holds
   * control). Used when the session's agent is the driver — the normal case
   * under multi-user readiness §3.1.3 — after a human disconnects or is revoked.
   */
  setAgentController(identity: PresenceIdentity, attribution?: Attribution | null): void {
    this.controllerId = null
    this.controllerIdentity = identity
    if (attribution) this.lastInputAttribution = attribution
  }

  redraw(): void {
    this.init.toDaemon({ type: 'redraw', sessionId: this.init.sessionId })
  }

  onFrame(data: string): void {
    const seq = this.nextSeq++
    this.bufferFrame(seq, data)
    this.broadcast({
      type: 'outputFrame',
      sessionId: this.init.sessionId,
      seq,
      epoch: this.epoch,
      data,
    })
    this.outputAtMs_ = Date.now()
    this.outputCount_ += 1
    this.activityDirty_ = true
    if (this.init.agentKind === 'shell' && this.shellCommandRunning) this.markShellBusy()
  }

  stopOutput(): void {
    if (this.shellBusyTimer) clearTimeout(this.shellBusyTimer)
    this.shellBusyTimer = undefined
    this.shellBusy_ = false
    this.shellCommandRunning = false
  }

  adoptGeometryIfUncontrolled(geometry: Geometry): void {
    if (this.controllerId === null) this.setGeometry(geometry.cols, geometry.rows)
  }

  broadcast(message: ServerMessage): void {
    for (const client of this.clients.values()) client.send(message)
  }

  captureState(): SessionTerminalState {
    return {
      grid: { ...this.geometry },
      times: [this.outputAtMs_, this.inputAtMs_, this.resumedAtMs_],
      counts: [this.inputCount_, this.outputCount_, this.activityCount_],
      dirty: this.activityDirty_,
      shell: [this.shellBusy_, this.shellCommandRunning],
    }
  }

  restoreState(state: SessionTerminalState, preserveGeometry: boolean): void {
    if (!preserveGeometry) this.geometry = { ...state.grid }
    ;[this.outputAtMs_, this.inputAtMs_, this.resumedAtMs_] = state.times
    ;[this.inputCount_, this.outputCount_, this.activityCount_] = state.counts
    this.activityDirty_ = state.dirty
    ;[this.shellBusy_, this.shellCommandRunning] = state.shell
  }

  private setController(clientId: string, client: ClientConn | undefined): void {
    this.controllerId = clientId
    if (!client) {
      this.controllerIdentity = null
      return
    }
    this.controllerIdentity = identityOf(controlSubjectFromClient(client.principal))
  }

  private clearController(): void {
    this.controllerId = null
    this.controllerIdentity = null
  }

  private setGeometry(cols: number, rows: number): void {
    if (this.geometry.cols === cols && this.geometry.rows === rows) return
    this.geometry = { cols, rows }
    this.activityDirty_ = true
  }

  private markShellBusy(): void {
    const at = new Date().toISOString()
    const becameBusy = !this.shellBusy_
    this.shellBusy_ = true
    this.init.onActivity?.(at, becameBusy)
    if (this.shellBusyTimer) clearTimeout(this.shellBusyTimer)
    this.shellBusyTimer = setTimeout(() => {
      this.shellBusy_ = false
      this.shellCommandRunning = false
      this.init.onActivity?.(new Date().toISOString(), true)
    }, SHELL_BUSY_WINDOW_MS)
    this.shellBusyTimer.unref?.()
  }

  private bufferFrame(seq: number, data: string): void {
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

  private seedMs(value: string | null | undefined): number {
    const parsed = value ? Date.parse(value) : 0
    return Number.isNaN(parsed) ? 0 : parsed
  }
}
