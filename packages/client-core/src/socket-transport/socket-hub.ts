import { createLogger, getProcessContext } from '@podium/logger'
import type {
  AutomationRunWire,
  AutomationWire,
  ConversationSummaryWire,
  HostMetricsWire,
  IssueDepProjection,
  IssueEventWire,
  IssueProjection,
  IssueWire,
  LayoutWire,
  MachineId,
  MachineWire,
  ReadPositionWire,
  RepoProjection,
  SessionId,
  SessionMeta,
  ShipOrderProjection,
  TranscriptItem,
} from '@podium/model'
import { asMachineId, layoutRowId, readPositionRowId } from '@podium/model'
import {
  type ApprovalWire,
  CAP_ISSUES_NORMALIZED,
  CAP_METADATA_DELTA,
  CAP_SYNC_FEED_IDENTITY,
  createDispatcher,
  encode,
  type HeadlessActivityEvent,
  isKnownMetadataChange,
  type MetadataChange,
  type MetadataChangeLenient,
  type PresenceIdentity,
  type PresencePayload,
  type PresenceRoomClientMessage,
  type PresenceRoomServerMessage as PresenceRoomServerFrame,
  parseServerMessageLenient,
  presencePayloadWithinBudget,
  type RoomRef,
  type ServerMessage,
  type ServerMessageLenient,
  type SessionOpenUrlMessage,
  type SessionOpenUrlResultMessage,
  WIRE_VERSION,
} from '@podium/protocol'
import { applyServerLogLevel } from '../logging/level-command'
import { type EchoLatencyStats, EchoLatencyTracker } from './echo-latency'
import type { LegacyFeedSinkPort, LegacyMetadataProjection } from './legacy-feed-port'
import { type ClientSubscription, ClientSubscriptionRegistry } from './subscriptions'

const log = createLogger('client-core:socket-hub')

/**
 * This client's `hello.origin`, derived from the logger's process context
 * (POD-1920). Returns the wrapper object so an absent role sends NO field at
 * all: `origin: undefined` and a missing key are the same on the wire, but only
 * the second is what an older build would have sent, and the server's reading of
 * "absent means not individually addressable" is written against that.
 *
 * `v` can legitimately be missing here while appearing on the same client's
 * records: the browser resolves its build stamp asynchronously after boot, and
 * hello is sent once per connection. Role and machine — the two an operator
 * selects on — are set before the socket opens.
 */
function clientLogOrigin(): { origin: { role: string; v?: string; machineId?: MachineId } } | null {
  const { role, v, machineId } = getProcessContext()
  if (typeof role !== 'string' || role === '') return null
  return {
    origin: {
      role,
      ...(typeof v === 'string' ? { v } : {}),
      // The logger's process context is an untyped bag, so the brand is asserted
      // on the way OUT of it rather than re-validated: the value was put there by
      // `installClientLogging`, which takes a `MachineId`.
      ...(typeof machineId === 'string' ? { machineId: asMachineId(machineId) } : {}),
    },
  }
}

const interactionNow = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()

export interface WebSocketLike {
  send(data: string): void
  close(): void
  readonly bufferedAmount?: number
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror?: ((ev: unknown) => void) | null
}

export interface ConnectionViewport {
  cols: number
  rows: number
  dpr: number
}

export type TerminalOutcome = 'unauthorized' | 'unreachable'

export interface ConnectionState {
  connected: boolean
  clientId: string
  controllerId: string | null
  controllerIdentity: PresenceIdentity | null
  outcome: TerminalOutcome | null
  sessionId: SessionId
  role: 'controller' | 'spectator'
  cols: number
  rows: number
  epoch: number
  lastSeq: number
  /**
   * Has the PTY behind this session produced ANY output since it was spawned?
   * True as soon as a frame lands here, or when the attach reports the server's
   * durable output counter as non-zero. False therefore means one specific
   * thing: we are attached to a child that has printed NOTHING yet — which a
   * blank screen alone cannot say, because a lost replay window looks identical
   * [POD-385]. True before the first attach, and against a server too old to
   * report it, so nothing ever claims a session is silent on a guess.
   */
  outputSeen: boolean
}

export interface SessionCallbacks {
  onFrame?: (text: string) => void
  onState?: (state: ConnectionState) => void
  /**
   * The server is about to send a full replay (not a `resumed` catch-up): clear
   * the screen before the buffered frames land. Not called on an incremental
   * resume, where the view keeps its content and appends.
   */
  onReset?: () => void
  /**
   * The server confirmed the attach (the PTY is bound and ready for input). Fires
   * on every `attached` message — independent of whether any output follows, so a
   * session sitting idle at a prompt is still recognised as ready. Use this rather
   * than the first output frame to clear a "Starting…" state, or an idle/blocked
   * child with an empty replay buffer would hang it forever.
   */
  onAttached?: () => void
  onOutcome?: (outcome: TerminalOutcome) => void
}

export interface SocketHubOptions {
  url: string
  viewport: ConnectionViewport
  makeSocket?: (url: string) => WebSocketLike
  onError?: (message: string, event?: unknown) => void
  /** Opaque wire-v1 Replica adapter. Transport only drives lifecycle and forwards envelopes. */
  legacyFeed?: LegacyFeedSinkPort
  /** Advertise the normalized issue projection capability on the legacy wire. */
  issuesNormalized?: boolean
  /**
   * WIRE v2 (POD-376): opt this hub into the FEED, and hand every frame to the
   * kernel Replica.
   *
   * PROVIDING THIS IS THE ADVERTISEMENT. `hello` gains `wireVersion`, so the
   * server resolves the identity adapter instead of the v1 translation, and
   * this connection receives every canonical feed envelope untranslated.
   *
   * Mutually exclusive with the legacy feed sink: one wire per connection.
   */
  feed?: FeedSinkPort
  /**
   * Schedule one feed envelope. Production uses a macrotask so the
   * browser can service input and paint between bootstrap chunks; tests may
   * inject a deterministic scheduler.
   */
  scheduleFeedTask?: (task: () => void) => void
}

/** The frames the v2 wire carries. Narrowed off the parsed union rather than
 *  restated, so a new member of the family is a compile error here — and off the
 *  LENIENT union since POD-1610, because the rows that reach a sink may include
 *  kinds this build has no arm for (ignored downstream) and must no longer cost
 *  the whole frame. */
export type FeedServerFrame = Extract<
  ServerMessageLenient,
  { type: 'feedDelta' | 'feedBootstrap' | 'feedRescope' | 'feedResyncRequired' }
>

/** Main-thread budgets for the safe, pre-worker feed boundary. */
export const FEED_TASK_BUDGET_MS = 16.7
export const FEED_INTERACTABILITY_BUDGET_MS = 50

/**
 * The queued-DELTA backlog above which replay is abandoned for a snapshot resync.
 *
 * The ingress queue drains one envelope per macrotask, so a backlog of D deltas
 * costs at BEST D × FEED_TASK_BUDGET_MS of degraded interactivity before the
 * client is current again — at 256 that is ~4.3 seconds even when every task
 * makes budget, and a client that queued 256 deltas faster than it applied them
 * is not briefly behind, it is losing. Past that point the recovery the protocol
 * already owns is cheaper: `requestFreshWorld()` cycles the socket, the fresh
 * admission serves one world at its head, and the whole backlog is replaced by
 * ONE install instead of replayed frame by frame.
 *
 * Counted over `feedDelta` frames ONLY, deliberately: a bootstrap world
 * legitimately arrives as an arbitrarily long run of `feedBootstrap` chunks, and
 * a bound that counted those would abandon every large world mid-download and
 * request another — a resync loop that never converges. Rescope/resync frames
 * are rare singles and already trigger their own recovery.
 */
export const FEED_DELTA_RESYNC_QUEUE_DEPTH = 256

export interface FeedTaskTiming {
  kind: FeedServerFrame['type']
  durationMs: number
  /** Feed frames still waiting after this task was dequeued. */
  queuedFrames: number
  yielded: true
  overTaskBudget: boolean
  overInteractabilityBudget: boolean
}

export interface FeedBudgetSnapshot {
  tasks: number
  yieldedTasks: number
  maxTaskMs: number
  overTaskBudget: number
  overInteractabilityBudget: number
  maxQueueDepth: number
  /** Times the delta backlog crossed {@link FEED_DELTA_RESYNC_QUEUE_DEPTH} and
   *  the queue was traded for a snapshot resync. Non-zero means the client fell
   *  terminally behind and recovered — worth knowing, never silent. */
  backlogResyncs: number
}

/**
 * Scheduling hint only — `parseServerMessageLenient` remains authoritative.
 * The canonical encoder writes `type` first, which lets this avoid JSON.parse
 * before yielding the expensive feed path. A malformed or hand-written frame
 * simply falls through to the existing synchronous parser.
 */
