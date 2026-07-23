import { spawnSync } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'

import {
  type AgentSession,
  agentLaunchCommand,
  isAbducoAvailable,
  isTmuxAvailable,
  killAbducoSession,
  killTmuxServer,
} from '@podium/agent-bridge'
import {
  type ControlMessage,
  type DaemonHandshake,
  type DaemonHandshakeReply,
  encode,
  parseControlMessage,
  parseDaemonHandshakeReply,
  WIRE_VERSION,
} from '@podium/protocol'
import {
  loadConfig,
  resolveAgentHomeDir,
  resolveAgentRelayPort,
  resolveHookPort,
  stateDir,
} from '@podium/runtime/config'
import { writeConnectivity } from '@podium/runtime/connectivity'
import {
  applyInstanceRuntimeEnv,
  durableSessionLabel,
  ensureInstanceStateIdentity,
  instanceStateDir,
  resolveInstanceId,
} from '@podium/runtime/instance'
import { startLoopMetrics } from '@podium/runtime/loop-metrics'
import { consumePairCode } from '@podium/runtime/setup'
import WebSocket, { type RawData } from 'ws'
import { createAgentRelayHub, startAgentRelayServer } from './agent-relay'
import { createBrowserOpenManager } from './browser-open'
import { ensurePodiumCodexHooks } from './codex-hooks'
import { CodexIdentityReceipts } from './codex-identity-receipts'
import { ComposerSyncEngine } from './composer-sync'
import type { DaemonContext, DurableBackend } from './control/context'
import { reportInventory, startInventoryRefresh } from './control/inventory'
import { dispatchControlMessage } from './control/registry'
import { createDiscoveryLoop, DEFAULT_DISCOVERY_SCAN_INTERVAL_MS } from './discovery-loop'
import { ensurePodiumGrokHooks } from './grok-hooks'
import { sweepHandoffStage } from './handoff-package'
import type { HeadlessTurnHandle } from './headless-drivers.js'
import { startHookIngest } from './hook-ingest'
import { sampleHostMemory } from './host-metrics'
import { loadIdentity, saveToken } from './identity'
import {
  beginControlTurn,
  reportLongTick,
  startLoopAttribution,
  timeTask,
} from './loop-attribution'
import { composeResponders, createAckReminderInjector, createMailInjector } from './mail-injector'
import { OutputScheduler } from './output-scheduler'
import { createPrimeInjector } from './prime-injector'
import { makeQuotaFetcher } from './quota-fetch'
import { decideOnProtocolMismatch, decidePostUpdate } from './self-update'
import { createSessionObservers } from './session-observers'
import { sweepUploads, UPLOADS_GC_INTERVAL_MS } from './session-uploads'
import { DiscoveryWorkerClient } from './worker-client'
import { createCwdResolver, createSessionCwdTracker } from './worktree-resolve'

export type { DurableBackend } from './control/context'
export { agentRelayEnv } from './control/session'
// Re-exported from their new module homes for the daemon's public surface
// (index.ts) and the unit tests that exercise them directly.
export { normalizeAgentKind } from './control/transcripts'

const DEFAULT_HOST_METRICS_INTERVAL_MS = 5_000

// A control frame this large is never legitimate — the biggest real payload (an image
// upload) is bounded well under this — but a multi-hundred-MB frame's synchronous
// toString()+JSON.parse would stall the daemon loop and back up the socket (audit P0-4).
// 64 MB leaves generous headroom over real uploads/pastes/file writes.
const MAX_CONTROL_FRAME_BYTES = 64 * 1024 * 1024

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
  /** Defaults to the selected instance state root/discovery.db. */
  cachePath?: string
  /** Test hook / isolated HOME for discovery. */
  homeDir?: string
  /** Background quick-scan interval. Defaults to 15s. */
  scanIntervalMs?: number
}

