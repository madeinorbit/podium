import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

import {
  type AgentConversationDiagnostic,
  type AgentConversationSummary,
  type AgentRuntimeState,
  type AgentSession,
  type AgentStateEvent,
  type AgentStateProvider,
  abducoHasSessionAsync,
  agentLaunchCommand,
  agentStateProviderFor,
  attachAbducoAgent,
  attachTmuxAgent,
  ConversationDiscoveryCache,
  type CursorStateObserver,
  claudeProjectSlug,
  claudeRecordToItems,
  codexRecordToItems,
  compareConversationSummaries,
  cursorRecordToItems,
  cursorSessionPaths,
  findCodexRolloutPath,
  type GitDiscoveryDiagnostic,
  type GitRepositorySummary,
  type GrokStateObserver,
  grokRecordToItems,
  grokSessionPaths,
  initialAgentState,
  isAbducoAvailable,
  isTmuxAvailable,
  killAbducoSession,
  killAbducoSessionAsync,
  killTmuxServer,
  killTmuxServerAsync,
  loadOpencodeTranscriptTail,
  type OpencodeStateObserver,
  observeCodexState,
  observeCursorState,
  observeGrokState,
  observeOpencodeState,
  opencodeRowsToItems,
  openOpencodeDb,
  readTranscriptPage,
  readTranscriptTail,
  reduceAgentState,
  resolveCursorBin,
  resolveOpencodeBin,
  scanAgentConversationsCached,
  scanGitRepositories,
  spawnAbducoAgent,
  spawnAgent,
  spawnTmuxAgent,
  type TranscriptTailer,
  tailTranscript,
  tmuxHasSessionAsync,
} from '@podium/agent-bridge'
import {
  type AgentKind,
  type ControlMessage,
  type ConversationDiagnosticWire,
  type ConversationSummaryWire,
  type DaemonHandshake,
  type DaemonHandshakeReply,
  type DaemonMessage,
  encode,
  type GitDiscoveryDiagnosticWire,
  type GitRepositoryWire,
  parseControlMessage,
  parseDaemonHandshakeReply,
  type TranscriptItem,
  WIRE_VERSION,
} from '@podium/protocol'
import WebSocket, { type RawData } from 'ws'
import { readAssetSandboxed, readFileSandboxed, writeFileSandboxed } from './file-access'
import { buildHarnessExec } from './harness-exec.js'
import { startHookIngest } from './hook-ingest'
import { sampleHostMemory } from './host-metrics'
import { loadIdentity, saveToken } from './identity'
import { attributeMemory, snapshotProcesses } from './memory-breakdown'
import { makeQuotaFetcher } from './quota-fetch'
import { uploadFilePath } from './upload'
import { uploadsToGc } from './uploads-gc'
import { scanClaudeUsage } from './usage-scan'

const DEFAULT_DISCOVERY_SCAN_INTERVAL_MS = 15_000
const DEFAULT_HOST_METRICS_INTERVAL_MS = 5_000

// A control frame this large is never legitimate — the biggest real payload (an image
// upload) is bounded well under this — but a multi-hundred-MB frame's synchronous
// toString()+JSON.parse would stall the daemon loop and back up the socket (audit P0-4).
// 64 MB leaves generous headroom over real uploads/pastes/file writes.
const MAX_CONTROL_FRAME_BYTES = 64 * 1024 * 1024

/** Byte length of an inbound ws frame without materializing it to a string. Exported
 *  for unit testing the oversized-frame guard. */
export function controlFrameByteLength(raw: RawData): number {
  if (Buffer.isBuffer(raw)) return raw.length
  if (Array.isArray(raw)) return raw.reduce((n, b) => n + b.length, 0)
  return (raw as ArrayBuffer).byteLength
}

export interface DaemonDiscoveryOptions {
  /** Disable unsolicited cached/background conversation pushes; scanRequest still works. */
  background?: boolean
  /** Defaults to $PODIUM_STATE_DIR/discovery.db else ~/.podium/discovery.db. */
  cachePath?: string
  /** Test hook / isolated HOME for discovery. */
  homeDir?: string
  /** Background quick-scan interval. Defaults to 15s. */
  scanIntervalMs?: number
}

/** What holds the agent's PTY across daemon restarts. `none` = bare node-pty. */
export type DurableBackend = 'abduco' | 'tmux' | 'none'

export interface DaemonOptions {
  serverUrl: string
  /**
   * The in-process bootstrap secret (from the ServerHandle) OR the persistent shared
   * secret read from the state dir. When set, the daemon authenticates as the local
   * machine by presenting it as the `hello` token — the bundled localhost daemon needs
   * no paired credential of its own.
   */
  bootstrapToken?: string
  /**
   * A one-time pairing code (UI-issued) for a NEW remote daemon with no stored
   * token yet. Used only when there's no bootstrapToken and no persisted token.
   */
  pairCode?: string
  /** Display name to register on first pair (defaults to the hostname server-side). */
  name?: string
  /** Override the identity-file directory (tests/isolated state). Defaults per loadIdentity. */
  identityDir?: string
  /** Override the machineId to register as, instead of the one in the identity file. The
   *  bundled LOCAL daemon passes the stable local id so it attaches to the machine the
   *  server already adopted its sessions onto; remote daemons use their own identity. */
  machineId?: string
  /** Map an agent kind to a spawn command. Defaults to agentLaunchCommand; tests inject a fixture. */
  launch?: typeof agentLaunchCommand
  /**
   * Durable PTY backend. Defaults to abduco when installed (a transparent pipe —
   * no second terminal grid fighting xterm.js), else tmux, else bare node-pty.
   */
  backend?: DurableBackend
  /** Legacy force-tmux switch: true → 'tmux', false → 'none'. Prefer `backend`. */
  tmux?: boolean
  discovery?: DaemonDiscoveryOptions
  metrics?: DaemonMetricsOptions
  hooks?: DaemonHooksOptions
}

export interface DaemonMetricsOptions {
  /** Disable the periodic hostMetrics push entirely. */
  background?: boolean
  /** Sample/push cadence. Defaults to 5s. */
  intervalMs?: number
}

export interface DaemonHooksOptions {
  /** Ingest port. Fixed by default (DEFAULT_HOOK_PORT) so durable sessions survive restarts; 0 = ephemeral (tests). */
  port?: number
  /** Where per-session hook settings files are written. Defaults to $PODIUM_STATE_DIR/hooks else ~/.podium/hooks. */
  settingsDir?: string
}

/** Explicit choice wins (operator intent); otherwise prefer abduco → tmux → none. */
export function resolveDurableBackend(
  opts: Pick<DaemonOptions, 'backend' | 'tmux'>,
  avail: { abduco: boolean; tmux: boolean },
): DurableBackend {
  if (opts.backend) return opts.backend
  if (opts.tmux !== undefined) return opts.tmux ? 'tmux' : 'none'
  if (avail.abduco) return 'abduco'
  if (avail.tmux) return 'tmux'
  return 'none'
}

/** Daemon→server reconnect backoff bounds (ms). */
const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 5_000
/**
 * How many durable reattaches may spawn an `abduco`/`tmux` attach client at once.
 * Reattaches arrive as a burst when the daemon (re)connects; gating the spawns
 * keeps a 30-session boot from forking 30 children in one tick. Sessions still all
 * reattach — just over a few ticks instead of starving anything.
 */
const REATTACH_CONCURRENCY = 6

/**
 * Minimal async concurrency limiter: returns a runner that keeps at most `max`
 * thunks in flight and queues the rest. Used to bound reattach spawn fan-out.
 */
export function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const queue: Array<() => void> = []
  const release = (): void => {
    active--
    queue.shift()?.()
  }
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = (): void => {
        active++
        fn().then(resolve, reject).finally(release)
      }
      if (active < max) run()
      else queue.push(run)
    })
}

export interface DaemonHandle {
  /** Where the hook ingest is actually listening (fixed port unless it was taken). */
  readonly hookPort: number
  /**
   * Detach from all sessions and close the server connection. Durable sessions
   * (abduco/tmux) keep running — that's the feature. Pass `reapSessions: true` to
   * kill them instead (test harnesses / explicit full teardown only).
   */
  close(opts?: { reapSessions?: boolean }): Promise<void>
}

