import { hostname } from 'node:os'
import {
  type AgentConversationDiagnostic,
  type AgentConversationSummary,
  type AgentSession,
  abducoHasSession,
  agentLaunchCommand,
  attachAbducoAgent,
  attachTmuxAgent,
  ConversationDiscoveryCache,
  compareConversationSummaries,
  type GitDiscoveryDiagnostic,
  type GitRepositorySummary,
  isAbducoAvailable,
  isTmuxAvailable,
  killAbducoSession,
  killTmuxServer,
  scanAgentConversationsCached,
  scanGitRepositories,
  spawnAbducoAgent,
  spawnAgent,
  spawnTmuxAgent,
  tmuxHasSession,
} from '@podium/agent-bridge'
import {
  type ControlMessage,
  type ConversationDiagnosticWire,
  type ConversationSummaryWire,
  type DaemonMessage,
  encode,
  type GitDiscoveryDiagnosticWire,
  type GitRepositoryWire,
  parseControlMessage,
} from '@podium/protocol'
import WebSocket, { type RawData } from 'ws'
import { sampleHostMemory } from './host-metrics'

const DEFAULT_DISCOVERY_SCAN_INTERVAL_MS = 15_000
const DEFAULT_HOST_METRICS_INTERVAL_MS = 5_000

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
}

export interface DaemonMetricsOptions {
  /** Disable the periodic hostMetrics push entirely. */
  background?: boolean
  /** Sample/push cadence. Defaults to 5s. */
  intervalMs?: number
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

export interface DaemonHandle {
  /**
   * Detach from all sessions and close the server connection. Durable sessions
   * (abduco/tmux) keep running — that's the feature. Pass `reapSessions: true` to
   * kill them instead (test harnesses / explicit full teardown only).
   */
  close(opts?: { reapSessions?: boolean }): Promise<void>
}

type SpawnControl = Extract<ControlMessage, { type: 'spawn' }>
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

export function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
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
  const ws = new WebSocket(`${opts.serverUrl}/daemon`)
  const bridges = new Map<string, AgentSession>()
  const discoveryCache = new ConversationDiscoveryCache(opts.discovery?.cachePath)
  const discoveryBackground = opts.discovery?.background ?? true
  const discoveryIntervalMs = opts.discovery?.scanIntervalMs ?? DEFAULT_DISCOVERY_SCAN_INTERVAL_MS
  let discoveryTimer: ReturnType<typeof setTimeout> | undefined
  let discoveryInFlight: Promise<ConversationWireResult> | undefined
  let lastConversationPush = ''
  const metricsBackground = opts.metrics?.background ?? true
  const metricsIntervalMs = opts.metrics?.intervalMs ?? DEFAULT_HOST_METRICS_INTERVAL_MS
  let metricsTimer: ReturnType<typeof setInterval> | undefined

  const send = (msg: DaemonMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encode(msg))
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

  const wireBridge = (sessionId: string, session: AgentSession): void => {
    bridges.set(sessionId, session)
    session.onFrame((frame) =>
      send({ type: 'agentFrame', sessionId, seq: frame.seq, data: frame.data }),
    )
    session.onTitle((title) => send({ type: 'title', sessionId, title }))
    session.onExit((code) => {
      bridges.delete(sessionId)
      send({ type: 'agentExit', sessionId, code })
    })
  }

  const spawn = (msg: SpawnControl): void => {
    try {
      const cmd = launch(msg.agentKind, {
        cwd: msg.cwd,
        ...(msg.resume ? { resume: msg.resume } : {}),
      })
      const label = `podium-${msg.sessionId}`
      const spawnOpts = {
        label,
        cmd: cmd.cmd,
        args: cmd.args,
        cwd: cmd.cwd,
        cols: msg.geometry.cols,
        rows: msg.geometry.rows,
      }
      const session =
        backend === 'abduco'
          ? spawnAbducoAgent(spawnOpts)
          : backend === 'tmux'
            ? spawnTmuxAgent(spawnOpts)
            : spawnAgent(spawnOpts)
      wireBridge(msg.sessionId, session)
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

  ws.on('message', (raw: RawData) => {
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
      case 'reattach': {
        // Backend-agnostic: try whichever durable host owns the label, so sessions
        // created under tmux before an abduco upgrade still reattach (no flag day).
        const attach = { label: msg.durableLabel, cols: msg.geometry.cols, rows: msg.geometry.rows }
        const found =
          backend !== 'none' && abducoHasSession(msg.durableLabel)
            ? { session: attachAbducoAgent(attach), cmd: `abduco -a ${msg.durableLabel}` }
            : backend !== 'none' && tmuxHasSession(msg.durableLabel)
              ? { session: attachTmuxAgent(attach), cmd: `tmux -L ${msg.durableLabel} attach` }
              : undefined
        if (!found) {
          send({
            type: 'reattachFailed',
            sessionId: msg.sessionId,
            reason: backend === 'none' ? 'durable backend unavailable' : 'session not found',
          })
          break
        }
        wireBridge(msg.sessionId, found.session)
        send({
          type: 'bind',
          sessionId: msg.sessionId,
          cmd: found.cmd,
          cwd: msg.cwd,
          agentKind: msg.agentKind,
          geometry: msg.geometry,
        })
        break
      }
      case 'kill': {
        const session = bridges.get(msg.sessionId)
        if (session) {
          session.dispose()
          bridges.delete(msg.sessionId)
          if (backend !== 'none') {
            // Both reapers are cheap no-ops when the label isn't theirs.
            killAbducoSession(`podium-${msg.sessionId}`)
            killTmuxServer(`podium-${msg.sessionId}`)
          }
        }
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
    }
  })

  const disposeAll = (reapSessions = false): void => {
    if (discoveryTimer) clearTimeout(discoveryTimer)
    if (metricsTimer) clearInterval(metricsTimer)
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
  }

  const handle: DaemonHandle = {
    close(opts) {
      return new Promise<void>((resolve) => {
        disposeAll(opts?.reapSessions ?? false)
        if (ws.readyState === WebSocket.CLOSED) {
          resolve()
          return
        }
        ws.once('close', () => resolve())
        ws.close()
      })
    },
  }

  return new Promise<DaemonHandle>((resolve, reject) => {
    ws.once('open', () => {
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
      resolve(handle)
    })
    ws.once('error', (err) => {
      disposeAll()
      reject(err)
    })
  })
}
