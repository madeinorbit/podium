import { asMachineId } from '@podium/model'
import type { ClientLogOrigin, ServerMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { captureLogs } from '../../test-support/capture-logs'
import { type ClientConnectionsPort, ClientLogLevelDirector } from './level-director'

interface FakeConn {
  id: string
  origin?: ClientLogOrigin
}

/** The gateway's registry, narrowed to the two methods a raise uses. Structural,
 *  because that is exactly how the real `ClientRegistry` satisfies the port. */
function connections(conns: FakeConn[]): ClientConnectionsPort & {
  sent: Array<{ id: string; msg: ServerMessage }>
} {
  const sent: Array<{ id: string; msg: ServerMessage }> = []
  return {
    sent,
    values: () => conns.values(),
    deliver: (conn, msg) => void sent.push({ id: conn.id, msg }),
  }
}

const web: FakeConn = {
  id: 'c0',
  origin: { role: 'web', v: '1.0.0', machineId: asMachineId('m1') },
}
const mobile: FakeConn = {
  id: 'c1',
  origin: { role: 'mobile', v: '1.0.1', machineId: asMachineId('m2') },
}
/** A build too old to describe itself, or one that connected before its logging
 *  installed. It has no origin and never will. */
const anonymous: FakeConn = { id: 'c2' }

describe('logs.setLevel', () => {
  it('raises every connected client when no target is given', () => {
    const clients = connections([web, mobile, anonymous])

    const result = new ClientLogLevelDirector(clients).setLevel({ level: 'debug', ttlMs: 60_000 })

    expect(clients.sent.map((s) => s.id)).toEqual(['c0', 'c1', 'c2'])
    expect(clients.sent[0]?.msg).toEqual({ type: 'setLogLevel', level: 'debug', ttlMs: 60_000 })
    expect(result.clients.map((c) => c.clientId)).toEqual(['c0', 'c1', 'c2'])
  })

  it('reaches one client by the role and machine its log file is named after', () => {
    const clients = connections([web, mobile])

    const result = new ClientLogLevelDirector(clients).setLevel({
      level: 'debug',
      target: { role: 'mobile', machineId: asMachineId('m2') },
    })

    expect(clients.sent.map((s) => s.id)).toEqual(['c1'])
    expect(result.clients).toEqual([
      { clientId: 'c1', role: 'mobile', v: '1.0.1', machineId: 'm2' },
    ])
  })

  it('names one of two tabs by connection id', () => {
    const otherTab: FakeConn = {
      id: 'c9',
      origin: { role: 'web', v: '1.0.0', machineId: asMachineId('m1') },
    }
    const clients = connections([web, otherTab])

    new ClientLogLevelDirector(clients).setLevel({ level: 'trace', target: { clientId: 'c9' } })

    expect(clients.sent.map((s) => s.id)).toEqual(['c9'])
  })

  it('never guesses on behalf of a client that did not describe itself', () => {
    // The bug this pins is a selector matching `undefined === undefined` and
    // raising an anonymous connection because it was asked for `web`. An
    // operator investigating one machine would be turning up another.
    const clients = connections([anonymous])

    const result = new ClientLogLevelDirector(clients).setLevel({
      level: 'debug',
      target: { role: 'web' },
    })

    expect(clients.sent).toEqual([])
    expect(result.clients).toEqual([])
  })

  it('reports reaching nobody rather than refusing an unknown client id', () => {
    // Unknown id and just-disconnected are deliberately indistinguishable: the
    // alternative is a liveness oracle over other people's sessions.
    const clients = connections([web])

    const result = new ClientLogLevelDirector(clients).setLevel({
      level: 'debug',
      target: { clientId: 'c404' },
    })

    expect(result).toEqual({ level: 'debug', clients: [] })
  })

  it('sends the reset as a null level, carrying no threshold of its own', () => {
    const clients = connections([web])

    const result = new ClientLogLevelDirector(clients).setLevel({ level: null })

    expect(clients.sent[0]?.msg).toEqual({ type: 'setLogLevel', level: null })
    expect(result.level).toBeNull()
  })

  it('records the operator act in the server log', () => {
    // A REAL SINK following the namespace level, not a console spy: the record
    // is at `info`, which is the server family's default, so this observes what
    // an operator would actually find in `~/.podium/logs/server.ndjson`.
    const clients = connections([web, mobile])
    const logs = captureLogs()
    try {
      new ClientLogLevelDirector(clients).setLevel({ level: 'debug', ttlMs: 1000 })
    } finally {
      logs.restore()
    }

    // `to`, not `level`: the record shape owns `level` and drops a caller field
    // of that name, so the act would be logged without saying what it did.
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        ns: 'server:logs',
        level: 'info',
        msg: 'client log level command',
        to: 'debug',
        reached: 2,
      }),
    )
  })
})