export interface DaemonOptions {
  serverUrl: string
  /**
   * Install the global codex native-hook instrumentation (hooks.json + trust
   * entries in the user's CODEX_HOME) at boot. Opt-IN so tests booting a daemon
   * can never write to the real ~/.codex; every production entrypoint sets it.
   */
  installCodexHooks?: boolean
  /**
   * Install global, env-gated Grok Build hooks in the user's GROK_HOME.
   * Opt-in for the same reason as Codex: tests must never mutate a real login.
   */
  installGrokHooks?: boolean
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
  /**
   * Called when the server TERMINALLY rejects this daemon (pairRejected / helloRejected
   * with no pair-code fallback) — re-pairing is required and reconnecting is pointless.
   * The CLI entrypoint exits with DAEMON_BLOCKED_EXIT_CODE here so the systemd unit
   * (RestartPreventExitStatus) stops crash-looping. Library embedders may ignore it.
   */
  onBlocked?: (info: { type: string; reason: string }) => void
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
  /** Agent-relay loopback server. Tests pass `port: 0` for an ephemeral port so
   *  parallel daemons don't contend for DEFAULT_AGENT_RELAY_PORT. */
  agentRelay?: { port?: number }
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
  /** Stable Codex hook socket. Defaults in the instance runtime dir on POSIX. */
  socketPath?: string
  /** Pending exact Codex bindings. Defaults in the instance runtime dir. */
  receiptDir?: string
}

/**
 * What to tell the operator when no durable backend is available. On Windows that is
 * the EXPECTED state (abduco/tmux are POSIX-only; sessions run on the ConPTY PTY
 * backend [spec:SP-7f2c]) — don't ask anyone to install tools that don't exist there.
 */
export function noDurableBackendWarning(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? '[podium] windows: sessions run on ConPTY without a durable host — they will not survive a daemon restart'
    : '[podium] neither abduco nor tmux found — sessions will not survive a daemon restart'
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
 * How many transcript-tail SEEDS (the first backfill read of a tailed JSONL) may
 * run at once. Deliberately narrower than the reattach gate: seeds are the heavy
 * part of a reattach burst (a multi-MB read + JSONL parse per session), while
 * bridge wiring is a cheap fork/exec — splitting the two keeps every session
 * typable within a couple of seconds of boot instead of queueing input behind
 * transcript work (POD-612).
 */
const TAIL_SEED_CONCURRENCY = 2

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

function createPriorityLimiter(
  max: number,
): <T>(priority: number, fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const queues: Array<Array<() => void>> = [[], [], [], []]
  const release = (): void => {
    active--
    for (const queue of queues) {
      const next = queue.shift()
      if (next) {
        // A completed seed resumes through a microtask. Cross a macrotask boundary
        // before the next allocation/parse unit so timers (including the systemd
        // watchdog pet) can run during a large reconnect burst. [spec:SP-c29e]
        // Reserve the released slot across the yield so a newly-arriving job
        // cannot start beside the queued continuation and exceed `max`.
        active++
        setTimeout(() => {
          active--
          next()
        }, 0)
        return
      }
    }
  }
  return <T>(priority: number, fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = (): void => {
        active++
        fn().then(resolve, reject).finally(release)
      }
      if (active < max) run()
      else (queues[priority] ?? queues[3]!).push(run)
    })
}

/**
 * The two gates a reattach burst runs through, split so bridge wiring is never
 * queued behind transcript work (POD-612):
 *
 * - `reattachGate` bounds the cheap-but-forking part (abduco/tmux existence check,
 *   attach-client spawn, wireBridge, bootEvents seed). Sessions become typable the
 *   moment their bridge is wired, so this fan-out must finish fast for ALL of them.
 * - `tailSeedGate` paces the heavy part (a tailed transcript's first backfill
 *   read/parse). It additionally waits for the reattach burst to SETTLE — every
 *   pending reattach's bridge wired — before letting the first seed run, so a
 *   boot with ~100 sessions wires them all before any multi-MB tail read starts.
 *
 * Pending is counted at reattachGate CALL time (queued + running), so a seed
 * created mid-burst waits for the whole burst's wiring, not just its own session's.
 */
