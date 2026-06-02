import type { ControlMessage, ServerMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { RelayHub } from '../src/relay'

function capture<T>() {
  const msgs: T[] = []
  const send = (m: T): void => {
    msgs.push(m)
  }
  return { msgs, send }
}

describe('RelayHub — daemon side + lifecycle', () => {
  it('records session state on bind and reports it via info()', () => {
    const hub = new RelayHub()
    hub.attachDaemon(capture<ControlMessage>().send)
    hub.onDaemonMessage({
      type: 'bind',
      sessionId: 's1',
      cmd: 'fixture',
      geometry: { cols: 80, rows: 24 },
    })
    const info = hub.info()
    expect(info.sessionId).toBe('s1')
    expect(info.cmd).toBe('fixture')
    expect(info.geometry).toEqual({ cols: 80, rows: 24 })
    expect(info.epoch).toBe(0)
    expect(info.clientCount).toBe(0)
    expect(info.controllerId).toBeNull()
  })

  it('sends a welcome to a new client and makes the first client the controller', () => {
    const hub = new RelayHub()
    hub.onDaemonMessage({
      type: 'bind',
      sessionId: 's1',
      cmd: 'fixture',
      geometry: { cols: 80, rows: 24 },
    })
    const a = capture<ServerMessage>()
    const id = hub.attachClient(a.send)
    expect(a.msgs).toHaveLength(1)
    expect(a.msgs[0]).toEqual({
      type: 'welcome',
      clientId: id,
      sessionId: 's1',
      controllerId: id,
      geometry: { cols: 80, rows: 24 },
    })
    expect(hub.info().controllerId).toBe(id)
    expect(hub.info().clientCount).toBe(1)
  })

  it('fans out an agentFrame to all clients as an epoch-stamped outputFrame', () => {
    const hub = new RelayHub()
    const a = capture<ServerMessage>()
    const b = capture<ServerMessage>()
    hub.attachClient(a.send)
    hub.attachClient(b.send)
    hub.onDaemonMessage({ type: 'agentFrame', seq: 5, data: 'Zm9v' })
    const expected = { type: 'outputFrame', seq: 5, epoch: 0, data: 'Zm9v' }
    expect(a.msgs.at(-1)).toEqual(expected)
    expect(b.msgs.at(-1)).toEqual(expected)
  })

  it('fans out agentExit to all clients', () => {
    const hub = new RelayHub()
    const a = capture<ServerMessage>()
    hub.attachClient(a.send)
    hub.onDaemonMessage({ type: 'agentExit', code: 0 })
    expect(a.msgs.at(-1)).toEqual({ type: 'agentExit', code: 0 })
  })

  it('reassigns the controller when the controller detaches', () => {
    const hub = new RelayHub()
    const a = capture<ServerMessage>()
    const b = capture<ServerMessage>()
    const idA = hub.attachClient(a.send)
    const idB = hub.attachClient(b.send)
    expect(hub.info().controllerId).toBe(idA)
    hub.detachClient(idA)
    expect(hub.info().controllerId).toBe(idB)
    hub.detachClient(idB)
    expect(hub.info().controllerId).toBeNull()
    expect(hub.info().clientCount).toBe(0)
  })

  it('tolerates daemon messages with no daemon attached', () => {
    const hub = new RelayHub()
    expect(() => hub.onDaemonMessage({ type: 'agentExit', code: 1 })).not.toThrow()
  })
})
