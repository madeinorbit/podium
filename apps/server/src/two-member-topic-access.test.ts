/**
 * A MEMBER'S LIVE TOPICS FOLLOW THEIR ACCESS (POD-6947).
 *
 * Bob holds `machine.processes` (a `machine.use` kind) for machines Alice
 * holds custody of, on a production SocketHub over the real `/client` socket,
 * with the production feed sink in front of it. Alice gives and takes `use`,
 * and a machine's custody goes. Each change reaches Bob's held key on the same
 * socket: a grant re-admits a key the server refused, and losing `use` closes
 * it `revoked`, on a machine with no checkouts and on one whose custodian is
 * gone. The server keeps no refusals: the client asks again, and the server
 * decides as it always does.
 *
 * Each case uses its own machine, so the cases do not depend on their order.
 */

import { FeedSink } from '@podium/client-core/replica/feed'
import {
  SocketHub,
  type TopicState,
  type WebSocketLike,
} from '@podium/client-core/socket-transport'
import { asMachineId, type MachineId } from '@podium/model'
import { CLIENT_WIRE_VERSION } from '@podium/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startTwoMemberInstance, type TwoMemberInstance } from './test-support/two-member-instance'

/** No checkouts: nothing but the access row moves when `use` is given or taken. */
const GRANTED = asMachineId('machine-granted-later')
const TAKEN = asMachineId('machine-use-taken')
/** Alice's custody of it ends while Bob holds `use`: his grant becomes inert. */
const RELEASED = asMachineId('machine-custody-released')

let f: TwoMemberInstance
let hub: SocketHub
let sockets = 0

beforeAll(async () => {
  f = await startTwoMemberInstance()
  for (const id of [GRANTED, TAKEN, RELEASED]) {
    await f.handle.registry.sessionStore.machines.upsertMachine({
      id,
      name: id,
      hostname: id,
      tokenHash: `${id}-token`,
      ownerUserId: f.members.alice.id,
      assignment: { server: false, agentExecution: true },
    })
  }
  const { cookie } = await f.as('bob')
  // The production sink, over a replica that only takes frames: what it
  // decides about an access move is the code under test.
  const replica = {
    posture: 'live',
    cursor: null,
    connect: () => {},
    transportDisconnected: () => {},
    requestRebootstrap: () => {},
    observeKindTokens: () => {},
    receive: () => {},
  }
  hub = new SocketHub({
    url: `${f.origin.replace(/^http/, 'ws')}/client?v=${CLIENT_WIRE_VERSION}`,
    feed: new FeedSink({ replica: replica as never }),
    makeSocket: (url) => {
      sockets += 1
      return new WebSocket(url, { headers: { cookie } }) as unknown as WebSocketLike
    },
  })
  hub.connect()
  await expect.poll(() => hub.connected, { timeout: 10_000 }).toBe(true)
}, 60_000)

afterAll(async () => {
  hub?.dispose()
  await f?.close()
})

// biome-ignore lint/suspicious/noExplicitAny: tRPC procedures addressed by one loose handle
const alice = async (): Promise<any> => (await f.as('alice')).trpc

/** Hold the machine's processes as Bob, recording every state the holder hears. */
function hold(machine: MachineId): TopicState[] {
  const states: TopicState[] = []
  hub.subscribeTopic('machine.processes', machine, { onState: (state) => states.push(state) })
  return states
}

const status = (machine: MachineId) => hub.topicState('machine.processes', machine)?.status
/** Admitted: the server answered with a snapshot (a value, or an honest unknown). */
const admitted = (machine: MachineId) => ['value', 'unknown'].includes(status(machine) ?? '')
const heard = (states: readonly TopicState[], reason: string) =>
  states.some((state) => state.status === 'closed' && state.reason === reason)

const shareUse = async (machine: MachineId) =>
  await (await alice()).machines.share.mutate({
    id: machine,
    grantee: f.members.bob.id,
    verb: 'use',
    acknowledgeSharedMachine: true,
  })

describe('live topics follow the member’s access, on the same socket', () => {
  it('a use grant re-admits a key the server refused', async () => {
    const states = hold(GRANTED)
    await expect.poll(() => heard(states, 'refused'), { timeout: 10_000 }).toBe(true)
    await shareUse(GRANTED)
    await expect.poll(() => admitted(GRANTED), { timeout: 10_000 }).toBe(true)
    expect(sockets).toBe(1)
  })

  it('taking use away on a machine with no checkouts closes the key revoked', async () => {
    await shareUse(TAKEN)
    const states = hold(TAKEN)
    await expect.poll(() => admitted(TAKEN), { timeout: 10_000 }).toBe(true)
    await (await alice()).machines.unshare.mutate({
      id: TAKEN,
      grantee: f.members.bob.id,
      verb: 'use',
    })
    await expect.poll(() => heard(states, 'revoked'), { timeout: 10_000 }).toBe(true)
    // Asked once more on the same access move, it stays closed: not admitted.
    expect(status(TAKEN)).toBe('closed')
    expect(sockets).toBe(1)
  })

  it('custody released while the member holds use closes the key revoked', async () => {
    await shareUse(RELEASED)
    const states = hold(RELEASED)
    await expect.poll(() => admitted(RELEASED), { timeout: 10_000 }).toBe(true)
    await f.handle.registry.sessionStore.machines.setMachineOwner(RELEASED, null)
    await expect.poll(() => heard(states, 'revoked'), { timeout: 10_000 }).toBe(true)
    expect(status(RELEASED)).toBe('closed')
    expect(sockets).toBe(1)
  })
})
