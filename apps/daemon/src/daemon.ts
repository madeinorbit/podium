import {
  type AgentConversationDiagnostic,
  type AgentConversationSummary,
  type AgentSession,
  agentLaunchCommand,
  scanAgentConversations,
  spawnAgent,
} from '@podium/agent-bridge'
import {
  type ControlMessage,
  type ConversationDiagnosticWire,
  type ConversationSummaryWire,
  type DaemonMessage,
  encode,
  parseControlMessage,
} from '@podium/protocol'
import WebSocket, { type RawData } from 'ws'

export interface DaemonOptions {
  serverUrl: string
  /** Map an agent kind to a spawn command. Defaults to agentLaunchCommand; tests inject a fixture. */
  launch?: typeof agentLaunchCommand
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

export function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const launch = opts.launch ?? agentLaunchCommand
  const ws = new WebSocket(`${opts.serverUrl}/daemon`)
  const bridges = new Map<string, AgentSession>()

  const send = (msg: DaemonMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encode(msg))
  }

  const spawn = (msg: SpawnControl): void => {
    try {
      const cmd = launch(msg.agentKind, {
        cwd: msg.cwd,
        ...(msg.resume ? { resume: msg.resume } : {}),
      })
      const session = spawnAgent({
        cmd: cmd.cmd,
        args: cmd.args,
        cwd: cmd.cwd,
        cols: msg.geometry.cols,
        rows: msg.geometry.rows,
      })
      bridges.set(msg.sessionId, session)
      session.onFrame((frame) =>
        send({ type: 'agentFrame', sessionId: msg.sessionId, seq: frame.seq, data: frame.data }),
      )
      session.onExit((code) => {
        bridges.delete(msg.sessionId)
        send({ type: 'agentExit', sessionId: msg.sessionId, code })
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
      case 'kill': {
        const session = bridges.get(msg.sessionId)
        if (session) {
          session.dispose()
          bridges.delete(msg.sessionId)
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
    }
  })

  const disposeAll = (): void => {
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