type SpawnControl = Extract<ControlMessage, { type: 'spawn' }>
type ReattachControl = Extract<ControlMessage, { type: 'reattach' }>
type ConversationWireResult = {
  conversations: ConversationSummaryWire[]
  diagnostics: ConversationDiagnosticWire[]
}

function summaryToWire(s: AgentConversationSummary): ConversationSummaryWire {
  return {
    id: s.id,
    agentKind: s.agentKind,
    ...(s.title !== undefined ? { title: s.title } : {}),
    ...(s.projectPath !== undefined ? { projectPath: s.projectPath } : {}),
    ...(s.parentConversationId !== undefined
      ? { parentConversationId: s.parentConversationId }
      : {}),
    ...(s.statusHint !== undefined ? { statusHint: s.statusHint } : {}),
    ...(s.createdAt ? { createdAt: s.createdAt.toISOString() } : {}),
    ...(s.updatedAt ? { updatedAt: s.updatedAt.toISOString() } : {}),
    ...(s.messageCount !== undefined ? { messageCount: s.messageCount } : {}),
    ...(s.git ? { git: s.git } : {}),
    ...(s.resume ? { resume: s.resume } : {}),
    providerId: s.source.providerId,
  }
}

function diagnosticToWire(d: AgentConversationDiagnostic): ConversationDiagnosticWire {
  return {
    severity: d.severity,
    ...(d.providerId !== undefined ? { providerId: d.providerId } : {}),
    ...(d.root !== undefined ? { root: d.root } : {}),
    ...(d.path !== undefined ? { path: d.path } : {}),
    message: d.message,
  }
}

function repoToWire(r: GitRepositorySummary): GitRepositoryWire {
  return {
    path: r.path,
    kind: r.kind,
    ...(r.branch !== undefined ? { branch: r.branch } : {}),
    ...(r.headSha !== undefined ? { headSha: r.headSha } : {}),
    ...(r.originUrl !== undefined ? { originUrl: r.originUrl } : {}),
    worktrees: (r.worktrees ?? []).map((w) => ({
      path: w.path,
      ...(w.branch !== undefined ? { branch: w.branch } : {}),
      ...(w.headSha !== undefined ? { headSha: w.headSha } : {}),
      ...(w.locked !== undefined ? { locked: w.locked } : {}),
      ...(w.prunable !== undefined ? { prunable: w.prunable } : {}),
    })),
  }
}

function gitDiagnosticToWire(d: GitDiscoveryDiagnostic): GitDiscoveryDiagnosticWire {
  return { severity: d.severity, path: d.path, message: d.message }
}

