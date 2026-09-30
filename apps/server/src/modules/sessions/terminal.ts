import { createLogger } from '@podium/logger'
import type { AgentKind, Attribution, Geometry, SessionId, TranscriptItem } from '@podium/model'
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
import {
  type SendOutcome,
  type SendSequenceSource,
  SequenceBinary,
} from '../../gateway/ordered-client-send'
import { perfPrincipal } from '../perf/principal'
import { perf } from '../perf/registry'
import { type CachedPicture, PictureCache } from './picture-cache'
import type { Send } from './session'
import { controlSubjectFromClient, identityOf } from './session-control-policy'

const log = createLogger('server:sessions:terminal')

const MAX_TRANSCRIPT_ITEMS = 12_000
const SHELL_BUSY_WINDOW_MS = 4000
/** A viewer owed a catch-up with nothing to serve asks the daemon after this (H2). */
const STALE_OWED_MS = 1000

function sameGeometry(a: Geometry, b: Geometry | undefined): boolean {
  return b !== undefined && a.cols === b.cols && a.rows === b.rows
}

function submitsCommandLine(bytes: Uint8Array): boolean {
  return bytes.includes(0x0d) || bytes.includes(0x0a)
}

/**
 * Merge logical transcript rows by item.id, the stable identity contract.
 * Cursor aliases are a compatibility safety net for previously emitted rows;
 * cursor rotation never changes item identity. A disjoint-set pass joins aliases in
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
  }
  // Resolve primary identities first. Cursor aliases only bridge remaining roots.
  for (const [index, itemAliases] of aliases.entries()) {
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
    return { item, order: root.order, position: root.winner }
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
    // Equal retained orders can occur when an item is reused in another merge.
    // Preserve this merge's observed order; opaque cursors have no sort meaning.
    return a.position - b.position
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
  const allItems = mergeTranscriptItems(providerItems, runtimeItems, Number.MAX_SAFE_INTEGER)
  return {
    items: boundedLimit === 0 ? [] : allItems.slice(-boundedLimit),
    hasMore: allItems.length > boundedLimit,
  }
}

interface OutputFanout {
  binary?: Uint8Array
  legacy?: ServerMessage
}

/** A picture from the daemon, as the output path carries it (POD-4912). */
export interface TerminalPicture {
  reason: 'reset' | 'cut'
  cols: number
  rows: number
  bytes: Uint8Array
}

/** Why a viewer became owed — named in the log line, never branched on. */
type OweTrigger = 'attach' | 'drop' | 'reset' | 'epoch' | 'redraw'

/**
 * A VIEWER THAT MISSED OUTPUT (POD-4912). While owed it gets no live bytes;
 * it is served the latest picture and the tail after it, and is no longer
 * owed the moment that serve ends.
 */
interface OwedViewer {
  readonly since: number
  readonly trigger: OweTrigger
  /** The serve in flight, if one is. */
  serve?: { cancel(): void }
  /** Owed again while a serve was in flight: end it and serve the latest. */
  again: boolean
}

/**
 * A viewer's box statement, as the server reads a `viewportRequest`: the box it
 * measured, and whether it also claims control.
 *
 * The frame's `visible`/`mode` are NOT read (POD-4771). Visibility has one
 * source, the connection's `viewState`; a statement that overtakes the
 * `viewState` announcing the same reveal is recorded, and that `viewState` is a
 * reconcile trigger of its own, so nothing is lost by waiting for it. Its `seq`
 * is not read either: one ordered socket per connection needs no watermark.
 */
