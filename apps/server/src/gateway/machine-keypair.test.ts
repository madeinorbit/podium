import { createHash } from 'node:crypto'
import { asMachineId, asUserId } from '@podium/model'
import { machineHelloTranscript, machineRotationTranscript, type MachineChallenge, DAEMON_WIRE_VERSION } from '@podium/protocol'
import { machinePublicKeyWire, signWithMachine } from '@podium/runtime/machine-credential'
import { mintSigningKeyPair, signMessage } from '@podium/runtime/signing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PairingManager } from '../hub/pairing'
import { MachinesService } from '../modules/machines/service'
import { openTestStore } from '../test-support/open-test-store'
import { createMachineSupervisorAcceptor, prepareDaemonFrame } from './peer-handshake'

const machineId = asMachineId('keypair-machine')
const member = asUserId('pairing-member')
const key = mintSigningKeyPair()
const publicKey = machinePublicKeyWire(key)
const stores: Awaited<ReturnType<typeof openTestStore>>[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close() })
const hello = (credential: unknown) => JSON.stringify({ type: 'peerHello', v: DAEMON_WIRE_VERSION,
  peerRole: 'machine', caps: [], credential, claims: { machineId, hostname: 'box' } })
const keyHello = () => hello({ kind: 'machineKey', machineHint: machineId })
const proofHello = (challenge: MachineChallenge, signature = signWithMachine(key, machineHelloTranscript(challenge))) =>
  hello({ kind: 'machineKey', machineHint: challenge.machineId, proof: {
    nonce: challenge.nonce, connectionId: challenge.connectionId, installationId: challenge.installationId, signature,
  } })
async function world(enrolled = true) {
  const store = await openTestStore(':memory:'); stores.push(store)
  await store.users.create({ id: member, displayName: 'Pairer', role: 'member', createdAt: new Date().toISOString(), disabledAt: null }, 'unused')
  const pairing = new PairingManager({ installationId: 'installation-a' })
  const machines = new MachinesService({ instanceId: 'test', installationId: 'installation-a',
    store, hostMachineId: store.hostMachineId, pairing,
    clients: () => [], machinesForPrincipal: async () => [] })
  const enrollment = { id: machineId, name: 'box', hostname: 'box', tokenHash: '',
    credentialKind: 'ed25519' as const, publicKey, ownerUserId: member, podiumManaged: true,
    assignment: { server: false, agentExecution: true },
    assignmentEvidence: { version: 1 as const, source: 'test', requestId: 'test' } }
  if (enrolled) expect(await store.machines.enrollMachine(enrollment)).toBe(true)
  const acceptor = (connectionId = 'connection-a') => createMachineSupervisorAcceptor({ machines, connectionId })
  return { store, machines, pairing, acceptor, enrollment }
}
async function challengeFor(acceptor: ReturnType<typeof createMachineSupervisorAcceptor>) {
  const { outcome } = await prepareDaemonFrame(acceptor, keyHello())
  expect(outcome.kind).toBe('challenge')
  if (outcome.kind !== 'challenge') throw new Error('challenge absent')
  return outcome.reply
}