export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const launch = opts.launch ?? agentLaunchCommand
  const backend = resolveDurableBackend(opts, {
    abduco: isAbducoAvailable(),
    tmux: isTmuxAvailable(),
  })
  if (opts.backend === undefined && opts.tmux === undefined && backend === 'none') {
    console.warn(
      '[podium] neither abduco nor tmux found — sessions will not survive a daemon restart',
    )
  }
  // Agent state observation: harness hooks POST here; provider translates the
  // payload into normalized events; the reducer folds them; changes go to the
  // server as `agentState`. Started before the WS so spawns can never race it.
  const settingsDir =
    opts.hooks?.settingsDir ??
    join(process.env.PODIUM_STATE_DIR ?? join(homedir(), '.podium'), 'hooks')
  const trackers = new Map<string, { provider: AgentStateProvider; state: AgentRuntimeState }>()
  // Live structured-transcript tails, keyed by Podium session id. Claude tails
  // the path reported by hook payloads; Grok tails its session chat_history.jsonl
  // once the observer learns the harness session id. Resume paths are derivable
  // for both harnesses, so reattached chat gets history before new activity.
  const tails = new Map<string, TranscriptTailer>()
  const grokStateObservers = new Map<string, GrokStateObserver>()
  // Codex is observed the same way as Grok (no hooks): one poller per session
  // that discovers the rollout file, tails it for state, and feeds the chat tail.
  const codexStateObservers = new Map<string, { stop(): void }>()
  const opencodeStateObservers = new Map<string, OpencodeStateObserver>()
  const cursorStateObservers = new Map<string, CursorStateObserver>()
  const ensureTranscriptTail = (
    sessionId: string,
    path: string,
    recordToItems?: (record: unknown) => TranscriptItem[],
  ): void => {
    const existing = tails.get(sessionId)
    if (existing?.path === path) return
    existing?.stop()
    tails.set(
      sessionId,
      tailTranscript(
        path,
        (items, reset) => {
          if (items.length === 0 && !reset) return
          send({ type: 'transcriptAppend', sessionId, items, ...(reset ? { reset } : {}) })
        },
        {
          ...(recordToItems ? { recordToItems } : {}),
          // The agent's `/color` accent rides the same transcript tail.
          onColor: (color) => send({ type: 'agentColor', sessionId, color }),
        },
      ),
    )
  }
  const stopTranscriptTail = (sessionId: string): void => {
    tails.get(sessionId)?.stop()
    tails.delete(sessionId)
  }
  const stopGrokStateObserver = (sessionId: string): void => {
    grokStateObservers.get(sessionId)?.stop()
    grokStateObservers.delete(sessionId)
  }
  const stopCodexStateObserver = (sessionId: string): void => {
    codexStateObservers.get(sessionId)?.stop()
    codexStateObservers.delete(sessionId)
  }
  const stopOpencodeStateObserver = (sessionId: string): void => {
    opencodeStateObservers.get(sessionId)?.stop()
    opencodeStateObservers.delete(sessionId)
  }
  const stopCursorStateObserver = (sessionId: string): void => {
    cursorStateObservers.get(sessionId)?.stop()
    cursorStateObservers.delete(sessionId)
  }
  const applyAgentStateEvents = (sessionId: string, events: AgentStateEvent[]): void => {
    const tracker = trackers.get(sessionId)
    if (!tracker) return
    for (const event of events) {
      const next = reduceAgentState(tracker.state, event, new Date().toISOString())
      if (next === tracker.state) continue
      tracker.state = next
      send({ type: 'agentState', sessionId, state: next })
    }
  }
  const startGrokStateObserver = (
    sessionId: string,
    cwd: string,
    resumeValue: string | undefined,
    // On a fresh spawn, pass the actual spawn timestamp so discovery skips older
    // sibling sessions in the same cwd. On reattach, pass undefined → observeGrokState
    // defaults watermarkMs to 0 (no floor), so the latest-by-activity session
    // is found even if it predates this daemon process start.
    startedAtMs?: number,
  ): void => {
    stopGrokStateObserver(sessionId)
    grokStateObservers.set(
      sessionId,
      observeGrokState({
        cwd,
        ...(resumeValue ? { resumeValue } : {}),
        ...(opts.discovery?.homeDir ? { homeDir: opts.discovery.homeDir } : {}),
        ...(startedAtMs !== undefined ? { startedAtMs } : {}),
        onSession: (grokSessionId) => {
          send({
            type: 'sessionResumeRef',
            sessionId,
            resume: { kind: 'grok-session', value: grokSessionId },
          })
          tailGrokTranscript(sessionId, cwd, grokSessionId)
        },
        onEvents: (events) => applyAgentStateEvents(sessionId, events),
      }),
    )
  }
  // Eagerly tail a claude-code session's resume transcript — the JSONL the harness
  // is already writing. The chat view then has history before the first hook fires.
  // Essential on reattach: a fresh daemon's tails map is empty and an idle survivor
  // fires no hook to register one, so chat would stay blank while the PTY scrollback
  // (native view) still shows the whole conversation.
  const tailResumeTranscript = (sessionId: string, cwd: string, resumeValue: string): void => {
    ensureTranscriptTail(
      sessionId,
      join(homedir(), '.claude', 'projects', claudeProjectSlug(cwd), `${resumeValue}.jsonl`),
    )
  }
  const tailGrokTranscript = (sessionId: string, cwd: string, grokConversationId: string): void => {
    ensureTranscriptTail(
      sessionId,
      grokSessionPaths({
        cwd,
        sessionId: grokConversationId,
        ...(opts.discovery?.homeDir ? { homeDir: opts.discovery.homeDir } : {}),
      }).chatHistoryPath,
      grokRecordToItems,
    )
  }
  const tailCodexTranscript = (sessionId: string, rolloutPath: string): void => {
    // Codex's rollout file carries both the conversation and state — the same
    // path the observer found feeds the chat tail.
    ensureTranscriptTail(sessionId, rolloutPath, codexRecordToItems)
  }
  // startedAtMs scopes the rollout search: a fresh spawn passes its start time so
  // discovery can't latch onto a stale sibling rollout in the same cwd. Reattach
  // passes undefined → the observer searches without a freshness floor and finds
  // the live session's existing (idle, older-mtime) rollout. Mirrors how the Grok
  // observer scopes its search on spawn but not on reattach.
  const tailCursorTranscript = (sessionId: string, cwd: string, chatId: string): void => {
    ensureTranscriptTail(
      sessionId,
      cursorSessionPaths({
        cwd,
        chatId,
        ...(opts.discovery?.homeDir ? { homeDir: opts.discovery.homeDir } : {}),
      }).transcriptPath,
      cursorRecordToItems,
    )
  }
  const startCursorStateObserver = (
    sessionId: string,
    cwd: string,
    resumeValue: string | undefined,
    startedAtMs = Date.now(),
  ): void => {
    stopCursorStateObserver(sessionId)
    cursorStateObservers.set(
      sessionId,
      observeCursorState({
        cwd,
        ...(resumeValue ? { resumeValue } : {}),
        ...(opts.discovery?.homeDir ? { homeDir: opts.discovery.homeDir } : {}),
        startedAtMs,
        onSession: (chatId) => {
          send({
            type: 'sessionResumeRef',
            sessionId,
            resume: { kind: 'cursor-chat', value: chatId },
          })
          tailCursorTranscript(sessionId, cwd, chatId)
        },
        onEvents: (events) => applyAgentStateEvents(sessionId, events),
      }),
    )
  }
  const startOpencodeStateObserver = (
    sessionId: string,
    cwd: string,
    resumeValue: string | undefined,
    startedAtMs = Date.now(),
  ): void => {
    stopOpencodeStateObserver(sessionId)
    opencodeStateObservers.set(
      sessionId,
      observeOpencodeState({
        cwd,
        ...(resumeValue ? { resumeValue } : {}),
        ...(opts.discovery?.homeDir ? { homeDir: opts.discovery.homeDir } : {}),
        startedAtMs,
        onSession: (opencodeSessionId) => {
          send({
            type: 'sessionResumeRef',
            sessionId,
            resume: { kind: 'opencode-session', value: opencodeSessionId },
          })
        },
        onEvents: (events) => applyAgentStateEvents(sessionId, events),
        onTranscriptItems: (items, reset) => {
          if (items.length === 0 && !reset) return
          send({ type: 'transcriptAppend', sessionId, items, ...(reset ? { reset } : {}) })
        },
      }),
    )
  }
  const startCodexStateObserver = (sessionId: string, cwd: string, startedAtMs?: number): void => {
    stopCodexStateObserver(sessionId)
    codexStateObservers.set(
      sessionId,
      observeCodexState({
        cwd,
        ...(opts.discovery?.homeDir ? { homeDir: opts.discovery.homeDir } : {}),
        ...(startedAtMs !== undefined ? { startedAtMs } : {}),
        onSession: (rolloutId, rolloutPath) => {
          // Recording a resume ref marks the session resumable (→ hibernate
          // button); the first transcript frame marks it chat-capable (→ chat
          // switcher + BTW button).
          send({
            type: 'sessionResumeRef',
            sessionId,
            resume: { kind: 'codex-thread', value: rolloutId },
          })
          tailCodexTranscript(sessionId, rolloutPath)
        },
        // Codex's OSC terminal title is just the cwd basename (suppressed in
        // wireBridge); the observer derives a real title from the thread instead.
        onTitle: (title) => send({ type: 'title', sessionId, title }),
        onEvents: (events) => applyAgentStateEvents(sessionId, events),
      }),
    )
  }
  // Resolve a session's on-disk transcript file + record→items mapper from its
  // resume ref, the same way the live tails are. Opencode has no JSONL file (it's
  // a SQLite store) so it returns null — callers read it via the DB path instead.
  const resolveTranscriptSource = async (msg: {
    agentKind: AgentKind
    cwd: string
    resume: { kind: string; value: string }
  }): Promise<{ path: string; recordToItems: (record: unknown) => TranscriptItem[] } | null> => {
    const isGrok = msg.agentKind === 'grok' || msg.resume.kind === 'grok-session'
    const isCodex = msg.agentKind === 'codex' || msg.resume.kind === 'codex-thread'
    const isCursor = msg.agentKind === 'cursor' || msg.resume.kind === 'cursor-chat'
    if (isCodex) {
      // Codex stores no derivable per-cwd path; resolve the rollout from the
      // resume value (state DB, then filename fallback).
      const path = await findCodexRolloutPath({
        resumeValue: msg.resume.value,
        ...(opts.discovery?.homeDir ? { homeDir: opts.discovery.homeDir } : {}),
      })
      return path ? { path, recordToItems: codexRecordToItems } : null
    }
    if (isCursor) {
      const path = cursorSessionPaths({
        cwd: msg.cwd,
        chatId: msg.resume.value,
        ...(opts.discovery?.homeDir ? { homeDir: opts.discovery.homeDir } : {}),
      }).transcriptPath
      return { path, recordToItems: cursorRecordToItems }
    }
    if (isGrok) {
      const path = grokSessionPaths({
        cwd: msg.cwd,
        sessionId: msg.resume.value,
        ...(opts.discovery?.homeDir ? { homeDir: opts.discovery.homeDir } : {}),
      }).chatHistoryPath
      return { path, recordToItems: grokRecordToItems }
    }
    const path = join(
      homedir(),
      '.claude',
      'projects',
      claudeProjectSlug(msg.cwd),
      `${msg.resume.value}.jsonl`,
    )
    return { path, recordToItems: claudeRecordToItems }
  }

  // On-demand disk read of a parked session's transcript (no live tail running).
  const readParkedTranscript = async (
    msg: Extract<ControlMessage, { type: 'transcriptReadRequest' }>,
  ): Promise<void> => {
    const isOpencode = msg.agentKind === 'opencode' || msg.resume.kind === 'opencode-session'
    let items: TranscriptItem[] = []
    if (isOpencode) {
      const db = openOpencodeDb(opts.discovery?.homeDir)
      items = db ? opencodeRowsToItems(loadOpencodeTranscriptTail(db, msg.resume.value)) : []
      db?.close()
    } else {
      const source = await resolveTranscriptSource(msg)
      items = source ? await readTranscriptTail(source.path, source.recordToItems) : []
    }
    send({ type: 'transcriptReadResult', requestId: msg.requestId, items })
  }

  // Scroll-to-top paging: read the page of OLDER items before the client's window
  // (see TranscriptPageRequestMessage for the fromEnd cursor). Works for both live
  // and parked sessions — it's a pure disk read off the same JSONL the tail uses,
  // independent of whatever in-memory window the server is streaming. Opencode is
  // unsupported (DB-backed, no JSONL to page) → empty page, hasMore:false.
  const readTranscriptPageRequest = async (
    msg: Extract<ControlMessage, { type: 'transcriptPageRequest' }>,
  ): Promise<void> => {
    const isOpencode = msg.agentKind === 'opencode' || msg.resume.kind === 'opencode-session'
    if (isOpencode) {
      send({ type: 'transcriptPageResult', requestId: msg.requestId, items: [], hasMore: false })
      return
    }
    const source = await resolveTranscriptSource(msg)
    const page = source
      ? await readTranscriptPage(source.path, msg.fromEnd, msg.limit, source.recordToItems)
      : { items: [], hasMore: false }
    send({
      type: 'transcriptPageResult',
      requestId: msg.requestId,
      items: page.items,
      hasMore: page.hasMore,
    })
  }
  const ingest = await startHookIngest({
    ...(opts.hooks?.port !== undefined ? { port: opts.hooks.port } : {}),
    onPayload: (sessionId, payload) => {
      const tracker = trackers.get(sessionId)
      if (!tracker) return
      // Every Claude hook payload carries transcript_path — the authoritative
      // pointer to the live JSONL (resumes roll into a fresh file; this follows).
      const fields = payload as Record<string, unknown> | null
      const transcriptPath = fields?.transcript_path
      if (typeof transcriptPath === 'string' && transcriptPath) {
        ensureTranscriptTail(sessionId, transcriptPath)
      }
      // The hook payload's session_id is the harness's own conversation id — the
      // authoritative resume ref (don't reverse-engineer it from the filename,
      // which couples us to Claude's on-disk layout). Lets the server hibernate
      // a fresh spawn and resume it later.
      const harnessSessionId = fields?.session_id
      if (typeof harnessSessionId === 'string' && harnessSessionId) {
        send({
          type: 'sessionResumeRef',
          sessionId,
          resume: { kind: 'claude-session', value: harnessSessionId },
        })
      }
      void tracker.provider
        .translate(payload)
        .then((events) => applyAgentStateEvents(sessionId, events))
        .catch((err) => console.warn(`[podium] hook translate failed for ${sessionId}:`, err))
    },
  })
  // Reconnecting client: the daemon may start before the server (separate
  // processes / `After=` ordering) and must survive a server restart without
  // dropping its abduco attaches. `currentWs` is the live socket; `send()` always
  // targets it, so frames keep flowing to the new connection after a reconnect.
  let currentWs: WebSocket | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectBackoffMs = RECONNECT_MIN_MS
  let closing = false
  const bridges = new Map<string, AgentSession>()
  const reattachGate = createLimiter(REATTACH_CONCURRENCY)
  const discoveryCache = new ConversationDiscoveryCache(opts.discovery?.cachePath)
  const discoveryBackground = opts.discovery?.background ?? true
  const discoveryIntervalMs = opts.discovery?.scanIntervalMs ?? DEFAULT_DISCOVERY_SCAN_INTERVAL_MS
  let discoveryTimer: ReturnType<typeof setTimeout> | undefined
  let discoveryInFlight: Promise<ConversationWireResult> | undefined
  let lastConversationPush = ''
  const metricsBackground = opts.metrics?.background ?? true
  const metricsIntervalMs = opts.metrics?.intervalMs ?? DEFAULT_HOST_METRICS_INTERVAL_MS
  let metricsTimer: ReturnType<typeof setInterval> | undefined
  let uploadsGcTimer: ReturnType<typeof setInterval> | undefined

  const UPLOADS_TTL_MS = 24 * 3600_000 // 24 hours
  const UPLOADS_GC_INTERVAL_MS = 3600_000 // 1 hour

  /** Collect all files under ~/.podium/uploads and delete those older than the TTL.
   *  Async fs throughout: the sweep walks every upload across all sessions on an
   *  hourly timer, and a sync readdir/stat storm on the daemon loop would stall every
   *  session's I/O for the duration (audit P2-17). */
  const sweepUploads = async (): Promise<void> => {
    const uploadsDir = join(homedir(), '.podium', 'uploads')
    try {
      const sessionDirs = await readdir(uploadsDir)
      const files: { path: string; mtimeMs: number }[] = []
      for (const sessionDir of sessionDirs) {
        const sessionPath = join(uploadsDir, sessionDir)
        try {
          const entries = await readdir(sessionPath)
          for (const entry of entries) {
            const filePath = join(sessionPath, entry)
            try {
              const st = await stat(filePath)
              if (st.isFile()) files.push({ path: filePath, mtimeMs: st.mtimeMs })
            } catch {
              // file may have already been removed
            }
          }
        } catch {
          // session dir may have disappeared
        }
      }
      const toDelete = uploadsToGc(files, Date.now(), UPLOADS_TTL_MS)
      for (const p of toDelete) {
        try {
          await rm(p)
        } catch {
          // best effort
        }
      }
    } catch {
      // uploads dir may not exist yet
    }
  }

  /** Remove a session's upload directory when the session is closed/killed. */
  const removeSessionUploads = (sessionId: string): void => {
    const sessionUploadsDir = join(homedir(), '.podium', 'uploads', sessionId)
    try {
      rmSync(sessionUploadsDir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }

  const send = (msg: DaemonMessage): void => {
    const w = currentWs
    if (w && w.readyState === WebSocket.OPEN) w.send(encode(msg))
  }

  // Seed agent state for a session whose CLI is already running but hasn't fired a
  // hook yet. Claude Code emits no SessionStart at interactive boot, so both a
  // fresh spawn and a post-restart reattach would otherwise sit at phase 'unknown'
  // — which the home board reads as 'working', flagging an idle survivor as active.
  // bootEvents reports idle (a resume value classifies the live transcript for a
  // richer verdict). Guarded on phase still 'unknown' so a real hook that already
  // landed always wins; best-effort, hooks remain authoritative.
  const seedBootState = async (
    sessionId: string,
    provider: AgentStateProvider,
    cwd: string,
    resumeValue?: string,
  ): Promise<void> => {
    if (!provider.bootEvents) return
    let events: AgentStateEvent[]
    try {
      events = await provider.bootEvents({ cwd, ...(resumeValue ? { resumeValue } : {}) })
    } catch {
      return
    }
    const tracker = trackers.get(sessionId)
    if (!tracker) return
    for (const event of events) {
      if (tracker.state.phase !== 'unknown') return
      const next = reduceAgentState(tracker.state, event, new Date().toISOString())
      if (next === tracker.state) continue
      tracker.state = next
      send({ type: 'agentState', sessionId, state: next })
    }
  }

  // (Re)build the per-session observers a fresh daemon must stand up right after
  // wiring the PTY bridge: the agent-state tracker, the harness state observer
  // (Grok has no hook channel), the resume transcript tail (Claude chat history
  // before the first hook), and a seeded phase. Spawn AND reattach both call this
  // so the two paths can't silently diverge — that drift left idle survivors shown
  // 'working' with an empty chat after a redeploy. `seedOnFrame` waits for the
  // first PTY frame (a fresh spawn's CLI isn't up yet); reattach seeds now (the
  // survivor is already at its prompt). `grokStartedAt` scopes Grok's session
  // search (a fresh spawn's start time; omitted on reattach → watermarkMs:0,
  // so discovery binds the latest-by-activity session regardless of its age).
  const initSessionObservers = (
    msg: SpawnControl | ReattachControl,
    session: AgentSession,
    provider: AgentStateProvider | undefined,
    init: { seedOnFrame: boolean; grokStartedAt?: number },
  ): void => {
    if (provider) {
      trackers.set(msg.sessionId, {
        provider,
        state: initialAgentState(new Date().toISOString()),
      })
    }
    if (msg.agentKind === 'grok') {
      startGrokStateObserver(msg.sessionId, msg.cwd, msg.resume?.value, init.grokStartedAt)
    } else if (msg.agentKind === 'codex') {
      startCodexStateObserver(msg.sessionId, msg.cwd, init.grokStartedAt)
    } else if (msg.agentKind === 'opencode') {
      startOpencodeStateObserver(msg.sessionId, msg.cwd, msg.resume?.value, init.grokStartedAt)
    } else if (msg.agentKind === 'cursor') {
      startCursorStateObserver(msg.sessionId, msg.cwd, msg.resume?.value, init.grokStartedAt)
      if (msg.resume) tailCursorTranscript(msg.sessionId, msg.cwd, msg.resume.value)
    } else if (msg.agentKind === 'claude-code' && msg.resume) {
      tailResumeTranscript(msg.sessionId, msg.cwd, msg.resume.value)
    }
    if (provider?.bootEvents) {
      // const capture so the narrowing survives into the onFrame closure.
      const bootProvider = provider
      const seed = (): void => {
        void seedBootState(msg.sessionId, bootProvider, msg.cwd, msg.resume?.value)
      }
      if (init.seedOnFrame) {
        const offFirstFrame = session.onFrame(() => {
          offFirstFrame()
          seed()
        })
      } else {
        seed()
      }
    }
  }

  const cachedConversationResult = (): ConversationWireResult => ({
    conversations: discoveryCache
      .listSummaries()
      .sort(compareConversationSummaries)
      .map(summaryToWire),
    diagnostics: [],
  })

  const publishConversations = (result: ConversationWireResult, force = false): void => {
    const key = JSON.stringify(result)
    if (!force && key === lastConversationPush) return
    lastConversationPush = key
    send({ type: 'conversationsChanged', ...result })
  }

  const runDiscoveryScan = (): Promise<ConversationWireResult> => {
    if (discoveryInFlight) return discoveryInFlight
    discoveryInFlight = (async () => {
      try {
        const result = await scanAgentConversationsCached({
          cache: discoveryCache,
          ...(opts.discovery?.homeDir ? { homeDir: opts.discovery.homeDir } : {}),
        })
        return {
          conversations: result.conversations.map(summaryToWire),
          diagnostics: result.diagnostics.map(diagnosticToWire),
        }
      } catch (err) {
        return {
          conversations: [],
          diagnostics: [
            { severity: 'error', message: err instanceof Error ? err.message : String(err) },
          ],
        }
      } finally {
        discoveryInFlight = undefined
      }
    })()
    return discoveryInFlight
  }

  const refreshAndPublishConversations = async (): Promise<ConversationWireResult> => {
    const result = await runDiscoveryScan()
    publishConversations(result)
    return result
  }

  const scheduleDiscoveryScan = (): void => {
    if (!discoveryBackground) return
    discoveryTimer = setTimeout(() => {
      void refreshAndPublishConversations().finally(scheduleDiscoveryScan)
    }, discoveryIntervalMs)
    discoveryTimer.unref?.()
  }

  const pushHostMetrics = (): void => {
    send({
      type: 'hostMetrics',
      hostname: hostname(),
      sampledAt: new Date().toISOString(),
      memory: sampleHostMemory(),
    })
  }

  const memoryBreakdown = (requestId: string, roots: string[]): void => {
    const memory = sampleHostMemory()
    const supported = process.platform === 'linux' // the walk needs /proc
    const { agents, projects } = supported
      ? attributeMemory(
          snapshotProcesses(),
          [...bridges.entries()].map(([sessionId, session]) => ({
            sessionId,
            label: `podium-${sessionId}`,
            pid: session.pid,
          })),
          roots,
          { selfPid: process.pid },
        )
      : { agents: [], projects: [] }
    const attributed =
      agents.reduce((sum, a) => sum + a.bytes, 0) + projects.reduce((sum, p) => sum + p.bytes, 0)
    const usedBytes = Math.max(0, memory.totalBytes - memory.availableBytes)
    send({
      type: 'memoryBreakdownResult',
      requestId,
      hostname: hostname(),
      sampledAt: new Date().toISOString(),
      supported,
      memory,
      agents,
      projects,
      otherBytes: Math.max(0, usedBytes - attributed),
    })
  }

  const wireBridge = (sessionId: string, session: AgentSession, agentKind: AgentKind): void => {
    bridges.set(sessionId, session)
    session.onFrame((frame) =>
      send({ type: 'agentFrame', sessionId, seq: frame.seq, data: frame.data }),
    )
    // Codex sets its OSC title to the cwd basename (+ a spinner glyph that churns at
    // frame-rate), which would clobber the real title the codex observer derives.
    // Every other harness sets a meaningful OSC title, so forward it for them.
    if (agentKind !== 'codex') {
      session.onTitle((title) => send({ type: 'title', sessionId, title }))
    }
    session.onExit((code) => {
      bridges.delete(sessionId)
      trackers.delete(sessionId)
      stopGrokStateObserver(sessionId)
      stopCodexStateObserver(sessionId)
      stopOpencodeStateObserver(sessionId)
      stopCursorStateObserver(sessionId)
      // The agent's gone — stop polling its (now frozen) transcript file.
      stopTranscriptTail(sessionId)
      // The attach CLIENT exiting is NOT the AGENT exiting. disposeAll() on a
      // daemon shutdown/redeploy SIGKILLs the client; a user detach or a client
      // crash do the same. For a durable backend the master + agent live on in
      // their own systemd scope (the whole point of abduco) — so reporting
      // agentExit here would persist a live session as 'exited', and boot never
      // reattaches an 'exited' row, orphaning a still-running agent. Only a
      // vanished master is a real exit. (`abducoHasSession` runs `abduco`, which
      // reaps the socket as it lists, so a just-exited master reads as gone.)
      const label = `podium-${sessionId}`
      void (async () => {
        if (backend === 'abduco' && (await abducoHasSessionAsync(label))) return
        if (backend === 'tmux' && (await tmuxHasSessionAsync(label))) return
        // The agent has truly exited (master is gone). Uploads are one-shot prompt
        // inputs that were already consumed before the agent finished processing
        // them, so it's safe to remove the per-session upload dir on any real exit
        // (natural finish, hibernate, or kill). kill also calls removeSessionUploads
        // directly, so the two are harmlessly idempotent (rmSync force:true is a no-op
        // on a missing dir). The hourly TTL sweep remains a backstop for edge cases.
        removeSessionUploads(sessionId)
        send({ type: 'agentExit', sessionId, code })
      })()
    })
  }

  const spawn = (msg: SpawnControl): void => {
    try {
      const spawnStartedAt = Date.now()
      const cmd = launch(msg.agentKind, {
        cwd: msg.cwd,
        ...(msg.resume ? { resume: msg.resume } : {}),
        ...(msg.model ? { model: msg.model } : {}),
      })
      const label = `podium-${msg.sessionId}`
      const provider = agentStateProviderFor(msg.agentKind)
      let extraArgs: string[] = []
      if (provider) {
        mkdirSync(settingsDir, { recursive: true })
        const instr = provider.instrumentation({
          endpointUrl: ingest.endpointFor(msg.sessionId),
          settingsPath: join(settingsDir, `${msg.sessionId}.json`),
        })
        if (instr.file) writeFileSync(instr.file.path, instr.file.contents)
        extraArgs = instr.args
      }
      const spawnOpts = {
        label,
        cmd: cmd.cmd,
        args: [...cmd.args, ...extraArgs],
        cwd: cmd.cwd,
        cols: msg.geometry.cols,
        rows: msg.geometry.rows,
        // Subagent model rides as env — Claude Code reads it; harmless elsewhere.
        ...(msg.subagentModel ? { env: { CLAUDE_CODE_SUBAGENT_MODEL: msg.subagentModel } } : {}),
      }
      const session =
        backend === 'abduco'
          ? spawnAbducoAgent(spawnOpts)
          : backend === 'tmux'
            ? spawnTmuxAgent(spawnOpts)
            : spawnAgent(spawnOpts)
      wireBridge(msg.sessionId, session, msg.agentKind)
      // Stand up the agent-state tracker, harness observer, resume transcript tail
      // and seeded phase. A fresh spawn's CLI isn't up yet, so seed on the first
      // frame. Same call on reattach keeps the two paths from drifting.
      initSessionObservers(msg, session, provider, {
        seedOnFrame: true,
        grokStartedAt: spawnStartedAt,
      })
      send({
        type: 'bind',
        sessionId: msg.sessionId,
        cmd: cmd.cmd,
        cwd: cmd.cwd,
        agentKind: msg.agentKind,
        geometry: msg.geometry,
      })
    } catch (err) {
      send({
        type: 'spawnError',
        sessionId: msg.sessionId,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const scan = async (requestId: string): Promise<void> => {
    const result = await refreshAndPublishConversations()
    send({ type: 'scanResult', requestId, ...result })
  }

  const scanRepos = async (
    requestId: string,
    roots: string[],
    opts: { includeHome?: boolean; maxDepth?: number } = {},
  ): Promise<void> => {
    const repositories: GitRepositoryWire[] = []
    const diagnostics: GitDiscoveryDiagnosticWire[] = []

    const addResult = (result: Awaited<ReturnType<typeof scanGitRepositories>>): void => {
      for (const repo of result.repositories) repositories.push(repoToWire(repo))
      for (const d of result.diagnostics) diagnostics.push(gitDiagnosticToWire(d))
    }

    try {
      addResult(
        await scanGitRepositories({
          roots,
          homeDir: process.env.HOME || undefined,
          ...(opts.includeHome === undefined ? {} : { includeHome: opts.includeHome }),
          ...(opts.maxDepth === undefined ? {} : { maxDepth: opts.maxDepth }),
        }),
      )
    } catch (err) {
      diagnostics.push({
        severity: 'error',
        path: '',
        message: err instanceof Error ? err.message : String(err),
      })
    }
    send({ type: 'scanReposResult', requestId, repositories, diagnostics })
  }

  // Reattach is the hot path on (re)connect: a burst of ~30 arrives at once. Each is
  // independent, so handle them off the synchronous message switch — async existence
  // checks (never a blocking fork+exec on the loop), idempotent (a reconnect re-sends
  // reattach for sessions we already hold — re-confirm the bind instead of spawning a
  // duplicate client), and gated so the spawn fan-out can't fork everything in one tick.
  const handleReattach = async (msg: ReattachControl): Promise<void> => {
    const existing = bridges.get(msg.sessionId)
    if (existing) {
      const cmd =
        backend === 'tmux' ? `tmux -L ${msg.durableLabel} attach` : `abduco -a ${msg.durableLabel}`
      send({
        type: 'bind',
        sessionId: msg.sessionId,
        cmd,
        cwd: msg.cwd,
        agentKind: msg.agentKind,
        geometry: msg.geometry,
      })
      existing.redraw()
      return
    }
    await reattachGate(async () => {
      if (bridges.has(msg.sessionId)) return // raced with another reattach for this id
      // A reattached shell sits idle at its prompt and ignores the SIGWINCH repaint
      // nudge, so without a Ctrl-L it shows blank until the user types. TUIs repaint
      // on resize, so only shells take the hard path.
      const attach = {
        label: msg.durableLabel,
        cols: msg.geometry.cols,
        rows: msg.geometry.rows,
        hardRepaint: msg.agentKind === 'shell',
      }
      let found: { session: AgentSession; cmd: string } | undefined
      // Backend-agnostic: try whichever durable host owns the label, so sessions
      // created under tmux before an abduco upgrade still reattach (no flag day).
      if (backend !== 'none' && (await abducoHasSessionAsync(msg.durableLabel))) {
        found = { session: attachAbducoAgent(attach), cmd: `abduco -a ${msg.durableLabel}` }
      } else if (backend !== 'none' && (await tmuxHasSessionAsync(msg.durableLabel))) {
        found = { session: attachTmuxAgent(attach), cmd: `tmux -L ${msg.durableLabel} attach` }
      }
      if (!found) {
        send({
          type: 'reattachFailed',
          sessionId: msg.sessionId,
          reason: backend === 'none' ? 'durable backend unavailable' : 'session not found',
        })
        return
      }
      wireBridge(msg.sessionId, found.session, msg.agentKind)
      // The settings file from the original spawn still points at our fixed port,
      // so a reattached agent keeps reporting. A fresh daemon (post-redeploy) lost
      // all in-memory per-session state — rebuild it via the same path spawn uses.
      // A survivor is already at its prompt and fires no hook until the user acts,
      // so seed immediately (an idle session would otherwise read 'unknown' →
      // 'working') and re-tail its transcript (else chat stays empty while the
      // native view still has scrollback).
      initSessionObservers(msg, found.session, agentStateProviderFor(msg.agentKind), {
        seedOnFrame: false,
      })
      send({
        type: 'bind',
        sessionId: msg.sessionId,
        cmd: found.cmd,
        cwd: msg.cwd,
        agentKind: msg.agentKind,
        geometry: msg.geometry,
      })
    })
  }

  const handleImageUpload = async (
    msg: Extract<ControlMessage, { type: 'imageUploadRequest' }>,
  ): Promise<void> => {
    // Session ownership is intentionally NOT validated here: a client may upload
    // an image before the agent PTY is live (e.g. pre-spawn or during reconnect).
    // Async fs: decoding+writing a multi-MB base64 image synchronously blocked the
    // whole daemon loop for the duration of the write (audit P0-4).
    try {
      const id = randomUUID()
      const filePath = uploadFilePath(homedir(), msg.sessionId, id, msg.mimeType)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, Buffer.from(msg.dataBase64, 'base64'))
      send({ type: 'imageUploadResult', requestId: msg.requestId, path: filePath })
    } catch (err) {
      // Return an empty path + error so the router can throw INTERNAL_SERVER_ERROR
      // (a write failure, not a timeout).
      console.warn('[podium] image upload failed:', err)
      send({
        type: 'imageUploadResult',
        requestId: msg.requestId,
        path: '',
        error: String(err),
      })
    }
  }

  // The control loop only runs after the handshake reply resolves the daemon (see the
  // connect Promise below): startBackground() flips `authenticated` true. Until then the
  // first inbound frame is the handshake reply, handled separately by the once('message')
  // interceptor. Each (re)connect resets this so every socket re-authenticates.
  let authenticated = false

  const handleControlMessage = (raw: RawData): void => {
    if (!authenticated) return // pre-auth frames belong to the handshake handler
    // Drop absurdly large frames before materializing/parsing them (audit P0-4): a
    // multi-hundred-MB frame's synchronous toString()+JSON.parse would stall the loop
    // and back up the socket Recv-Q — the wedge shape. The cap is generous so it never
    // touches legitimate big payloads (image uploads, large pastes, file writes).
    if (controlFrameByteLength(raw) > MAX_CONTROL_FRAME_BYTES) {
      console.warn('[podium:daemon] dropping oversized control frame')
      return
    }
    let msg: ControlMessage
    try {
      msg = parseControlMessage(raw.toString())
    } catch {
      return
    }
    switch (msg.type) {
      case 'spawn':
        spawn(msg)
        break
      case 'reattach':
        void handleReattach(msg)
        break
      case 'kill': {
        const session = bridges.get(msg.sessionId)
        trackers.delete(msg.sessionId)
        stopGrokStateObserver(msg.sessionId)
        stopCodexStateObserver(msg.sessionId)
        stopOpencodeStateObserver(msg.sessionId)
        stopCursorStateObserver(msg.sessionId)
        stopTranscriptTail(msg.sessionId)
        if (session) {
          session.dispose()
          bridges.delete(msg.sessionId)
        }
        // Reap the durable host unconditionally — NOT only when a bridge exists.
        // After a daemon restart a session can be live server-side with no local
        // bridge (attachDaemon only re-binds 'reconnecting' sessions); if kill
        // skipped the reap there, hibernate/kill would leave the abduco/tmux
        // master (and its agent) running. Both reapers are cheap no-ops when the
        // label isn't theirs. Async twins (audit P0-4): the sync reapers fork+exec
        // `abduco`/`tmux` on the loop, and kills arrive in bursts (superagent,
        // auto-hibernation) — serializing those would stall every other session.
        if (backend !== 'none') {
          void killAbducoSessionAsync(`podium-${msg.sessionId}`)
          void killTmuxServerAsync(`podium-${msg.sessionId}`)
        }
        removeSessionUploads(msg.sessionId)
        break
      }
      case 'input':
        bridges.get(msg.sessionId)?.write(msg.data)
        break
      case 'resize':
        bridges.get(msg.sessionId)?.resize(msg.cols, msg.rows)
        break
      case 'redraw':
        bridges.get(msg.sessionId)?.redraw()
        break
      case 'scanRequest':
        void scan(msg.requestId)
        break
      case 'scanReposRequest':
        void scanRepos(msg.requestId, msg.roots, {
          ...(msg.includeHome === undefined ? {} : { includeHome: msg.includeHome }),
          ...(msg.maxDepth === undefined ? {} : { maxDepth: msg.maxDepth }),
        })
        break
      case 'memoryBreakdownRequest':
        memoryBreakdown(msg.requestId, msg.roots)
        break
      case 'repoOpRequest':
        void runRepoOp(msg)
        break
      case 'harnessExecRequest':
        void runHarnessExec(msg)
        break
      case 'usageRequest':
        void runUsageScan(msg)
        break
      case 'agentQuotaRequest':
        void runAgentQuotaScan(msg)
        break
      case 'transcriptReadRequest':
        void readParkedTranscript(msg)
        break
      case 'imageUploadRequest':
        void handleImageUpload(msg)
        break
      case 'transcriptPageRequest':
        void readTranscriptPageRequest(msg)
        break
      case 'fileReadRequest':
        // .catch (audit P0-1): a sandboxed-read reject (ENOENT race, EACCES, decode
        // failure) would otherwise be an unhandled rejection AND leave the server's
        // pending resolver hanging until its 10s timeout. Reply with an error result.
        void readFileSandboxed({ cwd: msg.cwd, path: msg.path, knownPath: msg.knownPath })
          .then((r) => send({ type: 'fileReadResult', requestId: msg.requestId, ...r }))
          .catch((err) =>
            send({
              type: 'fileReadResult',
              requestId: msg.requestId,
              ok: false,
              path: msg.path,
              error: String(err),
            }),
          )
        break
      case 'fileAssetRequest':
        void readAssetSandboxed({ cwd: msg.cwd, path: msg.path, knownPath: msg.knownPath })
          .then((r) => send({ type: 'fileAssetResult', requestId: msg.requestId, ...r }))
          .catch((err) =>
            send({
              type: 'fileAssetResult',
              requestId: msg.requestId,
              ok: false,
              path: msg.path,
              error: String(err),
            }),
          )
        break
      case 'fileWriteRequest':
        void writeFileSandboxed({
          cwd: msg.cwd,
          path: msg.path,
          content: msg.content,
          ...(msg.baseHash ? { baseHash: msg.baseHash } : {}),
        })
          .then((r) => send({ type: 'fileWriteResult', requestId: msg.requestId, ...r }))
          .catch((err) =>
            send({
              type: 'fileWriteResult',
              requestId: msg.requestId,
              ok: false,
              error: String(err),
            }),
          )
        break
    }
  }

  // Per-agent plan-quota reader (live, read-only, TTL-cached). Same homeDir override
  // the discovery scans use, so tests can point it at a fixture home.
  const quotaFetcher = makeQuotaFetcher({
    ...(opts.discovery?.homeDir ? { homeDir: opts.discovery.homeDir } : {}),
  })

  // A usage scan reads every recently-active transcript — memo it so the status
  // chip's poll doesn't redo the walk per client. The TTL must exceed the chip's
  // poll interval (UsageView polls every 90s); at 60s the memo was always stale
  // by the next poll, so every poll re-read every recent transcript end to end.
  const USAGE_MEMO_TTL_MS = 120_000
  let usageMemo:
    | { atMs: number; sinceMs: number; buckets: import('@podium/protocol').UsageBucketWire[] }
    | undefined
  const runUsageScan = async (
    msg: Extract<ControlMessage, { type: 'usageRequest' }>,
  ): Promise<void> => {
    const sinceMs = msg.sinceMs ?? Date.now() - 7 * 24 * 3_600_000
    let buckets: import('@podium/protocol').UsageBucketWire[]
    if (
      usageMemo &&
      Date.now() - usageMemo.atMs < USAGE_MEMO_TTL_MS &&
      usageMemo.sinceMs <= sinceMs
    ) {
      buckets = usageMemo.buckets.filter((b) => Date.parse(b.hour) >= sinceMs - 3_600_000)
    } else {
      try {
        buckets = await scanClaudeUsage({
          sinceMs,
          ...(opts.discovery?.homeDir ? { homeDir: opts.discovery.homeDir } : {}),
        })
      } catch {
        buckets = []
      }
      usageMemo = { atMs: Date.now(), sinceMs, buckets }
    }
    send({ type: 'usageResult', requestId: msg.requestId, hostname: hostname(), buckets })
  }

  const runAgentQuotaScan = async (
    msg: Extract<ControlMessage, { type: 'agentQuotaRequest' }>,
  ): Promise<void> => {
    const agents = await quotaFetcher.getAgentQuota(msg.refresh ?? false)
    send({ type: 'agentQuotaResult', requestId: msg.requestId, hostname: hostname(), agents })
  }

  /** Allowlisted git operations for the superagent — each op is a fixed argv. */
  const runRepoOp = async (
    msg: Extract<ControlMessage, { type: 'repoOpRequest' }>,
  ): Promise<void> => {
    const argvFor = (): string[] | undefined => {
      switch (msg.op) {
        case 'status':
          return ['status', '--porcelain=v1', '-b']
        case 'log':
          return ['log', '--oneline', '-20']
        case 'branches':
          return ['branch', '-a', '-v']
        case 'worktreeAdd': {
          const path = msg.args?.path
          const branch = msg.args?.branch
          if (!path || !branch) return undefined
          return ['worktree', 'add', path, '-b', branch]
        }
      }
    }
    const argv = argvFor()
    if (!argv) {
      send({ type: 'repoOpResult', requestId: msg.requestId, ok: false, output: 'missing args' })
      return
    }
    try {
      const { stdout, stderr } = await execFileAsync('git', ['-C', msg.cwd, ...argv], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      })
      send({
        type: 'repoOpResult',
        requestId: msg.requestId,
        ok: true,
        output: `${stdout}${stderr ? `\n${stderr}` : ''}`.trim(),
      })
    } catch (err) {
      send({
        type: 'repoOpResult',
        requestId: msg.requestId,
        ok: false,
        output: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** One-shot `claude -p` / `codex exec` / `grok -p` for the harness-backed superagent. */
  const runHarnessExec = async (
    msg: Extract<ControlMessage, { type: 'harnessExecRequest' }>,
  ): Promise<void> => {
    // MCP config (Claude's --mcp-config) must be a file path, so write the JSON to
    // a temp file for the run and clean it up afterwards.
    let mcpConfigPath: string | undefined
    if (msg.mcpConfig) {
      mcpConfigPath = join(tmpdir(), `podium-mcp-${randomUUID()}.json`)
      try {
        writeFileSync(mcpConfigPath, msg.mcpConfig)
      } catch {
        mcpConfigPath = undefined
      }
    }
    const { cmd, args } = buildHarnessExec(
      msg.agent,
      {
        prompt: msg.prompt,
        ...(msg.model ? { model: msg.model } : {}),
        ...(msg.systemPrompt ? { systemPrompt: msg.systemPrompt } : {}),
        ...(mcpConfigPath ? { mcpConfigPath } : {}),
        ...(msg.allowedTools ? { allowedTools: msg.allowedTools } : {}),
      },
      { opencode: resolveOpencodeBin, cursor: resolveCursorBin },
    )
    try {
      const { stdout } = await execFileAsync(cmd, args, {
        timeout: 240_000,
        maxBuffer: 4 * 1024 * 1024,
        ...(msg.cwd ? { cwd: msg.cwd } : {}),
      })
      send({
        type: 'harnessExecResult',
        requestId: msg.requestId,
        ok: true,
        output: stdout.trim(),
      })
    } catch (err) {
      send({
        type: 'harnessExecResult',
        requestId: msg.requestId,
        ok: false,
        output: err instanceof Error ? err.message : String(err),
      })
    } finally {
      if (mcpConfigPath) {
        try {
          rmSync(mcpConfigPath, { force: true })
        } catch {
          // best-effort temp cleanup
        }
      }
    }
  }

  const disposeAll = (reapSessions = false): void => {
    if (discoveryTimer) clearTimeout(discoveryTimer)
    if (metricsTimer) clearInterval(metricsTimer)
    if (uploadsGcTimer) clearInterval(uploadsGcTimer)
    discoveryCache.close()
    // For durable sessions (abduco/tmux), dispose() only takes down the attach client,
    // so the agent survives the daemon going down — do NOT kill the masters here
    // unless the caller explicitly asked for a full reap (test harness teardown).
    for (const [sessionId, session] of bridges) {
      session.dispose()
      if (reapSessions && backend !== 'none') {
        killAbducoSession(`podium-${sessionId}`)
        killTmuxServer(`podium-${sessionId}`)
      }
    }
    bridges.clear()
    for (const id of [...grokStateObservers.keys()]) stopGrokStateObserver(id)
    for (const id of [...codexStateObservers.keys()]) stopCodexStateObserver(id)
    for (const id of [...opencodeStateObservers.keys()]) stopOpencodeStateObserver(id)
    for (const id of [...cursorStateObservers.keys()]) stopCursorStateObserver(id)
    trackers.clear()
  }

  const handle: DaemonHandle = {
    hookPort: ingest.port,
    async close(opts) {
      closing = true // stop the reconnect loop from resurrecting the socket
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      for (const id of [...tails.keys()]) stopTranscriptTail(id)
      await ingest.close()
      return new Promise<void>((resolve) => {
        disposeAll(opts?.reapSessions ?? false)
        const w = currentWs
        if (!w || w.readyState === WebSocket.CLOSED) {
          resolve()
          return
        }
        w.once('close', () => resolve())
        w.close()
      })
    },
  }

  const identity = loadIdentity(opts.identityDir ? { dir: opts.identityDir } : {})
  // The bundled local daemon overrides this with the server's stable local id so it
  // attaches to the machine the server already adopted; remote daemons use the identity.
  const machineId = opts.machineId ?? identity.machineId

  return new Promise<DaemonHandle>((resolve, reject) => {
    let resolved = false
    let kickedOff = false
    const resolveStart = (): void => {
      if (!resolved) {
        resolved = true
        resolve(handle)
      }
    }
    // Discovery + metrics startup, deferred until the handshake succeeds (the server
    // only sends control frames after our helloOk). Flips `authenticated` true so the
    // control loop accepts frames; kicks off discovery/metrics/uploads-GC exactly once
    // across reconnects (a reconnect must not double-start the intervals). The server
    // re-sends reattach for live sessions on every (re)connect; handleReattach is
    // idempotent.
    const startBackground = (): void => {
      authenticated = true
      if (!kickedOff) {
        kickedOff = true
        if (discoveryBackground) {
          publishConversations(cachedConversationResult(), true)
          void refreshAndPublishConversations()
          scheduleDiscoveryScan()
        }
        if (metricsBackground) {
          pushHostMetrics() // first sample immediately — the UI shouldn't wait a full interval
          metricsTimer = setInterval(pushHostMetrics, metricsIntervalMs)
          metricsTimer.unref?.()
        }
        // Periodic GC for stale uploads (TTL 24h, runs hourly).
        uploadsGcTimer = setInterval(sweepUploads, UPLOADS_GC_INTERVAL_MS)
        uploadsGcTimer.unref?.()
      }
      resolveStart()
    }
    // Send the handshake as the FIRST frame on a socket's open. The server holds the
    // socket unauthenticated until this proves who we are: bootstrap token (in-process
    // local daemon) or a stored token (returning paired daemon) → hello; else a
    // one-time pair code (new remote daemon) → pair; else we can't authenticate. Runs
    // on every (re)connect so each socket re-authenticates.
    const sendHandshake = (w: WebSocket): boolean => {
      const hostname0 = hostname()
      // Build the frame as a typed DaemonHandshake first. The `hello`/`pair` type
      // literals also exist in the Client/Control unions encode() accepts, so an inline
      // object literal would resolve against the wrong member; the annotation pins it.
      const token = opts.bootstrapToken ?? identity.token
      let frame: DaemonHandshake
      if (token) {
        frame = { type: 'hello', machineId, token, hostname: hostname0 }
      } else if (opts.pairCode) {
        frame = {
          type: 'pair',
          code: opts.pairCode,
          machineId,
          hostname: hostname0,
          ...(opts.name ? { name: opts.name } : {}),
        }
      } else {
        return false
      }
      w.send(encode(frame))
      return true
    }
    const scheduleReconnect = (): void => {
      if (closing || reconnectTimer) return
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined
        connect()
      }, reconnectBackoffMs)
      reconnectTimer.unref?.()
      reconnectBackoffMs = Math.min(reconnectBackoffMs * 2, RECONNECT_MAX_MS)
    }
    function connect(): void {
      if (closing) return
      const w = new WebSocket(`${opts.serverUrl}/daemon?pv=${WIRE_VERSION}`)
      currentWs = w
      authenticated = false // each connection re-authenticates before the control loop runs
      w.once('open', () => {
        reconnectBackoffMs = RECONNECT_MIN_MS // healthy connect resets the backoff
        if (!sendHandshake(w)) {
          disposeAll()
          reject(new Error('daemon has no token and no pair code; pair it first'))
          w.close()
        }
      })
      // The FIRST inbound frame is the handshake reply: intercept it before the
      // persistent control loop (gated by `authenticated`). On accept, persist any
      // minted token, start background work, and resolve; on reject, tear down.
      w.once('message', (raw: RawData) => {
        let reply: DaemonHandshakeReply
        try {
          reply = parseDaemonHandshakeReply(raw.toString())
        } catch {
          // The server's first frame wasn't a valid handshake reply — refuse rather
          // than silently proceed unauthenticated.
          disposeAll()
          reject(new Error('daemon handshake failed: malformed reply'))
          w.close()
          return
        }
        switch (reply.type) {
          case 'paired':
            // First pairing: persist the minted token so future boots send `hello`.
            saveToken(reply.token, opts.identityDir ? { dir: opts.identityDir } : {})
            startBackground()
            break
          case 'helloOk':
            startBackground()
            break
          case 'helloRejected':
          case 'pairRejected':
            // The server refused this daemon (bad/missing token, or the machine was
            // revoked). STOP — set `closing` so the `close` handler below does NOT
            // schedule a reconnect; otherwise the daemon would re-hammer the server with
            // the same rejected handshake on backoff forever. Re-pairing requires
            // operator action (a new pair code) + a restart. Log the reason loudly: the
            // `reject()` is usually a no-op here because the start-grace already resolved
            // the start handle, so this console line is the only surfaced signal.
            console.error(
              `[podium:daemon] server rejected this daemon (${reply.type}): ${reply.reason}. ` +
                `Not reconnecting — re-pair the machine (new pair code) and restart the daemon.`,
            )
            closing = true
            disposeAll()
            reject(new Error(`daemon handshake rejected: ${reply.reason}`))
            w.close()
            break
        }
      })
      w.on('message', handleControlMessage)
      // Server rejected the upgrade (426 = wire-protocol mismatch). Surface it loudly;
      // 'close' still drives the backoff reconnect below.
      w.on('unexpected-response', (_req, res) => {
        if (res.statusCode === 426) {
          console.error(
            `[podium:daemon] server rejected this daemon: protocol mismatch (daemon pv=${WIRE_VERSION}). Update the daemon to match the server.`,
          )
        }
      })
      // A dropped/refused connection (server restart, or not up yet) must NOT tear
      // down running agents — keep the abduco attaches + transcript tails alive and
      // just reconnect (re-authenticating). Only an explicit handle.close() disposes.
      // ('error' is followed by 'close', which drives the backoff reconnect.)
      w.on('close', () => {
        if (currentWs === w) currentWs = undefined
        scheduleReconnect()
      })
      w.on('error', () => {
        // Swallow: 'close' handles reconnect, and an unhandled 'error' would crash.
      })
    }
    // Don't hang the entrypoint if the server isn't up yet — resolve after a grace
    // window; the daemon keeps retrying in the background and authenticates on real open.
    const startGrace = setTimeout(resolveStart, 10_000)
    startGrace.unref?.()
    connect()
  })
}
