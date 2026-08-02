/**
 * THE GATEWAY END of the common framing — ADR 5 D3, implementation owner POD-317.
 *
 * A pure state machine over inbound frames: no sockets, no `ws`, no server
 * imports, so the whole handshake — including its ORDER — is unit-testable, and
 * POD-391 can drive a reattach storm through it without a network. The gateway
 * (`apps/server/src/wsServer.ts`) owns the socket and calls `receive` per frame.
 *
 * WHAT IS COMMON HERE, AND WHAT IS NOT. This module does version negotiation,
 * capability negotiation, role resolution, order enforcement and the reply
 * shapes — identically for every role. It contains no `if (isDaemon)`: the one
 * role-dependent step is a REGISTRY LOOKUP that hands off to a strategy module
 * (ADR 5 D5). That is the boundary D3's "Forbidden" clause draws.
 *
 * ORDER IS ENFORCED, NOT ASSUMED (the handshake-order regression class):
 *  1. the first frame MUST be a hello — anything else closes the connection;
 *  2. version is negotiated BEFORE any credential is examined, so an
 *     incompatible peer never reaches an auth strategy;
 *  3. a second hello after the handshake is a protocol violation, not a re-auth
 *     (re-authentication on a live connection would be a principal-swap
 *     primitive — ADR 3 D7's TOCTOU shape);
 *  4. no frame is delivered to the planes until a principal exists.
 */

import type { Principal } from '../planes/principal'
import {
  type AuthRole,
  type HandshakeRejectReason,
  localVersionSupport,
  PeerHello,
  type PeerHelloOk,
  type PeerHelloRejected,
  type PeerRole,
} from './envelope'
import { type CapabilityNegotiation, negotiateCapabilities, negotiateVersion } from './negotiation'
import type { AuthStrategyRegistry } from './strategies/registry'
import type { TransportFacts } from './strategies/types'

/**
 * ADR 5 D4.3: "H1 may keep endpoint-implied role (`/client` → console, `/daemon`
 * → machine)". The endpoint WINS over a peer-supplied `peerRole`: a peer that
 * names a role its endpoint does not imply is refused rather than routed to
 * another role's strategy. An endpoint with no implied role (a future
 * server↔server path) falls back to the declared `peerRole`, which is what keeps
 * D4.3's forward-compatibility promise.
 */
export const ENDPOINT_IMPLIED_ROLE: Readonly<Record<string, PeerRole>> = {
  '/client': 'console',
  '/daemon': 'machine',
}

export type HandshakeState = 'awaiting-hello' | 'established' | 'closed'

export interface EstablishedPeer {
  readonly role: AuthRole
  /** Which strategy module authenticated it (for logs and conformance reports). */
  readonly strategy: string
  readonly principal: Principal
  readonly agreedVersion: number
  readonly caps: CapabilityNegotiation
  readonly name?: string
  /**
   * Whatever the directory attached to its resolution, handed back to the gateway
   * untouched. The framing never reads it (see `ResolvedMachine.directoryContext`).
   */
  readonly directoryContext?: unknown
}

export type AcceptorStep =
  | {
      /**
       * A pre-auth frame that was not a handshake, dropped on the floor under the
       * `ignore` policy. NOTHING was delivered and no principal exists; the
       * connection is still waiting for a hello.
       */
      readonly action: 'ignore'
      readonly raw: string
    }
  | {
      readonly action: 'establish'
      readonly reply: PeerHelloOk
      readonly peer: EstablishedPeer
    }
  | {
      readonly action: 'reject'
      readonly reply: PeerHelloRejected
      /** Server-side detail. Deliberately absent from `reply`. */
      readonly diagnostic?: string
    }
  | {
      readonly action: 'deliver'
      /** The authenticated principal every delivered frame is stamped with. */
      readonly peer: EstablishedPeer
      readonly raw: string
    }

export interface AcceptorDeps {
  readonly registry: AuthStrategyRegistry
  /** Capability tokens THIS build implements. The negotiation is an intersection. */
  readonly supportedCaps?: readonly string[]
  readonly support?: { wire: number; min: number }
  readonly transport: TransportFacts
  /**
   * What to do with a pre-auth frame that is not a hello at all.
   *
   * `reject-and-close` (the default) is the strict reading of fail-closed. The
   * `/daemon` socket passes `ignore`, which is the behaviour it has shipped with
   * and which `wsServer.daemon.test.ts` pins: the frame is DROPPED (never
   * delivered, no principal, nothing reaches the registry) and the connection
   * keeps waiting for a real handshake. Both are fail-closed with respect to
   * identity — they differ only in whether a peer that sent junk gets another
   * chance — so this is a deployment choice, not a security one, and it is a
   * named option rather than a branch inside the state machine.
   */
  readonly preAuthNonHandshake?: 'reject-and-close' | 'ignore'
  /**
   * Pin the role for a non-peer ingress (the agent relay, the operator channel).
   * A peer cannot reach these: `peerRole` is a closed enum of PEER roles only, so
   * only the composition root can name them.
   */
  readonly role?: AuthRole
}