describe('machine nonce authentication', () => {
  it('accepts a valid signature once and consumes before any replay', async () => {
    const { acceptor } = await world(); const connection = acceptor()
    const challenge = await challengeFor(connection)
    expect((await prepareDaemonFrame(connection, proofHello(challenge))).outcome.kind).toBe('established')
    expect((await prepareDaemonFrame(connection, proofHello(challenge))).outcome.kind).toBe('rejected')
  })
  it.each(['machine', 'installation', 'connection', 'nonce', 'expired', 'signature', 'domain'] as const)(
    'refuses %s mismatch and burns the challenge', async (failure) => {
      const { acceptor } = await world(); const connection = acceptor()
      const challenge = await challengeFor(connection)
      const altered = { ...challenge }
      if (failure === 'machine') altered.machineId = 'another-machine'
      if (failure === 'installation') altered.installationId = 'another-installation'
      if (failure === 'connection') altered.connectionId = 'another-connection'
      if (failure === 'nonce') altered.nonce = 'another-nonce'
      if (failure === 'expired') vi.spyOn(Date, 'now').mockReturnValue(challenge.expiresAtMs)
      const signature = failure === 'signature' ? signWithMachine(mintSigningKeyPair(), machineHelloTranscript(altered))
        : failure === 'domain' ? signMessage(key, 'wrong-domain\n', machineHelloTranscript(altered)) : undefined
      expect((await prepareDaemonFrame(connection, proofHello(altered, signature))).outcome.kind).toBe('rejected')
      vi.restoreAllMocks()
      expect((await prepareDaemonFrame(connection, proofHello(challenge))).outcome.kind).toBe('rejected')
    })
  it('refuses a real nonce issued on another connection', async () => {
    const { acceptor } = await world(); const first = acceptor(); const second = acceptor('connection-b')
    const challenge = await challengeFor(first)
    await challengeFor(second)
    expect((await prepareDaemonFrame(second, proofHello(challenge))).outcome.kind).toBe('rejected')
  })
  it('fails closed for a bearer token on a keypair row, including an old daemon', async () => {
    const { acceptor, store } = await world()
    expect(await store.machines.getMachineByToken(machineId, publicKey)).toBe(false)
    for (const frame of [hello({ kind: 'machineToken', token: publicKey, machineHint: machineId }),
      JSON.stringify({ type: 'hello', machineId, token: publicKey, hostname: 'old-daemon' })]) {
      expect((await prepareDaemonFrame(acceptor(), frame)).outcome.kind).toBe('rejected')
    }
  })
  it('keeps an old daemon on its stage-1 bearer hash until rotation', async () => {
    const { acceptor, store } = await world(false)
    await store.machines.upsertMachine({ id: machineId, name: 'old', hostname: 'old', ownerUserId: member,
      tokenHash: createHash('sha256').update('stage-1-token').digest('hex') })
    const frame = JSON.stringify({ type: 'hello', machineId, token: 'stage-1-token', hostname: 'old-daemon' })
    expect((await prepareDaemonFrame(acceptor(), frame)).outcome.kind).toBe('established')
    const connection = acceptor(); const challenge = await challengeFor(connection)
    expect((await prepareDaemonFrame(connection, proofHello(challenge))).outcome.kind).toBe('rejected')
  })
  it('rejects inconsistent kind/material rows at storage admission', async () => {
    const { store, enrollment } = await world(false)
    for (const change of [{ tokenHash: 'bearer-material' }, { publicKey: null },
      { credentialKind: 'bearer-hash' as const, tokenHash: 'hash' }, { publicKey: 'not-a-key' }]) {
      await expect(store.machines.enrollMachine({ ...enrollment, ...change })).rejects.toThrow()
    }
  })
})

describe('keypair enrollment', () => {
  it('records and acknowledges only the public key, then authenticates by nonce', async () => {
    const { machines, acceptor, store } = await world(false)
    const code = machines.mintPairingCode({ ownerUserId: member })
    const result = await prepareDaemonFrame(acceptor(), hello({ kind: 'pairCode', code, publicKey }))
    expect(result.outcome.kind).toBe('established')
    if (result.outcome.kind !== 'established') throw new Error('enrollment failed')
    expect(result.outcome.reply).toMatchObject({ enrolledPublicKey: publicKey })
    expect(result.outcome.reply).not.toHaveProperty('issuedToken')
    expect(await store.machines.credentialIncarnation(machineId)).toBe(publicKey)
    expect((await prepareDaemonFrame(acceptor(), hello({ kind: 'pairCode', code, publicKey }))).outcome.kind).toBe('rejected')
    const connection = acceptor(); const challenge = await challengeFor(connection)
    expect((await prepareDaemonFrame(connection, proofHello(challenge))).outcome.kind).toBe('established')
  })
  it('rechecks member eligibility when redeeming a previously valid code', async () => {
    const { machines, acceptor, store } = await world(false)
    const code = machines.mintPairingCode({ ownerUserId: member })
    await store.users.disable(member, new Date().toISOString())
    expect((await prepareDaemonFrame(acceptor(), hello({ kind: 'pairCode', code, publicKey }))).outcome.kind).toBe('rejected')
    expect(await store.machines.getMachine(machineId)).toBeUndefined()
  })
  it('refuses a code with the wrong installation and a missing public key', async () => {
    const { pairing, acceptor, store } = await world(false)
    const code = pairing.mint({ ownerUserId: member })
    expect((await prepareDaemonFrame(acceptor(), hello({ kind: 'pairCode', code }))).outcome.kind).toBe('rejected')
    expect(await store.machines.getMachine(machineId)).toBeUndefined()
    const foreign = new PairingManager({ installationId: 'installation-b' })
    const machines = new MachinesService({ instanceId: 'test', installationId: 'installation-a', store,
      hostMachineId: store.hostMachineId, pairing: foreign, clients: () => [], machinesForPrincipal: async () => [] })
    const foreignCode = machines.mintPairingCode({ ownerUserId: member })
    expect((await prepareDaemonFrame(createMachineSupervisorAcceptor({ machines, connectionId: 'foreign' }),
      hello({ kind: 'pairCode', code: foreignCode, publicKey }))).outcome.kind).toBe('rejected')
  })
})


