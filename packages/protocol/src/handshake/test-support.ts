/**
 * Test doubles for the handshake ports, SHIPPED rather than colocated in a test
 * file, for the same reason `./conformance.ts` is: the gateway (POD-317), the
 * daemon dialer (POD-327) and a future H2 node binding must all be able to drive
 * the real strategies against the same fakes. A copy of these in three places
 * would drift, and the drift would be in security code.
 *
 * They are deliberately dumb: a Map lookup and nothing else. A fake that
 * implements policy would let a strategy's test pass for the fake's reasons.
 */

import type { MachineId } from '@podium/model'
import {
  asCapabilityRef,
  asDeviceId,
  asUserId,
  type CapabilityRef,
  type DeviceId,
  type UserId,
} from '../planes/principal'
import { WIRE_VERSION } from '../version'
import type { DelegationDirectory, DelegationLink } from './delegation-chain'
import type { PeerHello } from './envelope'
import type {
  CapabilityMinter,
  ClientSessionDirectory,
  MachineDirectory,
  MachineGrant,
  PairedMachine,
  PairingRequest,
  PeerObservations,
  ResolvedClientSession,
  ResolvedMachine,
  TransportFacts,
} from './strategies/types'

/** Records what it was asked to mint, so a test can prove what was NOT passed. */
export interface RecordingMinter extends CapabilityMinter {
  readonly minted: readonly { kind: 'user' | 'machine' | 'delegation'; subject: string }[]
}

export const createRecordingMinter = (): RecordingMinter => {
  const minted: { kind: 'user' | 'machine' | 'delegation'; subject: string }[] = []
  return {
    minted,
    forUser(user: UserId, device: DeviceId): CapabilityRef {
      minted.push({ kind: 'user', subject: `${user}/${device}` })
      return asCapabilityRef(`cap:user:${user}:${device}`)
    },
    forMachine(machine: MachineId): CapabilityRef {
      minted.push({ kind: 'machine', subject: machine })
      return asCapabilityRef(`cap:machine:${machine}`)
    },
    forDelegation(delegation: string): CapabilityRef {
      minted.push({ kind: 'delegation', subject: delegation })
      return asCapabilityRef(`cap:delegation:${delegation}`)
    },
  }
}

export const fakeClientSessions = (
  sessions: Readonly<Record<string, ResolvedClientSession>>,
): ClientSessionDirectory => ({
  resolve: (token) => sessions[token] ?? null,
})

export const clientSession = (
  user: string,
  device: string,
  userActive = true,
): ResolvedClientSession => ({
  user: asUserId(user),
  device: asDeviceId(device),
  userActive,
})

export interface FakeMachinesSeed {
  /** secret → machine record. */
  readonly secrets?: Readonly<Record<string, ResolvedMachine>>
  /** token → machine record. */
  readonly tokens?: Readonly<Record<string, ResolvedMachine>>
  /** pair code → the machine the DIRECTORY decides on (never the peer's request). */
  readonly codes?: Readonly<Record<string, PairedMachine>>
}

export interface FakeMachines extends MachineDirectory {
  /** The requests the pairing branch was given, to prove they are not identity. */
  readonly pairRequests: readonly (PairingRequest | undefined)[]
  /** The hints the token branch was given, same reason. */
  readonly tokenHints: readonly (string | undefined)[]
  /** The host metadata the directory was told about, to prove it is not identity. */
  readonly observations: readonly (PeerObservations | undefined)[]
}

export const fakeMachines = (seed: FakeMachinesSeed): FakeMachines => {
  const pairRequests: (PairingRequest | undefined)[] = []
  const tokenHints: (string | undefined)[] = []
  const observations: (PeerObservations | undefined)[] = []
  const redeemed = new Set<string>()
  return {
    pairRequests,
    tokenHints,
    observations,
    verifyDaemonSecret: (secret, observed) => {
      observations.push(observed)
      return seed.secrets?.[secret] ?? null
    },
    verifyMachineToken: (token, hint, observed) => {
      tokenHints.push(hint)
      observations.push(observed)
      // The hint is IGNORED for resolution on purpose: the fake proves the
      // strategy cannot use it to pick a machine, because nothing here lets it.
      return seed.tokens?.[token] ?? null
    },
    redeemPairCode: (code, request) => {
      pairRequests.push(request)
      // Single-use, like `PairingManager`.
      if (redeemed.has(code)) return null
      const paired = seed.codes?.[code]
      if (paired === undefined) return null
      redeemed.add(code)
      return paired
    },
  }
}

export const machineRecord = (
  machine: string,
  opts: {
    owner?: string | null
    grants?: readonly MachineGrant[]
    name?: string
    updatePubkey?: string
  } = {},
): ResolvedMachine => ({
  machine: machine as MachineId,
  owner: opts.owner === undefined || opts.owner === null ? null : asUserId(opts.owner),
  grants: opts.grants ?? [],
  ...(opts.name === undefined ? {} : { name: opts.name }),
  ...(opts.updatePubkey === undefined ? {} : { updatePubkey: opts.updatePubkey }),
})

export const pairedMachineRecord = (
  machine: string,
  issuedToken: string,
  opts: { owner?: string | null; name?: string; updatePubkey?: string } = {},
): PairedMachine => ({
  ...machineRecord(machine, opts),
  issuedToken,
  ...(opts.updatePubkey === undefined ? {} : { updatePubkey: opts.updatePubkey }),
})

export const fakeDelegations = (
  links: readonly DelegationLink[],
  inactiveUsers: readonly string[] = [],
): DelegationDirectory => {
  const byRef = new Map(links.map((link) => [String(link.ref), link]))
  const inactive = new Set(inactiveUsers)
  return {
    linkOf: (ref) => byRef.get(String(ref)) ?? null,
    userIsActive: (user) => !inactive.has(String(user)),
  }
}

/**
 * A hello carrying the credential under test. The default `claims` bag is
 * deliberately HOSTILE — it names a different user, machine, agent and delegator
 * than any fixture — so every strategy test that uses it is also a payload-inert
 * test, and a strategy that starts reading claims fails a pile of cases at once.
 */
export const helloFor = (
  credential: PeerHello['credential'],
  over: Partial<PeerHello> = {},
): PeerHello => ({
  type: 'peerHello',
  v: WIRE_VERSION,
  caps: [],
  credential,
  claims: HOSTILE_CLAIMS,
  ...over,
})

export const HOSTILE_CLAIMS = {
  user: 'usr-attacker',
  machineId: 'machine-attacker',
  agentIdentity: 'agent-attacker',
  onBehalfOf: 'usr-victim',
  hostname: 'attacker.local',
  name: 'Attacker',
} as const

export const transportFacts = (over: Partial<TransportFacts> = {}): TransportFacts => ({
  endpoint: '/daemon',
  connectionId: 'conn-1',
  ...over,
})