function feedFrameTypeHint(raw: string): FeedServerFrame['type'] | null {
  const match = /^\s*\{\s*"type"\s*:\s*"(feedDelta|feedBootstrap|feedRescope|feedResyncRequired)"/.exec(
    raw,
  )
  return (match?.[1] as FeedServerFrame['type'] | undefined) ?? null
}

/**
 * Where v2 frames go. Implemented by the kernel Replica's client-side consumer
 * (`@podium/client-core/replica/feed`); the transport knows nothing about
 * replicas, feed positions or storage.
 *
 * The two lifecycle calls are here rather than left to the embedder because the
 * transport is the only thing that knows when the socket is up: the kernel
 * Replica's `stale` posture — "visible, never blank" — is entered on
 * {@link disconnected} and resumed by the replica on {@link connected}; an embedder
 * polling `hub.connected` would enter it late, at a different moment than frames stop.
 */
export interface FeedSinkPort {
  /** The socket is open and `hello` has advertised the wire version. */
  connected(): void
  /** The socket ended. The replica holds its last-known slice, marked stale. */
  disconnected(): void
  /** One frame, in arrival order. Order IS the correctness property (ADR 2 D9). */
  frame(frame: FeedServerFrame): void
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function fromBase64Utf8(b64: string): string {
  const bin = atob(b64)
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return `${fallback}: ${error.message}`
  return fallback
}

const PRESENCE_OUTBOUND_BUDGET_BYTES = 64 * 1024

// Liveness + recovery tuning. The heartbeat catches connections that died without a
// close event (laptop sleep leaves a half-open TCP; some proxies drop idle sockets
// silently), doubles as proxy-keepalive traffic, and — at this cadence — works as a
// latency probe: each ping's round-trip feeds the connection-health indicator, so
// the interval is seconds, not tens of seconds. Reconnect backoff is capped low:
// the common cause here is a backend redeploy that is back within seconds.
const HEARTBEAT_INTERVAL_MS = 2_500
const HEARTBEAT_TIMEOUT_MS = 10_000
const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 10_000

// Health thresholds. Degraded = the UI shows a yellow dot (typing will feel laggy);
// down = red (input is not reaching the agent). RTT alone never maps to "down" —
// red is reserved for pings that aren't answered at all or a dropped socket.
const DEGRADED_RTT_MS = 400
const PING_DEGRADED_AFTER_MS = 1_500
const PING_DOWN_AFTER_MS = 5_000
// Unanswered pings older than the force-close window can't accumulate meaningfully;
// the cap just bounds the queue if pongs stop while other traffic keeps us alive.
const PING_QUEUE_CAP = 8
// Keystrokes typed while the socket is down are queued and flushed (in order) on
// reconnect, so a blip doesn't silently swallow input. Capped so a long outage
// can't replay an unbounded burst of stale typing into the agent on return.
const INPUT_QUEUE_CAP = 1_000

/** Fold one oplog change into an entity list (upsert replaces by id or appends;
 *  an upsert with no value is a producer bug the protocol says to drop). */
function applyChange<T>(
  list: T[],
  op: 'upsert' | 'remove',
  value: T | undefined,
  match: (el: T) => boolean,
): T[] {
  if (op === 'remove') return list.filter((el) => !match(el))
  if (value === undefined) return list
  let replaced = false
  const next = list.map((el) => {
    if (!match(el)) return el
    replaced = true
    return value
  })
  if (!replaced) next.push(value)
  return next
}

export interface AttentionEvent {
  sessionId: SessionId
  title: string
  body: string
}

export type ConnectionHealthStatus = 'ok' | 'degraded' | 'down'

export interface ConnectionHealth {
  status: ConnectionHealthStatus
  /** Latest measured ping round-trip. Null until the first pong (or while disconnected). */
  rttMs: number | null
  /** Epoch ms when the current status began — lets the UI say "down for 12s". */
  since: number
}

/**
 * WHAT THIS BUILD COULD NOT READ (POD-1610).
 *
 * A running tally, not an event log: the UI needs one persistent "this build and
 * this server disagree" statement, and every further unreadable row is more of
 * the same fact rather than a new one.
 *
 * The distinction between the two counters is the one that decides how bad it is.
 * A QUARANTINED row is a row missing from an otherwise-applied frame — the app
 * works, minus that entity. A REFUSED frame is the whole envelope thrown away,
 * which on the bootstrap path means the app has NOTHING, and is precisely the
 * shape of the outage this type was added for: a stale bundle whose console said
 * "dropped an unparseable server message" while the user looked at an empty board.
 */
export interface WireSkew {
  /** Rows the server sent that this build could not parse, dropped from otherwise
   *  applied frames. */
  quarantined: number
  /** Whole frames refused — the envelope itself failed. The severe case. */
  refusedFrames: number
  /** The first failure's message, for the console and a bug report. Never UI copy:
   *  a ZodError path is not something to put in front of a person. */
  firstError?: string
  /** Epoch ms of the first drop, so the UI can say when the disagreement started. */
  since: number
}

/**
 * The hub's typed subscription seam [spec:SP-3fe2]: every event the hub fans
 * out, keyed by a CLOSED kind union. Payloads are tuples so multi-argument
 * legacy callbacks (`onSessionDraft`) ride the same seam without an adapter.
 * `on(kind, handler)` is the one subscription primitive; the deprecated
 * `on*`/`subscribe*` methods below are thin wrappers over it.
 */
export interface HubEvents {
  /** Full session list after any change (snapshot, delta, title/state patch). */
  sessions: [sessions: SessionMeta[]]
  conversations: [conversations: ConversationSummaryWire[]]
  automations: [automations: AutomationWire[]]
  automationRuns: [automationRuns: AutomationRunWire[]]
  hostMetrics: [hosts: HostMetricsWire[]]
  machines: [machines: MachineWire[]]
  /** A repo's worktrees changed on the daemon side (POD-665). No cached list —
   *  this is a one-shot invalidation; the subscriber re-fetches through the same
   *  path it already uses at boot. */
  worktreesChanged: [repoPath: string, machineId: MachineId | undefined]
  /** Approval broker [spec:SP-edbb]: undecided management-op requests. */
  approvals: [pending: ApprovalWire[]]
  /** Full issue list after any change. */
  issues: [issues: IssueWire[]]
  /** Full NORMALIZED issue list after any change [POD-796]. Fires for a hub
   *  that offered CAP_ISSUES_NORMALIZED (the authority emits unconditionally
   *  since POD-797). Carries no session data of any kind —
   *  a consumer resolves members by indexing sessions on `issueId`. Emitted
   *  ALONGSIDE `issues` during the transition, never instead of it. */
  issueProjections: [issues: IssueProjection[]]
  /** Full dep-EDGE list after any change [POD-822]. Same gating as
   *  `issueProjections`; the replica joins these to derive blocked/ready/dependents. */
  issueDeps: [deps: IssueDepProjection[]]
  /** Full logical-repo list after any change [POD-822] — the `displayRef` prefix join. */
  repos: [repos: RepoProjection[]]
  /** The curated issue-event window after any change (POD-1772, entity kind
   *  `issueEvent`) — the chat feed's content, which used to arrive on a 15 s
   *  RPC timer of its own. Bounded server-side; evictions arrive as deletes. */
  issueEvents: [events: IssueEventWire[]]
  /** Compact shipping read rows, joined to issues by `issueId`. */
  shipOrders: [orders: ShipOrderProjection[]]
  /**
   * Per-user layout rows after any change (POD-1350, entity kind `userLayout`).
   * Feed demux only — POD-403's ui-state module is the hydrate/write owner; this
   * event lets a second device see live layout deltas without a second store.
   */
  userLayouts: [rows: LayoutWire[]]
  /**
   * Per-user read-cursor rows after any change (POD-1380, entity kind
   * `userReadPosition`). Feed demux only, same split as `userLayouts`: the feed is
   * how a person's OTHER device learns the position moved, and the hydrate/write
   * owner is the ui-state module.
   */
  userReadPositions: [rows: ReadPositionWire[]]
  /** Single-issue broadcast (fires alongside the full-list `issues` event). */
  issueUpdated: [issue: IssueWire]
  connectionHealth: [health: ConnectionHealth]
  /** The server said something this build could not read. Fires on every drop,
   *  carrying the running tally — see {@link WireSkew}. */
  wireSkew: [skew: WireSkew]
  /** One yielded feed task, for long-task and interactability budget telemetry. */
  feedTask: [timing: FeedTaskTiming]
  attention: [event: AttentionEvent]
  openUrl: [request: SessionOpenUrlMessage]
  openUrlResult: [result: SessionOpenUrlResultMessage]
  sessionDraft: [sessionId: SessionId, text: string]
  /** One live transcript frame: ONLY that frame's delta items — the caller owns
   *  history (see subscribeTranscript, which also manages the server-side
   *  subscription these frames depend on). */
  transcriptDelta: [sessionId: SessionId, items: TranscriptItem[], meta: { reset: boolean }]
  headlessActivity: [sessionId: SessionId, event: HeadlessActivityEvent]
  presenceRoomState: [frame: Extract<PresenceRoomServerFrame, { type: 'presenceRoomState' }>]
  presenceRoomDelta: [frame: Extract<PresenceRoomServerFrame, { type: 'presenceRoomDelta' }>]
  presenceRoomClosed: [frame: Extract<PresenceRoomServerFrame, { type: 'presenceRoomClosed' }>]
}

export type HubEventKind = keyof HubEvents

export type HubEventHandler<K extends HubEventKind> = (...payload: HubEvents[K]) => void

/** Storage-side supertype: every HubEventHandler is assignable to it. */
type AnyHubEventHandler = (...payload: never[]) => void

/** One ws, multiplexed across N sessions. Owns the connection + server-assigned clientId. */
export class SocketHub {
  private readonly opts: SocketHubOptions
  private readonly makeSocket: (url: string) => WebSocketLike
  private readonly legacyFeed: LegacyFeedSinkPort | undefined
  private readonly scheduleFeedTask: (task: () => void) => void
  private readonly subscriptionRegistry: ClientSubscriptionRegistry
  private readonly feedIngressQueue: Array<{
    raw: string
    socket: WebSocketLike
    kind: FeedServerFrame['type']
  }> = []
  private feedIngressScheduled = false
  private feedIngressGeneration = 0
  /** Running count of `feedDelta` entries in `feedIngressQueue` — the number the
   *  resync bound compares, kept as a counter because computing it would scan the
   *  queue on every enqueue. */
  private feedDeltaQueueDepth = 0
  private readonly feedBudgetStats: FeedBudgetSnapshot = {
    tasks: 0,
    yieldedTasks: 0,
    maxTaskMs: 0,
    overTaskBudget: 0,
    overInteractabilityBudget: 0,
    maxQueueDepth: 0,
    backlogResyncs: 0,
  }
  private socket: WebSocketLike | undefined
  private connectedFlag = false
  private clientIdValue = ''
  private sessionList: SessionMeta[] = []
  private conversationList: ConversationSummaryWire[] = []
  private automationList: AutomationWire[] = []
  private automationRunList: AutomationRunWire[] = []
  private hostMetricsList: HostMetricsWire[] = []
  private machinesList: MachineWire[] = []
  private approvalsList: ApprovalWire[] = []
  private issueList: IssueWire[] = []
  /** The normalized issue list [POD-796]. Separate from `issueList` rather than
   *  replacing it: the two shapes coexist for the whole transition, and the feed
   *  carries them as two entity KINDS ('issue' / 'issueProjection') because the
   *  ledger stores one value per (kind, id). Empty unless the authority's flag
   *  is on. */
  private issueProjectionList: IssueProjection[] = []
  /** The dep EDGES and the repos [POD-822] — the two kinds the replica joins the
   *  projections against to get back `blocked`/`ready`/`dependents` (edges) and
   *  `displayRef` (repo prefix). Separate lists for the same reason
   *  `issueProjectionList` is separate from `issueList`: they are separate feed
   *  kinds, because the ledger stores one value per (kind, id). Empty unless the
   *  authority's flag is on. */
  private issueDepList: IssueDepProjection[] = []
  private repoList: RepoProjection[] = []
  /** The curated issue-event window (POD-1772). Empty until the feed carries it. */
  private issueEventList: IssueEventWire[] = []
  private shipOrderList: ShipOrderProjection[] = []
  /** Per-user layout rows (POD-1350). Empty until the feed carries userLayout. */
  private userLayoutList: LayoutWire[] = []
  /** Per-user read-cursor rows (POD-1380). Empty until the feed carries them. */
  private userReadPositionList: ReadPositionWire[] = []
  private intentionalClose = false
  private everConnected = false
  private reconnectDelay = RECONNECT_MIN_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private heartbeatDeadline: ReturnType<typeof setTimeout> | undefined
  /** Send time of each unanswered ping, oldest first. Pongs arrive in ping order. */
  private pingQueue: number[] = []
  /** Input messages typed while offline, flushed in order on reconnect. */
  private readonly inputQueue: Parameters<typeof encode>[0][] = []
  /** Control messages issued while the socket is still CONNECTING (e.g. an eager
   *  requestControl on mount): sending then throws InvalidStateError — a race that
   *  only surfaces over a high-latency link (a tunnel) where onopen hasn't fired
   *  yet. Queued here and flushed, in order, once the socket opens. */
  private readonly preOpenQueue: Parameters<typeof encode>[0][] = []
  private staleTimer: ReturnType<typeof setTimeout> | undefined
  private lastRttMs: number | null = null
  private health: ConnectionHealth = { status: 'ok', rttMs: null, since: Date.now() }
  /** Null until the server says something this build cannot read; never cleared —
   *  the disagreement is a property of the pair, and it does not heal by a later
   *  frame happening to parse. */
  private skew: WireSkew | null = null
  private readonly connections = new Map<SessionId, SessionConnection>()
  private readonly terminalAttachDenials = new Set<SessionId>()
  // Per-session structured transcript subscriptions. The hub is a thin
  // delta-forwarder: it holds no buffered items, only the stream resume token.
  // The token is transcript state, not feed state.

  // An entry exists while at least one observer is subscribed.
  private readonly transcripts = new Map<
    SessionId,
    {
      since: string | undefined
      observers: Set<(items: TranscriptItem[], meta: { reset: boolean }) => void>
      /** The entry's seam registration — released when the last observer leaves. */
      off: () => void
    }
  >()
  // Per-session headless-activity registrations, keyed by callback.
  private readonly headlessSubs = new Map<
    string,
    Map<(e: HeadlessActivityEvent) => void, () => void>
  >()
  /** THE subscription seam: one handler Set per event kind (see HubEvents). */
  private readonly eventObservers = new Map<HubEventKind, Set<AnyHubEventHandler>>()
  private lastVisible = true
  private lastViewState: {
    visible: SessionId[]
    focused: SessionId | null
    modes?: Record<string, 'native' | 'chat'>
  } = {
    visible: [],
    focused: null,
  }

  constructor(opts: SocketHubOptions) {
    if (opts.feed !== undefined && opts.legacyFeed !== undefined) {
      throw new Error('SocketHub accepts one feed sink per connection')
    }
    this.opts = opts
    this.subscriptionRegistry = new ClientSubscriptionRegistry(
      opts.feed !== undefined || opts.legacyFeed !== undefined,
    )
    this.makeSocket = opts.makeSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike)
    this.legacyFeed = opts.legacyFeed
    this.scheduleFeedTask = opts.scheduleFeedTask ?? ((task) => setTimeout(task, 0))
    this.legacyFeed?.bind({
      apply: (changes) => this.applyChanges(changes),
      replace: (projection) => this.replaceMetadataSnapshot(projection),
      snapshot: () => this.metadataProjection(),
    })
  }

  get connected(): boolean {
    return this.connectedFlag
  }
  get clientId(): string {
    return this.clientIdValue
  }

  connect(): void {
    if (this.socket !== undefined) return
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }

    let socket: WebSocketLike
    try {
      socket = this.makeSocket(this.opts.url)
    } catch (err) {
      // A constructor throw before first contact is a config problem (bad URL) —
      // surface it; once we have connected successfully, retry like any other drop.
      log.warn('socket could not be opened', { err, everConnected: this.everConnected })
      if (this.everConnected) this.scheduleReconnect()
      else this.opts.onError?.(errorMessage(err, 'WebSocket connection failed'), err)
      return
    }

    let opened = false
    let reportedError = false
    this.intentionalClose = false
    this.socket = socket
    socket.onopen = () => {
      opened = true
      // BEFORE `everConnected` moves, so the record says whether this was the
      // first connection or a recovery — which is the difference between "the
      // client started" and "the client survived something".
      log.info('socket connected', { reconnect: this.everConnected })
      this.connectedFlag = true
      this.everConnected = true
      this.reconnectDelay = RECONNECT_MIN_MS
      this.startHeartbeat()
      this.sendRaw({
        type: 'hello',
        clientId: this.clientIdValue,
        viewport: { ...this.opts.viewport },
        // Legacy feed capability negotiation is keyed only by the presence of the
        // opaque Replica sink. Transport never reads its position or stamp.
        // CAP_ISSUES_NORMALIZED is opt-in on top (see `issuesNormalized`): it
        // promises the server this client no longer needs IssueWire, which is
        // what licenses the server to skip the O(issues x sessions) rebuild on
        // session churn [POD-796].
        ...(this.legacyFeed
          ? {
              caps: [
                CAP_METADATA_DELTA,
                CAP_SYNC_FEED_IDENTITY,
                ...(this.opts.issuesNormalized ? [CAP_ISSUES_NORMALIZED] : []),
              ],
            }
          : {}),
        // WIRE v2 (POD-376). Sent only in feed mode: an absent `wireVersion` IS
        // the v1 advertisement (`wire-feed-edge.ts` — "a pre-cutover client
        // cannot be made to send a field it was never built with"), so a hub
        // with no feed sink must keep saying nothing rather than announcing a
        // version it has nowhere to put.
        ...(this.opts.feed ? { wireVersion: WIRE_VERSION } : {}),
        // HOW THIS CLIENT NAMES ITSELF to an operator (POD-1920). Read from the
        // logger's process context rather than taken as a hub option, because
        // that context is what stamps the records the server files under this
        // same tuple — an option would be a second answer to "which client is
        // this?", free to disagree with the log file it is meant to match.
        // Absent before client logging is installed, which is honest: nothing
        // this connection says is being forwarded yet either.
        ...(clientLogOrigin() ?? {}),
      })
      // Start both opaque feed sinks before restoring attaches and presence.
      this.opts.feed?.connected()
      // The legacy adapter independently decides whether and how to catch up.
      this.legacyFeed?.connected()
      // Re-attach with a resume cursor: the view survived the drop, so ask the
      // server to catch us up from the last seq we rendered instead of wiping and
      // replaying the whole buffer. A connection that has rendered nothing yet
      // (lastSeq -1) omits the cursor → full replay.
      for (const [sessionId, conn] of this.connections) {
        if (this.terminalAttachDenials.has(sessionId)) continue
        const sinceSeq = conn.resumeCursor
        this.sendRaw({ type: 'attach', sessionId, ...(sinceSeq >= 0 ? { sinceSeq } : {}) })
      }
      // Transcript subscriptions survive reconnects the same way attaches do —
      // resume from the last cursor we forwarded (`since`) so the stream picks up
      // where it left off instead of replaying. A subscription that hasn't seen a
      // delta yet (since undefined) re-subscribes from the live tail.
      for (const [sessionId, entry] of this.transcripts) {
        this.sendRaw({
          type: 'transcriptSubscribe',
          sessionId,
          ...(entry.since ? { since: entry.since } : {}),
        })
      }
      // Restore lossy room membership from the SAME registry as the durable feed.
      // Updates are full-state and never enter the control queue.
      for (const frame of this.subscriptionRegistry.reconnectFrames()) {
        this.sendPresenceFrame(frame)
      }
      // Re-assert per-session view state the same way: the server starts each new
      // client with empty view state, so a reconnecting client must re-declare which
      // sessions it renders / has focused for output-relay prioritization to resume.
      this.sendRaw({ type: 'viewState', ...this.lastViewState })
      // Flush keystrokes typed during the outage — after the re-attaches above, so
      // the session exists and this (reclaimed) client is the controller again
      // before its input lands.
      for (const msg of this.inputQueue.splice(0)) this.sendRaw(msg)
      // Flush control messages that were issued before the socket opened (e.g. an
      // eager requestControl) — after the re-attaches above so the session exists.
      for (const msg of this.preOpenQueue.splice(0)) this.sendRaw(msg)
      this.notifyConnections()
      this.evaluateHealth()
    }
    socket.onmessage = (ev) => {
      this.markAlive()
      const raw = String(ev.data)
      const kind = feedFrameTypeHint(raw)
      if (kind !== null) {
        this.enqueueFeedFrame(raw, socket, kind)
        return
      }
      // Control, terminal and legacy messages keep their existing synchronous
      // delivery semantics. Only the JSON-heavy v2 feed path yields.
      this.route(raw)
    }
    socket.onerror = (ev) => {
      reportedError = true
      // Errors after a successful first connection are transient (backend redeploy,
      // network blip): the reconnect loop handles them. Only a failure to ever
      // connect is fatal — that's a wrong address or a server that isn't running.
      if (!this.everConnected) this.opts.onError?.('WebSocket connection failed', ev)
    }
    socket.onclose = () => {
      if (!this.intentionalClose && !opened && !reportedError && !this.everConnected) {
        this.opts.onError?.('WebSocket connection closed before connecting')
      }
      this.onSocketClosed()
    }
  }

  /** Common teardown for any socket end: from onclose or a heartbeat force-close. */
  private onSocketClosed(): void {
    if (!this.intentionalClose) {
      // `warn`, so it forwards at the client's default threshold: a client that
      // keeps losing its socket is the thing an operator most wants to see from
      // the outside, and it is invisible in the server's own logs.
      log.warn('socket closed — reconnecting', { retryInMs: this.reconnectDelay })
    }
    this.stopHeartbeat()
    this.connectedFlag = false
    this.socket = undefined
    // Frames from a closed socket cannot be installed after a replacement
    // socket starts a new feed identity/stream.
    this.clearFeedIngress()
    // D7 stale-visible: the replica keeps serving its last-known slice, marked
    // stale. Told here rather than by an embedder watching `connected`, so the
    // posture changes at the same instant the frames stop.
    this.opts.feed?.disconnected()
    this.legacyFeed?.disconnected()
    this.notifyConnections()
    if (!this.intentionalClose) this.evaluateHealth()
    if (!this.intentionalClose) this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      // `debug`: one line per attempt is flight-recorder context, not something
      // an operator wants forwarded during an hour-long outage.
      log.debug('reconnecting', { afterMs: this.reconnectDelay })
      this.connect()
    }, this.reconnectDelay)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    // First ping right away: it seeds the latency measurement on connect and, after
    // a reconnect, confirms the server is actually answering — an open socket alone
    // already cleared the indicator, and this verifies that optimism within ~1.5s.
    this.sendPing()
    this.heartbeatTimer = setInterval(() => this.sendPing(), HEARTBEAT_INTERVAL_MS)
  }

  private sendPing(): void {
    this.sendRaw({ type: 'ping' })
    if (this.pingQueue.length < PING_QUEUE_CAP) this.pingQueue.push(Date.now())
    if (this.pingQueue.length === 1) this.armStaleTimer()
    if (this.heartbeatDeadline !== undefined) return
    this.heartbeatDeadline = setTimeout(() => {
      this.heartbeatDeadline = undefined
      this.forceClose()
    }, HEARTBEAT_TIMEOUT_MS)
  }

  /** Two-stage alarm on the oldest unanswered ping: degraded, then down. Without
   *  this the health would only be re-checked when a message arrives — exactly what
   *  isn't happening on a stalling connection. */
  private armStaleTimer(): void {
    this.clearStaleTimer()
    this.staleTimer = setTimeout(() => {
      this.staleTimer = setTimeout(() => {
        this.staleTimer = undefined
        this.evaluateHealth()
      }, PING_DOWN_AFTER_MS - PING_DEGRADED_AFTER_MS)
      this.evaluateHealth()
    }, PING_DEGRADED_AFTER_MS)
  }

  private clearStaleTimer(): void {
    if (this.staleTimer !== undefined) clearTimeout(this.staleTimer)
    this.staleTimer = undefined
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    if (this.heartbeatDeadline !== undefined) clearTimeout(this.heartbeatDeadline)
    this.heartbeatTimer = undefined
    this.heartbeatDeadline = undefined
    this.clearStaleTimer()
    this.pingQueue = []
    this.lastRttMs = null
  }

  /** Any inbound traffic proves the connection is alive; clear the ping deadline. */
  private markAlive(): void {
    if (this.heartbeatDeadline === undefined) return
    clearTimeout(this.heartbeatDeadline)
    this.heartbeatDeadline = undefined
  }

  /** The heartbeat went unanswered. A half-open TCP connection may not deliver a
   *  close event for minutes, so detach the handlers and run the close path now. */
  private forceClose(): void {
    const socket = this.socket
    if (socket === undefined) return
    socket.onopen = null
    socket.onmessage = null
    socket.onclose = null
    if (socket.onerror !== undefined) socket.onerror = null
    try {
      socket.close()
    } catch {
      // already dead — exactly the case we're cleaning up
    }
    this.onSocketClosed()
  }

  /**
   * Dial again immediately after the page comes back from being hidden.
   *
   * `connect()` is a no-op while a socket object still exists. iOS Safari keeps
   * that object after backgrounding without firing `close`, so the first tap
   * would otherwise sit on a dead connection until the heartbeat (or a 60s
   * IndexedDB reopen) unsticks it. Tear the zombie down and open now. A live
   * socket takes the same path: one extra hello is cheaper than a frozen UI.
   */
  wake(): void {
    if (this.socket !== undefined) this.forceClose()
    this.connect()
  }

  /**
   * Ask the server for a fresh world, by ending this socket (POD-376).
   *
   * THE SERVER PUSHES BOOTSTRAPS AND THE CLIENT CANNOT REQUEST ONE. That is
   * `FeedServing`'s design and it is right — a connection acquires its position in
   * one synchronous pass at admission, and a client-requested world would have to
   * be read at some other moment, which is the window the pre-cutover bootstrap
   * covered "by hope". But the kernel Replica PULLS: every rung of D7's ladder
   * that terminates at re-bootstrap calls `AuthorityReadPort.bootstrap()`, and
   * something has to make a world arrive.
   *
   * Reconnecting is that something, and it is not a workaround: a fresh socket is
   * admitted, served its world at `throughSeq`, and framed from exactly there —
   * the same one-pass guarantee, obtained the only way the protocol offers it. The
   * cost is one socket cycle per re-bootstrap, which is already the rare path.
   *
   * `forceClose` rather than `close`: this must land in the RECONNECT path, not
   * the intentional-shutdown path, or nothing would reopen.
   */
  requestFreshWorld(): void {
    if (this.socket === undefined) return
    this.forceClose()
    this.scheduleReconnect()
  }

  attach(sessionId: SessionId, cb: SessionCallbacks = {}): SessionConnection {
    let conn = this.connections.get(sessionId)
    if (conn === undefined) {
      conn = new SessionConnection(this, sessionId, cb, this.opts.viewport)
      this.connections.set(sessionId, conn)
      if (this.connectedFlag) this.sendRaw({ type: 'attach', sessionId })
    } else {
      conn.setCallbacks(cb)
    }
    return conn
  }

  detach(sessionId: SessionId): void {
    this.terminalAttachDenials.delete(sessionId)
    if (this.connections.delete(sessionId) && this.connectedFlag) {
      this.sendRaw({ type: 'detach', sessionId })
    }
  }

  /**
   * Subscribe to a hub event (see {@link HubEvents} for the kinds + payloads).
   * The one subscription primitive — every legacy `on*`/`subscribe*` method is
   * a thin wrapper over it. Does NOT replay current state on subscribe: read
   * that from the matching getter (`sessions()`, `issues()`, `connectionHealth()`, …).
   * Returns an unsubscribe.
   */
  on<K extends HubEventKind>(kind: K, handler: HubEventHandler<K>): () => void {
    let set = this.eventObservers.get(kind)
    if (set === undefined) {
      set = new Set()
      this.eventObservers.set(kind, set)
    }
    // Erase the per-kind payload tuple for storage; emit() restores it. Safe
    // because handlers only ever receive the payload emitted under their kind.
    const stored = handler as unknown as AnyHubEventHandler
    set.add(stored)
    return () => {
      set.delete(stored)
    }
  }

  /** Fan one event out to its subscribers. Iterates the live Set — the same
   *  mid-iteration add/remove semantics as the per-kind Sets this replaced. */
  private emit<K extends HubEventKind>(kind: K, ...payload: HubEvents[K]): void {
    const set = this.eventObservers.get(kind)
    if (set === undefined) return
    // Snapshot + membership check reproduces the pre-seam per-Set semantics:
    // a handler REGISTERED during this emit starts with the NEXT event (the
    // old per-session transcript entries were captured before routing, so a
    // handoff re-subscription never saw the in-flight frame), while a handler
    // UNSUBSCRIBED during this emit is skipped (old live-Set iteration).
    for (const handler of [...set]) {
      if (!set.has(handler)) continue
      ;(handler as unknown as HubEventHandler<K>)(...payload)
    }
  }

  sessions(): SessionMeta[] {
    return this.sessionList
  }

  /** @deprecated Use `on('sessions', cb)` (which does not replay — read `sessions()`). */
  onSessions(cb: (s: SessionMeta[]) => void): () => void {
    const off = this.on('sessions', cb)
    cb(this.sessionList)
    return off
  }

  conversations(): ConversationSummaryWire[] {
    return this.conversationList
  }

  /** @deprecated Use `on('conversations', cb)` (no replay — read `conversations()`). */
  onConversations(cb: (c: ConversationSummaryWire[]) => void): () => void {
    const off = this.on('conversations', cb)
    cb(this.conversationList)
    return off
  }

  automations(): AutomationWire[] {
    return this.automationList
  }

  automationRuns(): AutomationRunWire[] {
    return this.automationRunList
  }

  hostMetrics(): HostMetricsWire[] {
    return this.hostMetricsList
  }

  /** @deprecated Use `on('hostMetrics', cb)` (no replay — read `hostMetrics()`). */
  onHostMetrics(cb: (h: HostMetricsWire[]) => void): () => void {
    const off = this.on('hostMetrics', cb)
    cb(this.hostMetricsList)
    return off
  }

  machines(): MachineWire[] {
    return this.machinesList
  }

  /** @deprecated Use `on('machines', cb)` (no replay — read `machines()`). */
  onMachines(cb: (m: MachineWire[]) => void): () => void {
    const off = this.on('machines', cb)
    cb(this.machinesList)
    return off
  }

  issues(): IssueWire[] {
    return this.issueList
  }

  /**
   * Observe the full issue list. Replays the current list immediately, like `onSessions`.
   * @deprecated Use `on('issues', cb)` (no replay — read `issues()`).
   */
  onIssues(cb: (i: IssueWire[]) => void): () => void {
    const off = this.on('issues', cb)
    cb(this.issueList)
    return off
  }

  /**
   * Observe single-issue updates (no immediate replay; mirrors `onAttention`).
   * @deprecated Use `on('issueUpdated', cb)`.
   */
  onIssueUpdated(cb: (i: IssueWire) => void): () => void {
    return this.on('issueUpdated', cb)
  }

  /**
   * Seed the entity lists from a persisted local replica (hydrate-first paint,
   * docs/spec/thin-client-replica.md §2.2) and notify observers, so an offline
   * reload shows last-known data before — or without — the network answering.
   * A no-op once server truth has landed (any completed changesSince): the
   * replica is a cache and never argues with the server (spec invariant 1).
   */
  seedMetadata(seed: {
    sessions: SessionMeta[]
    issues: IssueWire[]
    issueProjections?: IssueProjection[]
    issueDeps?: IssueDepProjection[]
    repos?: RepoProjection[]
    shipOrders?: ShipOrderProjection[]
    conversations: ConversationSummaryWire[]
    automations?: AutomationWire[]
    automationRuns?: AutomationRunWire[]
  }): void {
    if (this.legacyFeed !== undefined) {
      this.legacyFeed.seed({
        sessions: seed.sessions,
        issues: seed.issues,
        issueProjections: seed.issueProjections ?? [],
        issueDeps: seed.issueDeps ?? [],
        repos: seed.repos ?? [],
        shipOrders: seed.shipOrders ?? [],
        conversations: seed.conversations,
        automations: seed.automations ?? [],
        automationRuns: seed.automationRuns ?? [],
      })
      return
    }
    this.sessionList = seed.sessions
    this.issueList = seed.issues
    // The three POD-796/POD-822 kinds [POD-822]: seed the hub's in-memory lists
    // from the persisted replica so a warm-reload DELTA applies onto them rather
    // than onto empty lists. Optional + `?? []` so an embedder that predates them
    // seeds exactly as before.
    this.issueProjectionList = seed.issueProjections ?? []
    this.issueDepList = seed.issueDeps ?? []
    this.repoList = seed.repos ?? []
    this.shipOrderList = seed.shipOrders ?? []
    this.conversationList = seed.conversations
    this.automationList = seed.automations ?? []
    this.automationRunList = seed.automationRuns ?? []
    this.emit('sessions', this.sessionList)
    this.emit('issues', this.issueList)
    // Emit-only-when-non-empty, unlike sessions/issues above: consumers default
    // these three kinds to empty, so an empty seed emit is a no-op — and after a
    // server-side flag rollback a stale persisted replica gets its emptying
    // event from the next delta/reconcile, not from the seed [POD-822].
    if (this.issueProjectionList.length > 0) this.emit('issueProjections', this.issueProjectionList)
    if (this.issueDepList.length > 0) this.emit('issueDeps', this.issueDepList)
    if (this.repoList.length > 0) this.emit('repos', this.repoList)
    if (this.shipOrderList.length > 0) this.emit('shipOrders', this.shipOrderList)
    this.emit('conversations', this.conversationList)
    this.emit('automations', this.automationList)
    this.emit('automationRuns', this.automationRunList)
  }

  /**
   * Observe a session's live structured-transcript deltas, resuming from `since`
   * (the cursor of the newest item the caller already holds — typically the
   * `tail` of an initial tRPC read). The first observer triggers a server-side
   * subscription; a later one that brings its own `since` re-asserts it from
   * that cursor so the frames it missed while reading are replayed; the last
   * one leaving unsubscribes.
   *
   * The hub is a thin forwarder: each `transcriptDelta` frame calls the callback
   * with ONLY that frame's delta items (not an accumulated list) — the caller
   * owns history. `meta.reset` is true when the tailer re-seeded (resume rolled
   * into a fresh file / reattach) and the caller should re-read its window.
   *
   * The callback is NOT invoked synchronously: the caller seeds its initial state
   * from the read, and a sync empty cb would clobber it.
   */
  subscribeTranscript(
    sessionId: SessionId,
    since: string | undefined,
    cb: (items: TranscriptItem[], meta: { reset: boolean }) => void,
  ): () => void {
    let entry = this.transcripts.get(sessionId)
    if (!entry) {
      // One seam registration per session entry, fanning out to the entry's
      // observer Set — preserving the old per-session semantics exactly (dedup
      // by callback identity, live-Set iteration) on top of `on()`.
      const observers = new Set<(items: TranscriptItem[], meta: { reset: boolean }) => void>()
      const off = this.on('transcriptDelta', (sid, items, meta) => {
        if (sid !== sessionId) return
        for (const o of observers) o(items, meta)
      })
      entry = { since, observers, off }
      this.transcripts.set(sessionId, entry)
      if (this.connectedFlag) {
        this.sendRaw({ type: 'transcriptSubscribe', sessionId, ...(since ? { since } : {}) })
      }
    } else if (since !== undefined && this.connectedFlag) {
      // A LATER observer joining an entry that already exists [POD-1132]. This
      // is the ORDINARY case, not an edge one: the agent panel subscribes at
      // mount to build its file-link index, and the chat subscribes only once
      // its transcript read has resolved — hundreds of milliseconds later, and
      // seconds on a cold panel.
      //
      // Its `since` is the tail of a read that has ALREADY happened, and
      // everything the agent appended between that read and this call went to
      // the observers registered AT THE TIME — never to this one. Dropping the
      // cursor (which is what joining silently used to do) left that gap in the
      // joiner's window permanently: the live stream is forward-only, so no
      // later frame carries it, and a tail probe cannot see a hole that is not
      // at the tail. Re-asserting the subscription from the cursor is how the
      // protocol closes it — the server replays from there.
      //
      // Safe to repeat: the server keys subscribers by connection id, and every
      // observer merges by cursor, so a replayed item replaces itself. The
      // replay is bounded by the server's per-session buffer, the same bound the
      // first-subscriber and reconnect paths already ride on. `entry.since` is
      // deliberately NOT moved backwards — it governs the reconnect resume,
      // which wants the newest cursor anyone has seen.
      this.sendRaw({ type: 'transcriptSubscribe', sessionId, since })
    }
    entry.observers.add(cb)
    return () => {
      const current = this.transcripts.get(sessionId)
      if (!current) return
      current.observers.delete(cb)
      if (current.observers.size === 0) {
        current.off()
        this.transcripts.delete(sessionId)
        if (this.connectedFlag) this.sendRaw({ type: 'transcriptUnsubscribe', sessionId })
      }
    }
  }

  /**
   * Observe live turn activity for a HEADLESS session (partial assistant text,
   * status, turn boundaries). Frames are server-broadcast to all clients, so this
   * is a local fan-out only — mirrors subscribeTranscript's shape without the
   * server subscription. Returns an unsubscribe.
   * @deprecated Use `on('headlessActivity', cb)` and filter by sessionId.
   */
  subscribeHeadless(sessionId: SessionId, cb: (e: HeadlessActivityEvent) => void): () => void {
    // Dedup by the CALLER's callback per session (the old per-session Set
    // semantics): re-registering the same cb must not double-deliver, and the
    // one registration has one unsubscribe. A fresh wrapper closure per call
    // would defeat the seam Set's identity dedup.
    let subs = this.headlessSubs.get(sessionId)
    if (!subs) {
      subs = new Map()
      this.headlessSubs.set(sessionId, subs)
    }
    const existing = subs.get(cb)
    if (existing) return existing
    const off = this.on('headlessActivity', (sid, event) => {
      if (sid === sessionId) cb(event)
    })
    const unsubscribe = () => {
      const current = this.headlessSubs.get(sessionId)
      if (current?.get(cb) === unsubscribe) {
        current.delete(cb)
        if (current.size === 0) this.headlessSubs.delete(sessionId)
        off()
      }
    }
    subs.set(cb, unsubscribe)
    return unsubscribe
  }

  /**
   * Attention events (agent needs the human) — the app turns these into notifications.
   * @deprecated Use `on('attention', cb)`.
   */
  onAttention(cb: (e: AttentionEvent) => void): () => void {
    return this.on('attention', cb)
  }

  /**
   * Subscribe to draft changes broadcast by other clients/devices. Returns an unsubscribe.
   * @deprecated Use `on('sessionDraft', cb)`.
   */
  onSessionDraft(cb: (sessionId: SessionId, text: string) => void): () => void {
    return this.on('sessionDraft', cb)
  }

  /** Publish this client's in-progress draft for a session to the server. */
  sendSessionDraft(sessionId: SessionId, text: string): void {
    if (this.connectedFlag) this.sendRaw({ type: 'setSessionDraft', sessionId, text })
  }
  /** Submit a user-pasted loopback callback to the daemon that owns the session. */
  submitOpenUrlCallback(sessionId: SessionId, requestId: string, url: string): void {
    this.sendRaw({
      type: 'sessionOpenUrlCallback',
      sessionId,
      requestId,
      url,
    })
  }

  /** Dismiss and revoke a pending browser-open request. */
  dismissOpenUrl(sessionId: SessionId, requestId: string): void {
    this.sendRaw({
      type: 'sessionOpenUrlDismiss',
      sessionId,
      requestId,
    })
  }

  subscriptionSnapshot(): readonly ClientSubscription[] {
    return this.subscriptionRegistry.snapshot()
  }

  subscribeRoom(room: RoomRef, payload?: PresencePayload): () => void {
    const fresh = this.subscriptionRegistry.subscribeRoom(room, payload, this.lastVisible)
    if (fresh && this.connectedFlag) this.sendPresenceFrame({ type: 'presenceSubscribe', room })
    if (this.connectedFlag) {
      this.sendPresenceFrame({
        type: 'presenceUpdate',
        room,
        ...(payload !== undefined ? { payload } : {}),
        visible: this.lastVisible,
      })
    }
    return () => {
      if (!this.subscriptionRegistry.unsubscribeRoom(room)) return
      if (this.connectedFlag) this.sendPresenceFrame({ type: 'presenceUnsubscribe', room })
    }
  }

  publishPresence(room: RoomRef, payload: PresencePayload): boolean {
    if (!presencePayloadWithinBudget(payload)) return false
    if (!this.subscriptionRegistry.updateRoom(room, payload, this.lastVisible)) return false
    return this.sendPresenceFrame({
      type: 'presenceUpdate',
      room,
      payload,
      visible: this.lastVisible,
    })
  }

  /** Report page visibility; the server's smart router skips mobile push while visible. */
  setVisible(visible: boolean): void {
    this.lastVisible = visible
    this.subscriptionRegistry.updateVisibility(visible)
    for (const subscription of this.subscriptionRegistry.snapshot()) {
      if (subscription.room === undefined) continue
      this.sendPresenceFrame({
        type: 'presenceUpdate',
        room: subscription.room,
        ...(subscription.payload !== undefined ? { payload: subscription.payload } : {}),
        visible,
      })
    }
  }

  /**
   * Report which sessions this client renders (`visible`) and which one has input
   * focus (`focused`). The server unions this across clients to prioritize PTY output
   * relay (focused/visible live; the rest coalesced). Stored and re-asserted on reconnect.
   *
   * `modes` (optional) maps each visible session to its rendered mode (native terminal
   * vs chat). It's wired through so the server has the signal; it does NOT change
   * relay/coalescing behavior.
   */
  setViewState(
    visible: SessionId[],
    focused: SessionId | null,
    modes?: Record<string, 'native' | 'chat'>,
  ): void {
    // Omit `modes` entirely when undefined so the wire payload (and the
    // re-assert below) stays byte-identical to the pre-modes message for clients
    // that don't report a mode — keeps old expectations exact.
    this.lastViewState = modes ? { visible, focused, modes } : { visible, focused }
    if (this.connectedFlag)
      this.sendRaw(
        modes
          ? { type: 'viewState', visible, focused, modes }
          : { type: 'viewState', visible, focused },
      )
  }

  connectionHealth(): ConnectionHealth {
    return this.health
  }

  /** @deprecated Use `on('connectionHealth', cb)` (no replay — read `connectionHealth()`). */
  onConnectionHealth(cb: (h: ConnectionHealth) => void): () => void {
    const off = this.on('connectionHealth', cb)
    cb(this.health)
    return off
  }

  private evaluateHealth(): void {
    const next = this.computeHealth()
    if (next.status === this.health.status && next.rttMs === this.health.rttMs) return
    // A status that merely re-confirms keeps its start time — `since` marks the
    // transition, not the latest re-evaluation.
    this.health = next.status === this.health.status ? { ...next, since: this.health.since } : next
    this.emit('connectionHealth', this.health)
  }

  private computeHealth(): ConnectionHealth {
    const since = Date.now()
    if (!this.connectedFlag) {
      // Before the first connection the fatal-error page owns the messaging; a red
      // dot on top of it (or during the initial load) would be noise.
      return { status: this.everConnected ? 'down' : 'ok', rttMs: null, since }
    }
    const oldest = this.pingQueue[0]
    if (oldest !== undefined) {
      const waitedMs = Date.now() - oldest
      if (waitedMs >= PING_DOWN_AFTER_MS) return { status: 'down', rttMs: this.lastRttMs, since }
      if (waitedMs >= PING_DEGRADED_AFTER_MS)
        return { status: 'degraded', rttMs: this.lastRttMs, since }
    }
    if (this.lastRttMs !== null && this.lastRttMs >= DEGRADED_RTT_MS) {
      return { status: 'degraded', rttMs: this.lastRttMs, since }
    }
    return { status: 'ok', rttMs: this.lastRttMs, since }
  }

  /** @internal Used by SessionConnection to send its sessionId-tagged messages. */
  _send(msg: Parameters<typeof encode>[0]): void {
    this.sendRaw(msg)
  }

  /** @internal Input path: send now if connected, else queue for flush on
   *  reconnect so a blip doesn't silently drop keystrokes. */
  _sendInput(msg: Parameters<typeof encode>[0]): void {
    if (this.connectedFlag && this.socket !== undefined) {
      this.sendRaw(msg)
      return
    }
    if (this.inputQueue.length < INPUT_QUEUE_CAP) this.inputQueue.push(msg)
  }

  /**
   * Principal rebinding seam. This instance is terminal after release: callers
   * construct a fresh hub after authentication changes, so no room, attach,
   * input, transcript cursor or transport-derived identity can cross users.
   */
  releasePrincipal(): void {
    this.subscriptionRegistry.clearForPrincipalChange()
    for (const entry of this.transcripts.values()) entry.off()
    this.transcripts.clear()
    this.headlessSubs.clear()
    this.connections.clear()
    this.terminalAttachDenials.clear()
    this.clientIdValue = ''
    this.preOpenQueue.length = 0
    this.dispose()
  }

  dispose(): void {
    this.intentionalClose = true
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.stopHeartbeat()
    this.socket?.close()
    this.socket = undefined
    this.clearFeedIngress()
    this.connectedFlag = false
    this.inputQueue.length = 0
    this.preOpenQueue.length = 0
    this.legacyFeed?.dispose()
    this.notifyConnections()
  }

  /** Running feed-task budget counters for diagnostics and acceptance probes. */
  feedBudget(): FeedBudgetSnapshot {
    return { ...this.feedBudgetStats }
  }

  private enqueueFeedFrame(
    raw: string,
    socket: WebSocketLike,
    kind: FeedServerFrame['type'],
  ): void {
    this.feedIngressQueue.push({ raw, socket, kind })
    if (kind === 'feedDelta') this.feedDeltaQueueDepth += 1
    this.feedBudgetStats.maxQueueDepth = Math.max(
      this.feedBudgetStats.maxQueueDepth,
      this.feedIngressQueue.length,
    )
    // A backlog past the bound is terminal under replay (see the constant's
    // header): drop it and let the reconnect's pushed world replace it with one
    // install. Feed-mode only — the legacy sink has no `requestFreshWorld`
    // contract, and a v1 hub never receives these frames anyway.
    if (this.opts.feed !== undefined && this.feedDeltaQueueDepth > FEED_DELTA_RESYNC_QUEUE_DEPTH) {
      this.feedBudgetStats.backlogResyncs += 1
      log.warn('feed delta backlog exceeded the replay bound — resyncing from a snapshot', {
        queuedDeltas: this.feedDeltaQueueDepth,
        queuedFrames: this.feedIngressQueue.length,
        bound: FEED_DELTA_RESYNC_QUEUE_DEPTH,
      })
      this.clearFeedIngress()
      this.requestFreshWorld()
      return
    }
    if (this.feedIngressScheduled) return
    this.feedIngressScheduled = true
    const generation = this.feedIngressGeneration
    this.scheduleFeedTask(() => this.drainFeedIngress(generation))
  }

  /** Drop the queued feed frames and invalidate any drain already scheduled.
   *  Shared by dispose and the backlog resync — the two paths where replaying
   *  what is queued would be wrong. */
  private clearFeedIngress(): void {
    this.feedIngressQueue.length = 0
    this.feedDeltaQueueDepth = 0
    this.feedIngressScheduled = false
    this.feedIngressGeneration += 1
  }

  /**
   * Process exactly one feed envelope per scheduled task. This is the first
   * cooperative boundary: a later worker can take over the same queue without
   * changing the Replica's ordering, quarantine or atomic-install rules.
   */
  private drainFeedIngress(generation: number): void {
    if (generation !== this.feedIngressGeneration) return
    this.feedIngressScheduled = false
    const entry = this.feedIngressQueue.shift()
    if (entry === undefined) return
    if (entry.kind === 'feedDelta') this.feedDeltaQueueDepth -= 1

    if (this.socket === entry.socket) {
      const startedAt = interactionNow()
      try {
        this.route(entry.raw)
      } finally {
        const durationMs = Math.max(0, interactionNow() - startedAt)
        const overTaskBudget = durationMs > FEED_TASK_BUDGET_MS
        const overInteractabilityBudget = durationMs > FEED_INTERACTABILITY_BUDGET_MS
        this.feedBudgetStats.tasks += 1
        this.feedBudgetStats.yieldedTasks += 1
        this.feedBudgetStats.maxTaskMs = Math.max(this.feedBudgetStats.maxTaskMs, durationMs)
        if (overTaskBudget) this.feedBudgetStats.overTaskBudget += 1
        if (overInteractabilityBudget) this.feedBudgetStats.overInteractabilityBudget += 1
        this.emit('feedTask', {
          kind: entry.kind,
          durationMs,
          queuedFrames: this.feedIngressQueue.length,
          yielded: true,
          overTaskBudget,
          overInteractabilityBudget,
        })
      }
    }

    if (this.feedIngressQueue.length > 0 && !this.feedIngressScheduled) {
      this.feedIngressScheduled = true
      this.scheduleFeedTask(() => this.drainFeedIngress(generation))
    }
  }

  private route(raw: string): void {
    let msg: ServerMessageLenient | null
    try {
      // Lenient parse: for the collection-bearing messages, one poisoned element
      // (e.g. a session with an out-of-enum agentKind) is quarantined instead of
      // failing the whole batch — otherwise a single bad row blanks an entire list.
      const result = parseServerMessageLenient(raw)
      msg = result.message
      if (result.dropped > 0) {
        // Never silent: a swallowed drop here was what turned a one-row data bug into
        // an invisible, blank-UI outage. Make every quarantine observable.
        log.warn('quarantined invalid item(s) in a server message', {
          dropped: result.dropped,
          type: msg?.type ?? '?',
        })
        this.recordSkew({ quarantined: result.dropped })
      }
      if (!msg) return
      this.dispatchServerMessage(msg, { dropped: result.dropped })
    } catch (err) {
      // A REFUSED frame — the envelope, not a row. On the bootstrap path this is
      // the whole world, so it goes on the record as well as into the console:
      // POD-1610 is the incident where the console line was the only trace and
      // the user's evidence was a blank screen. `warn` deliberately: it is the
      // client console sink's default threshold, so the visibility that incident
      // bought survives the move off `console`.
      log.warn('dropped an unparseable server message', { err })
      this.recordSkew({ refusedFrames: 1, error: err })
      return
    }
  }

  /**
   * Fold one drop into the running tally and tell anyone watching.
   *
   * Emits on EVERY drop rather than only on the first: a UI that shows a count
   * needs it to move, and a subscriber that mounts late (the banner renders after
   * the first bootstrap fails, which is exactly when this fires) would otherwise
   * see nothing until a second, unrelated failure.
   */
  private recordSkew(drop: {
    quarantined?: number
    refusedFrames?: number
    error?: unknown
  }): void {
    const prior = this.skew
    this.skew = {
      quarantined: (prior?.quarantined ?? 0) + (drop.quarantined ?? 0),
      refusedFrames: (prior?.refusedFrames ?? 0) + (drop.refusedFrames ?? 0),
      firstError: prior?.firstError ?? (drop.error === undefined ? undefined : String(drop.error)),
      since: prior?.since ?? Date.now(),
    }
    this.emit('wireSkew', this.skew)
  }

  /** The running tally of what this build could not read, or null if it has read
   *  everything the server has sent. */
  wireSkew(): WireSkew | null {
    return this.skew
  }

  /** Subscribe to {@link wireSkew}, replaying the current tally if there is one —
   *  a banner that mounts after the failure must still show it. */
  onWireSkew(cb: (skew: WireSkew) => void): () => void {
    if (this.skew) cb(this.skew)
    return this.on('wireSkew', cb)
  }

  /**
   * Total dispatch over the parsed ServerMessage union [spec:SP-3fe2]: the
   * handler table is a mapped type over `ServerMessage['type']`, so adding a
   * message type to the protocol breaks compilation HERE until it is handled —
   * the hand-written if-ladder this replaces could silently ignore one.
   */
  private readonly dispatchServerMessage = createDispatcher<
    ServerMessageLenient,
    { dropped: number }
  >({
    pong: () => {
      // Liveness was already recorded in onmessage; here the pong closes out the
      // oldest in-flight ping to yield a round-trip sample.
      const sentAt = this.pingQueue.shift()
      if (sentAt !== undefined) {
        this.lastRttMs = Date.now() - sentAt
        if (this.pingQueue.length === 0) this.clearStaleTimer()
        this.evaluateHealth()
      }
    },
    welcome: (msg) => {
      this.clientIdValue = msg.clientId
      this.notifyConnections()
    },
    // POD-1081: attach/requestControl refusal. Unauthorized is sticky so we do
    // not retry a principal that cannot see the session or use its machine.
    terminalOutcome: (msg) => {
      if (msg.outcome === 'unauthorized') {
        this.terminalAttachDenials.add(msg.sessionId)
      }
      this.connections.get(msg.sessionId)?._outcome(msg.outcome)
    },
    metadataDelta: (msg, context) => {
      this.legacyFeed?.frame(msg, context.dropped)
    },
    // ---- wire v2 (POD-308 built it, POD-376 consumes it) ----
    // WHICH WIRE THIS HUB SPEAKS IS PER CONNECTION, not per build. Without a
    // `feed` sink the hub sends no `wireVersion`, the server serves it through
    // the v1 edge adapter, and these frames never arrive — so forwarding to an
    // absent sink is the correct no-op rather than a swallowed frame. With one,
    // `hello` announces the version and the server's identity adapter passes the
    // canonical frames through untouched.
    //
    // FORWARDED RAW, IN ARRIVAL ORDER, AND NOTHING ELSE HAPPENS HERE. No
    // cursor bookkeeping, no gap detection, no heal — every one of those is the
    // kernel Replica's, and a transport that did any of them would be the second
    // place the ladder lives. Note in particular what is NOT done: this does not
    // call `healMetadata()` on a suspect frame the way `metadataDelta` does. The
    // v2 frame certifies its own range, so a gap is something the Replica sees in
    // `fromSeq` and resolves down its own ladder; healing from here would be the
    // transport deciding a rung. Parser quarantine counts are ignored here too.
    //
    // The rollout order is server → clients → daemons
    // (docs/rearch-wire-cutover-rollout.md): this is the CLIENT step, and it stays
    // separately deployable because the sink is optional — a build that ships it
    // with the flag off is byte-for-byte a v1 peer.
    feedDelta: (msg) => {
      this.opts.feed?.frame(msg)
    },
    feedBootstrap: (msg) => {
      this.opts.feed?.frame(msg)
    },
    feedRescope: (msg) => {
      this.opts.feed?.frame(msg)
    },
    feedResyncRequired: (msg) => {
      this.opts.feed?.frame(msg)
    },
    presenceRoomState: (msg) => {
      this.emit('presenceRoomState', msg)
    },
    presenceRoomDelta: (msg) => {
      this.emit('presenceRoomDelta', msg)
    },
    presenceRoomClosed: (msg) => {
      this.emit('presenceRoomClosed', msg)
    },
    sessionsChanged: (msg) => {
      this.sessionList = msg.sessions
      this.emit('sessions', this.sessionList)
    },
    sessionViewDelta: (msg) => {
      const removed = new Set(msg.removedSessionIds)
      this.sessionList = this.sessionList.filter((session) => !removed.has(session.sessionId))
      this.emit('sessions', this.sessionList)
    },

    conversationsChanged: (msg) => {
      this.conversationList = msg.conversations
      this.emit('conversations', this.conversationList)
    },
    automationsChanged: (msg) => {
      this.automationList = msg.automations
      this.emit('automations', this.automationList)
    },
    automationRunsChanged: (msg) => {
      this.automationRunList = msg.automationRuns
      this.emit('automationRuns', this.automationRunList)
    },
    hostMetricsChanged: (msg) => {
      this.hostMetricsList = msg.hosts
      this.emit('hostMetrics', this.hostMetricsList)
    },
    issuesChanged: (msg) => {
      this.issueList = msg.issues
      this.emit('issues', this.issueList)
    },
    issueUpdated: (msg) => {
      // Upsert, not just replace: single-issue broadcasts are the server's primary
      // issue delta (#22), so an id we haven't seen yet must join the list rather
      // than be dropped on the floor.
      this.issueList = this.issueList.some((i) => i.id === msg.issue.id)
        ? this.issueList.map((i) => (i.id === msg.issue.id ? msg.issue : i))
        : [...this.issueList, msg.issue]
      this.emit('issues', this.issueList)
      this.emit('issueUpdated', msg.issue)
    },
    attentionEvent: (msg) => {
      this.emit('attention', { sessionId: msg.sessionId, title: msg.title, body: msg.body })
    },
    setLogLevel: (msg) => {
      // APPLIED HERE, not emitted for an app to wire (POD-1920). Every client
      // that speaks this protocol runs this hub, and a per-app subscription is
      // one composition root away from a feature that ships inert on the
      // platform whose author forgot it — which for a diagnostic knob would
      // mean an operator raising a phone that never hears them, with nothing
      // failing to say so. `applyServerLogLevel` is a no-op before client
      // logging is installed.
      applyServerLogLevel({ level: msg.level, ...(msg.ttlMs ? { ttlMs: msg.ttlMs } : {}) })
    },
    sessionOpenUrl: (msg) => {
      this.emit('openUrl', msg)
    },
    sessionOpenUrlResult: (msg) => {
      this.emit('openUrlResult', msg)
    },
    headlessActivity: (msg) => {
      this.emit('headlessActivity', msg.sessionId, msg.event)
    },
    transcriptDelta: (msg) => {
      // Track the newest cursor so a reconnect resumes from here. A reset frame
      // re-seeds: keep the new tail too (the caller re-reads its window).
      const entry = this.transcripts.get(msg.sessionId)
      if (entry && msg.tail) entry.since = msg.tail
      this.emit('transcriptDelta', msg.sessionId, msg.items, { reset: msg.reset ?? false })
    },
    sessionTitleChanged: (msg) => {
      let changed = false
      this.sessionList = this.sessionList.map((s) => {
        if (s.sessionId !== msg.sessionId || s.title === msg.title) return s
        changed = true
        return { ...s, title: msg.title }
      })
      if (changed) this.emit('sessions', this.sessionList)
    },
    sessionDraftChanged: (msg) => {
      this.emit('sessionDraft', msg.sessionId, msg.text)
    },
    sessionAgentStateChanged: (msg) => {
      let changed = false
      this.sessionList = this.sessionList.map((s) => {
        if (s.sessionId !== msg.sessionId) return s
        changed = true
        return { ...s, agentState: msg.state }
      })
      if (changed) this.emit('sessions', this.sessionList)
    },
    machinesChanged: (msg) => {
      this.machinesList = msg.machines
      this.emit('machines', this.machinesList)
    },
    worktreesChanged: (msg) => {
      this.emit('worktreesChanged', msg.repoPath, msg.machineId)
    },
    approvalsChanged: (msg) => {
      this.approvalsList = msg.pending
      this.emit('approvals', this.approvalsList)
    },
    // Session-scoped terminal stream: forwarded to the matching SessionConnection
    // (or dropped when no view is attached — same as the old fall-through arm).
    attached: (msg) => this.forwardToSession(msg),
    outputFrame: (msg) => this.forwardToSession(msg),
    controllerChanged: (msg) => this.forwardToSession(msg),
    geometry: (msg) => this.forwardToSession(msg),
    agentExit: (msg) => this.forwardToSession(msg),
  })

  private forwardToSession(msg: SessionScopedServerMessage): void {
    this.connections.get(msg.sessionId)?._ingest(msg)
  }

  private metadataProjection(): LegacyMetadataProjection {
    return {
      sessions: this.sessionList,
      issues: this.issueList,
      issueProjections: this.issueProjectionList,
      issueDeps: this.issueDepList,
      repos: this.repoList,
      shipOrders: this.shipOrderList,
      conversations: this.conversationList,
      automations: this.automationList,
      automationRuns: this.automationRunList,
    }
  }

  private replaceMetadataSnapshot(result: LegacyMetadataProjection): void {
    this.sessionList = result.sessions
    this.issueList = result.issues
    this.issueProjectionList = result.issueProjections
    this.issueDepList = result.issueDeps
    this.repoList = result.repos
    this.shipOrderList = result.shipOrders ?? []
    this.conversationList = result.conversations
    this.automationList = result.automations
    this.automationRunList = result.automationRuns
    this.emit('sessions', this.sessionList)
    this.emit('issues', this.issueList)
    this.emit('issueProjections', this.issueProjectionList)
    this.emit('issueDeps', this.issueDepList)
    this.emit('repos', this.repoList)
    this.emit('shipOrders', this.shipOrderList)
    this.emit('conversations', this.conversationList)
    this.emit('automations', this.automationList)
    this.emit('automationRuns', this.automationRunList)
  }

  /** Fold wire changes into the entity lists and notify only touched observers.
   *  Exhaustive over the KNOWN entity kinds; an unknown kind (a NEWER server,
   *  [spec:SP-3fe2] #258) is ignored with a debug log — the old else-branch
   *  folded anything unrecognised into the conversation list, silently
   *  corrupting it. Position advancement remains solely the Replica adapter's decision. */
  private applyChanges(changes: MetadataChangeLenient[]): void {
    const touched = new Set<MetadataChange['entity']>()
    for (const c of changes) {
      if (!isKnownMetadataChange(c)) {
        log.debug('ignoring metadata change with unknown entity kind', { entity: c.entity })
        continue
      }
      touched.add(c.entity)
      switch (c.entity) {
        case 'session':
          this.sessionList = applyChange(
            this.sessionList,
            c.op,
            c.value,
            (s) => s.sessionId === c.id,
          )
          break
        case 'issue':
          this.issueList = applyChange(this.issueList, c.op, c.value, (i) => i.id === c.id)
          break
        case 'issueProjection':
          this.issueProjectionList = applyChange(
            this.issueProjectionList,
            c.op,
            c.value,
            (i) => i.id === c.id,
          )
          break
        case 'issueDep':
          this.issueDepList = applyChange(this.issueDepList, c.op, c.value, (d) => d.id === c.id)
          break
        case 'repo':
          this.repoList = applyChange(this.repoList, c.op, c.value, (r) => r.id === c.id)
          break
        case 'shipOrder':
          this.shipOrderList = applyChange(
            this.shipOrderList,
            c.op,
            c.value,
            (order) => order.id === c.id,
          )
          break
        case 'conversation':
          this.conversationList = applyChange(
            this.conversationList,
            c.op,
            c.value,
            (x) => x.id === c.id,
          )
          break
        case 'automation':
          this.automationList = applyChange(
            this.automationList,
            c.op,
            c.value,
            (x) => x.id === c.id,
          )
          break
        case 'automationRun':
          this.automationRunList = applyChange(
            this.automationRunList,
            c.op,
            c.value,
            (x) => x.id === c.id,
          )
          break
        case 'issueEvent':
          // POD-1772. Matched on the composite id the Authority logs
          // (`issueEventRowId`), which is also the row's own `id` field — an
          // eviction arrives as a `delete` carrying only that id.
          this.issueEventList = applyChange(
            this.issueEventList,
            c.op,
            c.value,
            (x) => x.id === c.id,
          )
          break
        case 'userLayout':
          // Feed demux for POD-1350's per-user layout rows. Match on the same
          // composite id the Authority logs (layoutRowId), not payload equality.
          this.userLayoutList = applyChange(
            this.userLayoutList,
            c.op,
            c.value,
            (x) => layoutRowId(x.userId, x.key) === c.id,
          )
          break
        case 'userReadPosition':
          // Same demux for POD-1380's read positions, matched on readPositionRowId.
          this.userReadPositionList = applyChange(
            this.userReadPositionList,
            c.op,
            c.value,
            (x) => readPositionRowId(x.userId, x.streamId) === c.id,
          )
          break
        default:
          c satisfies never
      }
    }
    if (touched.has('session')) this.emit('sessions', this.sessionList)
    if (touched.has('issue')) this.emit('issues', this.issueList)
    if (touched.has('issueProjection')) this.emit('issueProjections', this.issueProjectionList)
    if (touched.has('issueDep')) this.emit('issueDeps', this.issueDepList)
    if (touched.has('repo')) this.emit('repos', this.repoList)
    if (touched.has('issueEvent')) this.emit('issueEvents', this.issueEventList)
    if (touched.has('shipOrder')) this.emit('shipOrders', this.shipOrderList)
    if (touched.has('conversation')) this.emit('conversations', this.conversationList)
    if (touched.has('automation')) this.emit('automations', this.automationList)
    if (touched.has('automationRun')) this.emit('automationRuns', this.automationRunList)
    if (touched.has('userLayout')) this.emit('userLayouts', this.userLayoutList)
    if (touched.has('userReadPosition')) this.emit('userReadPositions', this.userReadPositionList)
  }

  private sendPresenceFrame(frame: PresenceRoomClientMessage): boolean {
    const socket = this.socket
    if (!this.connectedFlag || socket === undefined) return false
    if ((socket.bufferedAmount ?? 0) >= PRESENCE_OUTBOUND_BUDGET_BYTES) return false
    socket.send(JSON.stringify(frame))
    return true
  }

  private notifyConnections(): void {
    for (const c of this.connections.values()) c._notifyHubChange()
  }

  private sendRaw(msg: Parameters<typeof encode>[0]): void {
    // Only send on an OPEN socket. connectedFlag is true exactly between onopen and
    // close, so a send issued while the socket is still CONNECTING (or already
    // closing) is queued instead of throwing InvalidStateError — the crash that
    // otherwise tears down the whole connection over a slow link. onopen flushes it.
    if (this.connectedFlag) {
      this.socket?.send(encode(msg))
    } else if (this.socket && this.preOpenQueue.length < INPUT_QUEUE_CAP) {
      this.preOpenQueue.push(msg)
    }
  }
}

