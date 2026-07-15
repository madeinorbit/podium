import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CAP_METADATA_DELTA,
  type ConversationSummaryWire,
  type IssueWire,
  isKnownMetadataChange,
  type MetadataChangeLenient,
  type MetadataDeltaMessageLenient,
  parseChangesSinceResult,
  parseServerMessageLenient,
  SESSION_COOKIE,
  type SessionMeta,
  type SyncChangesSinceResultLenient,
  WIRE_VERSION,
} from '@podium/protocol'
import { stateDir } from '@podium/runtime/local-machine'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import WebSocket from 'ws'

/**
 * UpstreamSync — the node side of node⇄hub sync (docs/spec/node-hub-sync.md §2.2).
 *
 * A server acting as a NODE runs one of these as a CLIENT of its hub, reusing the
 * thin-client protocol end-to-end: a /client WS in delta mode (hello advertises
 * `caps: ['metadataDelta']`, authenticated by riding the hub-minted token as the
 * `podium_session` cookie on the upgrade), plus `sync.changesSince(cursor)` over
 * HTTP tRPC with the same cookie for catch-up. The cursor is persisted in the
 * node's store, so a restart resumes with a DELTA, not a snapshot.
 *
 * What it applies where:
 *  - sessions + conversations → the registry's upstream mirror
 *    (setUpstreamSessions / setUpstreamConversations — read-only, viaHub-marked,
 *    echo-filtered there);
 *  - issues → the registry's upstream ISSUE mirror (setUpstreamIssues — P7b,
 *    docs/spec/node-hub-issues.md §2.1: merged into the node's issue WIRE only,
 *    never into its IssueService store) + stored verbatim (setUpstreamIssuesJson)
 *    so the replica survives restarts.
 *
 * Failure posture mirrors SocketHub server-side: exponential reconnect backoff
 * (flat-capped), and on hub loss the mirror KEEPS last-known entries, flagged
 * stale (setUpstreamStale(true)) — degrade to stale-visible, never to blank. A
 * bad/revoked token is just a failed upgrade: logged, retried on the same
 * backoff, never a crash.
 */

/** The registry surface UpstreamSync writes into (kept narrow for unit tests). */
export interface UpstreamMirror {
  setUpstreamSessions(list: SessionMeta[]): void
  setUpstreamConversations(list: ConversationSummaryWire[]): void
  setUpstreamIssues(list: IssueWire[]): void
  setUpstreamStale(stale: boolean): void
}

/** The store surface UpstreamSync persists through: the cursor, the last-known
 *  replica (so a restart resumes with a delta on top of durable state, never a
 *  delta over nothing), and the P7b issue blob. */
export interface UpstreamSyncStore {
  getUpstreamCursor(): number | null
  setUpstreamCursor(cursor: number): void
  getUpstreamSessionsJson(): string | null
  setUpstreamSessionsJson(json: string): void
  getUpstreamConversationsJson(): string | null
  setUpstreamConversationsJson(json: string): void
  getUpstreamIssuesJson(): string | null
  setUpstreamIssuesJson(json: string): void
}

/**
 * The narrow tRPC client shape UpstreamSync needs — just `sync.changesSince` —
 * so it depends only on @podium/protocol's wire types, never the app's actual
 * `AppRouter` (packages must not import apps/server). `createTRPCClient` is
 * called untyped and cast to this shape (the same pattern @podium/issue-client
 * uses for its own structural `IssueTrpc` seam): the wire shape IS the server's
 * AppRouter, but nothing here needs tRPC's compile-time router inference to get
 * that — the result is cast to `SyncChangesSinceResult` at the call site either way.
 */
export interface UpstreamTrpcClient {
  sync: {
    changesSince: {
      query(input: { cursor: number | null }): Promise<unknown>
    }
  }
}

