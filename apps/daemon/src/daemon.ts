import { spawnAgent } from '@podium/agent-bridge'
import { encode, parseControlMessage } from '@podium/protocol'
import WebSocket, { type RawData } from 'ws'

export interface DaemonOptions {
  serverUrl: string
  sessionId: string
  cmd: string
  args?: string[]
  cols?: number
  rows?: number
}

export interface DaemonHandle {
  close(): Promise<void>
}

export function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const cols = opts.cols ?? 80
  const rows = opts.rows ?? 24
  const session = spawnAgent({ cmd: opts.cmd, args: opts.args, cols, rows })
  const ws = new WebSocket(`${opts.serverUrl}/daemon`)

  session.onFrame((frame) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(encode({ type: 'agentFrame', seq: frame.seq, data: frame.data }))
    }
  })
  session.onExit((code) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encode({ type: 'agentExit', code }))
  })

  ws.on('message', (raw: RawData) => {
    let msg: ReturnType<typeof parseControlMessage>
    try {
      msg = parseControlMessage(raw.toString())
    } catch {
      return
    }
    switch (msg.type) {
      case 'input':
        session.write(msg.data)
        break
      case 'resize':
        session.resize(msg.cols, msg.rows)
        break
      case 'redraw':
        session.redraw()
        break
    }
  })

  const handle: DaemonHandle = {
    close() {
      return new Promise<void>((resolve) => {
        session.dispose()
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
      ws.send(
        encode({
          type: 'bind',
          sessionId: opts.sessionId,
          cmd: opts.cmd,
          geometry: { cols, rows },
        }),
      )
      resolve(handle)
    })
    ws.once('error', (err) => {
      session.dispose()
      reject(err)
    })
  })
}
