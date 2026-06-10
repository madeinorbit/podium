import {
  type AgentConversationDiagnostic,
  type AgentConversationSummary,
  type AgentSession,
  agentLaunchCommand,
  attachTmuxAgent,
  type GitDiscoveryDiagnostic,
  type GitRepositorySummary,
  isTmuxAvailable,
  killTmuxServer,
  scanAgentConversations,
  scanGitRepositories,
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

export interface DaemonOptions {
  serverUrl: string
  /** Map an agent kind to a spawn command. Defaults to agentLaunchCommand; tests inject a fixture. */
  launch?: typeof agentLaunchCommand
  /** Force tmux on/off. Defaults to isTmuxAvailable(); tests set it for determinism. */
  tmux?: boolean
}

export interface DaemonHandle {
  close(): Promise<void>
}

type SpawnControl = Extract<ControlMessage, { type: 'spawn' }>

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
  const tmuxMode = opts.tmux ?? isTmuxAvailable()
  if (opts.tmux === undefined && !tmuxMode) {
    console.warn('[podium] tmux not found — sessions will not survive a daemon restart')
  }
  const ws = new WebSocket(`${opts.serverUrl}/daemon`)
  const bridges = new Map<string, AgentSession>()

  const send = (msg: DaemonMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encode(msg))
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
      const session = tmuxMode
        ? spawnTmuxAgent({
            label,
            cmd: cmd.cmd,
            args: cmd.args,
            cwd: cmd.cwd,
            cols: msg.geometry.cols,
            rows: msg.geometry.rows,
          })
        : spawnAgent({
            cmd: cmd.cmd,
            args: cmd.args,
            cwd: cmd.cwd,
            cols: msg.geometry.cols,
            rows: msg.geometry.rows,
          })
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
    try {
      const result = await scanAgentConversations()
      send({
        type: 'scanResult',
        requestId,
        conversations: result.conversations.map(summaryToWire),
        diagnostics: result.diagnostics.map(diagnosticToWire),
      })
    } catch (err) {
      send({
        type: 'scanResult',
        requestId,
        conversations: [],
        diagnostics: [
          { severity: 'error', message: err instanceof Error ? err.message : String(err) },
        ],
      })
    }
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
        if (!tmuxMode || !tmuxHasSession(msg.tmuxLabel)) {
          send({
            type: 'reattachFailed',
            sessionId: msg.sessionId,
            reason: tmuxMode ? 'tmux session not found' : 'tmux unavailable',
          })
          break
        }
        const session = attachTmuxAgent({
          label: msg.tmuxLabel,
          cols: msg.geometry.cols,
          rows: msg.geometry.rows,
        })
        wireBridge(msg.sessionId, session)
        send({
          type: 'bind',
          sessionId: msg.sessionId,
          cmd: `tmux -L ${msg.tmuxLabel} attach`,
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
          if (tmuxMode) killTmuxServer(`podium-${msg.sessionId}`)
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

  const disposeAll = (): void => {
    // For tmux sessions, dispose() only detaches the client, so the agent survives the
    // daemon going down — do NOT kill the servers here.
    for (const session of bridges.values()) session.dispose()
    bridges.clear()
  }

  const handle: DaemonHandle = {
    close() {
      return new Promise<void>((resolve) => {
        disposeAll()
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
    ws.once('open', () => resolve(handle))
    ws.once('error', (err) => {
      disposeAll()
      reject(err)
    })
  })
}
