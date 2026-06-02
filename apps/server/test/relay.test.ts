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

describe('RelayHub — client control', () => {
  function setup() {
    const hub = new RelayHub()
    const daemon = capture<ControlMessage>()
    hub.attachDaemon(daemon.send)
    hub.onDaemonMessage({
      type: 'bind',
      sessionId: 's1',
      cmd: 'fixture',
      geometry: { cols: 80, rows: 24 },
    })
    return { hub, daemon }
  }

  it('forwards input from the controller to the daemon', () => {
    const { hub, daemon } = setup()
    const a = capture<ServerMessage>()
    const id = hub.attachClient(a.send)
    hub.onClientMessage(id, { type: 'input', data: 'YQ==' })
    expect(daemon.msgs).toContainEqual({ type: 'input', data: 'YQ==' })
  })

  it('drops input from a non-controller (spectator)', () => {
    const { hub, daemon } = setup()
    const a = capture<ServerMessage>()
    const b = capture<ServerMessage>()
    hub.attachClient(a.send)
    const idB = hub.attachClient(b.send)
    hub.onClientMessage(idB, { type: 'input', data: 'YQ==' })
    expect(daemon.msgs).not.toContainEqual({ type: 'input', data: 'YQ==' })
  })

  it('applies a controller resize to the session geometry and forwards it', () => {
    const { hub, daemon } = setup()
    const a = capture<ServerMessage>()
    const id = hub.attachClient(a.send)
    hub.onClientMessage(id, { type: 'resize', cols: 120, rows: 40 })
    expect(hub.info().geometry).toEqual({ cols: 120, rows: 40 })
    expect(daemon.msgs).toContainEqual({ type: 'resize', cols: 120, rows: 40 })
  })

  it('does not change session geometry on a spectator resize', () => {
    const { hub, daemon } = setup()
    const a = capture<ServerMessage>()
    const b = capture<ServerMessage>()
    hub.attachClient(a.send)
    const idB = hub.attachClient(b.send)
    hub.onClientMessage(idB, { type: 'resize', cols: 50, rows: 20 })
    expect(hub.info().geometry).toEqual({ cols: 80, rows: 24 })
    expect(daemon.msgs).not.toContainEqual({ type: 'resize', cols: 50, rows: 20 })
  })

  it('takeover: requestControl bumps epoch, resizes+redraws the daemon, broadcasts to all', () => {
    const { hub, daemon } = setup()
    const a = capture<ServerMessage>()
    const b = capture<ServerMessage>()
    hub.attachClient(a.send)
    const idB = hub.attachClient(b.send)
    hub.onClientMessage(idB, { type: 'resize', cols: 40, rows: 30 })
    hub.onClientMessage(idB, { type: 'requestControl' })
    expect(hub.info().controllerId).toBe(idB)
    expect(hub.info().epoch).toBe(1)
    expect(hub.info().geometry).toEqual({ cols: 40, rows: 30 })
    expect(daemon.msgs).toContainEqual({ type: 'resize', cols: 40, rows: 30 })
    expect(daemon.msgs).toContainEqual({ type: 'redraw' })
    expect(a.msgs).toContainEqual({
      type: 'controllerChanged',
      controllerId: idB,
      geometry: { cols: 40, rows: 30 },
    })
    expect(b.msgs).toContainEqual({ type: 'geometry', cols: 40, rows: 30 })
  })

  it('frames after a takeover carry the bumped epoch', () => {
    const { hub } = setup()
    const a = capture<ServerMessage>()
    const b = capture<ServerMessage>()
    hub.attachClient(a.send)
    const idB = hub.attachClient(b.send)
    hub.onClientMessage(idB, { type: 'requestControl' })
    hub.onDaemonMessage({ type: 'agentFrame', seq: 9, data: 'eA==' })
    expect(a.msgs.at(-1)).toEqual({ type: 'outputFrame', seq: 9, epoch: 1, data: 'eA==' })
  })

  it('redrawRequest forwards a redraw to the daemon', () => {
    const { hub, daemon } = setup()
    const a = capture<ServerMessage>()
    const id = hub.attachClient(a.send)
    hub.onClientMessage(id, { type: 'redrawRequest' })
    expect(daemon.msgs).toContainEqual({ type: 'redraw' })
  })

  it('hello updates the client viewport used on takeover', () => {
    const { hub } = setup()
    const a = capture<ServerMessage>()
    const b = capture<ServerMessage>()
    hub.attachClient(a.send)
    const idB = hub.attachClient(b.send)
    hub.onClientMessage(idB, {
      type: 'hello',
      clientId: idB,
      viewport: { cols: 33, rows: 21, dpr: 2 },
    })
    hub.onClientMessage(idB, { type: 'requestControl' })
    expect(hub.info().geometry).toEqual({ cols: 33, rows: 21 })
  })

  it('ignores client messages for an unknown id', () => {
    const { hub, daemon } = setup()
    expect(() => hub.onClientMessage('ghost', { type: 'redrawRequest' })).not.toThrow()
    expect(daemon.msgs).not.toContainEqual({ type: 'redraw' })
  })
})
