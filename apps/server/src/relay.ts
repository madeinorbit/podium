import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { basename, isAbsolute, join } from 'node:path'
import { fileChainSource, fileIdFor, recordToItemsForKind } from '@podium/agent-bridge'
import type { PodiumSettings } from '@podium/core'
import type {
  DirListResultMessage,
  FileAssetResultMessage,
  FileReadResultMessage,
  FileWriteResultMessage,
} from '@podium/protocol'
import {
  AgentKind,
  type AgentQuotaWire,
  type AgentRuntimeState,
  agentSupportsInitialPrompt,
  CAP_METADATA_DELTA,
  type ClientMessage,
  type ControlMessage,
  type ConversationDiagnosticWire,
  type ConversationSummaryWire,
  type DaemonHandshake,
  type DaemonMessage,
  type Geometry,
  type GitDiscoveryDiagnosticWire,
  type GitRepositoryWire,
  type HarnessAgent,
  type HeadlessActivityEvent,
  type HeadlessTurnEvent,
  type HostMetricsWire,
  type IssueWire,
  type MachineWire,
  type MetadataChange,
  type RepoOp,
  type ResumeRef,
  type ServerMessage,
  type SessionMeta,
  type SyncChangesSinceResult,
  type TranscriptItem,
  type UsageBucketWire,
  type WorkState,
} from '@podium/protocol'
import { AutoContinueController } from './auto-continue'
import { knownPathsFor } from './file-relay-policy'
import { type Capability, SCOPED_TARGET } from './issue-authz'
import { selectMailNudgeSession, sessionsForIssue } from './issue-util'
import { IssueService } from './issues'
import { LOCAL_MACHINE_ID } from './local-machine'
import { MirrorService } from './mirror'
import { ModelCatalog, type ModelCatalogSnapshot, type ModelProbe } from './model-catalog'
import {
  type AttentionNotice,
  attentionNotice,
  pushNtfy,
  pushTelegram,
  type TelegramConfig,
} from './notify'
import { MetadataOplog } from './oplog'
import { PairingManager } from './pairing'
import { type ClientConn, type Send, Session } from './session'
import { computePriorities } from './session-priority'
import { StewardService } from './steward'
import { type MachineRecord, type PinKind, SessionStore } from './store'
import {
  isGenericClaudeTitle,
  isTransientTitle,
  makeTitleDebouncer,
  titleFromPrompt,
} from './title-filter'
import { TranscriptIndexer } from './transcript-indexer'
import { optimisticComment, optimisticIssuePatch } from './upstream-forwarder'

/** sha-256 hex of a secret — matches the store's token-hash scheme. */
function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/** The narrow forwarder seam the registry needs (UpstreamForwarder implements it;
 *  kept minimal so relay tests can stub the write path without a hub). */
export interface IssueUpstreamForwarder {
  forward(proc: string, input: Record<string, unknown>): Promise<unknown>
  entries(): { mutationId: string; proc: string; input: string; attempts: number }[]
}

/**
 * The upstream-token mint primitive (node⇄hub sync §2.1): a long-lived, revocable
 * client_sessions row; the plaintext is returned exactly once (only its sha-256 is
 * stored). Standalone (store-only) so `scripts/mint-upstream-token.ts` can run it
 * against a hub's DB without constructing a full registry — a second registry's
 * boot reconciliation would append oplog rows behind a live server's back.
 */
export function mintUpstreamTokenInto(
  store: Pick<SessionStore, 'createClientSession'>,
  nowMs: number = Date.now(),
): string {
  const token = randomBytes(32).toString('base64url')
  // 10 years ≈ non-expiring, while keeping the ordinary expiry machinery (and
  // revocation via deleteClientSession) intact.
  const expiresAt = new Date(nowMs + 10 * 365 * 24 * 60 * 60 * 1000).toISOString()
  store.createClientSession(sha256(token), expiresAt)
  return token
}

/** Placeholder machineId for sessions/rows created before a real machine adopts
 *  them (single-machine boot, pre-provisioning). ensureLocalMachine rewrites these. */
const LOCAL_PLACEHOLDER = '__local__'

/** Routers/procs a relayed agent may invoke. `issues.*` is capability-gated by the router
 *  middleware (issueCapabilityGuard); everything else must be explicitly listed so a relay
 *  can never reach an ungated router (sessions/spawn/kill/etc.). `null` = any proc on that
 *  router. */
const RELAY_ALLOWED: Record<string, Set<string> | null> = {
  // null = every issues.* proc, which includes the agent-mail procs
  // (mailSend/mailInbox/mailClaim/mailPending, issue #103).
  issues: null,
  repos: new Set(['inferFromPath']),
}

const DEFAULT_GEOMETRY: Geometry = { cols: 80, rows: 24 }
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
// podium_events retention (issue #61): pruned on a sparse timer — first run
// shortly after boot, then every 6h. Hardcoded (no settings knob yet); revisit
// as a setting when the steward goes always-on.
const EVENT_RETENTION_MAX_AGE_DAYS = 14
const EVENT_RETENTION_MAX_ROWS = 50_000
const EVENT_PRUNE_BOOT_DELAY_MS = 60_000
const EVENT_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000
const SCAN_TIMEOUT_MS = 10_000
const FILE_RPC_TIMEOUT_MS = 10_000

export interface ScanResult {
  conversations: ConversationSummaryWire[]
  diagnostics: ConversationDiagnosticWire[]
}

export interface ScanReposResult {
  repositories: GitRepositoryWire[]
  diagnostics: GitDiscoveryDiagnosticWire[]
}

/** The daemon's memoryBreakdownResult, minus wire plumbing (type/requestId). */
export type MemoryBreakdown = Omit<
  Extract<DaemonMessage, { type: 'memoryBreakdownResult' }>,
  'type' | 'requestId'
>

/** Outcome of a daemon-executed operation (git op / harness one-shot). */
export interface OpResult {
  ok: boolean
  output: string
}

interface NotificationPushers {
  ntfy(topic: string, notice: AttentionNotice): void
  telegram(config: TelegramConfig, notice: AttentionNotice): void
}

const DEFAULT_NOTIFICATION_PUSHERS: NotificationPushers = {
  ntfy: pushNtfy,
  telegram: pushTelegram,
}

const TELEGRAM_SETUP_TTL_MS = 5 * 60 * 1000

interface TelegramSetupUpdate {
  updateId: number
  chatId: string | number
  chatType: string
  chatLabel?: string
  text: string
}

interface TelegramSetupClient {
  getMe(botToken: string): Promise<{ username: string }>
  getUpdates(botToken: string): Promise<TelegramSetupUpdate[]>
  sendMessage(config: TelegramConfig, text: string): Promise<void>
  acknowledgeUpdates?(botToken: string, offset: number): Promise<void>
}

interface SessionRegistryOptions {
  telegramSetup?: TelegramSetupClient
  generateTelegramSetupCode?: () => string
  now?: () => number
  /** Root of the transcript lake ($PODIUM_STATE_DIR/transcripts). Opt-in: when unset
   *  (the default — every existing test), NO mirror traffic is produced. */
  mirrorLakeDir?: string
  /** Live model-list probe (grok/cursor/opencode `models`). Injected in tests so the
   *  catalog never shells out; defaults to the real CLI probe. */
  modelProbe?: ModelProbe
}

interface PendingTelegramSetup {
  code: string
  botUsername: string
  expiresAtMs: number
}

export interface TelegramSetupStartResult {
  setupId: string
  code: string
  botUsername: string
  telegramUrl: string
  expiresAt: string
}

export type TelegramSetupPollResult =
  | { status: 'pending'; expiresAt: string }
  | { status: 'expired' }
  | {
      status: 'connected'
      chatId: string
      chatType: string
      chatLabel?: string
      settings: PodiumSettings
    }

type NotificationSettings = PodiumSettings['notifications']

function telegramConfig(settings: NotificationSettings): TelegramConfig {
  return {
    botToken: settings.telegramBotToken,
    chatId: settings.telegramChatId,
  }
}

function isTelegramEnabled(settings: NotificationSettings): boolean {
  const telegram = telegramConfig(settings)
  return telegram.botToken.trim() !== '' && telegram.chatId.trim() !== ''
}

function normalizedTelegramKey(settings: NotificationSettings): string {
  const telegram = telegramConfig(settings)
  return `${telegram.botToken.trim()}\n${telegram.chatId.trim()}`
}

function telegramApiUrl(botToken: string, method: string): string {
  return `https://api.telegram.org/bot${botToken.trim()}/${method}`
}

type TelegramApiBody = {
  ok?: boolean
  description?: string
  result?: unknown
}

async function telegramJson(
  botToken: string,
  method: string,
  init?: RequestInit,
): Promise<TelegramApiBody> {
  const res = await fetch(telegramApiUrl(botToken, method), init)
  const body = (await res.json().catch(() => ({}))) as TelegramApiBody
  if (res.ok && body.ok === true) return body
  const description = typeof body.description === 'string' ? body.description : `HTTP ${res.status}`
  throw new Error(description)
}

function telegramUpdateChatLabel(chat: {
  username?: unknown
  title?: unknown
  first_name?: unknown
}): string | undefined {
  if (typeof chat.username === 'string' && chat.username) return `@${chat.username}`
  if (typeof chat.title === 'string' && chat.title) return chat.title
  if (typeof chat.first_name === 'string' && chat.first_name) return chat.first_name
  return undefined
}

function parseTelegramSetupUpdates(result: unknown): TelegramSetupUpdate[] {
  if (!Array.isArray(result)) return []
  const updates: TelegramSetupUpdate[] = []
  for (const update of result) {
    if (!update || typeof update !== 'object') continue
    const u = update as { update_id?: unknown; message?: unknown; channel_post?: unknown }
    const msg = (u.message ?? u.channel_post) as { chat?: unknown; text?: unknown } | undefined
    const chat = msg?.chat as
      | { id?: unknown; type?: unknown; username?: unknown; title?: unknown; first_name?: unknown }
      | undefined
    if (typeof u.update_id !== 'number') continue
    if (!chat || (typeof chat.id !== 'number' && typeof chat.id !== 'string')) continue
    if (typeof chat.type !== 'string') continue
    if (typeof msg?.text !== 'string') continue
    updates.push({
      updateId: u.update_id,
      chatId: chat.id,
      chatType: chat.type,
      chatLabel: telegramUpdateChatLabel(chat),
      text: msg.text,
    })
  }
  return updates
}

const DEFAULT_TELEGRAM_SETUP_CLIENT: TelegramSetupClient = {
  async getMe(botToken) {
    const body = await telegramJson(botToken, 'getMe')
    const result = body.result as { username?: unknown } | undefined
    if (typeof result?.username !== 'string' || !result.username) {
      throw new Error('Telegram bot username was missing')
    }
    return { username: result.username }
  },
  async getUpdates(botToken) {
    const allowedUpdates = encodeURIComponent(JSON.stringify(['message', 'channel_post']))
    const body = await telegramJson(botToken, `getUpdates?allowed_updates=${allowedUpdates}`)
    return parseTelegramSetupUpdates(body.result)
  },
  async sendMessage(config, text) {
    await telegramJson(config.botToken, 'sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chatId.trim(), text }),
    })
  },
  async acknowledgeUpdates(botToken, offset) {
    await telegramJson(botToken, `getUpdates?offset=${offset}`)
  },
}

function defaultTelegramSetupCode(): string {
  return `PODIUM${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`
}

function telegramSetupUrl(botUsername: string, code: string): string {
  return `https://t.me/${botUsername}?start=${encodeURIComponent(code)}`
}

function telegramTextHasCode(text: string, code: string): boolean {
  const want = code.toUpperCase()
  return text
    .trim()
    .split(/\s+/)
    .some((part) => part.toUpperCase() === want)
}