/** The ServerMessage members addressed to a single session's terminal stream —
 *  the subset the hub forwards into SessionConnection._ingest. */
export type SessionScopedServerMessage = Extract<
  ServerMessage,
  { type: 'attached' | 'outputFrame' | 'controllerChanged' | 'geometry' | 'agentExit' }
>

/** A per-session view of the hub: tagged sends + the session's authoritative state. */
export class SessionConnection {
  readonly sessionId: SessionId
  private readonly hub: SocketHub
  private cb: SessionCallbacks
  private controllerId: string | null = null
  private controllerIdentity: PresenceIdentity | null = null
  private outcome: TerminalOutcome | null = null
  private cols: number
  private rows: number
  private epoch = 0
  private lastSeq = -1
  /** What the last attach said about the session's durable output counter. An
   *  older server omits the flag; that reads as "already produced", so the
   *  silent-startup affordance stays off rather than firing on no evidence. */
  private attachOutputSeen = true
  /** A non-empty frame has landed on THIS connection. Latched separately from
   *  the attach flag so a later attach can never un-see output we rendered. */
  private frameSeen = false
  private readonly echo = new EchoLatencyTracker()

  constructor(
    hub: SocketHub,
    sessionId: SessionId,
    cb: SessionCallbacks,
    viewport: ConnectionViewport,
  ) {
    this.hub = hub
    this.sessionId = sessionId
    this.cb = cb
    this.cols = viewport.cols
    this.rows = viewport.rows
  }

