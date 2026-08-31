import { asMachineId, type MachineId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { type DaemonConnectionsPort, FleetLogLevelDirector } from './fleet-director'

/** `MachinesService`, narrowed to the three things a raise uses. Structural,
 *  because that is exactly how the real service satisfies the port. */
function fleet(online: string[], names: Record<string, string> = {}) {
  const sent: Array<{ machineId: string; msg: ControlMessage }> = []
  const port: DaemonConnectionsPort = {
    onlineMachineIds: () => online.map((id) => asMachineId(id)),
    machineName: (id) => names[id] ?? id,
    toMachine: (machineId, msg) => void sent.push({ machineId, msg }),
  }
  return { port, sent }
}

describe('logs.setDaemonLevel', () => {
  it('raises every ONLINE daemon when no target is given', () => {
    const { port, sent } = fleet(['flatblock', 'ludovico'], {
      flatblock: 'Flatblock',
      ludovico: 'Ludovico',
    })

    const result = new FleetLogLevelDirector(port).setLevel({ level: 'debug', ttlMs: 60_000 })

    expect(sent.map((s) => s.machineId)).toEqual(['flatblock', 'ludovico'])
    expect(sent[0]?.msg).toEqual({ type: 'setDaemonLogLevel', level: 'debug', ttlMs: 60_000 })
    expect(result).toEqual({
      level: 'debug',
      daemons: [
        { machineId: 'flatblock', name: 'Flatblock' },
        { machineId: 'ludovico', name: 'Ludovico' },
      ],
    })
  })

  it('reaches one machine by the id its log file is named after', () => {
    const { port, sent } = fleet(['flatblock', 'ludovico'])

    const result = new FleetLogLevelDirector(port).setLevel({
      level: 'trace',
      target: { machineId: asMachineId('flatblock') },
    })

    expect(sent.map((s) => s.machineId)).toEqual(['flatblock'])
    expect(result.daemons.map((d) => d.machineId)).toEqual(['flatblock'])
  })

  /**
   * THE PROPERTY THIS FEATURE IS BUILT AROUND. `toMachine` would happily park a
   * control frame for an offline machine and flush it on the next attach; a
   * raise delivered that way arrives after the incident, at a host nobody is
   * investigating. Only machines with a live socket are in `onlineMachineIds`,
   * so nothing is sent and the reply says so by being empty.
   */
  it('does not queue a raise for a machine that is offline', () => {
    const { port, sent } = fleet(['ludovico'])

    const result = new FleetLogLevelDirector(port).setLevel({
      level: 'debug',
      target: { machineId: asMachineId('flatblock') },
    })

    expect(sent).toEqual([])
    expect(result.daemons).toEqual([])
  })

  it('a reset carries a null level and no ttl', () => {
    const { port, sent } = fleet(['flatblock'])

    const result = new FleetLogLevelDirector(port).setLevel({ level: null })

    expect(sent[0]?.msg).toEqual({ type: 'setDaemonLogLevel', level: null })
    expect(result.level).toBeNull()
  })

  /** A lossy link is the difference between "this daemon went quiet" and "this
   *  daemon's queue overflowed". The operator learns it from the same reply that
   *  raised the machine, rather than by grepping the file for it. */
  it('reports drops the store has recorded for a reached machine', () => {
    const { port } = fleet(['flatblock'])
    const drops = {
      droppedFor: (id: MachineId) => (id === 'flatblock' ? 12 : 0),
      serverDroppedFor: () => 0,
    }

    const result = new FleetLogLevelDirector(port, drops).setLevel({ level: 'debug' })

    expect(result.daemons[0]).toEqual({
      machineId: 'flatblock',
      name: 'flatblock',
      dropped: 12,
    })
  })

  /** A lossy LINK and a saturated SERVER are different problems with different
   *  fixes, so they are different fields rather than one bigger number. */
  it('reports what the server itself lost apart from what the daemon lost', () => {
    const { port } = fleet(['flatblock'])
    const drops = { droppedFor: () => 3, serverDroppedFor: () => 40 }

    const result = new FleetLogLevelDirector(port, drops).setLevel({ level: 'debug' })

    expect(result.daemons[0]).toEqual({
      machineId: 'flatblock',
      name: 'flatblock',
      dropped: 3,
      serverDropped: 40,
    })
  })

  it('omits the drop count when a machine has lost nothing', () => {
    const { port } = fleet(['flatblock'])
    const drops = { droppedFor: () => 0, serverDroppedFor: () => 0 }

    const result = new FleetLogLevelDirector(port, drops).setLevel({ level: 'debug' })

    expect(result.daemons[0]).toEqual({ machineId: 'flatblock', name: 'flatblock' })
  })
})