export interface ViewportRequest {
  geometry: Geometry
  claimControl: boolean
}

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
  /**
   * THE SERVER'S COPY of the pty's size (POD-3190 design rev 3).
   *
   * Written only by the daemon's report and its bind ({@link applyDaemonGeometry},
   * {@link bind}), both of which carry the kernel's size as the host read it.
   * A forward never writes it, and neither does a durable-write rollback.
   * Whether it is backed by a live pty is the session's `live`, not a flag here.
   */
  geometry: Geometry
  epoch = 0
  /**
   * The last size this server asked the daemon for (rule 2).
   *
   * Written by a forward, and by a bind (set to the size the bind carries, or
   * cleared by a bind that carries none). It is what makes a repeat free: a
   * reveal, a rebind or a controller change forwards only a box that differs
   * from it. It exists for the backends that are not the host: vendored abduco
   * signals the child on every resize packet, same size or not.
   */
  private lastForwarded: Geometry | undefined
  /**
   * HOW MANY VIEWPORT STATEMENTS THIS SESSION DID NOT FORWARD because their
   * sender was not the visible native controller (POD-3239 B6). Counted so a
   * pane stuck at a stale grid can be told apart from one that never asked.
   */
  requestsGated = 0
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
  /**
   * THE LAST BIND'S `pictures` (POD-4912): the daemon forwards its host's
   * pictures for this session, and viewers are served from them. `undefined`
   * until a daemon has bound this session (and again after its link
   * detached): an attach waits for that bind to decide between pictures and
   * live bytes.
   */
  private pictures: boolean | undefined
  /** The program exited: the last screen stays servable across a detach. */
  private exited = false
  private readonly pictureCache: PictureCache
  private readonly owed = new Map<string, OwedViewer>()
  private readonly dropHandlers = new WeakMap<ClientConn, () => void>()
  private nudgeTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly init: SessionTerminalInit) {
    this.pictureCache = new PictureCache(init.sessionId)
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

  attachClient(client: ClientConn): void {
    this.clients.set(client.id, client)
    if (this.controllerId === null) {
      this.setController(client.id, client)
      this.reconcile()
    }
    client.send({
      type: 'attached',
      sessionId: this.init.sessionId,
      controllerId: this.controllerId,
      controllerIdentity: this.controllerIdentity,
      geometry: { ...this.geometry },
      epoch: this.epoch,
      resumed: true,
      outputSeen: this.outputCount_ > 0,
    })
    // Before the first bind, wait for it to decide. Picture sessions get the
    // picture and tail; a bind without pictures releases viewers to live bytes.
    this.owe(client.id, 'attach')
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

  applyRuntimeDelta(items: TranscriptItem[], opts: { reset?: boolean; tail?: string } = {}): boolean {
    this.runtimeTranscript = mergeTranscriptItems(opts.reset ? [] : this.runtimeTranscript, items)
    return this.applyDelta(items, opts)
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
    this.release(clientId)
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
      })
      this.reconcile()
    } else {
      this.clearController()
    }
  }

  detachAll(): void {
    for (const client of this.clients.values()) client.viewports.delete(this.init.sessionId)
    for (const clientId of [...this.owed.keys()]) this.release(clientId)
    this.stopNudge()
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
   * A VIEWPORT STATEMENT: a viewer measured its box (POD-3239 B6, POD-4771).
   *
   * Recorded first, whoever sent it and whatever it is showing — a spectator's
   * box is exactly what a later controller change reconciles against, and what
   * `reconcileActiveRenderer` needs to promote a sole renderer. A claim then
   * takes control; anything else just reconciles.
   *
   * Returns whether the controller changed, which is what the caller broadcasts
   * session rows for.
   */
  handleViewportRequest(clientId: string, request: ViewportRequest): boolean {
    const client = this.clients.get(clientId)
    if (!client) {
      // Not a refusal: this connection is not attached to this session, so
      // there is no viewer to have been refused. Named, because a statement in
      // the window between a detach and its re-attach used to vanish unseen.
      log.debug('request:unattached', {
        sessionId: this.init.sessionId,
        clientId,
        geometry: request.geometry,
      })
      return false
    }
    if (request.claimControl) {
      this.requestControl(clientId, request.geometry)
      return true
    }
    this.state(client, request.geometry)
    return false
  }

  /** The legacy `resize` frame: a statement that claims nothing. */
  handleResize(clientId: string, cols: number, rows: number): void {
    const client = this.clients.get(clientId)
    if (client) this.state(client, { cols, rows })
  }

  /** Record a statement, count it if its sender cannot drive, and reconcile. */
  private state(client: ClientConn, geometry: Geometry): void {
    client.viewports.set(this.init.sessionId, { ...geometry })
    if (client.id !== this.controllerId || !this.rendersNative(client)) {
      this.requestsGated += 1
      // `request:gated` — the same token the client traces use, so a session's
      // statements can be read against its asks on one timeline (POD-3239).
      log.debug('request:gated', {
        sessionId: this.init.sessionId,
        clientId: client.id,
        reason: client.id !== this.controllerId ? 'not-controller' : 'not-visible-native',
        geometry,
        requestsGated: this.requestsGated,
      })
    }
    this.reconcile()
  }

  /**
   * RULE 2, THE ONE RECONCILE (POD-3190 design rev 3).
   *
   * If the controller is visible and native, and its viewport differs from
   * {@link lastForwarded}: forward it, and remember it. Run on a viewport
   * statement, a controller change (including a `viewState` that reveals or
   * hides a pane), a bind and a terminal's birth report — never on an ordinary
   * report, so it cannot loop.
   *
   * Level-triggered, which is what repairs a lost ask without a timer or a
   * retry: an ask lost on link A is restated by the browser's reconnect; one
   * lost on link B is re-driven by the daemon's next bind, and one the daemon
   * dropped for want of a terminal by that terminal's birth report — both reset
   * {@link lastForwarded} to the size the pty really has. A refused ask is not
   * re-sent: nothing here reads the copy.
   */
  reconcile(): void {
    const controller = this.controllerId === null ? undefined : this.clients.get(this.controllerId)
    if (!controller || !this.rendersNative(controller)) return
    const viewport = controller.viewports.get(this.init.sessionId)
    if (!viewport || sameGeometry(viewport, this.lastForwarded)) return
    this.lastForwarded = { ...viewport }
    this.init.toDaemon({
      type: 'resize',
      sessionId: this.init.sessionId,
      cols: viewport.cols,
      rows: viewport.rows,
    })
  }

  /** THE ONE SOURCE OF VISIBILITY: the connection's stored `viewState`. */
  private rendersNative(client: ClientConn): boolean {
    const sessionId = this.init.sessionId
    return (
      client.viewVisible.has(sessionId) && (client.viewModes[sessionId] ?? 'native') === 'native'
    )
  }

  /** Connections that currently render the native terminal. Presence rooms are
   * person-scoped; this list is deliberately device/connection-scoped so one
   * person's desktop and phone both participate in geometry policy. */
  activeNativeRenderers(): readonly ClientConn[] {
    return [...this.clients.values()].filter((client) => this.rendersNative(client))
  }

  /**
   * Claim control, optionally stating a box with the claim.
   *
   * The transfer is a control-plane fact and is broadcast here; the size is not
   * (the `controllerChanged` frame carries the current copy — who drives, never
   * what size the pty is now). A controller change is a reconcile trigger, so
   * the new controller's box is forwarded if it differs from what was last
   * asked. No redraw: the size change, if any, repaints the child itself.
   */
  requestControl(clientId: string, claimedGeometry?: Geometry): void {
    const client = this.clients.get(clientId)
    if (!client) return
    if (claimedGeometry) client.viewports.set(this.init.sessionId, { ...claimedGeometry })
    if (this.controllerId !== clientId) {
      // Preemptive transfer — current controller cannot refuse (policy §3).
      this.setController(clientId, client)
      this.epoch += 1
      this.broadcast({
        type: 'controllerChanged',
        sessionId: this.init.sessionId,
        controllerId: clientId,
        controllerIdentity: this.controllerIdentity,
        geometry: { ...this.geometry },
      })
      // A viewer clears its screen on a new epoch: serve every one of them the
      // picture instead of leaving it blank (POD-4912).
      this.oweAll('epoch')
    }
    this.reconcile()
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

  /**
   * THE USER'S REDRAW (POD-4912): the requester is owed and served the
   * picture again. Only the controller's also reaches the program, as a
   * Ctrl-L — a spectator must never make the program redraw.
   */
  redrawRequest(clientId: string): void {
    if (!this.clients.has(clientId)) return
    this.owe(clientId, 'redraw')
    if (clientId === this.controllerId) this.redraw({ hard: true })
  }

  /**
   * Ask the daemon to repaint the viewers. `replayRequired`: the server holds
   * no servable picture, so the daemon must request a fresh one from the host.
   * `hard`: the user pressed redraw — the one repaint that reaches the program,
   * as a Ctrl-L. Every other redraw leaves the child alone.
   */
  redraw(opts: { replayRequired?: boolean; hard?: boolean } = {}): void {
    this.init.toDaemon({
      type: 'redraw',
      sessionId: this.init.sessionId,
      ...(opts.replayRequired ? { replayRequired: true } : {}),
      ...(opts.hard ? { hard: true } : {}),
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
    this.pictureCache.appendData(seq, normalized)
    const fanout: OutputFanout = {}
    for (const client of this.clients.values()) {
      // An owed viewer gets these bytes in its tail, not live.
      if (this.owed.has(client.id)) continue
      this.sendOutput(client, seq, normalized, true, fanout, this.dropHandler(client))
    }
    this.outputAtMs_ = Date.now()
    this.outputCount_ += sourceFrames
    this.activityDirty_ = true
    if (this.init.agentKind === 'shell' && this.shellCommandRunning) this.markShellBusy()
  }

  stopOutput(): void {
    this.exited = true
    this.stopNudge()
    if (this.shellBusyTimer) clearTimeout(this.shellBusyTimer)
    this.shellBusyTimer = undefined
    this.shellBusy_ = false
    this.shellCommandRunning = false
  }

  /**
   * THE DAEMON'S REPORT: the kernel's size, as the host read it (rule 3).
   *
   * One of the two writers of {@link geometry}. It writes and broadcasts only
   * when the size moved, and it never forwards anything: a report is an answer,
   * so reconciling on it is what would make the rule able to loop.
   *
   * Returns whether the copy changed, so the caller republishes the row only
   * then.
   */
  applyDaemonGeometry(geometry: Geometry): boolean {
    if (sameGeometry(geometry, this.geometry)) return false
    this.geometry = { cols: geometry.cols, rows: geometry.rows }
    // The DB copy is lazy: the activity flush writes it with the row.
    this.activityDirty_ = true
    this.broadcast({
      type: 'geometry',
      sessionId: this.init.sessionId,
      cols: this.geometry.cols,
      rows: this.geometry.rows,
    })
    // A picture at the new size is servable now (H1).
    this.serveOwed()
    return true
  }

  /**
   * THE DAEMON BOUND THIS SESSION: a full statement after link B (re)connects,
   * or a terminal's birth report (POD-4771: a client TUI opening, a pty spawned
   * or re-adopted), which states the same fact.
   *
   * A bind with a size is a report (rule 3), and it resets {@link lastForwarded}
   * to that size, because that is what the pty really is now: any ask this
   * server sent into a dropped link was never applied. A bind without one (a
   * backend that cannot read its size back) keeps the copy and clears
   * {@link lastForwarded}. Then reconcile, which re-drives a lost ask.
   */
  bind(geometry: Geometry | undefined): void {
    this.exited = false
    this.lastForwarded = geometry ? { cols: geometry.cols, rows: geometry.rows } : undefined
    if (geometry) this.applyDaemonGeometry(geometry)
    this.reconcile()
    this.serveOwed()
  }

  /**
   * WHETHER THIS SESSION'S OUTPUT CARRIES PICTURES (POD-4912), as its bind (or
   * a terminal's birth report) states it. Set SYNCHRONOUSLY where the frame is
   * received, before anything awaits (H1): the reset picture right behind the
   * bind must find it set, whatever the bind's durable write is queued behind.
   * Without pictures, owed viewers are released to live bytes and the cache
   * goes (SPEC v4 H6).
   */
  setPictures(on: boolean): void {
    this.pictures = on
    if (on) {
      this.serveOwed()
      return
    }
    this.pictureCache.drop('unbound')
    if (this.owed.size === 0) return
    for (const clientId of [...this.owed.keys()]) this.release(clientId)
    this.stopNudge()
  }

  /**
   * A PICTURE FROM THE DAEMON (POD-4912): the host's screen at this point of
   * the output. It becomes the cache's picture; a `reset` (a request answered,
   * a resize) owes every viewer, a `cut` owes nobody. Not activity: no output
   * count, no recency, no shell busy.
   */
  acceptPicture(picture: TerminalPicture): void {
    const seq = this.nextSeq++
    this.pictureCache.putPicture(seq, picture.cols, picture.rows, picture.bytes)
    log.debug('picture', {
      sessionId: this.init.sessionId,
      reason: picture.reason,
      cols: picture.cols,
      rows: picture.rows,
      bytes: picture.bytes.byteLength,
    })
    if (picture.reason === 'reset') this.oweAll('reset')
    else this.serveOwed()
  }

  /**
   * THE DAEMON'S LINK WENT AWAY (POD-4912). A live session's cache goes with
   * it — the returning daemon rebinds and asks for a fresh picture — and until
   * that bind new viewers wait. An exited session keeps
   * its last screen.
   */
  linkDetached(): void {
    if (this.exited) return
    this.pictureCache.drop('detach')
    this.pictures = undefined
    this.stopNudge()
  }

  /** Owe one viewer, then serve whoever can be served. */
  private owe(clientId: string, trigger: OweTrigger): void {
    if (!this.markOwed(clientId, trigger)) return
    this.serveOwed()
  }

  /** Owe every viewer of a pictures session, then serve. */
  private oweAll(trigger: OweTrigger): void {
    let any = false
    for (const clientId of this.clients.keys()) any = this.markOwed(clientId, trigger) || any
    if (any) this.serveOwed()
  }

  private markOwed(clientId: string, trigger: OweTrigger): boolean {
    if (this.pictures === false || !this.clients.has(clientId)) return false
    const owed = this.owed.get(clientId)
    if (owed) {
      // A serve in flight is about an older picture: end it, serve the latest.
      if (owed.serve) owed.again = true
      return true
    }
    this.owed.set(clientId, { since: Date.now(), trigger, again: false })
    log.debug('owed', { sessionId: this.init.sessionId, clientId, trigger })
    return true
  }

  /** Stop owing a viewer (detached, or released by a bind without pictures). */
  private release(clientId: string): void {
    const owed = this.owed.get(clientId)
    if (!owed) return
    this.owed.delete(clientId)
    owed.serve?.cancel()
  }

  /**
   * THE ONE SERVE (H1): called when a picture is cached, on a bind, on a
   * geometry change, on attach and on every owe. Every owed viewer not already
   * being served is served, if the cached picture is at the session's size;
   * otherwise it waits, and the stale-owed nudge asks the daemon for a fresh
   * picture (H2).
   */
  private serveOwed(): void {
    if (this.pictures !== true || this.owed.size === 0) return
    const picture = this.pictureCache.picture
    const servable = picture !== undefined && sameGeometry(picture, this.geometry)
    let waiting = false
    for (const [clientId, owed] of this.owed) {
      if (owed.serve) continue
      const client = this.clients.get(clientId)
      if (!client) {
        this.owed.delete(clientId)
        continue
      }
      if (!servable) {
        waiting = true
        continue
      }
      this.serve(client, owed, picture)
    }
    if (waiting) this.armNudge()
  }

  /**
   * Serve one owed viewer the picture, then the tail, through a pulled send
   * sequence (E5). The tail is read by offset, so a cut mid-serve skips and
   * repeats nothing. The viewer stops being owed IN THE SAME CALL that ends the
   * sequence: a byte accepted after it goes out live, one before it was in the
   * tail. A tail the cap evicted, or a newer reason to owe, ends the serve and
   * serves again.
   */
  private serve(client: ClientConn, owed: OwedViewer, picture: CachedPicture): void {
    const reader = this.pictureCache.openReader(picture)
    const binary = client.caps.has(CAP_TERMINAL_OUTPUT_BINARY_V1) && client.sendBinary !== undefined
    let phase: 'picture' | 'tail' | 'done' = 'picture'
    let cancelled = false
    const finish = (outcome: 'served' | 'again' | 'failed' | 'cancelled'): void => {
      if (phase === 'done') return
      phase = 'done'
      this.pictureCache.closeReader(reader)
      if (this.owed.get(client.id) !== owed) return
      if (outcome === 'served' || outcome === 'failed') {
        this.owed.delete(client.id)
        if (outcome === 'served')
          log.debug('served', {
            sessionId: this.init.sessionId,
            clientId: client.id,
            trigger: owed.trigger,
            waitMs: Date.now() - owed.since,
          })
        return
      }
      owed.serve = undefined
      owed.again = false
      queueMicrotask(() => this.serveOwed())
    }
    const source: SendSequenceSource<ServerMessage> = {
      next: () => {
        if (phase === 'done') return undefined
        if (cancelled) {
          finish('cancelled')
          return undefined
        }
        // Owed again (a reset, a new epoch, a redraw) while this serve was in
        // flight: it is about an older picture — stop here, serve the latest.
        if (owed.again) {
          finish('again')
          return undefined
        }
        if (phase === 'picture') {
          phase = 'tail'
          return this.outputItem(binary, picture.seq, picture.bytes)
        }
        const read = this.pictureCache.read(reader)
        if (read.kind === 'end') {
          finish('served')
          return undefined
        }
        if (read.kind === 'evicted') {
          finish('again')
          return undefined
        }
        return this.outputItem(binary, read.seq, read.bytes)
      },
    }
    owed.serve = {
      cancel: () => {
        cancelled = true
        if (phase !== 'done') {
          phase = 'done'
          this.pictureCache.closeReader(reader)
        }
      },
    }
    const sent: Promise<SendOutcome> = client.sendSequence
      ? client.sendSequence(source)
      : this.serveEagerly(client, source)
    void sent.then((outcome) => {
      if (!outcome.ok) finish('failed')
    })
  }

  /** An in-process peer with no lazy sink takes the whole serve now. */
  private serveEagerly(
    client: ClientConn,
    source: SendSequenceSource<ServerMessage>,
  ): Promise<SendOutcome> {
    for (let item = source.next(); item !== undefined; item = source.next()) {
      if (item instanceof SequenceBinary) client.sendBinary?.(item.bytes)
      else client.send(item)
    }
    return Promise.resolve({ ok: true })
  }

  /** One catch-up frame on the normal output path: this viewer's encoding, the live epoch. */
  private outputItem(binary: boolean, seq: number, bytes: Buffer): ServerMessage | SequenceBinary {
    if (binary)
      return new SequenceBinary(
        encodeBinaryEnvelope(
          { v: 1, type: 'ptyOutput', sessionId: this.init.sessionId, seq, epoch: this.epoch },
          bytes,
        ),
      )
    return {
      type: 'outputFrame',
      sessionId: this.init.sessionId,
      seq,
      epoch: this.epoch,
      data: bytes.toString('base64'),
    }
  }

  /** A live frame this viewer lost owes it a catch-up (N4, E6) — on a pictures session. */
  private dropHandler(client: ClientConn): (() => void) | undefined {
    if (this.pictures !== true) return undefined
    let handler = this.dropHandlers.get(client)
    if (!handler) {
      handler = () => this.owe(client.id, 'drop')
      this.dropHandlers.set(client, handler)
    }
    return handler
  }

  /** H2: a viewer owed with nothing to serve asks the daemon, at most once a second. */
  private armNudge(): void {
    if (this.nudgeTimer !== undefined) return
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = undefined
      this.nudgeStale()
    }, STALE_OWED_MS)
    this.nudgeTimer.unref?.()
  }

  private stopNudge(): void {
    if (this.nudgeTimer === undefined) return
    clearTimeout(this.nudgeTimer)
    this.nudgeTimer = undefined
  }

  private nudgeStale(): void {
    if (this.pictures !== true || this.exited) return
    const waiting = [...this.owed.values()].filter((owed) => !owed.serve)
    if (waiting.length === 0) return
    log.debug('owed with nothing to serve: asking for a picture', {
      sessionId: this.init.sessionId,
      viewers: waiting.length,
      hasPicture: this.pictureCache.picture !== undefined,
    })
    this.redraw({ replayRequired: true })
    this.armNudge()
  }

  broadcast(message: ServerMessage): void {
    for (const client of this.clients.values()) client.send(message)
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

  /** Convert the canonical bytes only at one recipient's negotiated edge. */
  private sendOutput(
    client: ClientConn,
    seq: number,
    bytes: Buffer,
    lossy: boolean,
    shared?: OutputFanout,
    onDrop?: () => void,
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
      if (lossy && client.sendBinaryStream) sent = client.sendBinaryStream(frame, onDrop)
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
    if (lossy && client.sendStream) sent = client.sendStream(message, onDrop)
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