  setCallbacks(cb: SessionCallbacks): void {
    this.cb = cb
  }

  /** Last outputFrame seq rendered — the resume cursor the hub sends on reconnect. */
  get resumeCursor(): number {
    return this.lastSeq
  }

  sendInput(bytes: string, inputEventAt?: number): void {
    if (this.echo.enabled()) this.echo.onInput(inputEventAt ?? interactionNow())
    this.hub._sendInput({ type: 'input', sessionId: this.sessionId, data: utf8ToBase64(bytes) })
  }

  /** Enable/disable and reset the opt-in input→paint collector. */
  setEchoLatencyEnabled(enabled: boolean): void {
    this.echo.setEnabled(enabled)
  }

  /** Whether the next xterm render needs a browser-paint confirmation. */
  echoPaintPending(): boolean {
    return this.echo.awaitingPaint()
  }

  /** Close pending samples after xterm rendered and the browser crossed paint. */
  markEchoPaint(): void {
    this.echo.onPaint(interactionNow())
  }

  /** Input-event→paint latency over the last 30s — see {@link EchoLatencyTracker}. */
  echoLatency(): EchoLatencyStats {
    return this.echo.stats(interactionNow())
  }

  sendResize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.hub._send({ type: 'resize', sessionId: this.sessionId, cols, rows })
  }

  /**
   * Report this client's fitted viewport without optimistically replacing the
   * authoritative geometry in {@link state}. The server already records resize
   * frames from spectators; a crop view uses that record if its first input
   * later requests control, while continuing to render the current server grid.
   */
  reportViewport(cols: number, rows: number): void {
    this.hub._send({ type: 'resize', sessionId: this.sessionId, cols, rows })
  }

  requestControl(): void {
    this.hub._send({ type: 'requestControl', sessionId: this.sessionId })
  }

  redraw(): void {
    this.hub._send({ type: 'redrawRequest', sessionId: this.sessionId })
  }

  state(): ConnectionState {
    const clientId = this.hub.clientId
    return {
      connected: this.hub.connected,
      clientId,
      controllerId: this.controllerId,
      controllerIdentity: this.controllerIdentity,
      outcome: this.outcome,
      sessionId: this.sessionId,
      role: clientId !== '' && clientId === this.controllerId ? 'controller' : 'spectator',
      cols: this.cols,
      rows: this.rows,
      epoch: this.epoch,
      lastSeq: this.lastSeq,
      outputSeen: this.attachOutputSeen || this.frameSeen,
    }
  }

  /** @internal Hub-internal: apply a session-scoped server message. */
  _ingest(msg: SessionScopedServerMessage): void {
    this.dispatchSessionMessage(msg, undefined)
  }

  /** Total dispatch over the session-scoped subunion [spec:SP-3fe2] — the same
   *  compile-checked exhaustiveness as the hub's table, replacing the switch. */
  private readonly dispatchSessionMessage = createDispatcher<SessionScopedServerMessage>({
    attached: (msg) => {
      this.outcome = null
      this.controllerId = msg.controllerId
      this.controllerIdentity = msg.controllerIdentity ?? null
      this.cols = msg.geometry.cols
      this.rows = msg.geometry.rows
      this.epoch = msg.epoch
      this.attachOutputSeen = msg.outputSeen !== false
      // A full replay (not a `resumed` catch-up) is about to re-send the whole
      // buffer: clear the screen first so it rebuilds cleanly. A resume keeps the
      // screen and appends the missed frames.
      if (msg.resumed !== true) this.cb.onReset?.()
      this.emit()
      this.cb.onAttached?.()
    },
    outputFrame: (msg) => {
      this.lastSeq = msg.seq
      this.epoch = msg.epoch
      if (this.echo.enabled()) this.echo.onOutput(interactionNow())
      const text = fromBase64Utf8(msg.data)
      // Latch before emit so the state this frame publishes already says the
      // PTY has spoken — a subscriber that clears a waiting affordance on the
      // state must not see one more "silent" snapshot after real output.
      if (text.length > 0) this.frameSeen = true
      this.emit()
      this.cb.onFrame?.(text)
    },
    controllerChanged: (msg) => {
      this.controllerId = msg.controllerId
      this.controllerIdentity = msg.controllerIdentity ?? null
      this.cols = msg.geometry.cols
      this.rows = msg.geometry.rows
      this.emit()
    },
    geometry: (msg) => {
      this.cols = msg.cols
      this.rows = msg.rows
      this.emit()
    },
    agentExit: () => {
      this.emit()
    },
  })

  /** @internal Transport outcome for this session. */
  _outcome(outcome: TerminalOutcome): void {
    this.outcome = outcome
    this.emit()
    this.cb.onOutcome?.(outcome)
  }

  /** @internal Hub-internal: connection/clientId changed → recompute role. */
  _notifyHubChange(): void {
    this.emit()
  }

  private emit(): void {
    this.cb.onState?.(this.state())
  }
}
