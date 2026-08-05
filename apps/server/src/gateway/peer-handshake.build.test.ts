import { createHash } from 'node:crypto'
import { WIRE_VERSION } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from '../relay'
import { SessionStore } from '../store'
import { wireDaemonSocket } from './daemon-socket'
import { recordHelloBuild } from './peer-handshake'

const openTestStore = () => new SessionStore(':memory:')

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

function fakeWs() {
  const sent: string[] = []
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {}
  return {
    sent,
    readyState: 1,
    bufferedAmount: 0,
    send: (s: string) => sent.push(s),
    terminate: () => {},
    on: (event: string, callback: (...args: unknown[]) => void) => {
      let eventHandlers = handlers[event]
      if (eventHandlers === undefined) {
        eventHandlers = []
        handlers[event] = eventHandlers
      }
      eventHandlers.push(callback)
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const callback of handlers[event] ?? []) callback(...args)
    },
  }
}

const frame = (value: unknown) => Buffer.from(JSON.stringify(value))

describe('build report on hello accept', () => {
  it('persists a report carried by the hello', () => {
    const store = openTestStore()
    store.machines.upsertMachine({
      id: 'm1',
      name: 'box',
      hostname: 'box.local',
      tokenHash: 'token-hash',
      ownerUserId: 'user:sole',
    })
    recordHelloBuild(store.machines, 'm1', {
      build: { appVersion: '0.4.2', installKind: 'installed' },
      caps: ['update.delivery.feed'],
      at: '2026-08-04T00:00:00.000Z',
    })
    expect(store.machines.getMachine('m1')?.appVersion).toBe('0.4.2')
  })

  it('leaves an existing report untouched when a hello carries none', () => {
    const store = openTestStore()
    store.machines.upsertMachine({
      id: 'm1',
      name: 'box',
      hostname: 'box.local',
      tokenHash: 'token-hash',
      ownerUserId: 'user:sole',
    })
    recordHelloBuild(store.machines, 'm1', {
      build: { appVersion: '0.4.2' },
      caps: [],
      at: '2026-08-04T00:00:00.000Z',
    })
    recordHelloBuild(store.machines, 'm1', {
      build: undefined,
      caps: [],
      at: '2026-08-04T01:00:00.000Z',
    })
    expect(store.machines.getMachine('m1')?.appVersion).toBe('0.4.2')
  })

  it('records the build only after the envelope hello authenticates', () => {
    const store = openTestStore()
    store.machines.upsertMachine({
      id: 'm1',
      name: 'box',
      hostname: 'box.local',
      tokenHash: sha256('tok'),
      ownerUserId: 'user:sole',
    })
    const registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
    const ws = fakeWs()
    wireDaemonSocket(ws as never, registry)

    ws.emit(
      'message',
      frame({
        type: 'peerHello',
        v: WIRE_VERSION,
        caps: ['update.delivery.feed'],
        credential: { kind: 'machineToken', token: 'tok', machineHint: 'm1' },
        build: { appVersion: '0.4.2', wireSchemaDigest: 'abc', installKind: 'installed' },
      }),
    )

    expect(store.machines.getMachine('m1')).toMatchObject({
      appVersion: '0.4.2',
      wireSchemaDigest: 'abc',
      installKind: 'installed',
      deliveryCaps: ['update.delivery.feed'],
    })
  })
})
