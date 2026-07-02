import { execFile, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

import {
  type AgentRuntimeState,
  type AgentSession,
  type AgentStateEvent,
  type AgentStateProvider,
  abducoHasSessionAsync,
  agentLaunchCommand,
  agentStateProviderFor,
  attachAbducoAgent,
  attachTmuxAgent,
  type CursorStateObserver,
  claudeProjectSlug,
  codexRecordToItems,
  locateClaudeSessionFile,
  cursorRecordToItems,
  cursorSessionPaths,
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
  type OpencodeStateObserver,
  observeCodexState,
  observeCursorState,
  observeGrokState,
  observeOpencodeState,
  reduceAgentState,
  resolveCursorBin,
  resolveFileChain,
  resolveOpencodeBin,
  type SliceResult,
  scanGitRepositories,
  spawnAbducoAgent,
  spawnAgent,
  spawnTmuxAgent,
  type TranscriptSource,
  type TranscriptTailer,
  tailTranscript,
  tmuxHasSessionAsync,
  transcriptSourceFor,
} from '@podium/agent-bridge'
import { startLoopMetrics } from '@podium/core/loop-metrics'
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
import { type ActiveRefresh, createActiveRefresh } from './active-refresh'
import {
  listDirSandboxed,
  readAssetSandboxed,
  readFileSandboxed,
  writeFileSandboxed,
} from './file-access'
import { buildHarnessExec } from './harness-exec.js'
import { startHookIngest } from './hook-ingest'
import { sampleHostMemory } from './host-metrics'
import { loadIdentity, saveToken } from './identity'
import { createIssueRelayHub, startIssueRelayServer } from './issue-relay'
import { createPrimeInjector } from './prime-injector'
import { createCwdResolver, createSessionCwdTracker } from './worktree-resolve'
import {
  countControl,
  countFrame,
  countTail,
  countWorker,
  reportLongTick,
  startLoopAttribution,
  timeTask,
} from './loop-attribution'
import type { MemoryAttribution } from './memory-breakdown'
import { OutputScheduler, type Tier } from './output-scheduler'
import { makeQuotaFetcher } from './quota-fetch'
import { repoOpCommand } from './repo-op'
import { decideOnProtocolMismatch, decidePostUpdate } from './self-update'
import { uploadFilePath } from './upload'
import { uploadsToGc } from './uploads-gc'
import { scanClaudeUsage } from './usage-scan'
import { DiscoveryWorkerClient } from './worker-client'

const DEFAULT_DISCOVERY_SCAN_INTERVAL_MS = 15_000
const DEFAULT_HOST_METRICS_INTERVAL_MS = 5_000

// A control frame this large is never legitimate — the biggest real payload (an image
// upload) is bounded well under this — but a multi-hundred-MB frame's synchronous
// toString()+JSON.parse would stall the daemon loop and back up the socket (audit P0-4).
// 64 MB leaves generous headroom over real uploads/pastes/file writes.
const MAX_CONTROL_FRAME_BYTES = 64 * 1024 * 1024

/**
 * Env vars bound into EVERY spawned agent so its `podium issue` CLI can reach the
 * daemon's loopback relay for this exact session. PODIUM_SESSION_ID is bound at
 * spawn (never a CLI arg the agent could spoof); PODIUM_ISSUE_RELAY is the relay
 * URL with the session id baked into the path (issueRelay.endpointFor(sessionId)).
 * Pure so it's unit-testable without standing up the daemon.
 */
export function issueRelayEnv(sessionId: string, endpoint: string): Record<string, string> {
  // PODIUM_SESSION_ID is a deliberate informational/identity var: the `podium issue`
  // CLI reads the session id from PODIUM_ISSUE_RELAY's path, so this isn't consumed
  // by the relay path today — it's exposed for the agent itself and future consumers.
  return { PODIUM_SESSION_ID: sessionId, PODIUM_ISSUE_RELAY: endpoint }
}

// Malformed inbound frames and failed outbound sends are dropped so they can't wedge
// the daemon's control loop — but the drop is logged (never silent), throttled so a
// flapping socket or a poison-frame storm can't flood the journal.
const CONTROL_FRAME_WARN_THROTTLE_MS = 1_000
let lastControlFrameWarnAt = 0
function warnDroppedControlFrame(err: unknown, dir: 'inbound' | 'outbound' = 'inbound'): void {
  const now = Date.now()
  if (now - lastControlFrameWarnAt < CONTROL_FRAME_WARN_THROTTLE_MS) return
  lastControlFrameWarnAt = now
  console.warn(`[podium:daemon] dropped malformed ${dir} control frame:`, err)
}

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
  /** Issue-relay loopback server. Tests pass `port: 0` for an ephemeral port so
   *  parallel daemons don't contend for DEFAULT_ISSUE_RELAY_PORT. */
  issueRelay?: { port?: number }
  /**
   * The worker client that runs the /proc memory walk off the interactive loop.
   * Defaults to a real `DiscoveryWorkerClient` (spawns ./discovery-worker.ts).
   * Tests inject one whose `spawn` runs the job inline, because Node-based vitest
   * cannot spawn the `.ts` worker; the live daemon (Bun) uses the default.
   */
  workerClient?: DiscoveryWorkerClient
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

/**
 * Resolve a session's TRUE harness for the transcript-source layer, which routes
 * on `agentKind` alone. A session's real harness can hide behind its `resume.kind`
 * — e.g. a shell that the server later reclassifies, or a kind the server didn't
 * stamp precisely — so prefer the resume kind when it names a known harness; this
 * closes the mis-route gap where an opencode/grok/codex/cursor session arrived
 * with a generic `agentKind` and got read as the wrong source (empty chat). Falls
 * back to `agentKind` when the resume kind is absent or unrecognized.
 */
export function normalizeAgentKind(agentKind: AgentKind, resumeKind?: string): AgentKind {
  switch (resumeKind) {
    case 'opencode-session':
      return 'opencode'
    case 'grok-session':
      return 'grok'
    case 'codex-thread':
      return 'codex'
    case 'cursor-chat':
      return 'cursor'
    default:
      return agentKind
  }
}

export interface DaemonHandle {
  /** Where the hook ingest is actually listening (fixed port unless it was taken). */
  readonly hookPort: number
  /** Where the issue-relay loopback is actually listening (fixed port unless taken). */
  readonly issueRelayPort: number
  /**
   * Detach from all sessions and close the server connection. Durable sessions
   * (abduco/tmux) keep running — that's the feature. Pass `reapSessions: true` to
   * kill them instead (test harnesses / explicit full teardown only).
   */
  close(opts?: { reapSessions?: boolean }): Promise<void>
}

type SpawnControl = Extract<ControlMessage, { type: 'spawn' }>
type ReattachControl = Extract<ControlMessage, { type: 'reattach' }>
/**
 * What a discovery pass moved: the worker runs the scan against discovery.db and
 * returns just the delta (`changed`/`removed`) plus any diagnostics, so the daemon
 * forwards a delta instead of re-broadcasting the full conversation list every 15s.
 */
type ConversationDelta = {
  changed: ConversationSummaryWire[]
  removed: string[]
  diagnostics: ConversationDiagnosticWire[]
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
  // Event-driven active conversation-index refresh. Instantiated below once
  // `publishConversations` + `workerClient` exist; the tail callback marks a
  // transcript dirty so the worker re-summarizes JUST that file (coalesced) instead
  // of waiting for the next periodic scan. Holder is set before any tail can fire.
  let activeRefresh: ActiveRefresh | undefined
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
        (items, meta) => {
          if (items.length === 0 && !meta.reset) return
          countTail()
          send({
            type: 'transcriptDelta',
            sessionId,
            items,
            ...(meta.tail ? { tail: meta.tail } : {}),
            ...(meta.reset ? { reset: true } : {}),
          })
          // The tail fired because this transcript file was appended to — mark it
          // dirty so the worker re-summarizes JUST it (coalesced, ~1s) and keeps the
          // search index near-real-time, instead of waiting for the periodic scan.
          activeRefresh?.markConversationDirty(path)
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
  const tailResumeTranscript = (
    sessionId: string,
    cwd: string,
    resumeValue: string,
    pathHint?: string,
  ): void => {
    // Honor a discovery homeDir override (tests / isolated HOME) so the live tail
    // reads the SAME location the on-demand read source does — otherwise a daemon
    // run against an isolated home would tail the real ~/.claude and find nothing.
    const home = opts.discovery?.homeDir ?? homedir()
    void (async () => {
      // Locate, don't derive: after a worktree move the file lives in the ORIGINAL
      // cwd's bucket (docs/spec/conversation-registry.md §3.3). Fall back to the
      // derived path when nothing exists yet — a fresh resume creates the file a
      // moment later and the tailer waits on it.
      const located = await locateClaudeSessionFile({
        cwd,
        resumeValue,
        ...(pathHint ? { pathHint } : {}),
        homeDir: home,
      })
      ensureTranscriptTail(
        sessionId,
        located ??
          join(home, '.claude', 'projects', claudeProjectSlug(cwd), `${resumeValue}.jsonl`),
      )
    })()
  }
  // Start a claude-code session's transcript tail. With a resume ref we know the
  // exact file (derivable path). WITHOUT one — a fresh spawn that hasn't yet
  // reported a session id, or a reattach where the server never learned the resume
  // value — discover the newest .jsonl in the cwd bucket and tail that, so chat has
  // history from the start instead of waiting for the first hook (and so an idle
  // survivor that fires no hook still gets a tail). Hooks remain a fast-path: when
  // a hook lands, its transcript_path re-points ensureTranscriptTail at the live
  // file (the discovered one is the same file in the common case).
  const startClaudeTranscriptTail = (
    sessionId: string,
    cwd: string,
    resumeValue?: string,
    pathHint?: string,
  ): void => {
    if (resumeValue) {
      tailResumeTranscript(sessionId, cwd, resumeValue, pathHint)
      return
    }
    void (async () => {
      const chain = await resolveFileChain({
        agentKind: 'claude-code',
        cwd,
        ...(opts.discovery?.homeDir ? { homeDir: opts.discovery.homeDir } : {}),
      })
      const newest = chain.at(-1)
      if (newest) ensureTranscriptTail(sessionId, newest.path)
    })()
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
          // Items are already cursor-stamped (stampOpencodeItems) by the observer,
          // so the live delta carries the same cursors the on-demand read produces.
          const tail = items.at(-1)?.cursor
          send({
            type: 'transcriptDelta',
            sessionId,
            items,
            ...(reset ? { reset: true } : {}),
            ...(tail ? { tail } : {}),
          })
        },
      }),
    )
  }
  const startCodexStateObserver = (
    sessionId: string,
    cwd: string,
    // A reattach/resume passes the session's known codex-thread id so the observer
    // pins its OWN rollout instead of re-discovering by cwd+mtime (which collapses
    // sibling sessions in the same repo onto the newest rollout). A fresh spawn
    // passes undefined → discovery scoped by startedAtMs.
    resumeValue: string | undefined,
    startedAtMs?: number,
  ): void => {
    stopCodexStateObserver(sessionId)
    codexStateObservers.set(
      sessionId,
      observeCodexState({
        cwd,
        ...(resumeValue ? { resumeValue } : {}),
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
  // Build a TranscriptSource for the session named by a transcript-read request.
  // The factory routes on the TRUE harness (normalizeAgentKind, since a session's
  // real harness can hide behind resume.kind) and resolves the file chain / DB
  // session from cwd + resume value. Centralizes the per-read source resolution so
  // both the on-demand read and the reattach re-seed share one path.
  const sourceForRead = (msg: {
    agentKind: AgentKind
    cwd: string
    resume?: { kind: string; value: string }
    pathHint?: string
  }): Promise<TranscriptSource> => {
    const agentKind = normalizeAgentKind(msg.agentKind, msg.resume?.kind)
    return transcriptSourceFor({
      agentKind,
      cwd: msg.cwd,
      ...(msg.resume?.value ? { resumeValue: msg.resume.value } : {}),
      ...(msg.pathHint ? { pathHint: msg.pathHint } : {}),
      ...(opts.discovery?.homeDir ? { homeDir: opts.discovery.homeDir } : {}),
    })
  }

  // Unified cursor-anchored read (replaces the old parked-tail + scroll-back-page
  // handlers): resolve the right TranscriptSource and serve a SliceResult for ANY
  // harness, opencode included (the source layer hides the storage difference).
  // No anchor + 'before' = newest window; an anchor + 'before' pages older; 'after'
  // pages newer. Items carry cursors that interoperate with the live deltas.
  const readTranscript = async (
    msg: Extract<ControlMessage, { type: 'transcriptRead' }>,
  ): Promise<void> => {
    let res: SliceResult = { items: [], hasMore: false }
    try {
      const source = await sourceForRead(msg)
      res = await source.readSlice({
        ...(msg.anchor ? { anchor: msg.anchor } : {}),
        direction: msg.direction,
        limit: msg.limit,
      })
    } catch (err) {
      // A read failure (missing file/DB, decode error) must still answer the
      // server's pending request — reply with an empty page rather than hang it.
      console.warn(`[podium] transcript read failed for ${msg.sessionId}:`, err)
    }
    send({
      type: 'transcriptReadResult',
      requestId: msg.requestId,
      sessionId: msg.sessionId,
      items: res.items,
      ...(res.head ? { head: res.head } : {}),
      ...(res.tail ? { tail: res.tail } : {}),
      hasMore: res.hasMore,
    })
  }
  // Hook cwds are the agent's LIVE shell directory (they follow every `cd`), but
  // the server groups sessions by this value — forwarding raw cwds makes a session
  // vanish from its worktree the moment the agent cds into a subdirectory. The
  // tracker resolves each cwd to its git worktree root and forwards only genuine
  // worktree moves (EnterWorktree, cd into another checkout). Defined before
  // startHookIngest (whose onPayload feeds it) via the same `send` closure.
  const sessionCwdTracker = createSessionCwdTracker({
    resolver: createCwdResolver(),
    send: (sessionId, cwd) => send({ type: 'sessionCwd', sessionId, cwd }),
  })
  // `currentWs` is the live socket; `send()` always targets it, so frames keep flowing
  // to a new connection after a reconnect. Declared/defined ahead of startHookIngest
  // because the issue-relay hub captures `send` at construction, and the prime injector
  // (which startHookIngest's `respondTo` drives on hook events) is built from that hub —
  // so all three must exist before the ingest starts.
  let currentWs: WebSocket | undefined
  const send = (msg: DaemonMessage): void => {
    const w = currentWs
    if (!w || w.readyState !== WebSocket.OPEN) return
    // Mirror the server's safeSend: a send/encode throw (socket transitioning to
    // CLOSING between the check and the call, or an unencodable payload) must not
    // escape a handler and abort the rest of a burst (e.g. a reattach fan-out).
    try {
      w.send(encode(msg))
    } catch (err) {
      warnDroppedControlFrame(err, 'outbound')
    }
  }
  // Correlates daemon-initiated issue-relay requests (the loopback server originates
  // them) with the server's issueRelayResult. Built here in the startDaemon scope so
  // BOTH handleControlMessage (the result-dispatch case) and the loopback server can
  // reach the one hub; it captures `send` so requests ride the live WS.
  const issueRelayHub = createIssueRelayHub(send)
  // Injects the session's capability-scoped `prime` as additionalContext on the first
  // SessionStart/UserPromptSubmit after (re)start; re-arms on PreCompact. Driven by
  // startHookIngest's `respondTo`, so it must exist before the ingest starts.
  const primeInjector = createPrimeInjector((sessionId) =>
    issueRelayHub.relay({ sessionId, router: 'issues', proc: 'prime', input: {} }),
  )
  const ingest = await startHookIngest({
    ...(opts.hooks?.port !== undefined ? { port: opts.hooks.port } : {}),
    // Bounded, timeout-safe: injects the session's `prime` as additionalContext on the
    // first SessionStart/UserPromptSubmit (re-armed by PreCompact); null otherwise.
    respondTo: (sessionId, payload) => primeInjector.respondTo(sessionId, payload),
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
      // The agent's live working directory — follows EnterWorktree and `cd`. The
      // tracker resolves it to the containing worktree root and tells the server
      // only when THAT changes, so the sidebar re-groups on real worktree moves
      // but not on subdirectory cds within the same checkout.
      const hookCwd = fields?.cwd
      if (typeof hookCwd === 'string' && hookCwd) {
        void sessionCwdTracker.onHookCwd(sessionId, hookCwd)
      }
      void tracker.provider
        .translate(payload)
        .then((events) => applyAgentStateEvents(sessionId, events))
        .catch((err) => console.warn(`[podium] hook translate failed for ${sessionId}:`, err))
    },
  })
  // Reconnecting client: the daemon may start before the server (separate
  // processes / `After=` ordering) and must survive a server restart without
  // dropping its abduco attaches. `currentWs` (declared above alongside `send`) is
  // the live socket; these vars drive the backoff reconnect that re-points it.
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectBackoffMs = RECONNECT_MIN_MS
  let closing = false
  const bridges = new Map<string, AgentSession>()
  const reattachGate = createLimiter(REATTACH_CONCURRENCY)
  // The /proc memory walk AND the conversation discovery scan both run on the
  // worker thread so neither stalls the interactive daemon loop; stopped in
  // disposeAll(). The worker now owns discovery.db exclusively (no daemon-main
  // ConversationDiscoveryCache), so the every-15s scan never touches the loop.
  const workerClient = opts.workerClient ?? new DiscoveryWorkerClient()
  if (process.env.PODIUM_LOOP_PROFILE) {
    startLoopAttribution()
    startLoopMetrics({ label: 'daemon', onLongTick: reportLongTick })
  }
  const discoveryBackground = opts.discovery?.background ?? true
  const discoveryIntervalMs = opts.discovery?.scanIntervalMs ?? DEFAULT_DISCOVERY_SCAN_INTERVAL_MS
  let discoveryTimer: ReturnType<typeof setTimeout> | undefined
  // Coalesce overlapping scans: a 15s tick that fires while a worker job is still
  // in flight (or an on-demand scanRequest racing the timer) shares the one result.
  let discoveryInFlight: Promise<ConversationDelta> | undefined
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

  // Loopback HTTP endpoint an agent's `podium issue` CLI posts to. Its port is
  // injected into the agent env at spawn (Task 3); each request rides the hub
  // over the live WS and blocks until the server answers.
  const issueRelay = await startIssueRelayServer({
    ...(opts.issueRelay?.port !== undefined ? { port: opts.issueRelay.port } : {}),
    relay: async (req) => {
      // `session.setWorktree` is the agent-initiated worktree report (`podium
      // worktree <path>`). The daemon owns cwd truth, so it's handled here —
      // validated, resolved to its git toplevel, and sent as sessionCwd — never
      // forwarded to the server's capability relay (RELAY_ALLOWED would reject it).
      if (req.router === 'session' && req.proc === 'setWorktree') {
        const path = (req.input as { path?: unknown } | null | undefined)?.path
        if (typeof path !== 'string' || !path.startsWith('/')) {
          return { ok: false, error: 'path must be an absolute directory path' }
        }
        const st = await stat(path).catch(() => null)
        if (!st?.isDirectory()) return { ok: false, error: `no such directory: ${path}` }
        const worktree = await sessionCwdTracker.setExplicit(req.sessionId, path)
        return { ok: true, result: { worktree } }
      }
      return issueRelayHub.relay(req)
    },
  })

  // Coalesce + prioritize PTY frame relay (the per-frame stringify+send was the
  // dominant residual loop hitch). flush() sends one agentFrameBatch per session.
  const outputScheduler = new OutputScheduler({
    flush: (sessionId, frames) => send({ type: 'agentFrameBatch', sessionId, frames }),
  })

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
    pathHint?: string,
  ): Promise<void> => {
    if (!provider.bootEvents) return
    let events: AgentStateEvent[]
    try {
      events = await provider.bootEvents({
        cwd,
        ...(resumeValue ? { resumeValue } : {}),
        ...(pathHint ? { pathHint } : {}),
      })
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
  /** The reattach message's recorded-path evidence; spawns don't carry one. */
  const pathHintOf = (msg: SpawnControl | ReattachControl): string | undefined =>
    'pathHint' in msg ? msg.pathHint : undefined

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
      startCodexStateObserver(msg.sessionId, msg.cwd, msg.resume?.value, init.grokStartedAt)
    } else if (msg.agentKind === 'opencode') {
      startOpencodeStateObserver(msg.sessionId, msg.cwd, msg.resume?.value, init.grokStartedAt)
    } else if (msg.agentKind === 'cursor') {
      startCursorStateObserver(msg.sessionId, msg.cwd, msg.resume?.value, init.grokStartedAt)
      if (msg.resume) tailCursorTranscript(msg.sessionId, msg.cwd, msg.resume.value)
    } else if (msg.agentKind === 'claude-code') {
      // Ungated: start the tail even without a resume ref (discover the newest
      // file in the cwd bucket). A hook later re-points the tail if needed.
      // Reattach carries the server's recorded segment path — evidence beats
      // cwd derivation after a worktree move (conversation registry §3.3).
      startClaudeTranscriptTail(msg.sessionId, msg.cwd, msg.resume?.value, pathHintOf(msg))
    }
    if (provider?.bootEvents) {
      // const capture so the narrowing survives into the onFrame closure.
      const bootProvider = provider
      const seed = (): void => {
        void seedBootState(msg.sessionId, bootProvider, msg.cwd, msg.resume?.value, pathHintOf(msg))
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

  // Send the conversation delta. The common case every 15s is "nothing moved": an
  // all-empty delta produces NO broadcast at all, so an idle host doesn't fan a
  // pointless conversationsChanged frame out to every client every tick. (A genuinely
  // empty full snapshot — zero conversations on the host — is correctly skipped too.)
  const publishConversations = (delta: ConversationDelta): void => {
    if (delta.changed.length === 0 && delta.removed.length === 0 && delta.diagnostics.length === 0)
      return
    countWorker()
    timeTask(`publishConv(${delta.changed.length})`, () =>
      send({
        type: 'conversationsChanged',
        conversations: delta.changed,
        removed: delta.removed,
        diagnostics: delta.diagnostics,
      }),
    )
  }

  // Now that `publishConversations` + `workerClient` exist, wire the event-driven
  // active refresh declared near the tails. The paths-flush runs the SAME
  // `indexRefresh` worker job (off the interactive loop) scoped to the dirty files;
  // it shares kind `'indexRefresh'` with the periodic/full scans, so the worker
  // client may coalesce it onto an in-flight scan and return a superset — still a
  // correct upsert (see createActiveRefresh's note). Failures are loud, never silent.
  activeRefresh = createActiveRefresh({
    runPathsRefresh: (paths) =>
      workerClient.runJob('indexRefresh', {
        paths,
        ...(opts.discovery?.homeDir ? { homeDir: opts.discovery.homeDir } : {}),
        ...(opts.discovery?.cachePath ? { cachePath: opts.discovery.cachePath } : {}),
      }) as Promise<ConversationDelta>,
    publish: publishConversations,
    onError: (err) =>
      console.warn(
        `[podium:daemon] active index refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
  })

  // Run the discovery scan on the worker thread (off the interactive loop) and
  // return the delta. The worker owns discovery.db, so the scan's SQLite reads/
  // writes — the old ~800ms loop block — never touch the daemon's event loop.
  // A worker failure (crash, timeout) surfaces as an error diagnostic, never silent.
  //
  // `full: true` asks the worker for the ENTIRE conversation list (mapped into
  // `changed`), not just the cache-miss delta. Connect-time and on-demand scans use
  // it so a snapshot upserts everything — repopulating a cold/reset server index
  // even when the daemon's warm discovery.db cache reports nothing as "changed".
  // The periodic loop omits it and forwards only the delta.
  const runDiscoveryDelta = (full = false): Promise<ConversationDelta> => {
    if (discoveryInFlight) return discoveryInFlight
    discoveryInFlight = (async () => {
      try {
        return (await workerClient.runJob('indexRefresh', {
          ...(opts.discovery?.homeDir ? { homeDir: opts.discovery.homeDir } : {}),
          ...(opts.discovery?.cachePath ? { cachePath: opts.discovery.cachePath } : {}),
          ...(full ? { full: true } : {}),
        })) as ConversationDelta
      } catch (err) {
        return {
          changed: [],
          removed: [],
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

  // `full: true` (connect-time + on-demand) requests the entire conversation list so
  // the publish repopulates a cold server index; the periodic loop omits it (delta only).
  const refreshAndPublishConversations = async (full = false): Promise<ConversationDelta> => {
    const delta = await runDiscoveryDelta(full)
    publishConversations(delta)
    return delta
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

  const memoryBreakdown = async (requestId: string, roots: string[]): Promise<void> => {
    const memory = sampleHostMemory()
    const supported = process.platform === 'linux' // the walk needs /proc
    let agents: MemoryAttribution['agents'] = []
    let projects: MemoryAttribution['projects'] = []
    if (supported) {
      try {
        const result = (await workerClient.runJob('memoryBreakdown', {
          sessions: [...bridges.entries()].map(([sessionId, session]) => ({
            sessionId,
            label: `podium-${sessionId}`,
            pid: session.pid,
          })),
          roots,
          selfPid: process.pid,
        })) as MemoryAttribution
        agents = result.agents
        projects = result.projects
      } catch (err) {
        console.warn(
          `[podium:daemon] memoryBreakdown job failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
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
    session.onFrame((frame) => {
      countFrame(frame.data.length)
      outputScheduler.enqueue(sessionId, frame.data)
    })
    // Codex sets its OSC title to the cwd basename (+ a spinner glyph that churns at
    // frame-rate), which would clobber the real title the codex observer derives.
    // Every other harness sets a meaningful OSC title, so forward it for them.
    if (agentKind !== 'codex') {
      session.onTitle((title) => send({ type: 'title', sessionId, title }))
    }
    session.onExit((code) => {
      bridges.delete(sessionId)
      outputScheduler.remove(sessionId)
      trackers.delete(sessionId)
      sessionCwdTracker.clear(sessionId)
      primeInjector.reset(sessionId)
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
        ...(msg.initialPrompt ? { initialPrompt: msg.initialPrompt } : {}),
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
        env: {
          // Bind the loopback issue-relay + session id into every agent's env so its
          // `podium issue` CLI can reach the daemon for this exact session.
          ...issueRelayEnv(msg.sessionId, issueRelay.endpointFor(msg.sessionId)),
          // Subagent model rides as env — Claude Code reads it; harmless elsewhere.
          ...(msg.subagentModel ? { CLAUDE_CODE_SUBAGENT_MODEL: msg.subagentModel } : {}),
        },
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
    // On-demand (user-triggered) scan requests a FULL snapshot so a manual rescan can
    // recover a cold/reset server index — not just whatever moved since the last tick.
    // It runs on the worker + publishes to all clients; the requester additionally gets
    // a scanResult tagged with its requestId so its pending request resolves. Both carry
    // the (now full-list) changed + removed fields.
    const delta = await refreshAndPublishConversations(true)
    send({
      type: 'scanResult',
      requestId,
      conversations: delta.changed,
      removed: delta.removed,
      diagnostics: delta.diagnostics,
    })
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
      // Re-push agent state for the same reason we re-seed the transcript below: a
      // freshly restarted SERVER (the daemon survived) starts with NO agentState for
      // this session, and an idle survivor fires no hook to re-establish it — so it
      // would fall through the home board's `live → working` fallback and read as
      // WORKING. We still hold the live tracker, so resend its current phase. Skip
      // 'unknown' (nothing to assert) — a cold tracker is re-seeded by the fresh-bridge
      // branch below, not here.
      const tracker = trackers.get(msg.sessionId)
      if (tracker && tracker.state.phase !== 'unknown') {
        send({ type: 'agentState', sessionId: msg.sessionId, state: tracker.state })
      }
      // Re-seed the transcript even though we already hold the bridge: a freshly
      // restarted SERVER (the daemon survived) has an empty per-session buffer, and
      // this already-held branch otherwise does no transcript work, so chat would
      // stay blank. The live tail (if any) only re-emits on its NEXT file change, so
      // read the newest window now and push it as a reset delta. Best-effort; a read
      // failure just leaves the buffer to refill from live deltas.
      void (async () => {
        try {
          const source = await sourceForRead(msg)
          const res = await source.readSlice({ direction: 'before', limit: 2000 })
          if (res.items.length > 0) {
            send({
              type: 'transcriptDelta',
              sessionId: msg.sessionId,
              items: res.items,
              reset: true,
              ...(res.tail ? { tail: res.tail } : {}),
            })
          }
        } catch (err) {
          console.warn(`[podium] reattach re-seed failed for ${msg.sessionId}:`, err)
        }
      })()
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
    countControl()
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
    } catch (err) {
      // Drop the malformed control frame (don't wedge the loop) — but log it, never
      // silently, so protocol drift / poison frames are observable.
      warnDroppedControlFrame(err)
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
          outputScheduler.remove(msg.sessionId)
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
      case 'sessionPriority':
        outputScheduler.setPriority(msg.sessionId, msg.priority as Tier)
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
        void memoryBreakdown(msg.requestId, msg.roots)
        break
      case 'repoOpRequest':
        void runRepoOp(msg)
        break
      case 'issueRelayResult':
        issueRelayHub.onResult(msg)
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
      case 'transcriptRead':
        void readTranscript(msg)
        break
      case 'imageUploadRequest':
        void handleImageUpload(msg)
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
      case 'dirListRequest':
        void listDirSandboxed({ root: msg.root, path: msg.path })
          .then((r) => send({ type: 'dirListResult', requestId: msg.requestId, ...r }))
          .catch((err) =>
            send({
              type: 'dirListResult',
              requestId: msg.requestId,
              ok: false,
              path: msg.path,
              entries: [],
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
    const cmd = repoOpCommand(msg.op, msg.args ?? {})
    if ('error' in cmd) {
      send({ type: 'repoOpResult', requestId: msg.requestId, ok: false, output: cmd.error })
      return
    }
    try {
      const runArgs = cmd.bin === 'git' ? ['-C', msg.cwd, ...cmd.argv] : cmd.argv
      const opts =
        cmd.bin === 'git'
          ? { timeout: 120_000, maxBuffer: 1024 * 1024 }
          : { cwd: msg.cwd, timeout: 120_000, maxBuffer: 1024 * 1024 }
      const { stdout, stderr } = await execFileAsync(cmd.bin, runArgs, opts)
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
    activeRefresh?.stop()
    // discovery.db now lives entirely in the worker; stopping it terminates the
    // worker thread (and with it the cache's SQLite connection).
    workerClient.stop()
    outputScheduler.stop()
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
    issueRelayPort: issueRelay.port,
    async close(opts) {
      closing = true // stop the reconnect loop from resurrecting the socket
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      for (const id of [...tails.keys()]) stopTranscriptTail(id)
      await ingest.close()
      await issueRelay.close()
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
    // One-shot: if a stored token is rejected but a fresh pair code was supplied, drop the
    // token and re-pair on reconnect (the all-in-one → daemon switch leaves a token minted by
    // the local server that the remote has never seen). Guarded so a bad code can't loop.
    let pairFallbackTried = false
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
          // Run one FULL snapshot on the worker at connect (emits the entire current
          // conversation list, not just what moved), then settle into the periodic
          // delta loop. The full snapshot is required because the server index can be
          // COLD — a fresh server, or a reset/schema-migrated podium.db — while the
          // daemon's discovery.db cache is WARM (survives a daemon restart); a delta
          // off a warm cache would be empty and leave the cold index permanently bare.
          // The full scan still runs on the worker, so this never blocks the loop.
          void refreshAndPublishConversations(true)
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
    // Stop for good: the server refused us and reconnecting would just re-hammer it with the
    // same rejected handshake. Set `closing` so the `close` handler won't reschedule. The
    // `reject()` is usually a no-op (the start-grace already resolved the handle), so the log
    // line is the surfaced signal. Recovery needs operator action (a new code) + a restart.
    const stopNoReconnect = (type: string, reason: string, w: WebSocket): void => {
      console.error(
        `[podium:daemon] server rejected this daemon (${type}): ${reason}. ` +
          `Not reconnecting — re-pair the machine (new pair code) and restart the daemon.`,
      )
      closing = true
      disposeAll()
      reject(new Error(`daemon handshake rejected: ${reason}`))
      w.close()
    }
    function connect(): void {
      if (closing) return
      const w = new WebSocket(`${opts.serverUrl}/daemon?v=${WIRE_VERSION}`)
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
            w.on('message', handleControlMessage)
            break
          case 'helloOk':
            startBackground()
            w.on('message', handleControlMessage)
            break
          case 'helloRejected':
            // A stored token the server won't accept — revoked, OR (common right after an
            // all-in-one → daemon switch) a token minted by a DIFFERENT server. If the operator
            // supplied a fresh pair code, drop the stale token and re-pair on the next reconnect
            // rather than giving up. One-shot (`pairFallbackTried`) so a bad code can't loop.
            if (opts.pairCode && !pairFallbackTried) {
              pairFallbackTried = true
              identity.token = undefined // → sendHandshake() now sends `pair` with the code
              console.warn(
                `[podium:daemon] stored token rejected (${reply.reason}); re-pairing with the supplied code.`,
              )
              w.close() // the 'close' handler schedules a reconnect, which will pair
              break
            }
            stopNoReconnect(reply.type, reply.reason, w)
            break
          case 'pairRejected':
            // A bad/expired pair code: nothing to fall back to.
            stopNoReconnect(reply.type, reply.reason, w)
            break
        }
      })
      // NOTE: handleControlMessage is attached inside the handshake-reply cases above
      // (after startBackground), NOT here. Attaching it before the reply is consumed
      // meant the `once` handler flipped `authenticated` true synchronously, then this
      // persistent listener re-processed the SAME helloOk frame and logged it as a
      // malformed control frame. Attaching post-handshake means it only ever sees the
      // control frames the server sends after helloOk.
      // Server refused the upgrade with 426 = wire-protocol mismatch: our WIRE_VERSION
      // no longer matches the server's. Self-heal instead of hot-looping the same
      // rejected handshake forever:
      //   - installed binary → run `podium update` and read its exit code. Only a 10
      //                        (an update was actually pulled) → exit(0) so systemd
      //                        (Restart=always) relaunches into the new binary. Any
      //                        other code (0 already-current, 1 failed, null killed)
      //                        means no newer build exists, so give up loudly rather
      //                        than restart onto the same wire-incompatible binary.
      //   - source/dev run   → back off + reconnect (a `bun`-launched daemon can't
      //                        self-update; the mismatch is usually a mid-redeploy blip).
      // An installed run is: PODIUM_HOME set, or execPath is the `podium` binary itself.
      w.on('unexpected-response', (_req, res) => {
        if (res.statusCode !== 426) return
        const installed = !!process.env.PODIUM_HOME || /(?:^|[\\/])podium$/.test(process.execPath)
        const { action } = decideOnProtocolMismatch({ installed })
        if (action === 'self-update') {
          console.error(
            `[podium:daemon] server rejected this daemon: protocol mismatch (daemon v=${WIRE_VERSION}). Running \`podium update\`.`,
          )
          // spawnSync (not execFileSync) so a non-zero exit gives us `.status`
          // instead of throwing — we branch on that code.
          const r = spawnSync(process.execPath, ['update'], { stdio: 'inherit' })
          if (decidePostUpdate(r.status) === 'restart') {
            // Exit cleanly so systemd (Restart=always) relaunches into the newer
            // binary that matches the server's wire version.
            process.exit(0)
          }
          // No newer build available (or the update failed): restarting would just
          // land on the same wire-incompatible binary, so stop hot-looping.
          stopNoReconnect(
            'protocol-mismatch',
            `wire mismatch; no newer build available (podium update exit ${r.status}) — manual update required`,
            w,
          )
          return
        }
        // Source/dev run: log + let 'close' drive the backoff reconnect below.
        console.error(
          `[podium:daemon] server rejected this daemon: protocol mismatch (daemon v=${WIRE_VERSION}). Update the daemon to match the server.`,
        )
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
