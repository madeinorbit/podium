/**
 * THE AUTH STRATEGY CONTRACT — ADR 5 D5.
 *
 * One module per row of D5's table (plus the two non-peer ingresses of ADR 3
 * Amendment 1 D14). Each module sees only its OWN credential material and the
 * transport facts, and returns a principal or a refusal. What no module may do:
 *
 *  - read {@link PeerHello.claims} (ADR 3 D7.1 — payload identity is inert);
 *  - fall back to an ambient operator identity on failure (readiness §3.1.6 S4 —
 *    that fallback IS the multi-user hole);
 *  - evaluate policy. A strategy AUTHENTICATES. Authorization is the command
 *    layer's, re-resolved at every apply (ADR 3 D8/D16).
 *
 * `authenticate` is synchronous and pure with respect to its ports: every lookup
 * goes through an injected directory, which is what makes each strategy
 * unit-testable against a fake with no server, socket or database.
 */

import type { MachineId } from '@podium/model'
import type { CapabilityRef, DeviceId, Principal, UserId } from '../../planes/principal'
import type { DelegationDirectory, DelegationScope } from '../delegation-chain'
import type {
  AuthRole,
  CredentialKind,
  HandshakeRejectReason,
  PeerCredential,
  PeerHello,
} from '../envelope'

/**
 * What the TRANSPORT knows before any frame is read — the only identity input a
 * strategy is allowed besides its credential.
 *
 * `inProcess` is the operator channel's proof and is set by the composition root
 * that constructed the call, never by anything on a wire. It must not be
 * derivable from a socket: readiness §3.1.4 M4 is explicit that "connected over
 * the local socket" is not an identity.
 */
export interface TransportFacts {
  /** `/client`, `/daemon`, or a non-WS ingress label. Never peer-supplied. */
  readonly endpoint: string
  /** Cookies parsed off the HTTP upgrade by the gateway, not off a frame. */
  readonly cookies?: Readonly<Record<string, string>>
  /** True only for a caller constructed inside this process. */
  readonly inProcess?: boolean
  /** The connection identity the gateway assigned; the DEVICE half's fallback. */
  readonly connectionId?: string
}

export interface AuthInput<C extends PeerCredential = PeerCredential> {
  readonly credential: C
  /**
   * The full envelope, for CAPABILITY negotiation and logging only. A strategy
   * that reads `hello.claims` to decide identity is the bug this whole design
   * exists to prevent.
   */
  readonly hello: PeerHello
  readonly transport: TransportFacts
}

export type AuthOutcome =
  | {
      readonly ok: true
      readonly principal: Principal
      /** Set only by the pairing branch: a minted token the peer must persist. */
      readonly issuedToken?: string
      /** Set only by the pairing branch: the server update key the peer must pin. */
      readonly updatePubkey?: string
      /** Operator-facing name the acceptor settled on. */
      readonly name?: string
      /**
       * The resolved identity the peer must persist (a machine id today). Set by
       * the strategy — which is the only thing that knows what it resolved — so
       * the framing never branches on principal shape to find it.
       */
      readonly assignedId?: string
      /** Passed through from the directory's resolution; see `directoryContext`. */
      readonly directoryContext?: unknown
      /**
       * A refusal reason IS NOT allowed here, but a diagnostic is: text the
       * server may log. Never sent to the peer.
       */
      readonly diagnostic?: string
    }
  | {
      readonly ok: false
      readonly reason: HandshakeRejectReason
      /** Server-side only. Never crosses the wire (consistent-error rule). */
      readonly diagnostic?: string
      /**
       * Human hint the acceptor MAY forward. Only for failures that disclose
       * nothing about identity — the pairing ceremony's own UX.
       */
      readonly peerMessage?: string
    }

export interface PeerAuthStrategy<C extends PeerCredential = PeerCredential> {
  /** The registry key's role half (ADR 5 D2 / ADR 3 D14). */
  readonly role: AuthRole
  /** The registry key's credential half. */
  readonly credentialKind: C['kind']
  /** Stable module name for logs and for the conformance suite's reports. */
  readonly name: string
  authenticate(input: AuthInput<C>): AuthOutcome
}

// ---------------------------------------------------------------------------
// Directory ports
// ---------------------------------------------------------------------------

/**
 * PER-USER client sessions — ADR 3 Amendment 1 D14.1: a `client_session` remains
 * a DEVICE; it gains a user reference, and a user may hold many.
 *
 * The port is deliberately shaped as `(user, device)` even though today's
 * `client_sessions` table has no user column: POD-1075 lands the per-user
 * sessions this resolves against, and writing the port against today's single
 * shared password would bake the single-operator assumption into the one place
 * this issue exists to remove it from. Until POD-1075 lands there is no
 * production implementation, and the fail-closed default is the correct one.
 */
export interface ClientSessionDirectory {
  /**
   * Resolve a session cookie token. `null` for unknown, expired or revoked —
   * indistinguishably (consistent-error rule).
   */
  resolve(token: string): ResolvedClientSession | null
}

export interface ResolvedClientSession {
  readonly user: UserId
  /** The device this session IS. Two tabs on one device share it. */
  readonly device: DeviceId
  /** A disabled or revoked account fails closed at the transport edge. */
  readonly userActive: boolean
}