describe('machine credential rotation', () => {
  const rotateHello = (challenge: MachineChallenge, next: ReturnType<typeof mintSigningKeyPair>, token?: string) => {
    const newPublicKey = machinePublicKeyWire(next)
    const transcript = machineRotationTranscript(challenge, newPublicKey, newPublicKey)
    return hello({ kind: 'machineKey', machineHint: machineId,
      proof: { nonce: challenge.nonce, connectionId: challenge.connectionId, installationId: challenge.installationId,
        signature: signWithMachine(next, machineHelloTranscript(challenge)) },
      rotation: { newKeyId: newPublicKey, newPublicKey, newSignature: signWithMachine(next, transcript),
        previous: token ? { kind: 'bearer-hash', token }
          : { kind: 'ed25519', publicKey, signature: signWithMachine(key, transcript) } },
    })
  }
  it('acknowledges the replacement and immediately refuses the old key', async () => {
    const { acceptor, store } = await world()
    const next = mintSigningKeyPair(); const connection = acceptor()
    const challenge = await challengeFor(connection)
    expect(await store.machines.verifyMachineSignature(machineId, 'before', signWithMachine(key, 'before'))).toBe(true)
    const { outcome } = await prepareDaemonFrame(connection, rotateHello(challenge, next))
    expect(outcome).toMatchObject({ kind: 'established', reply: { enrolledPublicKey: machinePublicKeyWire(next) } })
    const old = acceptor('old'); const oldChallenge = await challengeFor(old)
    expect((await prepareDaemonFrame(old, proofHello(oldChallenge))).outcome.kind).toBe('rejected')
    const fresh = acceptor('new'); const freshChallenge = await challengeFor(fresh)
    expect((await prepareDaemonFrame(fresh, proofHello(freshChallenge, signWithMachine(next, machineHelloTranscript(freshChallenge))))).outcome.kind).toBe('established')
  })
  it('returns the same key id when an acknowledgement is lost and both keys are re-presented', async () => {
    const { acceptor, store } = await world(); const next = mintSigningKeyPair()
    const first = acceptor(); const challenge = await challengeFor(first)
    await prepareDaemonFrame(first, rotateHello(challenge, next)) // reply lost in transit
    const retry = acceptor('retry'); const retryChallenge = await challengeFor(retry)
    expect((await prepareDaemonFrame(retry, rotateHello(retryChallenge, next))).outcome)
      .toMatchObject({ kind: 'established', reply: { enrolledPublicKey: machinePublicKeyWire(next) } })
    expect(await store.machines.credentialIncarnation(machineId)).toBe(machinePublicKeyWire(next))
    // A spent nonce cannot be replayed to mutate the row.
    expect((await prepareDaemonFrame(retry, rotateHello(retryChallenge, next))).outcome.kind).toBe('rejected')
  })
  it('allows exactly one of two concurrent replacements to win', async () => {
    const { acceptor, store } = await world()
    const first = acceptor('first'); const second = acceptor('second')
    const firstChallenge = await challengeFor(first); const secondChallenge = await challengeFor(second)
    const a = mintSigningKeyPair(); const b = mintSigningKeyPair()
    const outcomes = await Promise.all([
      prepareDaemonFrame(first, rotateHello(firstChallenge, a)),
      prepareDaemonFrame(second, rotateHello(secondChallenge, b)),
    ])
    expect(outcomes.filter(({ outcome }) => outcome.kind === 'established')).toHaveLength(1)
    expect(outcomes.filter(({ outcome }) => outcome.kind === 'rejected')).toHaveLength(1)
    const winner = outcomes[0]!.outcome.kind === 'established' ? a : b
    expect(await store.machines.credentialIncarnation(machineId)).toBe(machinePublicKeyWire(winner))
  })
  it('acknowledges concurrent retries of the same key id without replacing it twice', async () => {
    const { acceptor, store } = await world(); const next = mintSigningKeyPair()
    const a = acceptor('a'); const b = acceptor('b')
    const ca = await challengeFor(a); const cb = await challengeFor(b)
    const replies = await Promise.all([
      prepareDaemonFrame(a, rotateHello(ca, next)), prepareDaemonFrame(b, rotateHello(cb, next)),
    ])
    for (const reply of replies) expect(reply.outcome)
      .toMatchObject({ kind: 'established', reply: { enrolledPublicKey: machinePublicKeyWire(next) } })
    expect(await store.machines.credentialIncarnation(machineId)).toBe(machinePublicKeyWire(next))
  })
  it('does not resurrect a rotated credential after revocation when its ack was lost', async () => {
    const { acceptor, store } = await world(); const next = mintSigningKeyPair()
    const first = acceptor(); const challenge = await challengeFor(first)
    await prepareDaemonFrame(first, rotateHello(challenge, next))
    await store.machines.revokeMachine(machineId)
    const retry = acceptor('retry'); const retryChallenge = await challengeFor(retry)
    expect((await prepareDaemonFrame(retry, rotateHello(retryChallenge, next))).outcome.kind).toBe('rejected')
  })
  it('migrates a bearer row through the same path and retries after losing the ack', async () => {
    const { acceptor, store, enrollment } = await world(false)
    const token = 'old-stage-1-token'
    await store.machines.enrollMachine({ ...enrollment, credentialKind: 'bearer-hash', publicKey: null,
      tokenHash: createHash('sha256').update(token).digest('hex') })
    const next = mintSigningKeyPair()
    expect(await store.machines.getMachineByToken(machineId, token)).toBe(true)
    for (const id of ['first', 'retry']) {
      const connection = acceptor(id); const challenge = await challengeFor(connection)
      expect((await prepareDaemonFrame(connection, rotateHello(challenge, next, token))).outcome)
        .toMatchObject({ kind: 'established', reply: { enrolledPublicKey: machinePublicKeyWire(next) } })
      expect(await store.machines.getMachineByToken(machineId, token)).toBe(false)
    }
  })
  it.each(['old-proof', 'new-proof', 'hello-proof', 'key-id', 'revoked', 'read-only'] as const)(
    'refuses %s without replacing the credential', async (failure) => {
      const { acceptor, store } = await world(); const connection = acceptor()
      const challenge = await challengeFor(connection)
      const frame = JSON.parse(rotateHello(challenge, mintSigningKeyPair()))
      if (failure === 'old-proof') frame.credential.rotation.previous.signature = 'bad'
      if (failure === 'new-proof') frame.credential.rotation.newSignature = 'bad'
      if (failure === 'hello-proof') frame.credential.proof.signature = 'bad'
      if (failure === 'key-id') frame.credential.rotation.newKeyId = 'another-key-id'
      if (failure === 'revoked') await store.machines.revokeMachine(machineId)
      const target = failure === 'read-only' ? { ...connection, deps: { ...connection.deps, verifyOnly: true } } : connection
      expect((await prepareDaemonFrame(target, JSON.stringify(frame))).outcome.kind).toBe('rejected')
      expect(await store.machines.credentialIncarnation(machineId)).toBe(publicKey)
    })
})
