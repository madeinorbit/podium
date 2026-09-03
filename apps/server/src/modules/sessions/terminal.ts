import { createLogger } from '@podium/logger'
import type {
  AgentKind,
  Attribution,
  Geometry,
  GeometryState,
  SessionId,
  TranscriptItem,
} from '@podium/model'
import type {
  DaemonPtyInputBatch,
  ObservationInputOrigin,
  PresenceIdentity,
  ServerMessage,
  TurnPreviewMessage,
} from '@podium/protocol'
import {
  CAP_TERMINAL_OUTPUT_BINARY_V1,
  DAEMON_PTY_OUTPUT_MAX_SOURCE_FRAMES,
  encodeBinaryEnvelope,
} from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { feedPrincipalOf } from '../../gateway/client-principal'
import type { ClientConn } from '../../gateway/client-registry'
import { perfPrincipal } from '../perf/principal'
import { perf } from '../perf/registry'
import type { Send } from './session'
import { controlSubjectFromClient, identityOf } from './session-control-policy'

const log = createLogger('server:sessions:terminal')

const MAX_REPLAY_BYTES = 256 * 1024
const MAX_REPLAY_FRAMES = 4096
const MAX_TRANSCRIPT_ITEMS = 12_000
const SHELL_BUSY_WINDOW_MS = 4000

function submitsCommandLine(bytes: Uint8Array): boolean {
  return bytes.includes(0x0d) || bytes.includes(0x0a)
}

/**
 * Merge logical transcript rows by either stable alias. Providers may preserve
 * an id while rotating a cursor, or preserve a cursor while deriving a new id;
 * either match identifies the same row. A disjoint-set pass joins aliases in
 * near-linear time, including a bridge item that connects two former roots.
 *
 * Complete rows are ordered by their real event timestamps. A missing/invalid
 * timestamp sorts before dated rows and keeps observed order as a deterministic
 * fallback, so it cannot masquerade as the newest item in a latest-page read.
 * Alias history follows the winning item across calls so an old replay remains
 * absorbed after an id or cursor rotates.
 */
interface TranscriptAliases {
  ids: Set<string>
  cursors: Set<string>
  order: number
}

const transcriptAliases = new WeakMap<TranscriptItem, TranscriptAliases>()

function transcriptTimestamp(item: TranscriptItem): number | undefined {
  if (!item.ts) return undefined
  const parsed = Date.parse(item.ts)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function mergeTranscriptItems(
  previous: TranscriptItem[],
  delta: TranscriptItem[],
  limit = MAX_TRANSCRIPT_ITEMS,
): TranscriptItem[] {
  if (delta.length === 0) return previous
  const items = [...previous, ...delta]
  const parent = items.map((_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root] ?? root
    while (parent[index] !== index) {
      const next = parent[index] ?? root
      parent[index] = root
      index = next
    }
    return root
  }
  const union = (left: number, right: number): void => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot
  }
  const byId = new Map<string, number>()
  const byCursor = new Map<string, number>()
  const aliasesFor = (item: TranscriptItem, fallbackOrder: number): TranscriptAliases => {
    const retained = transcriptAliases.get(item)
    return {
      ids: new Set([...(retained?.ids ?? []), ...(item.id.length > 0 ? [item.id] : [])]),
      cursors: new Set([
        ...(retained?.cursors ?? []),
        ...(item.cursor !== undefined && item.cursor.length > 0 ? [item.cursor] : []),
      ]),
      order: retained?.order ?? fallbackOrder,
    }
  }
  const retainedOrders = previous.map((item, index) => aliasesFor(item, index).order)
  let nextOrder = Math.max(-1, ...retainedOrders) + 1
  const aliases = items.map((item, index) =>
    aliasesFor(item, index < previous.length ? index : nextOrder++),
  )
  for (const [index, itemAliases] of aliases.entries()) {
    for (const id of itemAliases.ids) {
      const prior = byId.get(id)
      if (prior !== undefined) union(index, prior)
      byId.set(id, index)
    }
    for (const cursor of itemAliases.cursors) {
      const prior = byCursor.get(cursor)
      if (prior !== undefined) union(index, prior)
      byCursor.set(cursor, index)
    }
  }
  const roots = new Map<
    number,
    { winner: number; order: number; ids: Set<string>; cursors: Set<string> }
  >()
  for (const [index, itemAliases] of aliases.entries()) {
    const root = find(index)
    const aggregate = roots.get(root) ?? {
      winner: index,
      order: itemAliases.order,
      ids: new Set<string>(),
      cursors: new Set<string>(),
    }
    aggregate.winner = Math.max(aggregate.winner, index)
    aggregate.order = Math.min(aggregate.order, itemAliases.order)
    for (const id of itemAliases.ids) aggregate.ids.add(id)
    for (const cursor of itemAliases.cursors) aggregate.cursors.add(cursor)
    roots.set(root, aggregate)
  }
  const merged = [...roots.values()].map((root) => {
    const item = items[root.winner]
    if (!item) throw new Error('transcript alias root lost its winning item')
    transcriptAliases.set(item, { ids: root.ids, cursors: root.cursors, order: root.order })
    return { item, order: root.order }
  })
  merged.sort((a, b) => {
    const aTimestamp = transcriptTimestamp(a.item)
    const bTimestamp = transcriptTimestamp(b.item)
    if (aTimestamp !== undefined && bTimestamp !== undefined && aTimestamp !== bTimestamp) {
      return aTimestamp - bTimestamp
    }
    if (aTimestamp === undefined && bTimestamp !== undefined) return -1
    if (aTimestamp !== undefined && bTimestamp === undefined) return 1
    if (a.order !== b.order) return a.order - b.order
    const cursorOrder = (a.item.cursor ?? '').localeCompare(b.item.cursor ?? '')
    return cursorOrder !== 0 ? cursorOrder : a.item.id.localeCompare(b.item.id)
  })
  const result = merged.map(({ item }) => item)
  return result.length > limit ? result.slice(-limit) : result
}