export interface UpstreamSyncOptions {
  /** Hub base URL — http(s):// or ws(s)://, with or without a trailing slash. */
  url: string
  /** Hub-minted client-session token (spec §2.1) — rides as the session cookie. */
  token: string
  mirror: UpstreamMirror
  store: UpstreamSyncStore
  /** Reconnect backoff bounds (test seam). Defaults mirror SocketHub's posture. */
  backoff?: { minMs?: number; maxMs?: number }
  /** Fired after each successful catch-up (the hub is provably reachable over
   *  HTTP) — P7b's outbox drain trigger on upstream (re)connect. */
  onConnected?: () => void
}

// Same posture as SocketHub (packages/terminal-client/src/connection.ts): quick
// first retry, capped low — a node behind a flaky link should feel snappy when
// the hub returns, and a hammering loop at 10s is harmless server-side.
const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 10_000
// Flat retry for a failed changesSince heal while the socket is up (a tRPC blip
// with a healthy WS is rare; a reconnect re-enters the heal path anyway).
const HEAL_RETRY_MS = 2_000
// Repeating-failure log throttle: state changes always log; retries of the same
// failure at most this often, so a dead hub doesn't flood the journal.
const LOG_THROTTLE_MS = 30_000

/** `{ http, ws }` bases (no trailing slash) from a config `upstream.url`. */
export function normalizeUpstreamUrl(url: string): { http: string; ws: string } {
  const trimmed = url.replace(/\/+$/, '')
  const parsed = new URL(trimmed)
  const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:'
  const rest = trimmed.replace(/^[a-z+]+:\/\//i, '')
  return {
    http: `${secure ? 'https' : 'http'}://${rest}`,
    ws: `${secure ? 'wss' : 'ws'}://${rest}`,
  }
}

/**
 * The machineId this node's own daemon registers under when paired with a REMOTE
 * server (the hub) — read from the daemon identity file the daemon keeps in the
 * shared state dir. This is the echo-filter key (spec §2.3): hub sessions carrying
 * it originate from this very node and must not be mirrored back. Absent/unreadable
 * = no daemon identity here yet, nothing to filter.
 */
export function readOwnDaemonMachineId(dir: string = stateDir()): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'daemon.json'), 'utf8')) as {
      machineId?: unknown
    }
    return typeof raw.machineId === 'string' && raw.machineId ? raw.machineId : undefined
  } catch {
    return undefined
  }
}

export class UpstreamSync {
  private readonly httpBase: string
  private readonly wsBase: string
  private readonly cookie: string
  private readonly mirror: UpstreamMirror
  private readonly store: UpstreamSyncStore
  private readonly minBackoffMs: number
  private readonly maxBackoffMs: number
  private readonly onConnected: (() => void) | undefined

  // Node-side replica of the hub's wire entities, keyed by id so deltas apply
  // incrementally; pushed to the mirror as full lists (its setters replace).
  private readonly sessions = new Map<string, SessionMeta>()
  private readonly conversations = new Map<string, ConversationSummaryWire>()
  private readonly issues = new Map<string, IssueWire>()

  /** Last hub oplog seq applied; persisted so restarts resume with a delta. */
  private cursor: number | null
  private ws: WebSocket | undefined
  private stopped = true
  private healing = false
  /** Live deltas that arrived while a changesSince heal was in flight — replayed
   *  in order after the heal lands (the cursor check drops what the heal covered). */
  private pendingDeltas: MetadataDeltaMessageLenient[] = []
  private reconnectDelay: number
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private healRetryTimer: ReturnType<typeof setTimeout> | undefined
  private lastFailureLogAt = 0

  // ---- test seams (observability without poking privates) ----
  /** Kind of the most recent completed catch-up — 'delta' proves cursor resume. */
  lastCatchUpKind: 'snapshot' | 'delta' | null = null
  /** Completed catch-ups, in order. */
  readonly catchUps: Array<'snapshot' | 'delta'> = []
  /** WS connection attempts (grows across retries — the bad-token test's signal). */
  connectAttempts = 0

  private readonly trpc: UpstreamTrpcClient