/** Registry of all sessions + the per-machine daemon links + all client connections. Routes by sessionId. */
export class SessionRegistry {
  // machineId -> control-message sender for that daemon. Replaces the single
  // socket: each connected machine has its own send, so a session's control
  // messages route to the daemon that actually runs it.
  private readonly daemons = new Map<string, Send<ControlMessage>>()
  // Per-machine queue for control messages produced while that daemon is briefly
  // offline (e.g. the local daemon during boot, or a survivor session's reattach
  // before its machine re-attaches). Flushed in order on attachDaemon.
  private readonly pendingByMachine = new Map<string, ControlMessage[]>()
  // Short-lived pairing codes for new daemons (wsServer redeems these on handshake).
  private readonly pairing = new PairingManager()
  private readonly sessions = new Map<string, Session>()
  private readonly clients = new Map<string, ClientConn>()
  private readonly telegramSetups = new Map<string, PendingTelegramSetup>()
  /** Server-side issue tracker — constructed after loadFromStore() in the constructor. */
  readonly issues: IssueService
  /** Injected by server.ts: builds a tRPC caller bound to a capability — the scope-gate
   *  seam. A relayed agent op is run through this so the issueCapabilityGuard middleware
   *  enforces the subtree scope; it is NOT re-implemented here. Left undefined in tests that
   *  don't exercise the relay. */
  makeIssueCaller?: (
    capability: Capability,
    overrideScope?: boolean,
  ) => { [router: string]: Record<string, (i: unknown) => Promise<unknown>> | undefined }
  /** Backend auto-continue loop; constructed in the constructor (see below). */
  private autoContinue!: AutoContinueController
  /** Steward trigger queue over the event log; polls only while settings-enabled. */
  private steward!: StewardService
  private readonly pendingScans = new Map<string, (r: ScanResult) => void>()
  private readonly pendingRepoScans = new Map<string, (r: ScanReposResult) => void>()
  private readonly pendingBreakdowns = new Map<string, (r: MemoryBreakdown | undefined) => void>()
  private readonly pendingRepoOps = new Map<string, (r: OpResult) => void>()
  private readonly pendingHarnessExecs = new Map<string, (r: OpResult) => void>()
  private readonly pendingHeadlessTurns = new Map<
    string,
    {
      resolve: (r: {
        ok: boolean
        error?: string
        harnessSessionId?: string
        output?: string
      }) => void
      onEvent?: (e: HeadlessTurnEvent) => void
    }
  >()
  private readonly pendingHeadlessBinds = new Map<
    string,
    (r: { ok: boolean; error?: string }) => void
  >()
  private readonly pendingUsage = new Map<
    string,
    (r: { hostname: string; buckets: UsageBucketWire[] }) => void
  >()
  private readonly pendingAgentQuota = new Map<
    string,
    (r: { hostname: string; agents: AgentQuotaWire[] }) => void
  >()
  private readonly pendingTranscriptReads = new Map<
    string,
    (r: { items: TranscriptItem[]; head?: string; tail?: string; hasMore: boolean }) => void
  >()
  private readonly pendingMirrorReads = new Map<
    string,
    (r: { data: string; fileSize: number; eof: boolean; error?: string }) => void
  >()
  private readonly pendingUploads = new Map<string, (r: { path: string; error?: string }) => void>()
  private readonly pendingFileReads = new Map<
    string,
    (r: Omit<FileReadResultMessage, 'type' | 'requestId'>) => void
  >()
  private readonly pendingFileAssets = new Map<
    string,
    (r: Omit<FileAssetResultMessage, 'type' | 'requestId'>) => void
  >()
  private readonly pendingFileWrites = new Map<
    string,
    (r: Omit<FileWriteResultMessage, 'type' | 'requestId'>) => void
  >()
  private readonly pendingDirLists = new Map<
    string,
    (r: Omit<DirListResultMessage, 'type' | 'requestId'>) => void
  >()
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
  private latestConversations: ConversationSummaryWire[] = []
  private latestConversationDiagnostics: ConversationDiagnosticWire[] = []
  // Last session-list payload broadcast to clients. broadcastSessions() fires on many
  // events (activity bumps, attach/detach, resume refs) that often don't change any
  // visible field; skipping a byte-identical re-broadcast avoids re-serializing the
  // whole list and fanning it out to every client for nothing (audit P1-8). Existing
  // clients already hold this state; a NEW client gets the current list via
  // attachClient, so the dedup can never leave a client stale.
  private lastSessionsBroadcast = ''
  // Durable metadata change log fed at the broadcast seam (docs/spec/oplog-read-path.md).
  // Assigned in the constructor before loadFromStore (which can trigger broadcasts).
  private readonly oplog: MetadataOplog
  // SWR cache of live per-agent model lists (grok/cursor/opencode). Query-driven:
  // nothing probes until a client asks via getModelCatalog().
  private readonly modelCatalog: ModelCatalog
  // Transcript lake mirror (docs/spec/transcript-mirror.md) — constructed only when
  // options.mirrorLakeDir is set; undefined means zero mirror traffic (tests default).
  private readonly mirror: MirrorService | undefined
  // Mirror-fed FTS indexer (docs/spec/search-v1.md §2.3) — exists iff the mirror does.
  private readonly transcriptIndexer: TranscriptIndexer | undefined
  // Diagnostics ride the conversationsChanged snapshot, not the delta stream — track
  // their last serialization so cap clients still get a snapshot when ONLY diagnostics
  // changed (rare: scan problems), without re-sending the list on every conversation delta.
  private lastDiagnosticsBroadcast = ''
  // Latest health sample per daemon host, keyed by machineId — each connected
  // machine reports its own sample, scoped to it so a detach drops only its row.
  private readonly latestHostMetrics = new Map<string, HostMetricsWire>()
  private nextClientNum = 0
  // Shared by scan() ('r' prefix) and scanRepos() ('rr' prefix). Each scan
  // variant must use a distinct string prefix so ids never collide across the
  // separate pending maps.
  private nextRequestNum = 0
  // Last per-session output-relay priority pushed to the daemon. pushPriorities
  // diffs against this so only CHANGED sessions are re-sent (a viewState/attach
  // churn must not re-flood the daemon with the whole map every time).
  private readonly lastPriority = new Map<string, number>()