export function mergeLatestTranscriptPage(
  providerItems: TranscriptItem[],
  runtimeItems: TranscriptItem[],
  limit: number,
): { items: TranscriptItem[]; hasMore: boolean } {
  const boundedLimit = Math.max(0, limit)
  const allItems = mergeTranscriptItems(
    providerItems,
    runtimeItems,
    Number.MAX_SAFE_INTEGER,
  )
  return {
    items: boundedLimit === 0 ? [] : allItems.slice(-boundedLimit),
    hasMore: allItems.length > boundedLimit,
  }
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

interface OutputFanout {
  binary?: Uint8Array
  legacy?: ServerMessage
}

/**
 * The ask, as the server reads it (POD-3239 B6). Shaped exactly like the
 * `viewportRequest` frame minus its `type`/`sessionId`, so the legacy frames can
 * be expressed in the same vocabulary instead of keeping a second code path.
 */
export interface ViewportRequest {
  geometry: Geometry
  visible: boolean
  mode: 'native' | 'chat'
  claimControl: boolean
  seq: number
}

/**
 * A legacy `resize`/`requestControl` in the request vocabulary.
 *
 * `seq: 0` on purpose: it is below every watermark, so a legacy frame never
 * advances one and can never be mistaken for a duplicate of a real request. The
 * legacy paths do their own watermark-free dispatch; this exists so a gated
 * legacy frame is COUNTED and logged in exactly the same shape as a gated
 * `viewportRequest`.
 */
const legacyRequest = (
  geometry: Geometry,
  visible: boolean,
  mode: 'native' | 'chat',
): ViewportRequest => ({ geometry, visible, mode, claimControl: false, seq: 0 })

export interface SessionTerminalInit {
  sessionId: SessionId
  agentKind: AgentKind
  geometry: Geometry
  toDaemon: Send<ControlMessage>
  sendInput?: Send<DaemonPtyInputBatch>
  inputCount?: number
  outputCount?: number
  activityCount?: number
  lastOutputAt?: string | null
  lastInputAt?: string | null
  lastResumedAt?: string | null
  onActivity?: (at: string, changed: boolean) => void
  onTranscriptAvailable?: () => void
  /**
   * Does the daemon holding this session report the grid it applied
   * (`CAP_DAEMON_GEOMETRY_APPLIED`)? Asked at the moment a request arrives
   * rather than snapshotted, because a session outlives its daemon connection
   * and can be answered by an older or newer daemon after a reconnect.
   *
   * Absent/false means the ONE compatibility branch (POD-3239 B6): the server
   * keeps today's set-the-geometry-on-request behaviour for that session,
   * because nothing else would ever write W.
   */
  daemonReportsGeometry?: () => boolean
  /**
   * The session's three-valued {@link GeometryState}, which needs the lifecycle
   * status this object does not have. Absent in a fixture ⇒ the two states the
   * terminal CAN answer on its own.
   */
  geometryState?: () => GeometryState
  /**
   * Whether this session asks its daemon for a token-level watch while a viewer
   * has the chat open (POD-2293). The flag lives on the terminal because the
   * subscriber count that drives it does — see `reconcileWatchLevel`.
   */
  turnPreviewEnabled?: boolean
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
  /** Monotonic revision for the authoritative geometry timeline. A client can
   * reject a delayed logical state without guessing from the dimensions. */
  geometryRevision = 0
  /**
   * HAS A DAEMON REPORT CONFIRMED `geometry`? (MODEL rule 6, the
   * `unknown`/`current` half.)
   *
   * False at birth — including a rehydrated birth, which is exactly why a
   * server restart yields `unknown` without anyone remembering to say so — and
   * false again the moment the daemon holding this session goes away. True only
   * while a report stands.
   *
   * The third state, `absent`, is NOT here: it is a fact about whether there is
   * a pty at all, which is the session's status, and a copy of it on this object
   * would be a second answer to a question that already has one. `Session.geometryState()`
   * folds the two.
   */
  geometryKnown = false
  /**
   * HOW MANY VIEWPORT REQUESTS THIS SESSION REFUSED (POD-3239 B6).
   *
   * The whole point of the counter is that the refusal used to be invisible:
   * today's `handleResize` returns without a broadcast, without a daemon frame
   * and without telling the client anything, so a pane wrongly stuck at a stale
   * grid looked identical to one that had never asked. Every refusal now lands
   * here and in the log with its reason.
   */
  requestsGated = 0
  /**
   * How many requests this session rejected as duplicates — a `seq` at or below
   * the watermark for that (connection, session). Separate from
   * {@link requestsGated} on purpose: a duplicate is a retransmit, not a refusal,
   * and folding the two would make the refusal signal unreadable.
   */
  requestsDuplicate = 0
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
  /**
   * What the DAEMON currently believes this session's level is.
   *
   * INITIALISED TO `coarse` BECAUSE THAT IS ALREADY TRUE (POD-2745), not as a
   * guess. A daemon holds no watch for a session until asked, and `coarse` is
   * the name for holding none — so starting this `undefined` made the first
   * reconcile treat "still coarse" as a crossing and send a frame telling the
   * daemon to be what it already was. That fired for EVERY session on any
   * transcript-subscription lifecycle event, including plain `detachClient` on a
   * session nobody had ever opened a chat on, which is how a PTY session with no
   * viewer ended up producing runtime traffic the moment this plane's default
   * flipped on.
   *
   * The field's meaning is what makes {@link resetWatchLevel} necessary: it is a
   * claim about ANOTHER PROCESS's state, so anything that resets that process
   * has to reset this with it.
   */
  private watchLevelSent: 'coarse' | 'fine' = 'coarse'
  private readonly clients = new Map<string, ClientConn>()
  private readonly clientAttributions = new WeakMap<ClientConn, ReturnType<typeof perfPrincipal>>()
  private readonly outputLog: { seq: number; bytes: Buffer }[] = []
  private outputLogBytes = 0
  private transcript: TranscriptItem[] = []
  /** Complete items committed through the runtime event log. Kept separately
   * so a legacy tail reset cannot erase the shared terminal bridge. */
  private runtimeTranscript: TranscriptItem[] = []
  private transcriptAvailable = false
  private readonly transcriptSubscribers = new Map<string, ClientConn>()
  /**
   * THE LATEST PREVIEW FRAME, AND ONLY THE LATEST (POD-2293).
   *
   * One slot, newest wins — which IS the backpressure policy rather than a
   * simplification of one. Every frame is a complete snapshot of the in-progress
   * turn, so a client that missed the last three has lost nothing by receiving
   * only the fourth, and a client subscribing mid-turn is caught up by replaying
   * this one. A queue here would buy ordering nobody needs and would grow under
   * exactly the slowness it was meant to survive.
   */
  private turnPreview: TurnPreviewMessage | undefined

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
    // A FRESH ATTACH IS A FRESH CONVERSATION ABOUT THIS SESSION, so the viewport
    // watermark starts over (POD-3239 B6).
    //
    // The seq counter lives on the CLIENT's `SessionConnection`, and a detach
    // destroys that object — so the next attach legitimately starts again at 1.
    // One socket can attach, detach and re-attach a session (the panel remounts
    // its terminal whenever its mount gate flips), and a watermark that survived
    // that would reject every request the new attachment ever makes as a
    // duplicate: silently, forever, with the pane stuck at whatever size it
    // happened to have. Clearing it here is what keeps "dies with the
    // connection" true of the attachment rather than only of the socket.
    client.viewportSeq.delete(this.init.sessionId)
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
      geometryRevision: this.geometryRevision,
      // What that geometry is worth (MODEL rule 6). The client renders
      // last-known while this is `unknown`; only `absent` means "no buffer".
      geometryState: this.init.geometryState?.() ?? (this.geometryKnown ? 'current' : 'unknown'),
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
      replayBytes += frame.bytes.byteLength
      this.sendOutput(client, frame.seq, frame.bytes, false)
    }
    perf.record(
      'phase',
      'attach.replay',
      performance.now() - startedAt,
      this.clientAttribution(client),
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
    if (!resumed || this.outputLog.length === 0) this.redraw(this.outputLog.length === 0)
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
    // AFTER the durable replay, never before: the preview is the part of the
    // turn the transcript does NOT have yet, so a client that received it first
    // would briefly show the in-progress rows above the items they follow.
    if (this.turnPreview) client.send(this.turnPreview)
    this.reconcileWatchLevel()
  }

  unsubscribeTranscript(clientId: string): void {
    this.transcriptSubscribers.delete(clientId)
    this.reconcileWatchLevel()
  }

  /**
   * Tell the daemon what this session's viewers need.
   *
   * SUBSCRIBER-DRIVEN rather than always-on: a fine watch costs a token stream
   * per session, and on codex it costs a reconnect to acquire — paying that for
   * sessions nobody is looking at is the exact cost the two watch levels exist
   * to avoid. The frame carries a desired STATE, so calling this on every
   * crossing (and only on crossings) is safe: a duplicate is a no-op and a lost
   * one is corrected by the next.
   *
   * Sent for EVERY session, contract or not. Deciding whether a fine watch means
   * anything is the daemon's job — it holds the driver and its capability
   * declaration — and a server that guessed would be wrong for exactly the
   * sessions whose family it could not see. What bounds the blast radius is not
   * the family but the VIEWER: a session nobody opens a chat on never crosses,
   * so it sends nothing at all, whatever it is running (POD-2745).
   */
  private reconcileWatchLevel(): void {
    if (!this.init.turnPreviewEnabled) return
    const wanted = this.transcriptSubscribers.size > 0 ? 'fine' : 'coarse'
    if (wanted === this.watchLevelSent) return
    this.watchLevelSent = wanted
    this.init.toDaemon({ type: 'runtimeWatch', sessionId: this.init.sessionId, level: wanted })
  }

  /**
   * A daemon just (re)bound this session — forget what the old one was told.
   *
   * A DAEMON THAT RESTARTED HOLDS NO WATCHES (POD-2745). Its watch registry is
   * per-process and its release functions belonged to handles that no longer
   * exist, so a reattached daemon is at `coarse` for everything by definition.
   * `watchLevelSent` is a claim about that process, and it outlived it: a viewer
   * who had a chat open across a daemon restart left this reading `fine`, every
   * later reconcile agreed with itself, and no frame was ever sent again. The
   * viewer's stream stopped and nothing said so — the same "a watcher gets
   * nothing" failure this issue is about, reached by a different road.
   *
   * Resetting and re-reconciling in one step is what makes it self-healing: the
   * re-ask happens only if a viewer is still there, and a session nobody is
   * watching goes back to sending nothing.
   */
  resetWatchLevel(): void {
    this.watchLevelSent = 'coarse'
    this.reconcileWatchLevel()
  }

  /** Fan one preview frame out, and retain it for whoever subscribes next. A
   *  terminal frame clears the slot rather than filling it — there is nothing
   *  left to catch a late subscriber up on. */
  applyTurnPreview(frame: TurnPreviewMessage): void {
    this.turnPreview = frame.done ? undefined : frame
    for (const client of this.transcriptSubscribers.values()) client.send(frame)
  }

  transcriptItems(): TranscriptItem[] {
    return this.transcript
  }

  runtimeTranscriptItems(): TranscriptItem[] {
    return this.runtimeTranscript
  }

  applyRuntimeDelta(items: TranscriptItem[]): boolean {
    this.runtimeTranscript = mergeTranscriptItems(this.runtimeTranscript, items)
    return this.applyDelta(items, {})
  }

  applyDelta(items: TranscriptItem[], opts: { reset?: boolean; tail?: string }): boolean {
    const becameAvailable =
      !this.transcriptAvailable && (items.length > 0 || this.transcript.length > 0)
    if (becameAvailable) {
      this.transcriptAvailable = true
      this.init.onTranscriptAvailable?.()
    }
    const deltaItems = opts.reset ? mergeTranscriptItems(items, this.runtimeTranscript) : items
    this.transcript = mergeTranscriptItems(opts.reset ? [] : this.transcript, deltaItems)
    const delta: ServerMessage = {
      type: 'transcriptDelta',
      sessionId: this.init.sessionId,
      items: deltaItems,
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
    client?.viewportSeq.delete(this.init.sessionId)
    this.clients.delete(clientId)
    this.transcriptSubscribers.delete(clientId)
    this.reconcileWatchLevel()
    if (this.controllerId !== clientId) return
    // If the departure leaves one measured native renderer, hand it control
    // through the same atomic controller+geometry path as an explicit claim.
    // Otherwise clients would briefly receive "controller" at the departed
    // desktop's grid, followed by a separate phone geometry correction.
    const [soleRenderer, secondRenderer] = this.activeNativeRenderers()
    if (soleRenderer && !secondRenderer && soleRenderer.viewports.has(this.init.sessionId)) {
      this.requestControl(soleRenderer.id)
      return
    }
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
        geometryRevision: this.geometryRevision,
      })
    } else {
      this.clearController()
    }
  }

  detachAll(): void {
    for (const client of this.clients.values()) client.viewports.delete(this.init.sessionId)
    this.clients.clear()
    this.transcriptSubscribers.clear()
    // The retained frame goes with the viewers. It describes a turn that may
    // well have ended by the time anyone comes back, and a stale preview
    // replayed to a fresh subscriber is a session that looks like it is typing.
    this.turnPreview = undefined
    this.reconcileWatchLevel()
    this.clearController()
  }

  handleInput(clientId: string, data: string, attribution?: Attribution): void {
    this.handleInputBytes(clientId, Buffer.from(data, 'base64'), attribution)
  }

  handleInputBytes(clientId: string, bytes: Uint8Array, attribution?: Attribution): void {
    if (bytes.byteLength === 0) return
    if (clientId !== this.controllerId) return
    if (this.init.agentKind === 'shell' && submitsCommandLine(bytes)) {
      this.shellCommandRunning = true
      this.markShellBusy()
    }
    this.recordInputActivity()
    // Live-only keystroke attribution (POD-1081 §2). Durable retention is the
    // inbox/chat path, not the per-keystroke PTY stream.
    if (attribution) this.lastInputAttribution = attribution
    const input: DaemonPtyInputBatch = {
      sessionId: this.init.sessionId,
      inputOrigin: 'human',
      bytes,
      ...(attribution ? { attribution } : {}),
    }
    if (this.init.sendInput) {
      this.init.sendInput(input)
      return
    }
    this.init.toDaemon({
      type: 'input',
      sessionId: input.sessionId,
      data: Buffer.from(input.bytes).toString('base64'),
      inputOrigin: input.inputOrigin,
      ...(input.attribution ? { attribution: input.attribution } : {}),
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
      geometryRevision: this.geometryRevision,
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

  /**
   * THE ONE ASK (POD-3239 B6 / MODEL rules 3 and 4).
   *
   * A viewer measured its box and would like the pty to be that size. This
   * method decides whether to forward the ask; it does NOT decide what anyone
   * renders, and — on a daemon that reports — it does not write W either. The
   * daemon's `geometryApplied` does that.
   *
   * The order below is the contract:
   *
   *   1. WATERMARK first. A `seq` at or below what this (connection, session)
   *      has already processed is a duplicate: counted, and nothing about it is
   *      applied — including the viewport record, because an out-of-order old
   *      request carries an out-of-date box.
   *   2. RECORD the viewport, before any gate can return. `reconcileActiveRenderer`
   *      promotes a sole native renderer only when it has one, so a refusal that
   *      also forgot the measurement would silently disable that promotion (0b's
   *      C4 narrowing).
   *   3. GATE on `visible`/`mode` READ FROM THE MESSAGE, not from stored
   *      `viewState`. A request can legitimately overtake the `viewState` frame
   *      that announces the same reveal, and judging it on state that has not
   *      arrived yet is how a correct request gets dropped for being early.
   *   4. FORWARD, only when the geometry differs from W. A claim at an unchanged
   *      size is a claim, not a resize — re-sending the same winsize raises a
   *      SIGWINCH and flashes the TUI for nothing.
   *
   * Returns whether the controller changed, which is what the caller broadcasts
   * session rows for.
   */
  handleViewportRequest(clientId: string, request: ViewportRequest): boolean {
    const sessionId = this.init.sessionId
    const client = this.clients.get(clientId)
    if (!client) {
      // NOT A REFUSAL, AND NOT A SILENT DROP EITHER. There is no viewer here to
      // have been refused — this connection is not attached to this session, so
      // it is not counted against {@link requestsGated}, which measures refusals
      // of real renderers. It IS named, because a request arriving in the window
      // between a detach and the re-attach that follows it is exactly the kind
      // of thing that used to vanish without a word.
      log.debug('request:unattached', { sessionId, clientId, geometry: request.geometry })
      return false
    }

    const watermark = client.viewportSeq.get(sessionId) ?? 0
    if (request.seq <= watermark) {
      this.requestsDuplicate += 1
      log.debug('request:duplicate', {
        sessionId,
        clientId,
        seq: request.seq,
        watermark,
      })
      return false
    }
    // Advanced for a GATED request too: it was processed — we looked at it and
    // decided — so a later request must carry a higher seq to be new.
    client.viewportSeq.set(sessionId, request.seq)
    client.viewports.set(sessionId, { ...request.geometry })

    if (request.claimControl) {
      // The message's own `visible` travels with the claim, for the same reason
      // the gate below reads it: a reveal sends its `viewState` and its claim in
      // the same tick, and either can arrive first. `requestControl` otherwise
      // reads the connection's STORED visibility, which would refuse the
      // geometry on the claim that overtook it — transferring control and
      // leaving the pty at the grid the previous viewer had.
      this.requestControl(clientId, request.geometry, request.visible && request.mode === 'native')
      return true
    }
    if (!request.visible || request.mode !== 'native') {
      this.gateRequest(clientId, request, request.visible ? 'not-native' : 'not-visible')
      return false
    }
    if (clientId !== this.controllerId) {
      this.gateRequest(clientId, request, 'not-controller')
      return false
    }
    this.driveGeometry(request.geometry)
    return false
  }

  /**
   * A viewport request that will not be forwarded, counted and named.
   *
   * The measurement it carried is already recorded by the caller, which is the
   * part `reconcileActiveRenderer` needs; what is refused is the drive.
   */
  private gateRequest(clientId: string, request: ViewportRequest, reason: string): void {
    this.requestsGated += 1
    // `request:gated` — the same token the client traces use, so a session's
    // refusals can be read against its asks on one timeline (POD-3239).
    log.debug('request:gated', {
      sessionId: this.init.sessionId,
      clientId,
      reason,
      geometry: request.geometry,
      requestsGated: this.requestsGated,
    })
  }

  /**
   * Ask the daemon to make the pty this size — the ONLY thing an accepted
   * request does to geometry when the daemon reports.
   *
   * Nothing is written here and nothing is broadcast: `geometryApplied` comes
   * back and {@link applyDaemonGeometry} does both. The one compatibility branch
   * is for a daemon that never sends that frame, where the server has to keep
   * writing W itself or W would never move again.
   *
   * A request equal to W is not forwarded at all. That is what stops a reveal's
   * always-send claim (rule 4) from costing a SIGWINCH.
   */
  private driveGeometry(geometry: Geometry): void {
    if (geometry.cols === this.geometry.cols && geometry.rows === this.geometry.rows) return
    this.init.toDaemon({
      type: 'resize',
      sessionId: this.init.sessionId,
      cols: geometry.cols,
      rows: geometry.rows,
    })
    if (this.init.daemonReportsGeometry?.() === true) return
    this.setGeometry(geometry.cols, geometry.rows)
    this.announceGeometry()
  }

  /**
   * Today's `resize` frame, in the new vocabulary (POD-3239 B6).
   *
   * An installed client still sends it, so it keeps working — as a request that
   * claims nothing, with `visible`/`mode` taken from the stored `viewState`
   * because that frame has no fields of its own to carry them. Its `seq` is 0,
   * which is below every watermark and therefore never advances one: a legacy
   * client and a new client on the same connection cannot fight over the
   * counter, and repeated legacy resizes are not mistaken for duplicates.
   */
  handleResize(clientId: string, cols: number, rows: number): void {
    const client = this.clients.get(clientId)
    if (!client) return
    const sessionId = this.init.sessionId
    client.viewports.set(sessionId, { cols, rows })
    const visible = client.viewVisible.has(sessionId)
    const mode = client.viewModes[sessionId] ?? 'native'
    if (!visible || mode !== 'native') {
      this.gateRequest(clientId, legacyRequest({ cols, rows }, visible, mode), visible ? 'not-native' : 'not-visible')
      return
    }
    if (clientId !== this.controllerId) {
      this.gateRequest(clientId, legacyRequest({ cols, rows }, visible, mode), 'not-controller')
      return
    }
    this.driveGeometry({ cols, rows })
  }

  /**
   * A client became a visible native renderer and already has a measurement on
   * file — reconcile the pty to it.
   *
   * Same forward-don't-write rule as every other request path; the difference is
   * only where the number came from.
   */
  reconcileGeometry(clientId: string): void {
    const client = this.clients.get(clientId)
    if (!client || clientId !== this.controllerId || !client.viewVisible.has(this.init.sessionId)) {
      return
    }
    const viewport = client.viewports.get(this.init.sessionId)
    if (!viewport) return
    this.driveGeometry(viewport)
  }

  /** Connections that currently render the native terminal. Presence rooms are
   * person-scoped; this list is deliberately device/connection-scoped so one
   * person's desktop and phone both participate in geometry policy. */
  activeNativeRenderers(): readonly ClientConn[] {
    return [...this.clients.values()].filter(
      (client) =>
        client.viewVisible.has(this.init.sessionId) &&
        (client.viewModes[this.init.sessionId] ?? 'native') === 'native',
    )
  }

  /**
   * Claim control, and (if the claimer asked for a size) forward that size.
   *
   * TWO THINGS THAT USED TO BE ONE. The transfer is a control-plane fact and is
   * broadcast here, as it always was. The geometry is a REQUEST: it goes to the
   * daemon and comes back as a report (POD-3239 B6). Nothing on this path writes
   * W any more, so the `controllerChanged` frame carries the current cached W —
   * it describes who is driving, never what size the pty is now.
   *
   * `visible` defaults to the connection's stored `viewState`, because a claim
   * can arrive on the legacy `requestControl` frame, which carries no visibility
   * of its own. A `viewportRequest` passes its OWN — see the caller.
   */
  requestControl(clientId: string, claimedGeometry?: Geometry, visible?: boolean): void {
    const client = this.clients.get(clientId)
    if (!client) return
    if (claimedGeometry) client.viewports.set(this.init.sessionId, { ...claimedGeometry })

    const transferred = this.controllerId !== clientId
    if (transferred) {
      // Preemptive transfer — current controller cannot refuse (policy §3).
      this.setController(clientId, client)
      this.epoch += 1
    }

    const viewport = claimedGeometry ?? client.viewports.get(this.init.sessionId)
    const geometryDiffers =
      viewport !== undefined &&
      (this.geometry.cols !== viewport.cols || this.geometry.rows !== viewport.rows)
    const rendering = visible ?? client.viewVisible.has(this.init.sessionId)
    if (rendering && viewport) {
      this.driveGeometry(viewport)
      // Today's redraw rule, unchanged: a transfer repaints for the new owner,
      // and a size change asks the agent to repaint at it. A claim at an
      // unchanged size needs neither — the revealing client recovers its own
      // canvas locally, which is what `reveal()`'s repaint is for.
      if (transferred || geometryDiffers) {
        this.init.toDaemon({ type: 'redraw', sessionId: this.init.sessionId })
      }
    }
    if (transferred) {
      this.broadcast({
        type: 'controllerChanged',
        sessionId: this.init.sessionId,
        controllerId: clientId,
        controllerIdentity: this.controllerIdentity,
        geometry: { ...this.geometry },
        geometryRevision: this.geometryRevision,
      })
    }
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

  redraw(replayRequired = false): void {
    this.init.toDaemon({
      type: 'redraw',
      sessionId: this.init.sessionId,
      ...(replayRequired ? { replayRequired: true } : {}),
    })
  }

  onFrame(data: string): void {
    this.acceptOutput(Buffer.from(data, 'base64'), 1)
  }

  /** Preserve the daemon's scheduling batch through the client websocket.
   * PTY output is a byte stream, so frame boundaries carry no semantics; one
   * server sequence and one client send represent the concatenated bytes while
   * the durable activity counter still records every source frame. */
  onFrames(frames: readonly string[]): void {
    if (frames.length === 0) return
    if (frames.length === 1) {
      this.onFrame(frames[0]!)
      return
    }
    const bytes = Buffer.concat(frames.map((data) => Buffer.from(data, 'base64')))
    this.acceptOutput(bytes, frames.length)
  }

  acceptOutput(bytes: Uint8Array, sourceFrames: number): void {
    if (
      !Number.isSafeInteger(sourceFrames) ||
      sourceFrames < 1 ||
      sourceFrames > DAEMON_PTY_OUTPUT_MAX_SOURCE_FRAMES
    )
      throw new RangeError(
        `terminal output requires sourceFrames in 1..${DAEMON_PTY_OUTPUT_MAX_SOURCE_FRAMES}`,
      )
    const normalized = Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const seq = this.nextSeq++
    this.bufferFrame(seq, normalized)
    const fanout: OutputFanout = {}
    for (const client of this.clients.values())
      this.sendOutput(client, seq, normalized, true, fanout)
    this.outputAtMs_ = Date.now()
    this.outputCount_ += sourceFrames
    this.activityDirty_ = true
    if (this.init.agentKind === 'shell' && this.shellCommandRunning) this.markShellBusy()
  }

  stopOutput(): void {
    if (this.shellBusyTimer) clearTimeout(this.shellBusyTimer)
    this.shellBusyTimer = undefined
    this.shellBusy_ = false
    this.shellCommandRunning = false
  }

  /**
   * THE DAEMON'S REPORT OF THE GRID IT APPLIED (MODEL rule 5).
   *
   * The daemon dispatched a resize to the pty and is telling us what it
   * dispatched. That report — and the bind report — are the only things that may
   * move W, so this method is a WRITE, not a proposal: it takes the number as
   * given and announces it.
   *
   * The broadcast is unconditional, including when the grid did not move. A
   * report is news even at the same size: it is what turns a viewer's `unknown`
   * into `current`, and a viewer that asked for a size it already had learns
   * here that the ask was answered.
   */
  applyDaemonGeometry(geometry: Geometry): void {
    this.setGeometry(geometry.cols, geometry.rows)
    // A report is what makes W KNOWN — the `unknown` → `current` edge of rule 6.
    this.geometryKnown = true
    this.announceGeometry()
  }

  /**
   * The daemon holding this session is gone, so nothing confirms W any more
   * (MODEL rule 6). The geometry itself is KEPT and still renders — inside the
   * system it can only change through a daemon, so last-known stays right until
   * the first ask corrects it. What is lost is the confirmation.
   */
  markGeometryUnknown(): void {
    this.geometryKnown = false
  }

  /** The `geometry` frame for the current cached W. The only place one is built. */
  private announceGeometry(): void {
    this.broadcast({
      type: 'geometry',
      sessionId: this.init.sessionId,
      cols: this.geometry.cols,
      rows: this.geometry.rows,
      geometryRevision: this.geometryRevision,
    })
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
    // A durable-write rollback is still a live geometry transition. Keep the
    // revision timeline monotonic and announce the restored grid instead of
    // copying state.grid behind an already-emitted revision.
    //
    // CLIENTS ONLY — no `resize` to the daemon (POD-3239 B6). The rollback undoes
    // what the SERVER believed; the pty never moved, so telling it to move now
    // would be this path inventing a resize nobody asked for.
    if (
      !preserveGeometry &&
      (this.geometry.cols !== state.grid.cols || this.geometry.rows !== state.grid.rows)
    ) {
      this.setGeometry(state.grid.cols, state.grid.rows)
      this.announceGeometry()
    }
    // THE LIVE HALF IS NOT REWOUND [POD-3259, spec §3.6]. `times`, `counts`,
    // `dirty` and `shell` are observations of a pty, not fields the failed
    // metadata write was about, and they MAY change while persistence is
    // awaiting — a process does not stop producing output because a row is
    // being written. Putting them back would discard activity that really
    // happened, and `dirty: false` in particular would tell `flushActivity`
    // there is nothing to write, losing the counter advance until the next
    // frame arrives. Today this changes nothing: capture and restore are one
    // uninterruptible pair, so the values are identical either way. It is
    // written now so the rollback is right once the commit between them can
    // await. The grid above IS restored, because a rollback undoes what the
    // SERVER believed about geometry and the clients cached that belief.
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
    this.geometryRevision += 1
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

  private bufferFrame(seq: number, bytes: Buffer): void {
    if (SCREEN_RESET.test(bytes.toString('latin1'))) {
      this.outputLog.length = 0
      this.outputLogBytes = 0
    }
    // Own only the payload bytes. Binary envelope decoding returns a zero-copy
    // view, so retaining that view would pin the entire websocket frame.
    const retained = Buffer.from(bytes)
    this.outputLog.push({ seq, bytes: retained })
    this.outputLogBytes += retained.byteLength
    while (
      (this.outputLogBytes > MAX_REPLAY_BYTES || this.outputLog.length > MAX_REPLAY_FRAMES) &&
      this.outputLog.length > 1
    ) {
      const dropped = this.outputLog.shift()
      if (dropped) this.outputLogBytes -= dropped.bytes.byteLength
    }
  }

  /** Convert the canonical bytes only at one recipient's negotiated edge. */

  private sendOutput(
    client: ClientConn,
    seq: number,
    bytes: Buffer,
    lossy: boolean,
    shared?: OutputFanout,
  ): boolean {
    const attribution = this.clientAttribution(client)
    const fanout = shared ?? {}
    if (client.caps.has(CAP_TERMINAL_OUTPUT_BINARY_V1) && client.sendBinary) {
      let frame = fanout.binary
      if (!frame) {
        frame = encodeBinaryEnvelope(
          {
            v: 1,
            type: 'ptyOutput',
            sessionId: this.init.sessionId,
            seq,
            epoch: this.epoch,
          },
          bytes,
        )
        fanout.binary = frame
      }
      let sent = true
      if (lossy && client.sendBinaryStream) sent = client.sendBinaryStream(frame)
      else client.sendBinary(frame)
      if (sent) perf.record('phase', 'terminal.output.binary', 0, attribution, bytes.byteLength)
      return sent
    }

    let message = fanout.legacy
    if (!message) {
      message = {
        type: 'outputFrame',
        sessionId: this.init.sessionId,
        seq,
        epoch: this.epoch,
        data: bytes.toString('base64'),
      }
      fanout.legacy = message
    }
    let sent = true
    if (lossy && client.sendStream) sent = client.sendStream(message)
    else client.send(message)
    if (sent) perf.record('phase', 'terminal.output.base64', 0, attribution, bytes.byteLength)
    return sent
  }

  private clientAttribution(client: ClientConn): ReturnType<typeof perfPrincipal> {
    const cached = this.clientAttributions.get(client)
    if (cached) return cached
    const attribution = perfPrincipal(feedPrincipalOf(client.principal))
    this.clientAttributions.set(client, attribution)
    return attribution
  }

  private seedMs(value: string | null | undefined): number {
    const parsed = value ? Date.parse(value) : 0
    return Number.isNaN(parsed) ? 0 : parsed
  }
}