  constructor(opts: UpstreamSyncOptions) {
    const { http, ws } = normalizeUpstreamUrl(opts.url)
    this.httpBase = http
    this.wsBase = ws
    this.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.token)}`
    this.mirror = opts.mirror
    this.store = opts.store
    this.minBackoffMs = opts.backoff?.minMs ?? RECONNECT_MIN_MS
    this.maxBackoffMs = opts.backoff?.maxMs ?? RECONNECT_MAX_MS
    this.onConnected = opts.onConnected
    this.reconnectDelay = this.minBackoffMs
    this.cursor = this.store.getUpstreamCursor()
    // Rehydrate the last-known replica: the persisted cursor's meaning depends on
    // it (a delta catch-up applies ON TOP of this state). A corrupt blob degrades
    // to an empty replica + null cursor → the next catch-up is a full snapshot.
    try {
      const sessions = JSON.parse(this.store.getUpstreamSessionsJson() ?? '[]') as SessionMeta[]
      const conversations = JSON.parse(
        this.store.getUpstreamConversationsJson() ?? '[]',
      ) as ConversationSummaryWire[]
      const issues = JSON.parse(this.store.getUpstreamIssuesJson() ?? '[]') as IssueWire[]
      for (const s of sessions) this.sessions.set(s.sessionId, s)
      for (const c of conversations) this.conversations.set(c.id, c)
      for (const i of issues) this.issues.set(i.id, i)
    } catch {
      this.sessions.clear()
      this.conversations.clear()
      this.issues.clear()
      this.cursor = null
    }
    this.trpc = createTRPCClient({
      links: [
        httpBatchLink({
          url: `${this.httpBase}/trpc`,
          headers: () => ({ cookie: this.cookie }),
        }),
      ],
    }) as unknown as UpstreamTrpcClient
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    // Surface the rehydrated last-known state immediately, stale until the first
    // catch-up confirms it (spec §2.3: stale-visible beats blank, from boot on).
    if (this.sessions.size > 0 || this.conversations.size > 0 || this.issues.size > 0) {
      this.push()
      this.mirror.setUpstreamStale(true)
    }
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    if (this.healRetryTimer) clearTimeout(this.healRetryTimer)
    this.healRetryTimer = undefined
    const ws = this.ws
    this.ws = undefined
    if (ws) UpstreamSync.silence(ws)
    ws?.terminate()
  }

  /** Strip a socket's handlers but keep swallowing its errors — terminate() on a
   *  still-CONNECTING socket emits a late 'error' that would otherwise be an
   *  uncaught exception once the real handlers are gone. */
  private static silence(ws: WebSocket): void {
    ws.removeAllListeners()
    ws.on('error', () => {})
  }

  private connect(): void {
    if (this.stopped) return
    this.connectAttempts += 1
    const ws = new WebSocket(`${this.wsBase}/client?v=${WIRE_VERSION}`, {
      headers: { cookie: this.cookie },
    })
    this.ws = ws
    ws.on('open', () => {
      this.reconnectDelay = this.minBackoffMs
      ws.send(
        JSON.stringify({
          type: 'hello',
          clientId: '',
          viewport: { cols: 80, rows: 24, dpr: 1 },
          caps: [CAP_METADATA_DELTA],
        }),
      )
      // Catch up over HTTP with the persisted cursor; deltas arriving meanwhile
      // buffer in pendingDeltas and replay after the heal (ordering-safe).
      void this.heal()
    })
    ws.on('message', (raw) => this.onFrame(String(raw)))
    // A rejected upgrade (401 bad/revoked token, 426 wire version) surfaces here,
    // not as 'close' — log it distinctly and fall into the same retry loop.
    ws.on('unexpected-response', (_req, res) => {
      this.logFailure(`upstream hub rejected connection (HTTP ${res.statusCode})`)
      ws.terminate()
      this.onLinkDown()
    })
    ws.on('error', (err) => {
      this.logFailure(`upstream hub connection error: ${(err as Error).message}`)
      // 'close' follows and drives the reconnect; nothing else to do here.
    })
    ws.on('close', () => this.onLinkDown())
  }

  /** Hub link lost (or never established): stale-flag the mirror (entries are
   *  RETAINED — spec §3.3) and schedule a backoff reconnect. */
  private onLinkDown(): void {
    if (this.stopped) return
    if (this.ws) UpstreamSync.silence(this.ws)
    this.ws = undefined
    this.healing = false
    this.pendingDeltas = []
    if (this.healRetryTimer) clearTimeout(this.healRetryTimer)
    this.healRetryTimer = undefined
    this.mirror.setUpstreamStale(true)
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, this.reconnectDelay)
    this.reconnectTimer.unref?.()
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxBackoffMs)
  }

  private onFrame(raw: string): void {
    // Lenient parse ([spec:SP-3fe2] #258): a NEWER hub may stream entity kinds
    // this node doesn't know — those rows pass through (applyChange ignores
    // them, the cursor advances). A KNOWN kind with an invalid value is still
    // quarantined; a quarantined delta element is an invisible cursor gap, so
    // dropped>0 goes straight to a changesSince heal instead of applying a
    // batch with a hole in it.
    let msg: ReturnType<typeof parseServerMessageLenient>['message']
    let dropped = 0
    try {
      const result = parseServerMessageLenient(raw)
      msg = result.message
      dropped = result.dropped
    } catch {
      return // not for us / malformed — the hub also streams legacy snapshots pre-hello
    }
    if (msg?.type !== 'metadataDelta') return
    if (dropped > 0) {
      void this.heal()
      return
    }
    if (this.healing) {
      this.pendingDeltas.push(msg)
      return
    }
    this.applyDelta(msg)
  }

  /** Apply a live delta batch; a gap (missed seq) falls back to a changesSince heal. */
  private applyDelta(msg: MetadataDeltaMessageLenient): void {
    for (const change of msg.changes) {
      if (this.cursor !== null && change.seq <= this.cursor) continue // already applied
      if (this.cursor !== null && change.seq !== this.cursor + 1) {
        void this.heal() // gap — never apply past a hole (spec gap rule)
        return
      }
      if (this.cursor === null) {
        // No cursor yet (first boot, heal not landed): don't guess — heal instead.
        void this.heal()
        return
      }
      this.applyChange(change)
      this.cursor = change.seq
    }
    this.store.setUpstreamCursor(this.cursor ?? msg.seq)
    this.push()
  }

  /** Fold one change into its entity mirror. Exhaustive over the KNOWN kinds;
   *  an unknown kind (a NEWER hub, [spec:SP-3fe2] #258) is ignored with a debug
   *  log — the old else-branch folded anything unrecognised into the ISSUES
   *  map, silently corrupting the mirror. The caller still advances the cursor
   *  past ignored rows, so an unknown kind never wedges or heal-loops the node.
   *  An upsert without a value is a producer error — drop-this-change
   *  (protocol note). */
  private applyChange(change: MetadataChangeLenient): void {
    if (!isKnownMetadataChange(change)) {
      console.debug(
        `[upstream] ignoring metadata change with unknown entity kind '${change.entity}'`,
      )
      return
    }
    switch (change.entity) {
      case 'session':
        if (change.op === 'remove') this.sessions.delete(change.id)
        else if (change.value !== undefined) this.sessions.set(change.id, change.value)
        break
      case 'conversation':
        if (change.op === 'remove') this.conversations.delete(change.id)
        else if (change.value !== undefined) this.conversations.set(change.id, change.value)
        break
      case 'issue':
        if (change.op === 'remove') this.issues.delete(change.id)
        else if (change.value !== undefined) this.issues.set(change.id, change.value)
        break
      // Automations are node-local schedulers, not hub-mirrored server state.
      // Consume their shared cursor rows explicitly without folding them into
      // one of the three upstream mirror maps.
      case 'automation':
      case 'automationRun':
        break
      default:
        change satisfies never
    }
  }

  /**
   * Cursor catch-up over HTTP tRPC (`sync.changesSince`). A null/compacted cursor
   * yields a snapshot (full replace); otherwise a delta from exactly where we left
   * off — including across an UpstreamSync/node restart (the persisted cursor).
   */
  private async heal(): Promise<void> {
    if (this.healing || this.stopped) return
    this.healing = true
    // Kind-tolerant result type ([spec:SP-3fe2] #258): a newer hub's delta may
    // carry unknown entity kinds — applyChange ignores them, the cursor still
    // lands on res.cursor.
    let res: SyncChangesSinceResultLenient
    try {
      res = await this.fetchChangesSinceValidated()
    } catch (err) {
      this.logFailure(`upstream changesSince failed: ${(err as Error).message}`)
      this.healing = false
      // Retry flat while the socket is up; a socket drop re-enters via reconnect.
      if (!this.stopped && this.ws && !this.healRetryTimer) {
        this.healRetryTimer = setTimeout(() => {
          this.healRetryTimer = undefined
          void this.heal()
        }, HEAL_RETRY_MS)
        this.healRetryTimer.unref?.()
      }
      return
    }
    if (this.stopped) return
    if (res.kind === 'snapshot') {
      this.sessions.clear()
      this.conversations.clear()
      this.issues.clear()
      for (const s of res.sessions) this.sessions.set(s.sessionId, s)
      for (const c of res.conversations) this.conversations.set(c.id, c)
      for (const i of res.issues) this.issues.set(i.id, i)
    } else {
      for (const change of res.changes) this.applyChange(change)
    }
    this.cursor = res.cursor
    this.store.setUpstreamCursor(res.cursor)
    this.lastCatchUpKind = res.kind
    this.catchUps.push(res.kind)
    this.healing = false
    // Replay deltas that raced the heal (cursor check drops what it covered).
    const pending = this.pendingDeltas
    this.pendingDeltas = []
    for (const msg of pending) {
      if (this.healing) {
        this.pendingDeltas.push(msg) // a replay hit a gap and re-healed — re-buffer
        continue
      }
      this.applyDelta(msg)
    }
    this.push()
    this.mirror.setUpstreamStale(false)
    this.onConnected?.()
  }

  /**
   * `sync.changesSince` + runtime validation ([spec:SP-3fe2] #247). The WS
   * frames parse leniently already; the HTTP heal result was consumed on
   * trust, so a known-kind row with a malformed value installed into the
   * mirror and the cursor skipped it permanently. A malformed result with a
   * live cursor escalates to a SNAPSHOT heal (null-cursor refetch — matching
   * the server's own corrupt-row fallback); a malformed snapshot throws into
   * heal()'s normal retry path. Never installs, never advances past silently.
   */
  private async fetchChangesSinceValidated(): Promise<SyncChangesSinceResultLenient> {
    const first = parseChangesSinceResult(
      await this.trpc.sync.changesSince.query({ cursor: this.cursor }),
      { fromCursor: this.cursor },
    )
    if (first !== null) return first
    if (this.cursor !== null) {
      this.logFailure('upstream changesSince result malformed — escalating to a snapshot heal')
      const snap = parseChangesSinceResult(
        await this.trpc.sync.changesSince.query({ cursor: null }),
      )
      // The escalation exists to REPLACE state we could not trust — only a
      // full snapshot does that. A shape-valid delta here (e.g. empty, with a
      // later cursor) would skip the malformed rows permanently.
      if (snap !== null && snap.kind === 'snapshot') return snap
    }
    throw new Error('malformed changesSince result')
  }

  /** Push the replica into the registry mirror + persist it (the durable base a
   *  restarted UpstreamSync rehydrates before applying its cursor delta). */
  private push(): void {
    const sessions = [...this.sessions.values()]
    const conversations = [...this.conversations.values()]
    const issues = [...this.issues.values()]
    this.mirror.setUpstreamSessions(sessions)
    this.mirror.setUpstreamConversations(conversations)
    this.mirror.setUpstreamIssues(issues)
    this.store.setUpstreamSessionsJson(JSON.stringify(sessions))
    this.store.setUpstreamConversationsJson(JSON.stringify(conversations))
    this.store.setUpstreamIssuesJson(JSON.stringify(issues))
  }

  private logFailure(message: string): void {
    const now = Date.now()
    if (now - this.lastFailureLogAt < LOG_THROTTLE_MS) return
    this.lastFailureLogAt = now
    console.warn(`[podium:upstream] ${message}`)
  }
}
