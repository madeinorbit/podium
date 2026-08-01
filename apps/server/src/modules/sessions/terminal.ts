import type {
  AgentKind,
  Attribution,
  Geometry,
  SessionId,
  TranscriptItem,
} from '@podium/model'
import type { ControlMessage, ServerMessage } from '@podium/protocol'
import type { ClientConn } from '../../gateway/client-registry'
import { feedPrincipalOf } from '../../gateway/client-principal'
import { perfPrincipal } from '../perf/principal'
import { perf } from '../perf/registry'
import type { Send } from './session'

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
  controllerId: string | null = null

  private outputAtMs_ = 0
  private inputAtMs_ = 0
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
    if (this.controllerId === null) this.controllerId = client.id
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
      geometry: { ...this.geometry },
      epoch: this.epoch,
      resumed,
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
  }

  reassignController(fromId: string, toId: string): void {
    if (this.controllerId === fromId) this.controllerId = toId
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
    this.controllerId = this.clients.keys().next().value ?? null
    if (this.controllerId !== null) {
      this.broadcast({
        type: 'controllerChanged',
        sessionId: this.init.sessionId,
        controllerId: this.controllerId,
        geometry: { ...this.geometry },
      })
    }
  }

  detachAll(): void {
    for (const client of this.clients.values()) client.viewports.delete(this.init.sessionId)
    this.clients.clear()
    this.transcriptSubscribers.clear()
    this.controllerId = null
  }

  handleInput(clientId: string, data: string, attribution?: Attribution): void {
    if (clientId !== this.controllerId) return
    if (this.init.agentKind === 'shell' && submitsCommandLine(data)) {
      this.shellCommandRunning = true
      this.markShellBusy()
    }
    this.recordInputActivity()
    this.init.toDaemon({
      type: 'input',
      sessionId: this.init.sessionId,
      data,
      inputOrigin: 'human',
      ...(attribution ? { attribution } : {}),
    })
  }

  recordInputActivity(at = Date.now()): void {
    this.inputAtMs_ = at
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
    this.controllerId = clientId
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
      geometry: { ...this.geometry },
    })
    this.broadcast({
      type: 'geometry',
      sessionId: this.init.sessionId,
      cols: this.geometry.cols,
      rows: this.geometry.rows,
    })
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
