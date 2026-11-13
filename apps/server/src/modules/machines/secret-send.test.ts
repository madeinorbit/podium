/**
 * A SECRET IS NEVER QUEUED (credential management §8; epic plan Task 5).
 *
 * `attachAccess` judges the daemon connected when a launch is resolved. The
 * frame goes out a little later, after the row is written. If the socket went
 * away meanwhile, or was replaced by an older daemon or a plain link, the
 * frame must not be parked in the offline queue for whatever connects next:
 * `toMachine` refuses it at the send.
 */

import { asMachineId, asSessionId } from '@podium/model'
import { CAP_SESSION_ACCESS } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, test } from 'vitest'
import type { DaemonLinkKind } from '../../gateway/daemon-link-kind'
import type { Send } from '../sessions/session'
import { type MachinesDeps, MachinesService } from './service'

const MACHINE = asMachineId('machine-secret-send')
/** Obviously fake. */
const PLANTED = 'sk-FAKE-planted-queue-secret-0007'

function makeService(link: { kind: DaemonLinkKind | undefined }): MachinesService {
  return new MachinesService({
    instanceId: 'default',
    daemonLinkKind: () => link.kind,
    store: {
      machines: {
        getMachine: async () => ({ revokedAt: null }),
        addMachineComponent: () => false,
        setAvailability: async () => {},
        setPresenceSource: () => {},
        committed: { subscribe: () => () => {} },
      },
    } as unknown as MachinesDeps['store'],
    hostMachineId: asMachineId('host-under-test'),
  } satisfies MachinesDeps)
}

function spawnWith(kind: 'env' | 'home'): ControlMessage {
  return {
    type: 'spawn',
    sessionId: asSessionId('00000000-0000-4000-8000-0000000000b7'),
    agentKind: 'claude-code',
    cwd: '/p',
    geometry: { cols: 80, rows: 24 },
    access: {
      credentialId: 'cred_00000000-0000-4000-8000-0000000000b7',
      delivery:
        kind === 'env'
          ? { kind: 'env', variable: 'ANTHROPIC_API_KEY', secret: PLANTED }
          : { kind: 'home', homeId: 'h1' },
    },
  }
}

function recorder(): { send: Send<ControlMessage>; got: ControlMessage[] } {
  const got: ControlMessage[] = []
  return { send: (m) => got.push(m), got }
}

describe('toMachine with a frame that carries a secret', () => {
  test('goes to a capable daemon on a safe link', async () => {
    const svc = makeService({ kind: 'local' })
    const daemon = recorder()
    await svc.attach(MACHINE, daemon.send, [CAP_SESSION_ACCESS])
    svc.toMachine(MACHINE, spawnWith('env'))
    expect(JSON.stringify(daemon.got)).toContain(PLANTED)
  })

  test('is refused, not queued, when no daemon is connected', async () => {
    const link: { kind: DaemonLinkKind | undefined } = { kind: undefined }
    const svc = makeService(link)
    expect(() => svc.toMachine(MACHINE, spawnWith('env'))).toThrow('no daemon is connected')
    // A daemon that connects afterwards receives nothing from the queue.
    link.kind = 'local'
    const daemon = recorder()
    await svc.attach(MACHINE, daemon.send, [CAP_SESSION_ACCESS])
    await svc.flushQueued(MACHINE)
    expect(daemon.got).toEqual([])
  })

  test('is refused for an older daemon and for a plain link', async () => {
    const older = makeService({ kind: 'encrypted' })
    await older.attach(MACHINE, recorder().send, [])
    expect(() => older.toMachine(MACHINE, spawnWith('env'))).toThrow('too old')
    const plain = makeService({ kind: 'plain' })
    await plain.attach(MACHINE, recorder().send, [CAP_SESSION_ACCESS])
    expect(() => plain.toMachine(MACHINE, spawnWith('env'))).toThrow('not encrypted')
  })

  test('a home delivery holds no secret and is not held back', async () => {
    const svc = makeService({ kind: undefined })
    expect(() => svc.toMachine(MACHINE, spawnWith('home'))).not.toThrow()
  })
})
