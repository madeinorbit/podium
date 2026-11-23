/**
 * A DAEMON IS BOUND TO THE MACHINE ROW OF ITS SOCKET'S WORKSPACE (POD-7309).
 *
 * The `/daemon` socket is bound to a workspace at the edge, and its handshake
 * is checked against that workspace's machine rows only. One machine id can
 * exist in two workspaces of one database, and the installation (whose id the
 * challenge carries) is the same for both, so the workspace is the only thing
 * that tells the two enrollments apart.
 *
 * Two registries' machine services are built by hand over one database, one
 * per workspace, as a process holding both would hold them.
 */
import { asMachineId, asUserId } from '@podium/model'
import {
  DAEMON_WIRE_VERSION,
  type MachineChallenge,
  machineHelloTranscript,
} from '@podium/protocol'
import { machinePublicKeyWire, signWithMachine } from '@podium/runtime/machine-credential'
import { mintSigningKeyPair, type SigningKeyPair } from '@podium/runtime/signing'
import { afterEach, describe, expect, it } from 'vitest'
import { PairingManager } from '../hub/pairing'
import { MachinesService } from '../modules/machines/service'
import type { SessionStore } from '../store'
import { memberFacts } from '../store/fixtures/test-support'
import { openWorkspaceStores } from '../test-support/workspace-stores'
import { createMachineSupervisorAcceptor, prepareDaemonFrame } from './peer-handshake'

const INSTALLATION = 'installation-shared'
const machineId = asMachineId('shared-machine-id')
const member = asUserId('enrolling-member')

const hello = (credential: unknown) =>
  JSON.stringify({
    type: 'peerHello',
    v: DAEMON_WIRE_VERSION,
    peerRole: 'machine',
    caps: [],
    credential,
    claims: { machineId, hostname: 'box' },
  })

const opened: SessionStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

async function workspaceMachines(store: SessionStore) {
  await memberFacts(store).create(
    {
      id: member,
      displayName: 'Enroller',
      role: 'member',
      createdAt: new Date().toISOString(),
      disabledAt: null,
    },
    'unused',
  )
  const machines = new MachinesService({
    instanceId: 'test',
    installationId: INSTALLATION,
    store,
    hostMachine: store.hostMachine ? { id: store.hostMachine.id } : null,
    pairing: new PairingManager({ installationId: INSTALLATION }),
  })
  const enroll = async (key: SigningKeyPair) =>
    await store.machines.enrollMachine({
      id: machineId,
      name: 'box',
      hostname: 'box',
      tokenHash: '',
      credentialKind: 'ed25519' as const,
      publicKey: machinePublicKeyWire(key),
      ownerUserId: member,
      podiumManaged: true,
      assignment: { server: false, agentExecution: true },
      assignmentEvidence: { version: 1 as const, source: 'test', requestId: 'test' },
    })
  return { machines, enroll }
}

/** The whole machine-key handshake of one connection, signed with `key`. */
async function attach(
  machines: MachinesService,
  key: SigningKeyPair,
  connectionId: string,
): Promise<string> {
  const acceptor = createMachineSupervisorAcceptor({ machines, connectionId })
  const first = await prepareDaemonFrame(
    acceptor,
    hello({ kind: 'machineKey', machineHint: machineId }),
  )
  if (first.outcome.kind !== 'challenge') return first.outcome.kind
  const challenge: MachineChallenge = first.outcome.reply
  const proof = await prepareDaemonFrame(
    acceptor,
    hello({
      kind: 'machineKey',
      machineHint: machineId,
      proof: {
        nonce: challenge.nonce,
        connectionId: challenge.connectionId,
        installationId: challenge.installationId,
        signature: signWithMachine(key, machineHelloTranscript(challenge)),
      },
    }),
  )
  return proof.outcome.kind
}

describe('a daemon enrolled in workspace A, attaching to workspace B with the same machine id', () => {
  it('is refused where B has no row for the machine, and accepted in A', async () => {
    const [a, b] = await openWorkspaceStores(['ws_a', 'ws_b'])
    opened.push(a)
    const inA = await workspaceMachines(a)
    const inB = await workspaceMachines(b)
    const key = mintSigningKeyPair()
    expect(await inA.enroll(key)).toBe(true)

    expect(await attach(inA.machines, key, 'connection-a')).toBe('established')
    expect(await attach(inB.machines, key, 'connection-b')).toBe('rejected')
  })

  it("is refused where B enrolled the same machine id with its own key, and B's key is not A's", async () => {
    const [a, b] = await openWorkspaceStores(['ws_a', 'ws_b'])
    opened.push(a)
    const inA = await workspaceMachines(a)
    const inB = await workspaceMachines(b)
    const keyA = mintSigningKeyPair()
    const keyB = mintSigningKeyPair()
    expect(await inA.enroll(keyA)).toBe(true)
    expect(await inB.enroll(keyB)).toBe(true)

    expect(await attach(inB.machines, keyA, 'connection-1')).toBe('rejected')
    expect(await attach(inA.machines, keyB, 'connection-2')).toBe('rejected')
    expect(await attach(inA.machines, keyA, 'connection-3')).toBe('established')
    expect(await attach(inB.machines, keyB, 'connection-4')).toBe('established')
  })
})