export function createReattachGates(opts?: { reattachMax?: number; tailSeedMax?: number }): {
  reattachGate: <T>(fn: () => Promise<T>) => Promise<T>
  tailSeedGate: (fn: () => Promise<void>, priority?: number) => Promise<void>
} {
  const reattachLimit = createLimiter(opts?.reattachMax ?? REATTACH_CONCURRENCY)
  const tailSeedLimit = createPriorityLimiter(opts?.tailSeedMax ?? TAIL_SEED_CONCURRENCY)
  let reattachPending = 0
  const settledWaiters: Array<() => void> = []
  const reattachGate = <T>(fn: () => Promise<T>): Promise<T> => {
    reattachPending++
    return reattachLimit(fn).finally(() => {
      reattachPending--
      if (reattachPending === 0) for (const w of settledWaiters.splice(0)) w()
    })
  }
  const whenReattachSettled = (): Promise<void> =>
    reattachPending === 0 ? Promise.resolve() : new Promise((r) => settledWaiters.push(r))
  const tailSeedGate = (fn: () => Promise<void>, priority = 3): Promise<void> =>
    whenReattachSettled().then(() => tailSeedLimit(priority, fn))
  return { reattachGate, tailSeedGate }
}

export interface DaemonHandle {
  /** Where the hook ingest is actually listening (fixed port unless it was taken). */
  readonly hookPort: number
  /** Stable Codex hook endpoint; absent on Windows. */
  readonly hookSocketPath?: string
  /** Where the agent-relay loopback is actually listening (fixed port unless taken). */
  readonly agentRelayPort: number
  /**
   * Detach from all sessions and close the server connection. Durable sessions
   * (abduco/tmux) keep running — that's the feature. Pass `reapSessions: true` to
   * kill them instead (test harnesses / explicit full teardown only).
   */
  close(opts?: { reapSessions?: boolean }): Promise<void>
}