export interface HandshakeAcceptor {
  readonly state: HandshakeState
  readonly peer: EstablishedPeer | null
  receive(raw: string): AcceptorStep
}

const reject = (
  reason: HandshakeRejectReason,
  diagnostic?: string,
  message?: string,
): AcceptorStep => ({
  action: 'reject',
  reply: { type: 'peerHelloRejected', reason, ...(message === undefined ? {} : { message }) },
  ...(diagnostic === undefined ? {} : { diagnostic }),
})

export const createHandshakeAcceptor = (deps: AcceptorDeps): HandshakeAcceptor => {
  let state: HandshakeState = 'awaiting-hello'
  let peer: EstablishedPeer | null = null
  const support = deps.support ?? localVersionSupport()

  const acceptor: HandshakeAcceptor = {
    get state() {
      return state
    },
    get peer() {
      return peer
    },
    receive(raw: string): AcceptorStep {
      if (state === 'closed')
        return reject('unexpected-frame', 'frame after the connection was refused')

      if (state === 'established') {
        // Rule 3: a hello on a live connection is a protocol violation. Anything
        // else is application traffic and is delivered with the principal.
        if (looksLikeHello(raw)) {
          state = 'closed'
          return reject('unexpected-frame', 'second hello on an established connection')
        }
        // `peer` is non-null in this state by construction.
        return { action: 'deliver', peer: peer as EstablishedPeer, raw }
      }

      // Rule 1: the first frame must be a hello.
      let hello: PeerHello
      try {
        hello = PeerHello.parse(JSON.parse(raw))
      } catch (error) {
        if (looksLikeHello(raw)) {
          state = 'closed'
          return reject('malformed-hello', `hello failed to parse: ${String(error)}`)
        }
        if ((deps.preAuthNonHandshake ?? 'reject-and-close') === 'ignore')
          return { action: 'ignore', raw }
        state = 'closed'
        return reject('unexpected-frame', 'first frame was not a hello (pre-auth)')
      }

      // Rule 2: version before credentials. Nothing below this line runs for an
      // incompatible peer, so an unsupported version can never touch auth.
      const version = negotiateVersion(hello.v, support)
      if (!version.ok) {
        state = 'closed'
        return { action: 'reject', reply: version.rejection, diagnostic: 'wire version mismatch' }
      }

      const implied = ENDPOINT_IMPLIED_ROLE[deps.transport.endpoint]
      const role: AuthRole | undefined =
        deps.role ??
        (implied === undefined
          ? hello.peerRole
          : hello.peerRole === undefined || hello.peerRole === implied
            ? implied
            : undefined)
      if (role === undefined) {
        state = 'closed'
        return reject(
          'unknown-role',
          `role could not be resolved for endpoint ${deps.transport.endpoint} (declared ${String(hello.peerRole)})`,
        )
      }

      const strategy = deps.registry.lookup(role, hello.credential.kind)
      if (strategy === null) {
        state = 'closed'
        // A reserved role with no acceptor is refused by its OWN module
        // (`node-reserved`), which is why this branch is a genuinely unsupported
        // credential for the role rather than the node case.
        return reject(
          'unsupported-credential',
          `no strategy for (${role}, ${hello.credential.kind})`,
        )
      }

      const outcome = strategy.authenticate({
        credential: hello.credential,
        hello,
        transport: deps.transport,
      })
      if (!outcome.ok) {
        state = 'closed'
        return reject(outcome.reason, outcome.diagnostic, outcome.peerMessage)
      }

      // Capabilities are negotiated only for a peer that authenticated: an
      // unauthenticated peer learns nothing about what this build supports.
      const caps = negotiateCapabilities(hello.caps, deps.supportedCaps ?? [])
      peer = {
        role,
        strategy: strategy.name,
        principal: outcome.principal,
        agreedVersion: version.agreed,
        caps,
        ...(outcome.name === undefined ? {} : { name: outcome.name }),
        ...(outcome.directoryContext === undefined
          ? {}
          : { directoryContext: outcome.directoryContext }),
      }
      state = 'established'
      return {
        action: 'establish',
        reply: {
          type: 'peerHelloOk',
          v: support.wire,
          // The ACCEPTED intersection — never the offer echoed back, and never a
          // reserved token (ADR 5 D4.2).
          caps: [...caps.accepted],
          ...(outcome.name === undefined ? {} : { name: outcome.name }),
          ...(outcome.assignedId === undefined ? {} : { assignedId: outcome.assignedId }),
          ...(outcome.issuedToken === undefined ? {} : { issuedToken: outcome.issuedToken }),
        },
        peer,
      }
    },
  }
  return acceptor
}

/** Cheap discriminator used for ORDER decisions only — never for identity. */
const looksLikeHello = (raw: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(raw)
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { type?: unknown }).type === 'peerHello'
    )
  } catch {
    return false
  }
}
