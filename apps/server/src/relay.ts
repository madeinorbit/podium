import type {
  ClientMessage,
  ControlMessage,
  DaemonMessage,
  Geometry,
  ServerMessage,
} from '@podium/protocol'

export type Send<T> = (msg: T) => void

interface ClientConn {
  id: string
  send: Send<ServerMessage>
  viewport: Geometry
}

export interface SessionInfo {
  sessionId: string
  cmd: string
  controllerId: string | null
  geometry: Geometry
  epoch: number
  clientCount: number
}

export class RelayHub {
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: used by attachDaemon/detachDaemon; Task 3+ will read it
  private daemonSend: Send<ControlMessage> | undefined
  private sessionId = ''
  private cmd = ''
  private geometry: Geometry = { cols: 80, rows: 24 }
  private epoch = 0
  private controllerId: string | undefined
  private readonly clients = new Map<string, ClientConn>()
  private nextClientNum = 0

  attachDaemon(send: Send<ControlMessage>): void {
    this.daemonSend = send
  }

  detachDaemon(): void {
    this.daemonSend = undefined
  }

  onDaemonMessage(msg: DaemonMessage): void {
    switch (msg.type) {
      case 'bind':
        this.sessionId = msg.sessionId
        this.cmd = msg.cmd
        this.geometry = msg.geometry
        break
      case 'agentFrame':
        this.broadcast({ type: 'outputFrame', seq: msg.seq, epoch: this.epoch, data: msg.data })
        break
      case 'agentExit':
        this.broadcast({ type: 'agentExit', code: msg.code })
        break
    }
  }

  attachClient(send: Send<ServerMessage>): string {
    const id = `c${this.nextClientNum}`
    this.nextClientNum += 1
    this.clients.set(id, { id, send, viewport: { ...this.geometry } })
    if (this.controllerId === undefined) this.controllerId = id
    const controllerId = this.controllerId
    send({
      type: 'welcome',
      clientId: id,
      sessionId: this.sessionId,
      controllerId,
      geometry: this.geometry,
    })
    return id
  }

  detachClient(id: string): void {
    this.clients.delete(id)
    if (this.controllerId === id) {
      const next = this.clients.keys().next()
      this.controllerId = next.done ? undefined : next.value
    }
  }

  onClientMessage(_id: string, _msg: ClientMessage): void {
    throw new Error('not implemented')
  }

  info(): SessionInfo {
    return {
      sessionId: this.sessionId,
      cmd: this.cmd,
      controllerId: this.controllerId ?? null,
      geometry: { ...this.geometry },
      epoch: this.epoch,
      clientCount: this.clients.size,
    }
  }

  private broadcast(msg: ServerMessage): void {
    for (const c of this.clients.values()) c.send(msg)
  }
}