export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const instanceId = resolveInstanceId()
  ensureInstanceStateIdentity({ instanceId })
  applyInstanceRuntimeEnv(instanceId)
  const config = loadConfig()
  const launch = opts.launch ?? agentLaunchCommand
  const backend = resolveDurableBackend(opts, {
    abduco: isAbducoAvailable(),
    tmux: isTmuxAvailable(),
  })
  if (opts.backend === undefined && opts.tmux === undefined && backend === 'none') {
    console.warn(noDurableBackendWarning())
  }
  const settingsOverride = opts.hooks?.settingsDir
  const settingsDir = settingsOverride ?? join(stateDir(), 'hooks')
  // [spec:SP-15aa] These durable local endpoints belong to the selected
  // instance's runtime namespace, not the global home or the command relay.
  // An explicit settingsDir is also the isolation root for tests/embedders.
  const runtimeDir = settingsOverride ?? join(instanceStateDir(instanceId), 'runtime')
  const hookSocketPath =
    opts.hooks?.socketPath ??
    (process.platform === 'win32' ? undefined : join(runtimeDir, 'codex-hooks.sock'))
  const codexReceiptDir = opts.hooks?.receiptDir ?? join(runtimeDir, 'codex-identity-receipts')
  const codexIdentityReceipts = new CodexIdentityReceipts(codexReceiptDir)
  const homeDir = opts.discovery?.homeDir ?? resolveAgentHomeDir(config)

  // `currentWs` is the live socket; `send()` always targets it, so frames keep flowing
  // to a new connection after a reconnect. Everything below (observers, relay hub,
  // injectors, discovery loop) captures this one `send`.
  let currentWs: WebSocket | undefined
  const send: DaemonContext['send'] = (msg) => {
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

  // Draft Sync v2 (POD-859): read-only/inject composer engine. Publishes scraped
  // native drafts up to the server; injects chat drafts into the PTY (bytes are a
  // UTF-8 string of control chars + text; the bridge takes base64). Declared here so
  // the session observers can feed it agent-idle state.
  const bridges = new Map<string, AgentSession>()
  const composerEngine = new ComposerSyncEngine(
    (sessionId, text) => send({ type: 'nativeDraft', sessionId, text }),
    {
      writePty: (sessionId, bytes) =>
        bridges.get(sessionId)?.write(Buffer.from(bytes, 'utf8').toString('base64')),
      onDemote: (sessionId) =>
        console.warn(`[podium] draft-sync self-demoted to read-only for ${sessionId}`),
    },
  )

  // The /proc memory walk AND the conversation discovery scan both run on the
  // worker thread so neither stalls the interactive daemon loop; stopped in
  // disposeAll(). The worker owns discovery.db exclusively, so the every-15s
  // scan never touches the loop.
  const workerClient = opts.workerClient ?? new DiscoveryWorkerClient()
  if (process.env.PODIUM_LOOP_PROFILE) {
    startLoopAttribution()
    startLoopMetrics({ label: 'daemon', onLongTick: reportLongTick })
  }
  const discoveryLoop = createDiscoveryLoop({
    workerClient,
    send,
    homeDir,
    cachePath: opts.discovery?.cachePath,
    background: opts.discovery?.background ?? true,
    intervalMs: opts.discovery?.scanIntervalMs ?? DEFAULT_DISCOVERY_SCAN_INTERVAL_MS,
  })

  // Hook cwds are the agent's LIVE shell directory (they follow every `cd`), but
  // the server groups sessions by this value — forwarding raw cwds makes a session
  // vanish from its worktree the moment the agent cds into a subdirectory. The
  // tracker resolves each cwd to its git worktree root and forwards only genuine
  // worktree moves (EnterWorktree, cd into another checkout).
  const sessionCwdTracker = createSessionCwdTracker({
    resolver: createCwdResolver(),
    send: ({ sessionId, cwd, kind, branch, repoRoot, explicit }) =>
      send({
        type: 'sessionCwd',
        sessionId,
        cwd,
        kind,
        ...(branch ? { branch } : {}),
        ...(repoRoot ? { repoRoot } : {}),
        ...(explicit ? { explicit: true } : {}),
      }),
  })

  // Reattach fan-out gates (POD-612): wide gate for bridge wiring, narrow
  // burst-settled gate for transcript-tail seeds. Created before the observers
  // registry so tail seeds pace through it from the very first spawn/reattach.
  const gates = createReattachGates()

  // Agent state observation: harness hooks POST to the ingest; the provider
  // translates payloads into normalized events; the reducer folds them; changes
  // go to the server as `agentState`. The observers registry owns all of that
  // per-session state. Started before the WS so spawns can never race it.
  const observers = createSessionObservers({
    send,
    homeDir,
    onTranscriptDirty: (path) => discoveryLoop.markConversationDirty(path),
    cwdTracker: sessionCwdTracker,
    // Draft Sync v2 (POD-859): the composer engine only scrapes/injects while the
    // agent is idle — fed from the agent-state tracker's phase transitions.
    onIdleState: (sessionId, idle) => composerEngine.setIdle(sessionId, idle),
    onExactCodexBinding: async (sessionId, nativeId) => {
      if (!(await codexIdentityReceipts.record(sessionId, nativeId))) return
      // Replay sends ackRequested:true. If the socket is offline, the receipt
      // remains and the authentication path replays it after reconnect.
      await codexIdentityReceipts.replay(send)
    },
    tailSeedGate: gates.tailSeedGate,
  })

  // Correlates daemon-initiated agent-relay requests (the loopback server originates
  // them) with the server's agentRelayResult. Built here so BOTH the control registry
  // (the result-dispatch handler) and the loopback server reach the one hub; it
  // captures `send` so requests ride the live WS.
  const agentRelayHub = createAgentRelayHub(send)
  const browserOpen = createBrowserOpenManager(send, {
    // The session's harness adapter classifies its own known URLs (login vs
    // plain link) ahead of the generic redirect_uri fallback. [spec:SP-a43e]
    classify: (sessionId, url) => observers.adapterFor(sessionId)?.classifyBrowserOpen?.(url),
  })
  // Injects the session's capability-scoped `prime` as additionalContext on the first
  // SessionStart/UserPromptSubmit after (re)start; re-arms on PreCompact. Driven by
  // startHookIngest's `respondTo`, so it must exist before the ingest starts.
  const primeInjector = createPrimeInjector((sessionId) =>
    agentRelayHub.relay({ sessionId, router: 'issues', proc: 'prime', input: {} }),
  )
  // Blocks the Stop transition (decision:"block") when the session's issue has unread
  // mail, so the agent reads its inbox instead of going idle. Loop-guarded by
  // stop_hook_active and a per-session cooldown inside the injector.
  const mailInjector = createMailInjector((sessionId) =>
    agentRelayHub.relay({ sessionId, router: 'issues', proc: 'mailPending', input: {} }),
  )
  // Ack single-reminder (#237) [spec:SP-34d7 acks]: one block per delivered-but-
  // unacked message; the server persists reminded state so it never repeats.
  const ackReminder = createAckReminderInjector((sessionId) =>
    agentRelayHub.relay({ sessionId, router: 'messages', proc: 'pendingReminders', input: {} }),
  )
  const respondTo = composeResponders(
    (sessionId, payload) => primeInjector.respondTo(sessionId, payload),
    (sessionId, payload) => mailInjector.respondTo(sessionId, payload),
    (sessionId, payload) => ackReminder.respondTo(sessionId, payload),
  )
  const ingest = await startHookIngest({
    port: opts.hooks?.port ?? resolveHookPort(config),
    ...(hookSocketPath ? { socketPath: hookSocketPath } : {}),
    // Bounded, timeout-safe: prime injection first (SessionStart/UserPromptSubmit),
    // then mail delivery at Stop; first non-null wins.
    respondTo,
    onPayload: (sessionId, payload) => observers.onHookPayload(sessionId, payload),
  })
  // Install/refresh the global codex hook instrumentation once per boot —
  // idempotent, preserves foreign hooks, and skips when codex isn't present.
  // Best-effort: codex sessions degrade to the rollout observer without it.
  if (opts.installCodexHooks) {
    void ensurePodiumCodexHooks({
      ...(homeDir ? { homeDir } : {}),
    })
      .then((r) => {
        if (r.changed) console.log('[podium] codex hooks installed/refreshed')
      })
      .catch((err) => console.warn('[podium] codex hooks install failed:', err))
  }
  // Grok Build personal hooks need no project trust. The dedicated file is
  // env-gated per Podium session and the existing file observer is the fallback.
  if (opts.installGrokHooks) {
    void ensurePodiumGrokHooks({
      ...(homeDir ? { homeDir } : {}),
    })
      .then((r) => {
        if (r.changed) console.log('[podium] grok hooks installed/refreshed')
      })
      .catch((err) => console.warn('[podium] grok hooks install failed:', err))
  }

  // Loopback HTTP endpoint an agent's `podium` CLI posts to. Its port is
  // injected into the agent env at spawn; each request rides the hub over the
  // live WS and blocks until the server answers.
  const agentRelay = await startAgentRelayServer({
    port: opts.agentRelay?.port ?? resolveAgentRelayPort(config),
    openUrl: (sessionId, url) => browserOpen.capture(sessionId, url),
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
      return agentRelayHub.relay(req)
    },
  })

  // Coalesce + prioritize PTY frame relay (the per-frame stringify+send was the
  // dominant residual loop hitch). flush() sends one agentFrameBatch per session.
  const outputScheduler = new OutputScheduler({
    flush: (sessionId, frames) => send({ type: 'agentFrameBatch', sessionId, frames }),
  })

  const metricsBackground = opts.metrics?.background ?? true
  const metricsIntervalMs = opts.metrics?.intervalMs ?? DEFAULT_HOST_METRICS_INTERVAL_MS
  let metricsTimer: ReturnType<typeof setInterval> | undefined
  let uploadsGcTimer: ReturnType<typeof setInterval> | undefined
  let stopInventoryRefresh: (() => void) | undefined
  const pushHostMetrics = (): void => {
    send({
      type: 'hostMetrics',
      hostname: hostname(),
      sampledAt: new Date().toISOString(),
      memory: sampleHostMemory(),
    })
  }

  const identity = loadIdentity(opts.identityDir ? { dir: opts.identityDir } : {})
  // The bundled local daemon overrides this with the server's stable local id so it
  // attaches to the machine the server already adopted; remote daemons use the identity.
  const machineId = opts.machineId ?? identity.machineId

  // THE explicit handler context (#195): every control-frame handler receives
  // this object instead of closing over startDaemon's scope.
  const ctx: DaemonContext = {
    send,
    machineId,
    instanceId,
    durableLabels: new Map<string, string>(),
    durableLabelFor: (sessionId) => durableSessionLabel(sessionId, instanceId),
    backend,
    launch,
    settingsDir,
    homeDir,
    bridges,
    composerEngine,
    outputScheduler,
    observers,
    sessionCwdTracker,
    primeInjector,
    reattachGate: gates.reattachGate,
    tailSeedGate: gates.tailSeedGate,
    runningHeadlessTurns: new Map<string, HeadlessTurnHandle>(),
    hookSocketPath,
    codexReceiptDir,
    codexIdentityReceipts,
    hookEndpointFor: (sessionId) => ingest.endpointFor(sessionId),
    agentRelayEndpointFor: (sessionId) => agentRelay.endpointFor(sessionId),
    agentRelayHub,
    browserOpen,
    workerClient,
    refreshAndPublishConversations: (full) => discoveryLoop.refreshAndPublishConversations(full),
    // Per-agent plan-quota reader (live, read-only, TTL-cached). Same homeDir
    // override the discovery scans use, so tests can point it at a fixture home.
    quotaFetcher: makeQuotaFetcher({ ...(homeDir ? { homeDir } : {}) }),
    usageMemo: {},
  }

  // The control loop only runs after the handshake reply resolves the daemon (see the
  // connect Promise below): startBackground() flips `authenticated` true. Until then the
  // first inbound frame is the handshake reply, handled separately by the permanent
  // message listener's pre-auth branch. Each (re)connect resets this so every socket
  // re-authenticates.
  let authenticated = false

  const handleControlMessage = (raw: RawData): void => {
    if (!authenticated) return // pre-auth frames belong to the handshake handler
    const finishControlTurn = beginControlTurn()
    // Drop absurdly large frames before materializing/parsing them (audit P0-4): a
    // multi-hundred-MB frame's synchronous toString()+JSON.parse would stall the loop
    // and back up the socket Recv-Q — the wedge shape. The cap is generous so it never
    // touches legitimate big payloads (image uploads, large pastes, file writes).
    if (controlFrameByteLength(raw) > MAX_CONTROL_FRAME_BYTES) {
      finishControlTurn('<oversized>')
      console.warn('[podium:daemon] dropping oversized control frame')
      return
    }
    let msg: ControlMessage
    try {
      // The toString+parse of a large frame is a known synchronous loop cost
      // (the big-paste wedge shape) — time it separately from the handler.
      msg = timeTask('controlParse', () => parseControlMessage(raw.toString()))
    } catch (err) {
      finishControlTurn('<invalid>')
      // Drop the malformed control frame (don't wedge the loop) — but log it, never
      // silently, so protocol drift / poison frames are observable.
      warnDroppedControlFrame(err)
      return
    }
    try {
      timeTask(`controlDispatch(${msg.type})`, () => dispatchControlMessage(ctx, msg))
    } finally {
      finishControlTurn(msg.type)
    }
  }

  // Reconnecting client: the daemon may start before the server (separate
  // processes / `After=` ordering) and must survive a server restart without
  // dropping its abduco attaches. These vars drive the backoff reconnect that
  // re-points `currentWs`.
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectBackoffMs = RECONNECT_MIN_MS
  let closing = false

  const disposeAll = (reapSessions = false): void => {
    discoveryLoop.stop()
    if (metricsTimer) clearInterval(metricsTimer)
    if (uploadsGcTimer) clearInterval(uploadsGcTimer)
    stopInventoryRefresh?.()
    stopInventoryRefresh = undefined
    // discovery.db lives entirely in the worker; stopping it terminates the
    // worker thread (and with it the cache's SQLite connection).
    workerClient.stop()
    outputScheduler.stop()
    // For durable sessions (abduco/tmux), dispose() only takes down the attach client,
    // so the agent survives the daemon going down — do NOT kill the masters here
    // unless the caller explicitly asked for a full reap (test harness teardown).
    for (const [sessionId, session] of ctx.bridges) {
      session.dispose()
      if (reapSessions && backend !== 'none') {
        const durableLabel = ctx.durableLabels.get(sessionId) ?? ctx.durableLabelFor(sessionId)
        killAbducoSession(durableLabel)
        killTmuxServer(durableLabel)
      }
    }
    ctx.bridges.clear()
    ctx.durableLabels.clear()
    for (const turn of ctx.runningHeadlessTurns.values()) {
      if (reapSessions) turn.interrupt()
      else turn.dispose?.()
    }
    ctx.runningHeadlessTurns.clear()
    observers.disposeObservers()
    composerEngine.disposeAll()
  }

  const handle: DaemonHandle = {
    hookPort: ingest.port,
    ...(ingest.socketPath ? { hookSocketPath: ingest.socketPath } : {}),
    agentRelayPort: agentRelay.port,
    async close(closeOpts) {
      closing = true // stop the reconnect loop from resurrecting the socket
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      observers.stopAllTails()
      await ingest.close()
      await agentRelay.close()
      return new Promise<void>((resolve) => {
        disposeAll(closeOpts?.reapSessions ?? false)
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

  // Connectivity truthfulness (#19): a REMOTE daemon (pair-code / stored-token auth)
  // records its server-link state next to daemon.json so `podium status` reports actual
  // connectivity instead of inferring "up" from the PID alone. The bundled LOCAL daemon
  // (bootstrapToken) skips this — its link is localhost/in-process, and tests boot it
  // without an isolated state dir. Best-effort: a write failure never affects the link.
  const connectivityDir = opts.bootstrapToken ? undefined : (opts.identityDir ?? stateDir())
  const recordConnectivity = (
    patch: Omit<Parameters<typeof writeConnectivity>[0], 'serverUrl'>,
  ): void => {
    if (!connectivityDir) return
    try {
      writeConnectivity({ serverUrl: opts.serverUrl, ...patch }, connectivityDir)
    } catch (err) {
      console.warn('[podium:daemon] could not write connectivity status:', err)
    }
  }

  return new Promise<DaemonHandle>((resolve, reject) => {
    let resolved = false
    let kickedOff = false
    // Last socket error message, for the connectivity file's `lastError` (#19).
    let lastSocketError: string | undefined
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
    // re-sends reattach for live sessions on every (re)connect; the reattach handler is
    // idempotent.
    const startBackground = (): void => {
      authenticated = true
      recordConnectivity({ state: 'connected', lastHelloOkAt: new Date().toISOString() })
      if (!kickedOff) {
        kickedOff = true
        discoveryLoop.start()
        if (metricsBackground) {
          pushHostMetrics() // first sample immediately — the UI shouldn't wait a full interval
          metricsTimer = setInterval(pushHostMetrics, metricsIntervalMs)
          metricsTimer.unref?.()
        }
        // Periodic GC for stale uploads (TTL 24h, runs hourly).
        uploadsGcTimer = setInterval(sweepUploads, UPLOADS_GC_INTERVAL_MS)
        uploadsGcTimer.unref?.()
        stopInventoryRefresh = startInventoryRefresh(ctx)
        // Reclaim handoff packages abandoned by a failed transfer/import
        // ([POD-742]). Once, here: no transfer can be in flight through a daemon
        // that has only just handshaked, and exports sweep from then on.
        void sweepHandoffStage({ ...(homeDir ? { homeDir } : {}) }).catch(() => undefined)
      }
      // Machine inventory (#222): fire an unsolicited report after every successful
      // auth (paired AND every reconnect's helloOk) — off the handshake path, so a
      // hung CLI probe can never stall the first frame.
      void reportInventory(ctx)
      // At-least-once recovery: send every exact native binding still awaiting
      // a server persistence acknowledgement after each successful reconnect.
      void codexIdentityReceipts
        .replay(send)
        .catch((err) => console.warn('[podium] Codex identity receipt replay failed:', err))
      // Open requests captured during a transport outage are replayed after auth;
      // the server deduplicates them by session/request id. [spec:SP-a43e]
      browserOpen.replay()
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
      // Terminal blocked marker (#19): `podium status` reads this to explain WHY the
      // daemon is down and what to do, instead of a bare "down".
      recordConnectivity({ state: 'blocked', blockedReason: `${type}: ${reason}` })
      closing = true
      disposeAll()
      // A terminally-blocked daemon must not keep its loopback servers holding the
      // process (and a test's event loop) alive — handle.close() will never run.
      void ingest.close().catch(() => {})
      void agentRelay.close().catch(() => {})
      reject(new Error(`daemon handshake rejected: ${reason}`))
      w.close()
      // Give the CLI entrypoint its exit hook (distinct exit code → the systemd unit's
      // RestartPreventExitStatus stops the crash-loop). After the marker is on disk.
      opts.onBlocked?.({ type, reason })
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
      // The FIRST inbound frame is the handshake reply. Use ONE permanent listener and
      // branch on authenticated state instead of registering a second listener from inside
      // the handshake callback: ws/Bun can dispatch a listener added during the same emit,
      // which makes helloOk reach the control parser and can drop the next daemon request.
      const handleHandshakeReply = (raw: RawData): void => {
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
            // Keep the live identity in sync too: a transport/server restart before this
            // daemon process restarts must authenticate with the new token, not retry the
            // now-consumed pair code.
            identity.token = reply.token
            saveToken(reply.token, opts.identityDir ? { dir: opts.identityDir } : {})
            // The one-shot pair code is now consumed — drop it from config.json (#19) so
            // the config stops looking "unpaired" (guarded on the exact code inside).
            if (opts.pairCode) {
              try {
                consumePairCode(opts.pairCode)
              } catch (err) {
                console.warn('[podium:daemon] could not clear consumed pair code:', err)
              }
            }
            startBackground()
            break
          case 'helloOk':
            startBackground()
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
      }
      w.on('message', (raw: RawData) => {
        if (!authenticated) {
          handleHandshakeReply(raw)
          return
        }
        handleControlMessage(raw)
      })
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
      //
      // `unexpected-response` is a Node-`ws` event; Bun's WebSocket doesn't implement it, so
      // registering it under Bun does nothing except print `[bun] Warning: ws.WebSocket
      // 'unexpected-response' event is not implemented in bun` on every connect. The shipped
      // daemon runs under Bun, so only register it on Node — where it actually fires. Under Bun a
      // 426 surfaces as 'error'→'close' and drives the backoff reconnect below (the wire-mismatch
      // self-heal via `podium update` is not yet wired for Bun — tracked in #106).
      if (!process.versions.bun) {
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
      }
      // A dropped/refused connection (server restart, or not up yet) must NOT tear
      // down running agents — keep the abduco attaches + transcript tails alive and
      // just reconnect (re-authenticating). Only an explicit handle.close() disposes.
      // ('error' is followed by 'close', which drives the backoff reconnect.)
      w.on('close', () => {
        if (currentWs === w) currentWs = undefined
        // Don't clobber a terminal `blocked` marker (or write during a clean shutdown) —
        // only a live daemon that intends to retry reports `disconnected`.
        if (!closing) {
          recordConnectivity({
            state: 'disconnected',
            retryBackoffMs: reconnectBackoffMs,
            ...(lastSocketError ? { lastError: lastSocketError } : {}),
          })
        }
        scheduleReconnect()
      })
      w.on('error', (err) => {
        // Swallow: 'close' handles reconnect, and an unhandled 'error' would crash.
        // Remember the reason so the connectivity file can explain the disconnect.
        lastSocketError = err instanceof Error ? err.message : String(err)
      })
    }
    // Don't hang the entrypoint if the server isn't up yet — resolve after a grace
    // window; the daemon keeps retrying in the background and authenticates on real open.
    const startGrace = setTimeout(resolveStart, 10_000)
    startGrace.unref?.()
    connect()
  })
}