  private readonly telegramSetup: TelegramSetupClient
  private readonly generateTelegramSetupCode: () => string
  private readonly now: () => number
  // Single registry-wide timer that persists only sessions whose activity counters
  // advanced since the last tick — keeps the per-frame / per-keystroke path off the DB.
  private readonly activityFlushTimer = setInterval(() => this.flushActivity(), 12_000)
  // Sparse podium_events retention timers (issue #61): a one-shot boot delay that
  // hands off to the 6h interval. Both unref'd so they never hold the process open.
  private eventPruneBootTimer: ReturnType<typeof setTimeout> | undefined
  private eventPruneTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly store: SessionStore = new SessionStore(':memory:'),
    private readonly notificationPushers: NotificationPushers = DEFAULT_NOTIFICATION_PUSHERS,
    options: SessionRegistryOptions = {},
  ) {
    this.telegramSetup = options.telegramSetup ?? DEFAULT_TELEGRAM_SETUP_CLIENT
    this.generateTelegramSetupCode = options.generateTelegramSetupCode ?? defaultTelegramSetupCode
    this.now = options.now ?? Date.now
    this.activityFlushTimer.unref?.()
    this.modelCatalog = new ModelCatalog(options.modelProbe, {
      now: this.now,
      // Persist the catalog so the first picker-open after a restart/redeploy serves
      // the last-known list instantly (then refreshes), instead of a cold ~2s probe.
      load: () => this.store.getModelCatalog(),
      save: (snapshot) => this.store.setModelCatalog(snapshot),
    })
    this.oplog = new MetadataOplog(this.store, this.now)
    this.loadFromStore()
    if (options.mirrorLakeDir) {
      // The FTS indexer feeds off the mirror's chunk hooks (search-v1 §2.3) — it
      // exists only alongside the lake, and MirrorService stays indexing-free.
      const indexer = new TranscriptIndexer(this.store)
      this.transcriptIndexer = indexer
      this.mirror = new MirrorService(
        this.store,
        options.mirrorLakeDir,
        (machineId, req) => this.mirrorRead(machineId, req),
        this.now,
        {
          onBytes: (machineId, nativeId, lakePath) =>
            indexer.onBytes(machineId, nativeId, lakePath),
          onTruncate: (machineId, nativeId) => indexer.onTruncate(machineId, nativeId),
        },
      )
    } else {
      this.mirror = undefined
      this.transcriptIndexer = undefined
    }
    this.issues = new IssueService({
      store: this.store,
      listSessions: () => this.listSessions(),
      getSettings: () => this.store.getSettings(),
      spawnSession: (o) =>
        this.createSession({
          cwd: o.cwd,
          agentKind: o.agentKind as AgentKind,
          ...(o.model !== undefined ? { model: o.model } : {}),
          ...(o.effort !== undefined ? { effort: o.effort } : {}),
          ...(o.initialPrompt ? { initialPrompt: o.initialPrompt } : {}),
          ...(o.spawnedBy ? { spawnedBy: o.spawnedBy } : {}),
        }),
      repoOp: (op, cwd, args) => this.repoOp(op, cwd, args),
      getSessionIssueId: (sessionId) => this.getSessionIssueId(sessionId),
      setSessionIssueId: (sessionId, issueId) => this.setSessionIssueId(sessionId, issueId),
      broadcast: (msg) => {
        // Full issue-list fan-outs funnel through the oplog so delta-cap clients get
        // per-issue changes; everything else (issueUpdated etc.) stays a raw fan-out.
        if (msg.type === 'issuesChanged') this.publishIssues(msg.issues)
        else for (const c of this.clients.values()) c.send(msg)
      },
      // Agent mail send-time nudge (issue #103): poke the target issue's live agent
      // session so mail is noticed without polling. The nudge carries NO message
      // body — an idempotent "check your inbox" poke. Selection: a single idle
      // live agent gets an immediate sendText; otherwise the most recently active
      // live agent gets a durable queued send; no live agents → nothing (the mail
      // surfaces via prime / the stop-hook).
      onMailSent: (row) => {
        const members = sessionsForIssue(row.worktreePath, this.listSessions())
        const target = selectMailNudgeSession(members)
        if (!target) return
        const text = `You have mail on issue #${row.seq}: run 'podium issue mail inbox' (claim with 'podium issue mail claim <id>' only if you will act on it).`
        if (target.mode === 'send') this.sendText({ sessionId: target.sessionId, text })
        else void this.queueText({ sessionId: target.sessionId, text })
      },
    })
    // Boot-time reconciliation: reap draft issues leaked before the kill-path
    // reaper existed (sessions killed/removed while attached to an empty draft).
    // Sessions are already hydrated (loadFromStore ran above), so the emptiness
    // predicate sees real statuses: live sessions come back as 'reconnecting'
    // (not 'exited') and hibernated stays 'hibernated' — both block the reap,
    // so only truly dead drafts go.
    try {
      const reaped = this.issues.reapLeakedDrafts()
      if (reaped > 0) {
        console.warn(`[podium:issues] boot sweep reaped ${reaped} leaked draft issue(s)`)
      }
    } catch (err) {
      console.warn('[podium:issues] boot draft sweep failed:', err)
    }
    this.autoContinue = new AutoContinueController({
      isEnabled: () => this.store.getSettings().autoContinue.enabled,
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
    this.steward = new StewardService({
      store: this.store,
      issues: this.issues,
      listSessions: () => this.listSessions(),
      // Durable outbox path: the nudge survives restarts and waits out a booting TUI.
      sendTextWhenReady: (sessionId, text) => void this.queueText({ sessionId, text }),
      getSettings: () => this.store.getSettings(),
    })
    this.steward.start()
    // Event-log retention (issue #61): first prune ~1min after boot (off the boot
    // hot path), then every 6h. try/catch lives in pruneEventLog.
    this.eventPruneBootTimer = setTimeout(() => {
      this.pruneEventLog()
      this.eventPruneTimer = setInterval(() => this.pruneEventLog(), EVENT_PRUNE_INTERVAL_MS)
      this.eventPruneTimer.unref?.()
    }, EVENT_PRUNE_BOOT_DELAY_MS)
    this.eventPruneBootTimer.unref?.()
    // Boot reconciliation: record what changed across the restart (sessions restored
    // by loadFromStore, issues from the store) so a cursor-holding client that
    // reconnects can heal via changesSince instead of silently missing the gap.
    // Conversations are deliberately NOT reconciled here: they are daemon-fed, and
    // an empty list at boot means "not scanned yet", not "all gone" — recording it
    // would spam remove-all/re-upsert pairs around every restart.
    this.oplog.record(
      'session',
      this.listSessions().map((s) => ({ id: s.sessionId, value: s })),
    )
    this.oplog.record(
      'issue',
      this.safeIssuesList().map((i) => ({ id: i.id, value: i })),
    )
  }

  /** The backing store — shared with services that persist their own tables (superagent). */
  get sessionStore(): SessionStore {
    return this.store
  }

  private persist(session: Session): void {
    this.store.upsertSession(session.toRow())
  }

  /** Persist every session whose activity counters advanced since the last flush.
   *  Keeps the per-frame / per-keystroke path off the DB — the timer below calls
   *  this on a coarse interval, so a busy session writes at most once per tick. */
  flushActivity(): void {
    for (const s of this.sessions.values()) {
      if (s.activityDirty) {
        this.persist(s)
        s.clearActivityDirty()
      }
    }
  }

  /** One retention pass over podium_events. Failures are logged, never thrown —
   *  a broken prune must not take down the timer or the registry. */
  private pruneEventLog(): void {
    try {
      const deleted = this.store.pruneEvents({
        maxAgeDays: EVENT_RETENTION_MAX_AGE_DAYS,
        maxRows: EVENT_RETENTION_MAX_ROWS,
      })
      if (deleted > 0) console.log(`[podium:events] pruned ${deleted} event log rows`)
    } catch (err) {
      console.warn('[podium:events] event log prune failed:', err)
    }
  }

  dispose(): void {
    clearInterval(this.activityFlushTimer)
    if (this.eventPruneBootTimer) clearTimeout(this.eventPruneBootTimer)
    if (this.eventPruneTimer) clearInterval(this.eventPruneTimer)
    // Run any coalesced session broadcast so the oplog records the final state
    // (clients are going away, but the durable log must not drop the tail).
    this.flushBroadcasts()
    this.steward.dispose()
  }

  private loadFromStore(): void {
    // Restore persisted composer drafts so attachClient can replay them to the
    // first client to connect after a server restart (issue #34).
    for (const [sessionId, text] of Object.entries(this.store.loadDrafts())) {
      this.draftBySession.set(sessionId, text)
    }
    const draftTimes = this.store.loadDraftTimes()
    const snoozes = this.store.listSnoozes()
    for (const r of this.store.loadSessions()) {
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
        const podiumId = this.store.conversationPodiumId(s.machineId, s.resume.value)
        if (podiumId) s.conversationPodiumId = podiumId
      }
    }
    // Re-seed the transient queued-send counts from the durable queue — the rows
    // survived the restart (that's their point); delivery re-arms when the daemon
    // reattaches and the sessions bind.
    for (const [sessionId, n] of this.store.queuedMessageCounts()) {
      const session = this.sessions.get(sessionId)
      if (session) session.queuedMessageCount = n
      else this.store.deleteQueuedMessagesForSession(sessionId) // orphaned queue
    }
    this.store.pruneAppliedMutations({ maxAgeMs: APPLIED_MUTATIONS_MAX_AGE_MS, now: this.now() })
  }

  attachDaemon(machineId: string, send: Send<ControlMessage>): void {
    this.daemons.set(machineId, send)
    // The daemon may have (re-)registered/touched its machine row on the way in
    // (pair/hello, or a test upserting directly before attaching) — drop the cache.
    this.invalidateMachineCache()
    // The local machine adopts every lingering `'__local__'` placeholder row/session/
    // queue onto itself as it attaches. ensureLocalMachine already ran this at startup,
    // but a session created in the gap between that and the daemon connecting (the boot
    // race) is still attributed to `'__local__'` — adopting on attach reattributes it and
    // carries its queued spawn over to this machine so it isn't dead-queued. Idempotent.
    if (machineId === LOCAL_MACHINE_ID) this.adoptPlaceholderRows(machineId)
    // Flush control messages buffered while this machine was offline (e.g. a boot
    // session's spawn produced before the local daemon ws connected).
    const pending = this.pendingByMachine.get(machineId)
    if (pending && pending.length > 0) {
      this.pendingByMachine.delete(machineId)
      for (const m of pending) send(m)
    }
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
    this.triggerLakeSweep(machineId)
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
        ...(this.transcriptPathHint(s) ?? {}),
        // Spawn-time floor for observer-based harnesses (codex): lets a reattached
        // observer discover a lazily-created rollout it never saw before the restart.
        ...(Number.isFinite(Date.parse(s.createdAt)) ? { createdAtMs: Date.parse(s.createdAt) } : {}),
      })
    }
    // Headless sessions have no PTY to reattach; instead re-establish their
    // daemon-side transcript tails (fire-and-forget — re-issued on every daemon
    // connect, so a missed bind self-heals on the next attach).
    for (const s of this.sessions.values()) {
      if (s.machineId !== machineId || !s.headless || !s.resume?.value) continue
      void this.headlessBind({
        sessionId: s.sessionId,
        agentKind: s.agentKind,
        cwd: s.cwd,
        resumeValue: s.resume.value,
      }).then((r) => {
        if (!r.ok) {
          console.warn(`[podium] headless bind failed for ${s.sessionId}: ${r.error ?? 'unknown'}`)
        }
      })
    }
    this.broadcastMachines()
  }
  detachDaemon(machineId: string): void {
    this.daemons.delete(machineId)
    this.invalidateMachineCache()
    // This machine's host sample is only as live as its socket — drop it so a dead
    // machine's numbers never linger as truth. Keyed by machineId, so other machines'
    // samples are untouched.
    if (this.latestHostMetrics.delete(machineId)) this.broadcastHostMetrics()
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
    this.broadcastMachines()
  }

  /** Route a control message to the daemon that owns `machineId`; queue it if that
   *  machine is briefly offline (flushed in order on its next attachDaemon). */
  private readonly toMachine = (machineId: string, msg: ControlMessage): void => {
    const send = this.daemons.get(machineId)
    if (send) {
      send(msg)
      return
    }
    const q = this.pendingByMachine.get(machineId)
    if (q) q.push(msg)
    else this.pendingByMachine.set(machineId, [msg])
  }

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
      machineName: this.machineName(s.machineId),
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
  private readonly upstreamConversations = new Map<string, ConversationSummaryWire>()
  private upstreamStale = false
  /** machineIds that ARE this node (its daemon may also be paired with the hub in
   *  some topologies) — hub entries for them are echoes and are dropped at ingest. */
  private upstreamOwnMachineIds = new Set<string>()

  /** Rejection every command path returns for a hub-mirrored session (spec §2.3). */
  static readonly UPSTREAM_COMMAND_REJECTION = 'remote session — managed via the hub'

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
    return { ok: false, reason: SessionRegistry.UPSTREAM_COMMAND_REJECTION }
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

  /** Replace the mirrored conversation list (same pipeline as sessions). Conversations
   *  carry no machineId on the wire, so the echo filter here is id-based: a locally
   *  known conversation id wins over the hub copy. */
  setUpstreamConversations(list: ConversationSummaryWire[]): void {
    this.upstreamConversations.clear()
    const localIds = new Set(this.latestConversations.map((c) => c.id))
    for (const c of list) {
      if (localIds.has(c.id)) continue
      this.upstreamConversations.set(c.id, c)
    }
    this.broadcastConversations()
  }

  /**
   * Hub reachability flip. Unreachable → mirrored entries are KEPT and marked stale
   * (spec §2.3: degrade to stale-visible, never to blank); local entities are never
   * affected. Both directions rebroadcast so clients see the flag change.
   */
  setUpstreamStale(stale: boolean): void {
    if (this.upstreamStale === stale) return
    this.upstreamStale = stale
    if (this.upstreamSessions.size > 0) this.broadcastSessions()
    if (this.upstreamConversations.size > 0) this.broadcastConversations()
    if (this.upstreamIssues.size > 0) this.publishIssues(this.safeIssuesList())
  }

  /** Local ∪ upstream conversations — what attach/broadcast/changesSince serve. */
  private allConversations(): ConversationSummaryWire[] {
    if (this.upstreamConversations.size === 0) return this.latestConversations
    const localIds = new Set(this.latestConversations.map((c) => c.id))
    return [
      ...this.latestConversations,
      ...[...this.upstreamConversations.values()].filter((c) => !localIds.has(c.id)),
    ]
  }

  // ---- upstream issue mirror + write forwarding (docs/spec/node-hub-issues.md) ----
  // Hub issues merge into the node's issue WIRE only (issuesChanged / metadataDelta /
  // changesSince) — never into IssueService's store or derived logic (§2.1: ready/
  // blocked/deps arrive hub-computed on the wire). Writes targeting them forward to
  // the hub through the durable outbox (§2.2); pendingSync overlays keep the UI
  // truthful while an edit is queued, and hub truth always overwrites (P6a: the
  // replica never argues).
  private readonly upstreamIssues = new Map<string, IssueWire>()
  /** Optimistic overlays for QUEUED forwarded mutations, keyed by issue id. Merged
   *  at read time; dropped when hub truth arrives AND the outbox no longer holds an
   *  entry for the issue (so an unrelated hub push can't wipe a pending edit). */
  private readonly upstreamIssuePatches = new Map<string, Partial<IssueWire>>()
  private upstreamForwarder: IssueUpstreamForwarder | undefined

  setUpstreamForwarder(forwarder: IssueUpstreamForwarder): void {
    this.upstreamForwarder = forwarder
  }

  /** True when `id` is a hub-mirrored issue — the router's forwarding-detection key. */
  isUpstreamIssue(id: string): boolean {
    return this.upstreamIssues.has(id)
  }

  /** repoPaths that exist among hub issues — issues.create's "hub-only repo" reject
   *  check (spec §2.2: create stays local; a hub-only repoPath is detectable here). */
  upstreamIssueRepoPaths(): Set<string> {
    return new Set([...this.upstreamIssues.values()].map((i) => i.repoPath))
  }

  /**
   * Replace the mirrored issue list with the hub's truth (UpstreamSync push).
   * Entries are stamped `viaHub` at ingest. Id collisions with a LOCAL issue are
   * impossible by construction (`iss_<uuid>`) but guarded anyway: the local issue
   * wins and the anomaly is logged (spec §2.1). Hub truth arriving also retires
   * optimistic overlays whose outbox entries have drained — the replica never argues.
   */
  setUpstreamIssues(list: IssueWire[]): void {
    this.upstreamIssues.clear()
    for (const i of list) {
      if (this.issues?.get(i.id)) {
        console.warn(
          `[podium:upstream] hub issue id collides with a local issue — local wins: ${i.id}`,
        )
        continue
      }
      this.upstreamIssues.set(i.id, { ...i, viaHub: true })
    }
    const stillQueued = this.pendingUpstreamTargets()
    for (const id of [...this.upstreamIssuePatches.keys()]) {
      if (!stillQueued.has(id)) this.upstreamIssuePatches.delete(id)
    }
    this.publishIssues(this.safeIssuesList())
  }

  /** Issue ids with at least one mutation still queued in the upstream outbox. */
  private pendingUpstreamTargets(): Set<string> {
    const out = new Set<string>()
    if (!this.upstreamForwarder) return out
    for (const e of this.upstreamForwarder.entries()) {
      try {
        const target = SCOPED_TARGET[e.proc]?.(JSON.parse(e.input) as Record<string, unknown>)
        if (typeof target === 'string') out.add(target)
      } catch {
        // corrupt input JSON — the forwarder drops it on its next drain pass
      }
    }
    return out
  }

  /** The mirrored issues as served: optimistic overlay + pendingSync while queued,
   *  upstreamStale applied at read time (same posture as sessions). */
  private upstreamIssuesList(): IssueWire[] {
    return [...this.upstreamIssues.values()].map((i) => {
      const patch = this.upstreamIssuePatches.get(i.id)
      const merged = patch ? { ...i, ...patch, id: i.id } : i
      if (!patch && !this.upstreamStale) return merged
      return {
        ...merged,
        ...(patch ? { pendingSync: true } : {}),
        ...(this.upstreamStale ? { upstreamStale: true } : {}),
      }
    })
  }

  /** Local ∪ upstream issues — the single union seam every issue wire path uses
   *  (attach snapshot, issuesChanged fan-out, changesSince). Local wins collisions. */
  private withUpstreamIssues(local: IssueWire[]): IssueWire[] {
    if (this.upstreamIssues.size === 0) return local
    const localIds = new Set(local.map((i) => i.id))
    return [...local, ...this.upstreamIssuesList().filter((i) => !localIds.has(i.id))]
  }

  /**
   * Forward one issue mutation to the hub (router hands viaHub targets here instead
   * of IssueService, spec §2.2). Ensures a mutationId (outbox PK + hub idempotency
   * key); when the hub is unreachable the result is `{ queued: true }` and the
   * upstream replica entry is optimistically patched (pendingSync) so the UI
   * reflects the edit immediately.
   */
  async forwardIssueMutation(proc: string, input: Record<string, unknown>): Promise<unknown> {
    const forwarder = this.upstreamForwarder
    if (!forwarder) {
      throw new Error('issue is managed via the hub, but no upstream is configured')
    }
    const mutationId =
      typeof input.mutationId === 'string' && input.mutationId ? input.mutationId : randomUUID()
    const payload = { ...input, mutationId }
    const result = await forwarder.forward(proc, payload)
    if ((result as { queued?: boolean } | null)?.queued === true) {
      const target = SCOPED_TARGET[proc]?.(payload)
      if (typeof target === 'string') this.applyUpstreamOptimisticPatch(target, proc, payload)
    }
    return result
  }

  /** Merge a queued mutation's optimistic effect into the issue's overlay and
   *  re-publish so pendingSync (and the patched value) hit the wire immediately. */
  private applyUpstreamOptimisticPatch(
    issueId: string,
    proc: string,
    input: Record<string, unknown>,
  ): void {
    if (!this.upstreamIssues.has(issueId)) return
    const nowIso = new Date(this.now()).toISOString()
    const prior = this.upstreamIssuePatches.get(issueId) ?? {}
    const patch = { ...prior, ...optimisticIssuePatch(proc, input, nowIso) }
    if (proc === 'addComment') {
      const base = prior.comments ?? this.upstreamIssues.get(issueId)?.comments ?? []
      patch.comments = [...base, optimisticComment(input, nowIso)]
    }
    this.upstreamIssuePatches.set(issueId, patch)
    this.publishIssues(this.safeIssuesList())
  }

  /** Outbox contents changed (enqueue/drain/poison-drop) — recompute pendingSync
   *  overlays and re-publish. Wired as the forwarder's onQueueChanged. */
  upstreamOutboxChanged(): void {
    const stillQueued = this.pendingUpstreamTargets()
    let changed = false
    for (const id of [...this.upstreamIssuePatches.keys()]) {
      // Keep the overlay VALUE until hub truth arrives (setUpstreamIssues) — only
      // pendingSync derivation lives here; dropping the value on drain-success
      // would flash the pre-edit state before the hub's delta lands.
      if (!stillQueued.has(id) && !this.upstreamIssues.has(id)) {
        this.upstreamIssuePatches.delete(id)
        changed = true
      }
    }
    if (changed || this.upstreamIssues.size > 0) this.publishIssues(this.safeIssuesList())
  }

  /**
   * Mint a long-lived client-session token for a NODE to sync against this server
   * as its hub (spec §2.1 provisioning). The token rides as the `podium_session`
   * cookie on the node's /client WS upgrade and /trpc calls — a normal, revocable
   * client_sessions row (delete it to cut the node off). Printed once; only the
   * sha-256 is stored.
   */
  mintUpstreamToken(): string {
    return mintUpstreamTokenInto(this.store, this.now())
  }

  /**
   * In-memory mirror of the machines table. listSessions() resolves machineName
   * PER SESSION (and allWire() transitively per issue), so an uncached lookup is
   * a fresh SQLite prepare+all on the hottest path in the process — the profiled
   * boot-storm CPU sink. Machines change rarely: every registry method that
   * writes the machines table (and daemon attach/detach, defensively) calls
   * invalidateMachineCache(); the next read rebuilds lazily.
   */
  private machineRecordsCache: MachineRecord[] | null = null
  private machineNameCache = new Map<string, string>()

  private machineRecords(): MachineRecord[] {
    if (!this.machineRecordsCache) {
      this.machineRecordsCache = this.store.listMachines()
      this.machineNameCache = new Map(this.machineRecordsCache.map((m) => [m.id, m.name]))
    }
    return this.machineRecordsCache
  }

  private invalidateMachineCache(): void {
    this.machineRecordsCache = null
  }

  /** Display name for a machineId (the machines table); falls back to the id.
   *  Served from the cache — ZERO SQL on the listSessions hot path. */
  machineName(id: string): string {
    if (!this.machineRecordsCache) this.machineRecords()
    return this.machineNameCache.get(id) ?? id
  }

  /** machineIds with a live daemon socket right now. Public for RepoRegistry fan-out. */
  onlineMachineIds(): string[] {
    return [...this.daemons.keys()]
  }

  /**
   * Resolve the machine a new session should spawn on. An explicitly requested
   * machine wins when it's online; otherwise pick by repo affinity, else the sole
   * online machine, else the local placeholder. For a single connected daemon this
   * always returns that one machine — single-machine behavior is unchanged.
   */
  private resolveMachine(requested: string | undefined, cwd: string): string {
    if (requested && this.daemons.has(requested)) return requested
    return this.pickMachineForRepo(undefined, cwd)
  }

  /**
   * Pick the best online machine for a repo: one that has the cwd registered as a
   * repo path, else the sole online machine, else (for 2+ online machines) any
   * online machine via defaultMachine(). Only falls through to LOCAL_PLACEHOLDER
   * when NO daemon is online — that is the deliberate boot-time queue: a session
   * created before the local daemon connects is queued under __local__ and flushed
   * once ensureLocalMachine/attachDaemon runs. With at least one daemon online, queuing
   * under __local__ would dead-queue forever because no daemon ever attaches as
   * '__local__' after adoption.
   *
   * Single-machine behavior is unchanged: online.length === 1 returns that machine
   * before the multi-machine branch is reached.
   */
  pickMachineForRepo(_originUrl: string | undefined, cwd: string): string {
    const online = this.onlineMachineIds()
    const byRepo = online.find((id) =>
      this.store.listRepos(id).some((r) => cwd === r.path || cwd.startsWith(`${r.path}/`)),
    )
    if (byRepo) return byRepo
    if (online.length === 1) return online[0] as string
    // 2+ daemons online but no repo match: route to the default online machine
    // rather than dead-queueing under __local__ (no daemon attaches as '__local__'
    // after adoption). Boot-before-connect (online.length === 0) still falls through
    // to LOCAL_PLACEHOLDER so the spawn is queued and flushed on first attachDaemon.
    if (online.length > 1) return this.defaultMachine()
    return LOCAL_PLACEHOLDER
  }

  listPins() {
    return this.store.listPins()
  }

  setPin(kind: PinKind, id: string, pinned: boolean) {
    this.store.setPin(kind, id, pinned)
  }

  listSnoozes() {
    return this.store.listSnoozes()
  }

  setSnooze({ sessionId, until }: { sessionId: string; until: string | null }): void {
    this.store.setSnooze(sessionId, until)
    const session = this.sessions.get(sessionId)
    if (session) session.snoozedUntil = until
    this.broadcastSessions()
  }

  clearSnooze(sessionId: string): void {
    this.store.clearSnooze(sessionId)
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

  listTabOrders() {
    return this.store.listTabOrders()
  }

  setTabOrder(worktree: string, sessionIds: string[]) {
    this.store.setTabOrder(worktree, sessionIds)
  }

  /** Live per-agent model lists (SWR — returns cached instantly, refreshes in the
   *  background). The web merges these over its static catalog. */
  getModelCatalog(): ModelCatalogSnapshot {
    return this.modelCatalog.get()
  }

  /** Force a fresh probe and return the updated snapshot (explicit "refresh now"). */
  async refreshModelCatalog(): Promise<ModelCatalogSnapshot> {
    await this.modelCatalog.refresh()
    return this.modelCatalog.get()
  }

  getSettings(): PodiumSettings {
    return this.store.getSettings()
  }

  setSettings(settings: PodiumSettings): PodiumSettings {
    const previous = this.store.getSettings()
    const wasEnabled = previous.autoContinue.enabled
    this.store.setSettings(settings)
    this.notifyAttentionForNewExternalTargets(previous.notifications, settings.notifications)
    const nowEnabled = settings.autoContinue.enabled
    if (nowEnabled !== wasEnabled) {
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
    }
    return settings
  }

  async startTelegramSetup(): Promise<TelegramSetupStartResult> {
    const botToken = this.store.getSettings().notifications.telegramBotToken.trim()
    if (!botToken) throw new Error('Telegram bot token is required before setup')

    const { username } = await this.telegramSetup.getMe(botToken)
    const code = this.generateTelegramSetupCode()
    const setupId = randomUUID()
    const expiresAtMs = this.now() + TELEGRAM_SETUP_TTL_MS
    this.telegramSetups.set(setupId, { code, botUsername: username, expiresAtMs })
    return {
      setupId,
      code,
      botUsername: username,
      telegramUrl: telegramSetupUrl(username, code),
      expiresAt: new Date(expiresAtMs).toISOString(),
    }
  }

  async pollTelegramSetup(setupId: string): Promise<TelegramSetupPollResult> {
    const setup = this.telegramSetups.get(setupId)
    if (!setup) return { status: 'expired' }
    if (this.now() > setup.expiresAtMs) {
      this.telegramSetups.delete(setupId)
      return { status: 'expired' }
    }

    const current = this.store.getSettings()
    const botToken = current.notifications.telegramBotToken.trim()
    if (!botToken) throw new Error('Telegram bot token is required before setup')

    const updates = await this.telegramSetup.getUpdates(botToken)
    const match = updates.find((update) => telegramTextHasCode(update.text, setup.code))
    if (!match) return { status: 'pending', expiresAt: new Date(setup.expiresAtMs).toISOString() }

    const chatId = String(match.chatId)
    const next = this.setSettings({
      ...current,
      notifications: {
        ...current.notifications,
        telegramChatId: chatId,
      },
    })
    this.telegramSetups.delete(setupId)
    await this.telegramSetup.sendMessage(
      { botToken, chatId },
      'Telegram notifications are connected to Podium.',
    )
    await this.telegramSetup.acknowledgeUpdates?.(botToken, match.updateId + 1)
    return {
      status: 'connected',
      chatId,
      chatType: match.chatType,
      ...(match.chatLabel ? { chatLabel: match.chatLabel } : {}),
      settings: next,
    }
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
    const defaults = this.store.getSettings().sessionDefaults
    // Resolve the agent down to a concrete AgentKind. `agentKind` may be absent,
    // or carry a non-AgentKind sentinel like 'auto' (the issue start-flow casts
    // the issue's `defaultAgent` — which defaults to the 'auto' settings choice —
    // `as AgentKind` at the boundary). 'auto' is NOT a valid AgentKind: persisting
    // or broadcasting it fails the sessionsChanged zod-parse and silently wipes
    // the whole session list on every client. safeParse anything that isn't a real
    // kind back to the configured default (itself resolved out of 'auto').
    const requested = AgentKind.safeParse(input.agentKind)
    const agentKind = requested.success
      ? requested.data
      : defaults.agent === 'auto'
        ? 'claude-code'
        : defaults.agent
    const prompt = input.initialPrompt?.trim() ? input.initialPrompt : undefined
    // argv delivery is race-free (the CLI reads the prompt at startup); only
    // argv-capable agents get it that way. Others fall through to a draft seed.
    const useArgv = prompt !== undefined && agentSupportsInitialPrompt(agentKind)
    // Explicit attachment wins; otherwise starting in an issue-owned worktree
    // means continuing that issue (spec: issue-as-workspace).
    const issueId = input.issueId ?? this.issues.soleOwnerForCwd(input.cwd) ?? undefined
    const spawned = this.spawn({
      agentKind,
      cwd: input.cwd,
      ...(input.title !== undefined ? { title: input.title } : {}),
      origin: { kind: 'spawn' },
      machineId: this.resolveMachine(input.machineId, input.cwd),
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
    const issueId = s.issueId ?? this.issues.issueForCwd(s.cwd)
    return issueId
      ? { role: 'worker', scope: { kind: 'subtree', rootId: issueId } }
      : { role: 'worker', scope: { kind: 'none' } }
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
      machineId: this.resolveMachine(input.machineId, input.cwd),
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
    for (const c of this.clients.values()) {
      if (c.id === fromClientId) continue
      c.send({ type: 'sessionDraftChanged', sessionId: input.sessionId, text: input.text })
    }
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
    }, SessionRegistry.DRAFT_WRITE_DEBOUNCE_MS)
    timer.unref?.()
    this.draftWriteTimers.set(sessionId, timer)
  }

  private writeDraft(sessionId: string, text: string): void {
    try {
      this.store.setDraft(sessionId, text)
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
    const inserted = this.store.enqueueMessage({
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
      const head = this.store.listQueuedMessages(sessionId)[0]
      if (!head) {
        stop()
        return
      }
      this.store.bumpQueuedAttempts(head.id)
      const sent = this.typeText({ sessionId, text: head.text })
      if (!sent.ok) {
        stop() // status raced to parked — rows remain
        return
      }
      // Delete only AFTER the bytes went toward the daemon (spec invariant 3).
      this.store.deleteQueuedMessage(head.id)
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
    const prior = this.store.getAppliedMutation(mutationId)
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
          this.store.recordAppliedMutation(
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
    this.store.recordAppliedMutation(mutationId, proc, JSON.stringify(result ?? null), this.now())
    return result
  }

  /** Set (or clear with '') the user-facing session name. */
  renameSession({ sessionId, name }: { sessionId: string; name: string }): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.name = name.trim()
    this.persist(session)
    this.broadcastSessions()
  }

  setArchived({ sessionId, archived }: { sessionId: string; archived: boolean }): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.archived = archived
    this.persist(session)
    this.broadcastSessions()
    // Archiving can leave its draft issue with no living sessions — reap it.
    if (archived) this.maybeReapDraftIssue(session.issueId)
  }

  /** Set (or clear with null) a session's explicit issue attachment. */
  setSessionIssueId(sessionId: string, issueId: string | null): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.issueId = issueId ?? undefined
    this.persist(session)
    this.broadcastSessions()
  }

  /** The session's explicit issue attachment (issue-as-workspace), if any. */
  getSessionIssueId(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.issueId ?? null
  }

  setWorkState({ sessionId, workState }: { sessionId: string; workState: WorkState | null }): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.workState = workState ?? undefined
    this.persist(session)
    this.broadcastSessions()
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

  // At most one hibernation per cooldown window PER MACHINE — memory readings need
  // time to reflect the previous kill before deciding to take down another agent.
  // Each machine has its own memory budget, so the cooldown and the candidate pool
  // are both scoped to the machine whose sample triggered this (sample.machineId).
  private readonly lastAutoHibernateMsByMachine = new Map<string, number>()
  private maybeAutoHibernate(sample: HostMetricsWire): void {
    const cfg = this.store.getSettings().hibernation
    if (!cfg.enabled) return
    const machineId = sample.machineId ?? LOCAL_PLACEHOLDER
    const m = sample.memory
    if (m.totalBytes <= 0) return
    const usedPct = ((m.totalBytes - m.availableBytes) / m.totalBytes) * 100
    if (usedPct < cfg.memoryPct) return
    const now = Date.now()
    if (now - (this.lastAutoHibernateMsByMachine.get(machineId) ?? 0) < 60_000) return
    const idleCutoff = now - cfg.idleMinutes * 60_000
    // A foreground turn can end (phase → idle) while a background agent or
    // `&`-spawned task keeps running — and a running agent paints its TUI, so
    // recent PTY output is the giveaway. Require the PTY to have been quiet for a
    // full minute before parking, so we never hibernate work that's still going.
    const OUTPUT_QUIET_MS = 60_000
    const candidates = [...this.sessions.values()]
      .filter(
        (s) =>
          // Only this machine's sessions are bound by this machine's memory budget.
          s.machineId === machineId &&
          s.status === 'live' &&
          s.resume !== undefined &&
          // Only agents that are demonstrably done/idle. needs_user keeps its
          // pending question; working agents are obviously off-limits.
          (s.agentState?.phase === 'idle' || s.agentState?.phase === 'ended') &&
          // "Idle since" is the latest of genuine agent activity (lastActiveAt),
          // the last resume, and the last user input — any of them resets the idle
          // timer WITHOUT restamping lastActiveAt (which owns recency ordering).
          Math.max(Date.parse(s.lastActiveAt), s.lastResumedAtMs, s.lastInputAtMs) <= idleCutoff &&
          // A running TUI repaints, so recent output means work is still going.
          now - s.lastOutputAtMs >= OUTPUT_QUIET_MS,
      )
      .sort((a, b) => a.lastActiveAt.localeCompare(b.lastActiveAt))
    const target = candidates[0]
    if (!target) return
    this.lastAutoHibernateMsByMachine.set(machineId, now)
    console.info(
      `[podium] memory ${usedPct.toFixed(0)}% on ${sample.hostname} ≥ ${cfg.memoryPct}% — hibernating idle session ${target.sessionId}`,
    )
    this.hibernateSession({ sessionId: target.sessionId })
  }

  /** issue-as-workspace draft cleanup: after a session dies (kill/remove/exit/
   *  archive), reap its draft issue if the draft is now empty — draft, no
   *  worktree, no children, and every attached session dead (exited/archived) or
   *  gone. Hibernation does NOT land here via a dead status ('hibernated' blocks
   *  the reap inside reapIfEmptyDraft), so a parked draft survives. */
  private maybeReapDraftIssue(issueId: string | null | undefined): void {
    if (!issueId) return
    try {
      this.issues.reapIfEmptyDraft(issueId)
    } catch (err) {
      console.warn(`[podium:issues] draft-issue reap failed for ${issueId}:`, err)
    }
  }

  killSession(input: { sessionId: string }): void {
    // Read-only surface (node-hub-sync §2.3): killing a hub-mirrored session here
    // would fabricate a kill for a PTY this server doesn't own — reject loudly.
    if (this.isUpstreamSession(input.sessionId)) {
      throw new Error(SessionRegistry.UPSTREAM_COMMAND_REJECTION)
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
    this.store.deleteSession(input.sessionId)
    // A killed session can never deliver: drop its queued sends now rather than
    // leaving orphan rows for the next boot's sweep.
    this.store.deleteQueuedMessagesForSession(input.sessionId)
    for (const c of this.clients.values()) c.attached.delete(input.sessionId)
    this.broadcastSessions()
    // The killed session may have been the last living occupant of an empty
    // draft issue — reap the vessel so "x" doesn't leak orphaned Drafts.
    this.maybeReapDraftIssue(issueId)
  }

  /**
   * Shared request/response plumbing for daemon round-trips: mint a prefixed
   * requestId, register a resolver keyed by it, send the control message, and
   * resolve a fallback on timeout. Every `*Result` daemon message looks its
   * resolver up in the matching pending map. One place to get unref/cleanup
   * right instead of six near-identical copies.
   */
  private daemonRequest<T>(
    pending: Map<string, (r: T) => void>,
    prefix: string,
    timeoutMs: number,
    onTimeout: () => T,
    buildMsg: (requestId: string) => ControlMessage,
    machineId: string = this.defaultMachine(),
  ): Promise<T> {
    const requestId = `${prefix}${this.nextRequestNum++}`
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        resolve(onTimeout())
      }, timeoutMs)
      timer.unref?.()
      pending.set(requestId, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      this.toMachine(machineId, buildMsg(requestId))
    })
  }

  /**
   * The machine a host-scoped request (scan/usage/repoOp/…) targets when the caller
   * has no machine context: the sole online machine, else the local placeholder.
   * For a single connected daemon this is that one machine — behavior is unchanged.
   * Multi-machine fan-out of these is a later task; for now they hit one machine.
   */
  private defaultMachine(): string {
    const online = this.onlineMachineIds()
    return online.length >= 1 ? (online[0] as string) : LOCAL_PLACEHOLDER
  }

  /** Public alias for defaultMachine() — used by RepoRegistry when no machineId is provided. */
  defaultMachineId(): string {
    return this.defaultMachine()
  }

  scan(): Promise<ScanResult> {
    return this.daemonRequest(
      this.pendingScans,
      'r',
      SCAN_TIMEOUT_MS,
      () => ({
        conversations: [],
        diagnostics: [{ severity: 'error', message: 'discovery scan timed out' }],
      }),
      (requestId) => ({ type: 'scanRequest', requestId }),
    )
  }

  scanRepos(
    roots: string[],
    opts: { includeHome?: boolean; maxDepth?: number } = {},
  ): Promise<ScanReposResult> {
    return this.daemonRequest(
      this.pendingRepoScans,
      'rr',
      SCAN_TIMEOUT_MS,
      () => ({
        repositories: [],
        diagnostics: [{ severity: 'error', path: '', message: 'repos scan timed out' }],
      }),
      (requestId) => ({
        type: 'scanReposRequest',
        requestId,
        roots,
        ...(opts.includeHome === undefined ? {} : { includeHome: opts.includeHome }),
        ...(opts.maxDepth === undefined ? {} : { maxDepth: opts.maxDepth }),
      }),
    )
  }

  /**
   * Per-machine variant of scanRepos: sends the request to a specific machine.
   * Used by RepoRegistry to fan out to each online daemon. Requestids are globally
   * unique (shared counter) so concurrent per-machine requests are safe across the
   * single pendingRepoScans map.
   */
  scanReposForMachine(
    roots: string[],
    machineId: string,
    opts: { includeHome?: boolean; maxDepth?: number } = {},
  ): Promise<ScanReposResult> {
    return this.daemonRequest(
      this.pendingRepoScans,
      'rr',
      SCAN_TIMEOUT_MS,
      () => ({
        repositories: [],
        diagnostics: [{ severity: 'error', path: '', message: 'repos scan timed out' }],
      }),
      (requestId) => ({
        type: 'scanReposRequest',
        requestId,
        roots,
        ...(opts.includeHome === undefined ? {} : { includeHome: opts.includeHome }),
        ...(opts.maxDepth === undefined ? {} : { maxDepth: opts.maxDepth }),
      }),
      machineId,
    )
  }

  /** Token-usage buckets from the daemon's transcript harvest (empty on timeout). */
  usage(sinceMs?: number): Promise<{ hostname: string; buckets: UsageBucketWire[] }> {
    return this.daemonRequest(
      this.pendingUsage,
      'us',
      20_000,
      () => ({ hostname: '', buckets: [] }),
      (requestId) => ({
        type: 'usageRequest',
        requestId,
        ...(sinceMs !== undefined ? { sinceMs } : {}),
      }),
    )
  }

  /** Per-agent plan-quota (5h/weekly windows), read live read-only on the daemon
   *  host. Empty agents on timeout. Distinct from `usage` (token-cost analytics). */
  agentQuota(refresh?: boolean): Promise<{ hostname: string; agents: AgentQuotaWire[] }> {
    return this.daemonRequest(
      this.pendingAgentQuota,
      'aq',
      20_000,
      () => ({ hostname: '', agents: [] }),
      (requestId) => ({
        type: 'agentQuotaRequest',
        requestId,
        ...(refresh !== undefined ? { refresh } : {}),
      }),
    )
  }

  /** Allowlisted git op on a dev machine (superagent tools). */
  repoOp(op: RepoOp, cwd: string, args?: Record<string, string>): Promise<OpResult> {
    return this.daemonRequest(
      this.pendingRepoOps,
      'ro',
      35_000,
      () => ({ ok: false, output: 'no daemon answered the git request in time' }),
      (requestId) => ({ type: 'repoOpRequest', requestId, op, cwd, ...(args ? { args } : {}) }),
    )
  }

  /** One-shot `claude -p` / `codex exec` / `grok -p` on a dev machine. */
  harnessExec(input: {
    agent: 'claude-code' | 'codex' | 'grok' | 'opencode' | 'cursor'
    model?: string
    prompt: string
    cwd?: string
    systemPrompt?: string
    mcpConfig?: string
    allowedTools?: string[]
    /** Kill budget for the CLI run, ms (daemon default 240s). The server-side
     *  wait adds 10s slack over it so the daemon's own timeout reports first. */
    timeoutMs?: number
  }): Promise<OpResult> {
    return this.daemonRequest(
      this.pendingHarnessExecs,
      'hx',
      (input.timeoutMs ?? 240_000) + 10_000,
      () => ({ ok: false, output: 'harness run timed out' }),
      (requestId) => ({
        type: 'harnessExecRequest',
        requestId,
        agent: input.agent,
        prompt: input.prompt,
        ...(input.model && input.model !== 'auto' ? { model: input.model } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
        ...(input.mcpConfig ? { mcpConfig: input.mcpConfig } : {}),
        ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      }),
    )
  }

  // ---- Headless harness sessions (concierge unification) ----

  /**
   * Create a headless harness session row: a persistent, PTY-less session the
   * superagent drives turn-by-turn (registry.headlessTurn). No spawn message is
   * sent to the daemon — the daemon only ever sees turn requests and transcript
   * binds. Status is 'live' for as long as the thread exists.
   */
  createHeadlessSession(input: {
    agentKind: AgentKind
    cwd: string
    title?: string
    spawnedBy?: string
    machineId?: string
  }): { sessionId: string } {
    const sessionId = randomUUID()
    const machineId = this.resolveMachine(input.machineId, input.cwd)
    const session = new Session({
      sessionId,
      agentKind: input.agentKind,
      cwd: input.cwd,
      title: input.title || basename(input.cwd) || input.cwd,
      origin: { kind: 'spawn' },
      createdAt: new Date().toISOString(),
      geometry: { ...DEFAULT_GEOMETRY },
      machineId,
      toDaemon: (msg) => this.toMachine(this.sessions.get(sessionId)?.machineId ?? machineId, msg),
      durableLabel: `podium-${sessionId}`,
      status: 'live',
      headless: true,
      ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
    })
    this.sessions.set(sessionId, session)
    this.persist(session)
    this.broadcastSessions()
    return { sessionId }
  }

  /**
   * Record the harness's own session id on a headless session once the first
   * turn reports it — the resume ref every later turn (and the "open in
   * terminal" escape hatch) reattaches to. Persisted + broadcast, mirroring how
   * PTY sessions learn their resume refs from the daemon.
   */
  setHeadlessResume(sessionId: string, resume: ResumeRef): void {
    const session = this.sessions.get(sessionId)
    if (!session || !session.headless) return
    session.resume = resume
    this.persist(session)
    this.broadcastSessions()
  }

  /** Fan a headless turn-activity event out to every connected client
   *  (turn-start/turn-end markers + the daemon's mid-turn progress events). */
  broadcastHeadlessActivity(sessionId: string, event: HeadlessActivityEvent): void {
    const msg: ServerMessage = { type: 'headlessActivity', sessionId, event }
    for (const c of this.clients.values()) c.send(msg)
  }

  // Server↔daemon plumbing (Phase A).

  /**
   * One turn of a headless harness session on the owning daemon. Mid-turn
   * progress (`headlessTurnEvent` frames) streams to `onEvent` before the
   * result resolves; the transcript tail delivers the canonical items.
   */
  headlessTurn(
    input: {
      sessionId: string
      threadId: string
      agent: HarnessAgent
      model?: string
      effort?: string
      cwd: string
      prompt: string
      systemPrompt?: string
      mcpConfig?: string
      allowedTools?: string[]
      permissionMode?: string
      resumeValue?: string
      sessionUuid?: string
      timeoutMs?: number
    },
    onEvent?: (event: HeadlessTurnEvent) => void,
  ): Promise<{ ok: boolean; error?: string; harnessSessionId?: string; output?: string }> {
    const machineId = this.sessions.get(input.sessionId)?.machineId ?? this.defaultMachine()
    const requestId = `ht${this.nextRequestNum++}`
    const timeoutMs = (input.timeoutMs ?? 600_000) + 10_000
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingHeadlessTurns.delete(requestId)
        resolve({ ok: false, error: 'headless turn timed out' })
      }, timeoutMs)
      timer.unref?.()
      this.pendingHeadlessTurns.set(requestId, {
        resolve: (r) => {
          clearTimeout(timer)
          this.pendingHeadlessTurns.delete(requestId)
          resolve(r)
        },
        ...(onEvent ? { onEvent } : {}),
      })
      this.toMachine(machineId, {
        type: 'headlessTurnRequest',
        requestId,
        sessionId: input.sessionId,
        threadId: input.threadId,
        agent: input.agent,
        cwd: input.cwd,
        prompt: input.prompt,
        ...(input.model && input.model !== 'auto' ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
        ...(input.mcpConfig ? { mcpConfig: input.mcpConfig } : {}),
        ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
        ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
        ...(input.resumeValue ? { resumeValue: input.resumeValue } : {}),
        ...(input.sessionUuid ? { sessionUuid: input.sessionUuid } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      })
    })
  }

  /** Interrupt a headless session's running turn (fire-and-forget; the turn's
   *  own headlessTurnResult reports the outcome). */
  headlessInterrupt(sessionId: string): void {
    const machineId = this.sessions.get(sessionId)?.machineId ?? this.defaultMachine()
    this.toMachine(machineId, {
      type: 'headlessInterrupt',
      requestId: `hi${this.nextRequestNum++}`,
      sessionId,
    })
  }

  /** (Re)establish the daemon-side transcript observers/tails for a headless
   *  session — the reattach equivalent for sessions with no PTY. */
  headlessBind(input: {
    sessionId: string
    agentKind: AgentKind
    cwd: string
    resumeValue: string
  }): Promise<{ ok: boolean; error?: string }> {
    const machineId = this.sessions.get(input.sessionId)?.machineId ?? this.defaultMachine()
    const requestId = `hb${this.nextRequestNum++}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingHeadlessBinds.delete(requestId)
        resolve({ ok: false, error: 'headless bind timed out' })
      }, 15_000)
      timer.unref?.()
      this.pendingHeadlessBinds.set(requestId, (r) => {
        clearTimeout(timer)
        this.pendingHeadlessBinds.delete(requestId)
        resolve(r)
      })
      this.toMachine(machineId, {
        type: 'headlessBind',
        requestId,
        sessionId: input.sessionId,
        agentKind: input.agentKind,
        cwd: input.cwd,
        resumeValue: input.resumeValue,
      })
    })
  }

  /**
   * Route an image upload to the owning daemon. The daemon writes the decoded
   * base64 bytes to ~/.podium/uploads/<sessionId>/<id>.<ext> and returns the
   * absolute path. Resolves with that path so the caller can insert it into a
   * prompt — Claude Code reads images by path.
   */
  uploadImage(input: {
    sessionId: string
    filename: string
    mimeType: string
    dataBase64: string
  }): Promise<{ path: string; error?: string }> {
    // The upload is written to (and read back by) the machine that runs the session,
    // so the returned path is valid in that session's prompt.
    const session = this.sessions.get(input.sessionId)
    return this.daemonRequest(
      this.pendingUploads,
      'iu',
      30_000,
      () => ({ path: '' }),
      (requestId) => ({
        type: 'imageUploadRequest',
        requestId,
        sessionId: input.sessionId,
        filename: input.filename,
        mimeType: input.mimeType,
        dataBase64: input.dataBase64,
      }),
      session?.machineId,
    )
  }

  /** Ask the daemon who owns the used memory. Resolves undefined when no daemon answers in time. */
  memoryBreakdown(roots: string[]): Promise<MemoryBreakdown | undefined> {
    return this.daemonRequest<MemoryBreakdown | undefined>(
      this.pendingBreakdowns,
      'mb',
      SCAN_TIMEOUT_MS,
      () => undefined,
      (requestId) => ({ type: 'memoryBreakdownRequest', requestId, roots }),
    )
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
    const defaults = this.store.getSettings().sessionDefaults
    const model = override?.model ?? defaults.model
    const effort = override?.effort ?? defaults.effort
    const subagentModel = defaults.subagentModel
    return {
      ...(model !== 'auto' && agentKind !== 'shell' ? { model } : {}),
      ...(subagentModel !== 'auto' && agentKind === 'claude-code' ? { subagentModel } : {}),
      // Cursor + shell have no effort flag; agentLaunchCommand also drops it, but
      // gating here keeps the spawn message clean.
      ...(effort !== 'auto' && agentKind !== 'shell' && agentKind !== 'cursor' ? { effort } : {}),
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
    send({ type: 'issuesChanged', issues: this.withUpstreamIssues(this.safeIssuesList()) })
    for (const [sessionId, text] of this.draftBySession) {
      send({ type: 'sessionDraftChanged', sessionId, text })
    }
    send({
      type: 'conversationsChanged',
      conversations: this.allConversations(),
      diagnostics: this.latestConversationDiagnostics,
    })
    send({ type: 'machinesChanged', machines: this.listMachines() })
    if (this.latestHostMetrics.size > 0) send(this.hostMetricsMessage())
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
   *  to scope/tag their data. */
  onDaemonMessageFrom(machineId: string, msg: DaemonMessage): void {
    switch (msg.type) {
      case 'issueRelayRequest': {
        void this.runIssueRelay(machineId, msg)
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
        this.issues.onSessionActivity(msg.sessionId)
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
        const update: ServerMessage = {
          type: 'sessionAgentStateChanged',
          sessionId: msg.sessionId,
          state: msg.state,
        }
        for (const c of this.clients.values()) c.send(update)
        this.issues.onSessionActivity(msg.sessionId)
        this.notifyAttention(session, prev, msg.state)
        if (
          session.snoozedUntil !== undefined &&
          SessionRegistry.isAttentionPhase(prev) &&
          !SessionRegistry.isAttentionPhase(msg.state)
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
              const update: ServerMessage = {
                type: 'sessionTitleChanged',
                sessionId: sid,
                title: stableTitle,
              }
              for (const c of this.clients.values()) c.send(update)
            }),
          )
        }
        this.titleDebouncers.get(msg.sessionId)!.push(msg.title)
        break
      }
      case 'scanResult': {
        // Index FIRST so latestConversations (and the broadcast) carry podiumId.
        this.latestConversations = this.indexConversations(
          msg.conversations,
          machineId,
          msg.removed ?? [],
        )
        this.latestConversationDiagnostics = msg.diagnostics
        this.broadcastConversations()
        const resolve = this.pendingScans.get(msg.requestId)
        if (resolve) {
          this.pendingScans.delete(msg.requestId)
          resolve({ conversations: msg.conversations, diagnostics: msg.diagnostics })
        }
        break
      }
      case 'conversationsChanged': {
        this.latestConversations = this.indexConversations(
          msg.conversations,
          machineId,
          msg.removed ?? [],
        )
        this.latestConversationDiagnostics = msg.diagnostics
        this.broadcastConversations()
        break
      }
      case 'scanReposResult': {
        const resolve = this.pendingRepoScans.get(msg.requestId)
        if (resolve) {
          this.pendingRepoScans.delete(msg.requestId)
          resolve({ repositories: msg.repositories, diagnostics: msg.diagnostics })
        }
        break
      }
      case 'hostMetrics': {
        const { type: _type, ...rest } = msg
        // Tag the sample with the reporting machine so clients can attribute it and
        // the per-machine cooldown/candidate scoping works. Keyed by machineId so a
        // detach drops only this machine's row.
        const sample: HostMetricsWire = { ...rest, machineId, name: this.machineName(machineId) }
        this.latestHostMetrics.set(machineId, sample)
        this.broadcastHostMetrics()
        this.maybeAutoHibernate(sample)
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
            ? this.store.linkConversationSegment({
                machineId: session.machineId,
                newNativeId: msg.resume.value,
                priorNativeId: prior,
                providerId: session.agentKind,
              })
            : this.store.ensureConversationIdentity({
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
          const issue = this.issues?.get(session.issueId)
          if (
            issue &&
            !issue.archived &&
            issue.worktreePath === null &&
            issue.repoPath !== msg.cwd
          ) {
            this.issues.update(issue.id, { worktreePath: msg.cwd })
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
            const update: ServerMessage = {
              type: 'sessionTitleChanged',
              sessionId: msg.sessionId,
              title: derived,
            }
            for (const c of this.clients.values()) c.send(update)
          }
        }
        break
      }
      case 'repoOpResult': {
        const resolve = this.pendingRepoOps.get(msg.requestId)
        if (resolve) {
          this.pendingRepoOps.delete(msg.requestId)
          resolve({ ok: msg.ok, output: msg.output })
        }
        break
      }
      case 'harnessExecResult': {
        const resolve = this.pendingHarnessExecs.get(msg.requestId)
        if (resolve) {
          this.pendingHarnessExecs.delete(msg.requestId)
          resolve({ ok: msg.ok, output: msg.output })
        }
        break
      }
      case 'headlessTurnEvent': {
        this.pendingHeadlessTurns.get(msg.requestId)?.onEvent?.(msg.event)
        break
      }
      case 'headlessTurnResult': {
        this.pendingHeadlessTurns.get(msg.requestId)?.resolve({
          ok: msg.ok,
          ...(msg.error !== undefined ? { error: msg.error } : {}),
          ...(msg.harnessSessionId !== undefined ? { harnessSessionId: msg.harnessSessionId } : {}),
          ...(msg.output !== undefined ? { output: msg.output } : {}),
        })
        break
      }
      case 'headlessBindResult': {
        this.pendingHeadlessBinds.get(msg.requestId)?.({
          ok: msg.ok,
          ...(msg.error !== undefined ? { error: msg.error } : {}),
        })
        break
      }
      case 'usageResult': {
        const resolve = this.pendingUsage.get(msg.requestId)
        if (resolve) {
          this.pendingUsage.delete(msg.requestId)
          resolve({ hostname: msg.hostname, buckets: msg.buckets })
        }
        break
      }
      case 'agentQuotaResult': {
        const resolve = this.pendingAgentQuota.get(msg.requestId)
        if (resolve) {
          this.pendingAgentQuota.delete(msg.requestId)
          resolve({ hostname: msg.hostname, agents: msg.agents })
        }
        break
      }
      case 'transcriptReadResult': {
        const resolve = this.pendingTranscriptReads.get(msg.requestId)
        if (resolve) {
          this.pendingTranscriptReads.delete(msg.requestId)
          resolve({
            items: msg.items,
            ...(msg.head !== undefined ? { head: msg.head } : {}),
            ...(msg.tail !== undefined ? { tail: msg.tail } : {}),
            hasMore: msg.hasMore,
          })
        }
        break
      }
      case 'transcriptMirrorResult': {
        const resolve = this.pendingMirrorReads.get(msg.requestId)
        if (resolve) {
          this.pendingMirrorReads.delete(msg.requestId)
          resolve({
            data: msg.data,
            fileSize: msg.fileSize,
            eof: msg.eof,
            ...(msg.error !== undefined ? { error: msg.error } : {}),
          })
        }
        break
      }
      case 'imageUploadResult': {
        const resolve = this.pendingUploads.get(msg.requestId)
        if (resolve) {
          this.pendingUploads.delete(msg.requestId)
          resolve({ path: msg.path, ...(msg.error !== undefined ? { error: msg.error } : {}) })
        }
        break
      }
      case 'memoryBreakdownResult': {
        const resolve = this.pendingBreakdowns.get(msg.requestId)
        if (resolve) {
          this.pendingBreakdowns.delete(msg.requestId)
          const { type: _type, requestId: _requestId, ...breakdown } = msg
          resolve(breakdown)
        }
        break
      }
      case 'fileReadResult': {
        const resolve = this.pendingFileReads.get(msg.requestId)
        if (resolve) {
          this.pendingFileReads.delete(msg.requestId)
          const { type: _t, requestId: _r, ...payload } = msg
          resolve(payload)
        }
        break
      }
      case 'fileWriteResult': {
        const resolve = this.pendingFileWrites.get(msg.requestId)
        if (resolve) {
          this.pendingFileWrites.delete(msg.requestId)
          const { type: _t, requestId: _r, ...payload } = msg
          resolve(payload)
        }
        break
      }
      case 'fileAssetResult': {
        const resolve = this.pendingFileAssets.get(msg.requestId)
        if (resolve) {
          this.pendingFileAssets.delete(msg.requestId)
          const { type: _t, requestId: _r, ...payload } = msg
          resolve(payload)
        }
        break
      }
      case 'dirListResult': {
        const resolve = this.pendingDirLists.get(msg.requestId)
        if (resolve) {
          this.pendingDirLists.delete(msg.requestId)
          const { type: _t, requestId: _r, ...payload } = msg
          resolve(payload)
        }
        break
      }
    }
  }

  /**
   * Run a relayed agent issue op against the shared tracker and reply to its daemon.
   *
   * The op is invoked through the capability-scoped tRPC caller (makeIssueCaller →
   * appRouter.createCaller), so the P1a issueCapabilityGuard middleware enforces the subtree
   * scope on every relayed issue write — the gate is NOT re-implemented here. The capability
   * itself is minted from the requesting session's cwd (capabilityForSession), and the agent's
   * `--outside-scope` flag rides through as overrideScope. RELAY_ALLOWED restricts which
   * router/proc a relay may reach so it can never touch an ungated router (sessions/spawn/kill).
   */
  private async runIssueRelay(
    machineId: string,
    msg: Extract<DaemonMessage, { type: 'issueRelayRequest' }>,
  ): Promise<void> {
    const reply = (r: { ok: boolean; result?: unknown; error?: string }): void =>
      this.toMachine(machineId, { type: 'issueRelayResult', requestId: msg.requestId, ...r })
    try {
      // RELAY_ALLOWED is a plain object; index it only for OWN keys so a router of
      // 'constructor'/'__proto__'/'toString' can't resolve to an inherited value
      // (which would throw a confusing TypeError on `.has(...)`) — treat any
      // non-own key as simply not permitted.
      if (!Object.hasOwn(RELAY_ALLOWED, msg.router)) {
        reply({ ok: false, error: `${msg.router}.${msg.proc} is not permitted via relay` })
        return
      }
      const allowed = RELAY_ALLOWED[msg.router]
      if (allowed === undefined || (allowed !== null && !allowed.has(msg.proc))) {
        reply({ ok: false, error: `${msg.router}.${msg.proc} is not permitted via relay` })
        return
      }
      const make = this.makeIssueCaller
      if (!make) {
        reply({ ok: false, error: 'issue relay is not configured' })
        return
      }
      const caller = make(this.capabilityForSession(msg.sessionId), msg.outsideScope)
      const fn = caller[msg.router]?.[msg.proc]
      if (!fn) {
        reply({ ok: false, error: `no such procedure: ${msg.router}.${msg.proc}` })
        return
      }
      // attachSession acts on the CALLING session: take its id from the relay
      // context (the daemon's /issue/<sessionId> path), never from agent input.
      const input =
        msg.router === 'issues' && msg.proc === 'attachSession'
          ? { ...(msg.input as Record<string, unknown> | undefined), sessionId: msg.sessionId }
          : msg.input
      reply({ ok: true, result: await fn(input) })
    } catch (err) {
      reply({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Every discovery push lands in the durable index — search sees machines' full
   *  history. Tagged with the reporting machineId so a conversation is attributable
   *  to (and resumable on) the machine that owns its on-disk transcript. `removed`
   *  drops conversations the daemon reports as deleted (incremental delta indexing). */
  /**
   * Persist scanned conversations and attach registry identities (docs/spec/
   * conversation-registry.md §3.1): every native conversation maps to a stable
   * podium id — minted on first sight, resolved thereafter — and subagent parents
   * resolve to parent PODIUM ids. Returns the wire list enriched with `podiumId`
   * so broadcasts carry stable identity alongside the native id.
   */
  private indexConversations(
    conversations: ConversationSummaryWire[],
    machineId: string,
    removed: string[] = [],
  ): ConversationSummaryWire[] {
    // Parents first, so a child's mint can point at its parent's identity. A
    // parent that is itself in this batch resolves in the first loop; one that
    // isn't (child-only rescan) is ensured on demand in the second.
    const podiumIds = new Map<string, string>()
    for (const c of conversations) {
      if (c.parentConversationId) continue
      podiumIds.set(
        c.id,
        this.store.ensureConversationIdentity({
          machineId,
          nativeId: c.id,
          providerId: c.providerId,
          ...(c.path ? { path: c.path } : {}),
          ...(c.sizeBytes !== undefined ? { sizeBytes: c.sizeBytes } : {}),
        }),
      )
    }
    for (const c of conversations) {
      if (!c.parentConversationId) continue
      const parentPodiumId =
        podiumIds.get(c.parentConversationId) ??
        this.store.ensureConversationIdentity({
          machineId,
          nativeId: c.parentConversationId,
          providerId: c.providerId,
        })
      podiumIds.set(
        c.id,
        this.store.ensureConversationIdentity({
          machineId,
          nativeId: c.id,
          providerId: c.providerId,
          parentPodiumId,
          ...(c.path ? { path: c.path } : {}),
          ...(c.sizeBytes !== undefined ? { sizeBytes: c.sizeBytes } : {}),
        }),
      )
    }
    this.store.upsertConversations(
      conversations.map((c) => ({
        id: c.id,
        agentKind: c.agentKind,
        providerId: c.providerId,
        machineId,
        ...(c.title !== undefined ? { title: c.title } : {}),
        ...(c.projectPath !== undefined ? { projectPath: c.projectPath } : {}),
        ...(c.resume ? { resumeKind: c.resume.kind, resumeValue: c.resume.value } : {}),
        ...(c.createdAt !== undefined ? { createdAt: c.createdAt } : {}),
        ...(c.updatedAt !== undefined ? { updatedAt: c.updatedAt } : {}),
        ...(c.messageCount !== undefined ? { messageCount: c.messageCount } : {}),
        ...(c.parentConversationId !== undefined
          ? { parentConversationId: c.parentConversationId }
          : {}),
      })),
    )
    if (removed.length) this.store.deleteConversations(removed)
    // Scan trigger (transcript-mirror spec §2.3): the segments just upserted may have
    // grown/appeared — pull their new bytes into the lake. No-op without a lake dir.
    this.triggerLakeSweep(machineId)
    return conversations.map((c) => {
      const podiumId = podiumIds.get(c.id)
      return podiumId ? { ...c, podiumId } : c
    })
  }

  searchConversations(opts: { query?: string; projectPath?: string; limit?: number }) {
    return this.store.searchConversations(opts)
  }

  transcriptFor(sessionId: string) {
    return this.sessions.get(sessionId)?.transcriptItems() ?? []
  }

  /**
   * Transcript for the chat view — a pure daemon round-trip; disk is the source of
   * truth. Reads the requested window of `limit` items relative to `anchor` (a
   * cursor) in `direction` ('before' = older, 'after' = newer; no anchor = the
   * latest window). The daemon resolves the on-disk transcript from the session's
   * agentKind/cwd/resume and serves the slice — so a LIVE session with an empty
   * recent-delta cache (e.g. right after a server restart) still loads its history
   * straight off disk, instead of the old short-circuit that returned an empty
   * buffer. Resolves an empty, hasMore:false page when the session is unknown or no
   * daemon answers.
   */
  /** The recorded segment path for a session's conversation, shaped for message
   *  spreads (`{pathHint}` or undefined). Lookup only — never derives. */
  private transcriptPathHint(session: {
    machineId: string
    resume?: { value: string }
  }): { pathHint: string } | undefined {
    const nativeId = session.resume?.value
    if (!nativeId) return undefined
    const path = this.store.conversationSegmentPath(session.machineId, nativeId)
    return path ? { pathHint: path } : undefined
  }

  async readTranscript(input: {
    sessionId: string
    anchor?: string
    direction: 'before' | 'after'
    limit: number
  }): Promise<{ items: TranscriptItem[]; head?: string; tail?: string; hasMore: boolean }> {
    const session = this.sessions.get(input.sessionId)
    if (!session) return { items: [], hasMore: false }
    // Daemon-first (docs/spec/search-v1.md §2.2): the native file is fresher than
    // the mirror. But a machine with no live daemon socket can't answer at all —
    // skip straight to the lake rather than stalling the chat view for the full
    // request timeout to learn that.
    const fromDaemon = this.daemons.has(session.machineId)
      ? await this.daemonRequest<{
          items: TranscriptItem[]
          head?: string
          tail?: string
          hasMore: boolean
        }>(
          this.pendingTranscriptReads,
          'tr',
          SCAN_TIMEOUT_MS,
          () => ({ items: [], hasMore: false }),
          (requestId) => ({
            type: 'transcriptRead',
            requestId,
            sessionId: input.sessionId,
            agentKind: session.agentKind,
            cwd: session.cwd,
            ...(session.resume ? { resume: session.resume } : {}),
            // Segment evidence beats cwd derivation: the recorded absolute path (from
            // discovery scans) survives worktree moves; the daemon still falls back to
            // derivation + sweep when absent/stale (conversation registry §3.3).
            ...(this.transcriptPathHint(session) ?? {}),
            ...(input.anchor ? { anchor: input.anchor } : {}),
            direction: input.direction,
            limit: input.limit,
          }),
          session.machineId, // the transcript file lives on the session's machine
        )
      : undefined
    if (fromDaemon && fromDaemon.items.length > 0) return fromDaemon
    // Empty/timeout daemon answer (or no daemon): serve from the mirrored copy.
    const fromLake = await this.readTranscriptFromLake(session, input)
    return fromLake ?? fromDaemon ?? { items: [], hasMore: false }
  }

  /** Lake-fallback transcript read (docs/spec/search-v1.md §2.2): serve the window
   *  from the server's mirrored copy when the daemon couldn't (detached machine,
   *  pruned native file, timeout). The lake file IS the native JSONL byte-verbatim,
   *  so the harness's own record→items mapper applies unchanged. Cursors are
   *  stamped against the LAKE path's fileId, so an anchor minted by a daemon read
   *  won't match here — the slice then serves its default window, the standard
   *  drifted-anchor degradation. Resolves undefined when there is nothing mirrored
   *  (no lake, no resume value, cursor at 0, or an unparseable/empty file). */
  private async readTranscriptFromLake(
    session: { machineId: string; agentKind: AgentKind; resume?: { value: string } },
    input: { anchor?: string; direction: 'before' | 'after'; limit: number },
  ): Promise<
    { items: TranscriptItem[]; head?: string; tail?: string; hasMore: boolean } | undefined
  > {
    const nativeId = session.resume?.value
    if (!this.mirror || !nativeId) return undefined
    if (this.store.mirrorCursor(session.machineId, nativeId) <= 0) return undefined
    const path = this.mirror.lakePath(session.machineId, nativeId)
    const source = fileChainSource(
      [{ path, fileId: fileIdFor(path) }],
      recordToItemsForKind(session.agentKind),
    )
    const slice = await source.readSlice({
      ...(input.anchor ? { anchor: input.anchor } : {}),
      direction: input.direction,
      limit: input.limit,
    })
    return slice.items.length > 0 ? slice : undefined
  }

  /** The lake maintenance pass behind every scan/attach trigger: mirror-pull the
   *  machine's DIRTY segments (spec §2.3 "Dirty-driven": reported size ≠ mirrored
   *  cursor — NOT a full sweep, which cost one daemon eof-check round trip per
   *  segment even when fully caught up) AND FTS-backfill segments whose lake copy
   *  is ahead of the index cursor. Both self-noop cheaply when caught up. On
   *  attach, before any scan, the LAST-KNOWN reported sizes persisted in the store
   *  cover the offline gap; the first scan (~15s later) refreshes them. */
  private triggerLakeSweep(machineId: string): void {
    const mirror = this.mirror
    if (!mirror) return
    mirror.enqueueDirty(machineId)
    this.transcriptIndexer?.backfillMachine(machineId, (nativeId) =>
      mirror.lakePath(machineId, nativeId),
    )
  }

  /** One transcript-mirror ranged read against a specific machine — MirrorService's
   *  read seam. A timeout resolves an error result (never rejects), so the pull loop
   *  backs the segment off instead of hanging (docs/spec/transcript-mirror.md §2.3). */
  private mirrorRead(
    machineId: string,
    req: { path: string; offset: number; maxBytes: number },
  ): Promise<{ data: string; fileSize: number; eof: boolean; error?: string }> {
    return this.daemonRequest(
      this.pendingMirrorReads,
      'mr',
      SCAN_TIMEOUT_MS,
      () => ({ data: '', fileSize: 0, eof: false, error: 'timeout' }),
      (requestId) => ({
        type: 'transcriptMirrorRead',
        requestId,
        path: req.path,
        offset: req.offset,
        maxBytes: req.maxBytes,
      }),
      machineId,
    )
  }

  listDir(input: {
    machineId?: string
    root: string
    path?: string
  }): Promise<Omit<DirListResultMessage, 'type' | 'requestId'>> {
    const path = input.path ?? input.root
    return this.daemonRequest(
      this.pendingDirLists,
      'dl',
      FILE_RPC_TIMEOUT_MS,
      () => ({ ok: false, path, entries: [], error: 'timeout' }),
      (requestId) => ({ type: 'dirListRequest', requestId, root: input.root, path }),
      input.machineId ?? this.defaultMachineId(),
    )
  }

  readFile(
    input: { sessionId: string; path: string } | { machineId?: string; root: string; path: string },
  ): Promise<Omit<FileReadResultMessage, 'type' | 'requestId'>> {
    if ('sessionId' in input) {
      const session = this.sessions.get(input.sessionId)
      if (!session) return Promise.resolve({ ok: false, path: input.path, error: 'no session' })
      const knownPath = knownPathsFor(session.transcriptItems()).has(input.path)
      return this.daemonRequest(
        this.pendingFileReads,
        'fr',
        FILE_RPC_TIMEOUT_MS,
        () => ({ ok: false, path: input.path, error: 'timeout' }),
        (requestId) => ({
          type: 'fileReadRequest',
          requestId,
          cwd: session.cwd,
          path: input.path,
          knownPath,
        }),
        session.machineId,
      )
    }
    return this.daemonRequest(
      this.pendingFileReads,
      'fr',
      FILE_RPC_TIMEOUT_MS,
      () => ({ ok: false, path: input.path, error: 'timeout' }),
      (requestId) => ({
        type: 'fileReadRequest',
        requestId,
        cwd: input.root,
        path: input.path,
        knownPath: false,
      }),
      input.machineId ?? this.defaultMachineId(),
    )
  }

  readAsset(
    input: { sessionId: string; path: string } | { machineId?: string; root: string; path: string },
  ): Promise<Omit<FileAssetResultMessage, 'type' | 'requestId'>> {
    if ('sessionId' in input) {
      const session = this.sessions.get(input.sessionId)
      if (!session) return Promise.resolve({ ok: false, path: input.path, error: 'no session' })
      const knownPath = knownPathsFor(session.transcriptItems()).has(input.path)
      return this.daemonRequest(
        this.pendingFileAssets,
        'fa',
        FILE_RPC_TIMEOUT_MS,
        () => ({ ok: false, path: input.path, error: 'timeout' }),
        (requestId) => ({
          type: 'fileAssetRequest',
          requestId,
          cwd: session.cwd,
          path: input.path,
          knownPath,
        }),
        session.machineId, // the asset lives in the session's cwd on its machine
      )
    }
    // Worktree-scoped variant (issue panel artifacts, worktree md images): same
    // daemon sandbox as fileReadRequest — cwd = the worktree root. Artifact paths
    // may be worktree-relative; the daemon realpaths them, so absolutize here.
    const absPath = isAbsolute(input.path) ? input.path : join(input.root, input.path)
    return this.daemonRequest(
      this.pendingFileAssets,
      'fa',
      FILE_RPC_TIMEOUT_MS,
      () => ({ ok: false, path: input.path, error: 'timeout' }),
      (requestId) => ({
        type: 'fileAssetRequest',
        requestId,
        cwd: input.root,
        path: absPath,
        knownPath: false,
      }),
      input.machineId ?? this.defaultMachineId(),
    )
  }

  writeFile(
    input:
      | { sessionId: string; path: string; content: string; baseHash?: string }
      | { machineId?: string; root: string; path: string; content: string; baseHash?: string },
  ): Promise<Omit<FileWriteResultMessage, 'type' | 'requestId'>> {
    const build = (requestId: string, cwd: string) => ({
      type: 'fileWriteRequest' as const,
      requestId,
      cwd,
      path: input.path,
      content: input.content,
      ...(input.baseHash ? { baseHash: input.baseHash } : {}),
    })
    if ('sessionId' in input) {
      const session = this.sessions.get(input.sessionId)
      if (!session) return Promise.resolve({ ok: false, error: 'no session' })
      return this.daemonRequest(
        this.pendingFileWrites,
        'fw',
        FILE_RPC_TIMEOUT_MS,
        () => ({ ok: false, error: 'timeout' }),
        (requestId) => build(requestId, session.cwd),
        session.machineId,
      )
    }
    return this.daemonRequest(
      this.pendingFileWrites,
      'fw',
      FILE_RPC_TIMEOUT_MS,
      () => ({ ok: false, error: 'timeout' }),
      (requestId) => build(requestId, input.root),
      input.machineId ?? this.defaultMachineId(),
    )
  }

  setConversationMeta(input: { id: string; name?: string; summary?: string }): void {
    this.store.setConversationMeta(input.id, input)
  }

  private attentionNoticeName(session: Session): string {
    return session.name || session.title || session.cwd.split('/').pop() || 'agent'
  }

  private notifyAttentionForNewExternalTargets(
    previous: NotificationSettings,
    next: NotificationSettings,
  ): void {
    const previousNtfy = previous.ntfyTopic.trim()
    const nextNtfy = next.ntfyTopic.trim()
    const sendNtfy = nextNtfy !== '' && previousNtfy !== nextNtfy
    const sendTelegram =
      isTelegramEnabled(next) &&
      (!isTelegramEnabled(previous) ||
        normalizedTelegramKey(previous) !== normalizedTelegramKey(next))
    if (!sendNtfy && !sendTelegram) return

    const telegram = telegramConfig(next)
    for (const session of this.sessions.values()) {
      const state = session.agentState
      if (!state) continue
      const notice = attentionNotice(this.attentionNoticeName(session), undefined, state)
      if (!notice) continue
      if (sendNtfy) this.notificationPushers.ntfy(nextNtfy, notice)
      if (sendTelegram) this.notificationPushers.telegram(telegram, notice)
    }
  }

  /**
   * Smart-routed attention notifications. Web clients always get the event
   * (each shows it only while hidden); the mobile push (ntfy) fires only when
   * NO Podium window is visible anywhere — if you're looking at a desktop, the
   * phone stays quiet.
   */
  private notifyAttention(
    session: Session,
    prev: AgentRuntimeState | undefined,
    next: AgentRuntimeState,
  ): void {
    // Durable event log: one row per REAL phase transition (the caller fires on
    // every agentState message, including same-phase refreshes). prev==null is the
    // first seed after a server restart (agentState isn't restored from the DB) —
    // skip it or every redeploy logs a phantom row per live session. Best-effort.
    if (prev != null && prev.phase !== next.phase) {
      try {
        this.store.appendEvent({
          ts: new Date(this.now()).toISOString(),
          kind: 'session.phase',
          subject: session.sessionId,
          payload: {
            phase: next.phase,
            ...(next.idle?.kind ? { verdict: next.idle.kind } : {}),
            agentKind: session.agentKind,
            cwd: session.cwd,
          },
        })
      } catch {}
    }
    const settings = this.store.getSettings().notifications
    const name = this.attentionNoticeName(session)
    const notice = attentionNotice(name, prev, next)
    if (!notice) return
    if (settings.web) {
      const event: ServerMessage = {
        type: 'attentionEvent',
        sessionId: session.sessionId,
        title: notice.title,
        body: notice.body,
      }
      for (const c of this.clients.values()) c.send(event)
    }
    const telegram = telegramConfig(settings)
    const telegramEnabled = isTelegramEnabled(settings)
    if (settings.ntfyTopic || telegramEnabled) {
      const someoneWatching = [...this.clients.values()].some((c) => c.visible)
      if (!someoneWatching) {
        if (settings.ntfyTopic) this.notificationPushers.ntfy(settings.ntfyTopic, notice)
        if (telegramEnabled) this.notificationPushers.telegram(telegram, notice)
      }
    }
  }

  // ---- machine admin + daemon pairing/auth ----

  /** Issue a short-lived, single-use pairing code for a new daemon (UI shows it). */
  mintPairingCode(): string {
    return this.pairing.mint()
  }

  /**
   * Authenticate a daemon's handshake frame (pre-Control/Daemon-union, parsed by
   * wsServer). `pair` redeems a one-time code and mints a fresh token, hashing it
   * for storage and returning the plaintext once (the daemon persists it). `hello`
   * verifies a returning daemon's token against the stored hash for its machineId,
   * then attaches as that machineId — the id always comes FROM the frame, never a
   * token lookup, so getMachineByToken returning a boolean is sufficient.
   */
  authenticateDaemon(
    frame: DaemonHandshake,
  ): { ok: true; machineId: string; name: string; token?: string } | { ok: false; reason: string } {
    if (frame.type === 'pair') {
      if (!this.pairing.redeem(frame.code)) return { ok: false, reason: 'invalid or expired code' }
      const name = frame.name ?? frame.hostname
      const token = randomUUID()
      this.store.upsertMachine({
        id: frame.machineId,
        name,
        hostname: frame.hostname,
        tokenHash: sha256(token),
      })
      this.invalidateMachineCache()
      return { ok: true, machineId: frame.machineId, name, token }
    }
    if (this.store.getMachineByToken(frame.machineId, frame.token)) {
      this.store.touchMachine(frame.machineId, frame.hostname)
      this.invalidateMachineCache()
      const name =
        this.store.listMachines().find((m) => m.id === frame.machineId)?.name ?? frame.hostname
      return { ok: true, machineId: frame.machineId, name }
    }
    return { ok: false, reason: 'unknown machine — re-pair' }
  }

  /** All known machines with live online status (a daemon socket is attached). */
  listMachines(): MachineWire[] {
    return this.machineRecords().map((m) => ({
      id: m.id,
      name: m.name,
      hostname: m.hostname,
      online: this.daemons.has(m.id),
      lastSeenAt: m.lastSeenAt,
    }))
  }

  renameMachine(id: string, name: string): void {
    this.store.renameMachine(id, name)
    this.invalidateMachineCache()
    this.broadcastSessions() // sessions show machineName — refresh it
    this.broadcastMachines()
  }

  revokeMachine(id: string): void {
    this.store.deleteMachine(id)
    this.invalidateMachineCache()
    this.daemons.delete(id)
    this.broadcastMachines()
  }

  /**
   * Rewrite the store's `'__local__'` placeholder rows (sessions/repos/conversations)
   * onto `machineId`, retarget in-memory sessions still on the placeholder, carry over
   * any queued control messages, and broadcast the updated session list. Idempotent.
   */
  private adoptPlaceholderRows(machineId: string): void {
    this.store.adoptLocalRows(machineId)
    for (const s of this.sessions.values()) {
      if (s.machineId === LOCAL_PLACEHOLDER) s.machineId = machineId
    }
    // Carry over any control messages queued under the placeholder (e.g. a boot
    // session's spawn produced before adoption) so they reach the adopting machine.
    const queued = this.pendingByMachine.get(LOCAL_PLACEHOLDER)
    if (queued && queued.length > 0) {
      this.pendingByMachine.delete(LOCAL_PLACEHOLDER)
      const dest = this.pendingByMachine.get(machineId)
      if (dest) dest.unshift(...queued)
      else this.pendingByMachine.set(machineId, queued)
    }
    // Parked (hibernated/exited) sessions aren't touched by attachDaemon's reattach
    // loop, so push the updated list now — this is what makes pre-existing sessions
    // reappear on upgrade.
    this.broadcastSessions()
  }

  /**
   * Provision the local machine at SERVER STARTUP. The local machine is just a normally
   * registered machine: the server owns its credential (`tokenHash = sha256(secret)`,
   * where `secret` is the value it wrote to the state-dir file for the same-host daemon
   * to read), so the local daemon authenticates through the regular hello path — exactly
   * like a paired remote, with no special bootstrap case. Adoption of pre-existing
   * `'__local__'` rows happens HERE, independent of the daemon, so a single-machine
   * install's sessions/repos are attributed and visible even if the daemon never connects
   * (the regression that lost everyone's data). The daemon presents this id + the secret,
   * attaches, and re-binds its sessions. Idempotent. Tests omit `secret` (a random
   * throwaway — they attach via the registry without authenticating).
   */
  ensureLocalMachine(hostname: string = LOCAL_MACHINE_ID, secret: string = randomUUID()): string {
    this.store.upsertMachine({
      id: LOCAL_MACHINE_ID,
      name: hostname,
      hostname,
      tokenHash: sha256(secret),
    })
    this.invalidateMachineCache()
    this.adoptPlaceholderRows(LOCAL_MACHINE_ID)
    return LOCAL_MACHINE_ID
  }

  private broadcastMachines(): void {
    const msg: ServerMessage = { type: 'machinesChanged', machines: this.listMachines() }
    for (const c of this.clients.values()) c.send(msg)
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

  private broadcastSessions(): void {
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
    // Record the change into the oplog FIRST (durable before fan-out, spec §2.5),
    // then split the fan-out: delta-cap clients get only the rows that changed,
    // legacy clients get the full list exactly as before.
    const changes = this.oplog.record(
      'session',
      sessions.map((s) => ({ id: s.sessionId, value: s })),
    )
    this.fanOutMetadata({ type: 'sessionsChanged', sessions }, changes)
    // Session changes also change issues' DERIVED member data (sessions/summary),
    // so keep issue clients live. Build the payload ONCE: allWire() is
    // O(issues × sessions), so calling it per-client would be a hot-path perf bug
    // (mirrors the sessionsMsg hoist above). sessionsChanged was already sent above,
    // so even if the issues build fails it can't take the session list down with it.
    this.publishIssues(this.safeIssuesList())
  }

  /**
   * Build the issue-list payload, degrading to an empty list if the DERIVED build
   * throws (e.g. a poison issue row whose member sessions fail to serialize).
   * An issues-layer throw must never abort an attach, a broadcast, or the daemon
   * handler that triggered it. `this.issues?` also guards construction-time calls
   * (broadcastSessions can run via loadFromStore before `this.issues` is set).
   */
  private safeIssuesList(): IssueWire[] {
    try {
      return this.issues?.allWire() ?? []
    } catch (err) {
      console.warn('[podium] issues payload build failed — broadcasting empty issues list', err)
      return []
    }
  }

  /** Oplog-record + split fan-out for a full issue list (every issuesChanged path).
   *  Takes the LOCAL list; the hub-mirrored issues are unioned in HERE, so every
   *  caller (IssueService broadcast, session rebroadcast, staleness flips) serves
   *  local ∪ upstream without knowing about the mirror (node-hub-issues §2.1). */
  private publishIssues(localIssues: IssueWire[]): void {
    const issues = this.withUpstreamIssues(localIssues)
    const changes = this.oplog.record(
      'issue',
      issues.map((i) => ({ id: i.id, value: i })),
    )
    this.fanOutMetadata({ type: 'issuesChanged', issues }, changes)
  }

  private broadcastConversations(): void {
    // Local ∪ upstream: hub-mirrored conversations ride the same snapshot + oplog
    // pipeline as local ones (node-hub-sync §2.3), so node clients see them live.
    const conversations = this.allConversations()
    const msg: ServerMessage = {
      type: 'conversationsChanged',
      conversations,
      diagnostics: this.latestConversationDiagnostics,
    }
    const changes = this.oplog.record(
      'conversation',
      conversations.map((c) => ({ id: c.id, value: c })),
    )
    // Diagnostics don't ride the delta stream (they're scan-level, not per-entity):
    // when they changed, cap clients need the snapshot too. Applying it as a full
    // replace on the client is safe — it's built from the same state as any delta
    // in flight, and later deltas re-apply idempotently by id.
    const diagKey = JSON.stringify(this.latestConversationDiagnostics)
    const diagnosticsChanged = diagKey !== this.lastDiagnosticsBroadcast
    this.lastDiagnosticsBroadcast = diagKey
    this.fanOutMetadata(msg, changes, { snapshotToCapClients: diagnosticsChanged })
  }

  /**
   * The split fan-out (spec §2.3): legacy clients always get the full-list snapshot
   * (exactly the pre-oplog behavior); delta-cap clients get a `metadataDelta` batch,
   * and only when something actually changed.
   */
  private fanOutMetadata(
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
    const changes = this.oplog.changesSince(cursor)
    if (changes) return { kind: 'delta', changes, cursor: this.oplog.cursor() }
    return {
      kind: 'snapshot',
      sessions: this.listSessions(),
      issues: this.withUpstreamIssues(this.safeIssuesList()),
      conversations: this.allConversations(),
      diagnostics: this.latestConversationDiagnostics,
      cursor: this.oplog.cursor(),
    }
  }

  private hostMetricsMessage(): ServerMessage {
    return { type: 'hostMetricsChanged', hosts: [...this.latestHostMetrics.values()] }
  }

  private broadcastHostMetrics(): void {
    const msg = this.hostMetricsMessage()
    for (const c of this.clients.values()) c.send(msg)
  }
}
