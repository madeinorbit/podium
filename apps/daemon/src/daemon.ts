import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

import {
  type AgentConversationDiagnostic,
  type AgentConversationSummary,
  type AgentRuntimeState,
  type AgentSession,
  type AgentStateProvider,
  abducoHasSession,
  agentLaunchCommand,
  agentStateProviderFor,
  attachAbducoAgent,
  attachTmuxAgent,
  ConversationDiscoveryCache,
  claudeProjectSlug,
  compareConversationSummaries,
  type GitDiscoveryDiagnostic,
  type GitRepositorySummary,
  initialAgentState,
  isAbducoAvailable,
  isTmuxAvailable,
  killAbducoSession,
  killTmuxServer,
  reduceAgentState,
  scanAgentConversationsCached,
  scanGitRepositories,
  spawnAbducoAgent,
  spawnAgent,
  spawnTmuxAgent,
  type TranscriptTailer,
  tailTranscript,
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
import { startHookIngest } from './hook-ingest'
import { sampleHostMemory } from './host-metrics'
import { attributeMemory, snapshotProcesses } from './memory-breakdown'
import { scanClaudeUsage } from './usage-scan'

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
  // Live structured-transcript tails, keyed by Podium session id. Registered
  // from hook payloads (the only place the harness tells us its transcript
  // path) and eagerly for resumes, where the resumed file is derivable.
  const tails = new Map<string, TranscriptTailer>()
  const ensureTranscriptTail = (sessionId: string, path: string): void => {
    const existing = tails.get(sessionId)
    if (existing?.path === path) return
    existing?.stop()
    tails.set(
      sessionId,
      tailTranscript(path, (items, reset) => {
        if (items.length === 0 && !reset) return
        send({ type: 'transcriptAppend', sessionId, items, ...(reset ? { reset } : {}) })
      }),
    )
  }
  const stopTranscriptTail = (sessionId: string): void => {
    tails.get(sessionId)?.stop()
    tails.delete(sessionId)
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
        .then((events) => {
          for (const event of events) {
            const next = reduceAgentState(tracker.state, event, new Date().toISOString())
            if (next === tracker.state) continue
            tracker.state = next
            send({ type: 'agentState', sessionId, state: next })
          }
        })
        .catch((err) => console.warn(`[podium] hook translate failed for ${sessionId}:`, err))
    },
  })
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

  const wireBridge = (sessionId: string, session: AgentSession): void => {
    bridges.set(sessionId, session)
    session.onFrame((frame) =>
      send({ type: 'agentFrame', sessionId, seq: frame.seq, data: frame.data }),
    )
    session.onTitle((title) => send({ type: 'title', sessionId, title }))
    session.onExit((code) => {
      bridges.delete(sessionId)
      trackers.delete(sessionId)
      // The agent's gone — stop polling its (now frozen) transcript file.
      stopTranscriptTail(sessionId)
      send({ type: 'agentExit', sessionId, code })
    })
  }

  const spawn = (msg: SpawnControl): void => {
    try {
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
        trackers.set(msg.sessionId, {
          provider,
          state: initialAgentState(new Date().toISOString()),
        })
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
      wireBridge(msg.sessionId, session)
      // Resumes: the resumed transcript is derivable right away, so the chat
      // view has history before the first hook fires. The first hook payload
      // re-points the tail at the live file (resume rolls into a fresh one).
      if (msg.agentKind === 'claude-code' && msg.resume) {
        ensureTranscriptTail(
          msg.sessionId,
          join(
            homedir(),
            '.claude',
            'projects',
            claudeProjectSlug(msg.cwd),
            `${msg.resume.value}.jsonl`,
          ),
        )
      }
      // Seed the state once the CLI is actually up (first PTY frame). Claude Code
      // emits no SessionStart hook at interactive boot, so without this the phase
      // sits at 'unknown' until the first prompt. Resumes classify the resumed
      // transcript for a rich verdict. Real hook events always win: every reduce
      // below is guarded on the phase still being 'unknown'.
      if (provider?.bootEvents) {
        const bootEvents = provider.bootEvents.bind(provider)
        const offFirstFrame = session.onFrame(() => {
          offFirstFrame()
          void bootEvents({
            cwd: msg.cwd,
            ...(msg.resume ? { resumeValue: msg.resume.value } : {}),
          })
            .then((events) => {
              const tracker = trackers.get(msg.sessionId)
              if (!tracker) return
              for (const event of events) {
                if (tracker.state.phase !== 'unknown') return
                const next = reduceAgentState(tracker.state, event, new Date().toISOString())
                if (next === tracker.state) continue
                tracker.state = next
                send({ type: 'agentState', sessionId: msg.sessionId, state: next })
              }
            })
            .catch(() => {}) // boot probe is best-effort; hooks remain authoritative
        })
      }
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
        // The settings file from the original spawn still points at our fixed
        // port, so a reattached agent keeps reporting — re-arm the tracker.
        const provider = agentStateProviderFor(msg.agentKind)
        if (provider) {
          trackers.set(msg.sessionId, {
            provider,
            state: initialAgentState(new Date().toISOString()),
          })
        }
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
        trackers.delete(msg.sessionId)
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
        // label isn't theirs.
        if (backend !== 'none') {
          killAbducoSession(`podium-${msg.sessionId}`)
          killTmuxServer(`podium-${msg.sessionId}`)
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
    }
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

  /** One-shot `claude -p` / `codex exec` for the harness-backed superagent. */
  const runHarnessExec = async (
    msg: Extract<ControlMessage, { type: 'harnessExecRequest' }>,
  ): Promise<void> => {
    const cmd = msg.agent === 'claude-code' ? 'claude' : 'codex'
    const args =
      msg.agent === 'claude-code'
        ? ['-p', msg.prompt, ...(msg.model ? ['--model', msg.model] : [])]
        : [
            'exec',
            '--skip-git-repo-check',
            ...(msg.model ? ['--model', msg.model] : []),
            msg.prompt,
          ]
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
    }
  }

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
    trackers.clear()
  }

  const handle: DaemonHandle = {
    hookPort: ingest.port,
    async close(opts) {
      for (const id of [...tails.keys()]) stopTranscriptTail(id)
      await ingest.close()
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