/**
 * Machines are OWNED COMPUTE — readiness §3.1.4, ADR 3 Amendment 1 D18.
 *
 * `owner` is `UserId | null` because machine ownership is POD-1079's deliverable
 * and existing rows predate it. The handshake's obligation (this issue) is that
 * the resolved principal can CARRY an owner and grants rather than being an
 * anonymous trusted peer; the `use`-verb gate that refuses an owner-less machine
 * is {@link machineUseAllowed}, and it fails closed.
 */
export interface MachineDirectory {
  /** ADR 5 D5, machine (local): verify the shared host secret. */
  verifyDaemonSecret(secret: string, observed?: PeerObservations): ResolvedMachine | null
  /** ADR 5 D5, machine (remote reconnect): verify a long-lived machine token. */
  verifyMachineToken(
    token: string,
    machineHint?: string,
    observed?: PeerObservations,
  ): ResolvedMachine | null
  /**
   * ADR 5 D5, machine (remote): redeem a one-shot pair code and mint a token.
   *
   * Everything in {@link PairingRequest} is a REQUEST, not identity: the code is
   * the credential, and the directory decides which machine row results. A
   * directory MUST NOT let a requested id rebind an EXISTING machine row — that
   * would let a pair code take over another machine's credential (POD-1125).
   */
  redeemPairCode(code: string, request?: PairingRequest): PairedMachine | null
}

/**
 * Non-identity host metadata a peer reports about itself, passed through so the
 * directory can record it (today's `touchMachine` stores the hostname). It is
 * explicitly NOT part of resolving who the peer is — a strategy passes it along
 * and never branches on it.
 */
export interface PeerObservations {
  readonly hostname?: string
}

/**
 * The self-describing fields a pairing peer sends. A brand-new machine has no
 * prior identity to authenticate, so it proposes one; the directory is what
 * decides. `machineId` is the load-bearing one and the directory MUST NOT let it
 * rebind an existing row (server refuses pair when the id is already registered).
 */
export interface PairingRequest {
  readonly machineId?: string
  readonly name?: string
  readonly hostname?: string
}

export interface ResolvedMachine {
  readonly machine: MachineId
  /** Whoever paired it (readiness §3.1.4 M3); `null` for pre-ownership rows. */
  readonly owner: UserId | null
  /** Subjects holding an explicit grant on this machine, per verb (D18.1). */
  readonly grants: readonly MachineGrant[]
  readonly name?: string
  /**
   * Opaque data the DIRECTORY attaches to a resolution and the gateway reads back
   * off the established peer. The handshake never interprets it — it exists so a
   * deployment-specific concern (today: the pairing grant that provisions agent
   * credentials onto a freshly paired machine) does not have to become part of
   * this contract.
   */
  readonly directoryContext?: unknown
}

export interface PairedMachine extends ResolvedMachine {
  /** Handed to the peer exactly once; the peer persists it. */
  readonly issuedToken: string
  /** The server's update-signing key, handed to the peer exactly once at pairing. */
  readonly updatePubkey?: string
}

export type MachineVerb = 'see' | 'use' | 'manage'

export interface MachineGrant {
  readonly subject: UserId
  readonly verb: MachineVerb
}

/**
 * THE ALL-IN-ONE GUARD — readiness §3.1.4 M4 / ADR 3 Amendment 1 D18.6.
 *
 * On an all-in-one install the `local` daemon IS the server host's machine.
 * Authenticating to the server must NOT thereby confer execute on it: `use` is a
 * code-execution boundary, not a visibility one, and it is owner-only until
 * explicitly granted. An owner-less machine grants `use` to NOBODY — fail closed
 * rather than treating a legacy row as ambient team compute.
 *
 * Kept next to the port it reads so nobody re-derives it per feature. The
 * command layer's row gate (ADR 3 D19) still runs; this is the machine half.
 */
export const machineUseAllowed = (machine: ResolvedMachine, subject: UserId | null): boolean => {
  if (subject === null) return false
  if (machine.owner === null) return false
  if (machine.owner === subject) return true
  return machine.grants.some((grant) => grant.subject === subject && grant.verb === 'use')
}

/**
 * Capability minting. The strategies never construct a capability themselves —
 * ADR 3 Amendment 1 D14.2 requires it to be minted SERVER-SIDE.
 *
 * The agent variant takes ONLY the delegation reference: there is no parameter
 * through which a scope could be copied into the connection, which is D16.1
 * ("a capability frozen at spawn is never an input to an allow decision")
 * expressed as a type rather than as a comment.
 */
export interface CapabilityMinter {
  forUser(user: UserId, device: DeviceId): CapabilityRef
  forMachine(machine: MachineId): CapabilityRef
  forDelegation(delegation: string): CapabilityRef
}

/** The bundle every strategy factory takes. Fakes in tests, services in prod. */
export interface StrategyPorts {
  readonly clientSessions?: ClientSessionDirectory
  readonly machines?: MachineDirectory
  readonly delegations?: DelegationDirectory
  readonly mint: CapabilityMinter
  /** The operator channel's in-process binding, when this process has one. */
  readonly boundUser?: () => UserId | null
}

/** Re-exported for strategy modules that talk about scopes in their doc comments. */
export type { DelegationScope, CredentialKind }
