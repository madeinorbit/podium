/**
 * THE DAEMON END of the common framing — the dialer side of ADR 5 D3, mirrored by
 * POD-327 from `apps/daemon`.
 *
 * It lives beside the acceptor, in the shared package, because the contract is
 * ONE contract: the shared conformance suite (`./conformance.ts`) runs the same
 * scenarios against both ends, which is what makes "the daemon mirrors the
 * gateway" a tested claim instead of a comment in two repositories' worth of
 * files.
 *
 * ORDER IS ENFORCED HERE TOO, and this end is where the known production wedge
 * lives. `wsServer.ts` documents it: if application traffic (a `sessionPriority`
 * frame) reaches the daemon before its `helloOk`, the daemon's first-frame parse
 * fails, it refuses, and it loops forever. That failure mode is now a NAMED,
 * TESTED outcome (`traffic-before-ack`) instead of a silent reconnect loop — a
 * dialer that hits it reports it rather than retrying blindly.
 */

import {
  type PeerBuild,
  type PeerCredential,
  type PeerHello,
  PeerHelloReply,
  type PeerHelloRejected,
  type PeerIdentityClaims,
  type PeerRole,
  localVersionSupport,
} from './envelope'
import { type CapabilityNegotiation, negotiateCapabilities } from './negotiation'

export type DialerState = 'unsent' | 'awaiting-ack' | 'established' | 'failed'

export type DialerStep =
  | {
      readonly action: 'established'
      readonly agreedVersion: number
      /** Capabilities the acceptor accepted, intersected with what this end offers. */
      readonly caps: CapabilityNegotiation
      readonly name?: string
      /**
       * Present exactly once, on the pairing branch: the long-lived machine token
       * this end must PERSIST before doing anything else (ADR 5 D5).
       */
      readonly issuedToken?: string
    }
  | { readonly action: 'rejected'; readonly reply: PeerHelloRejected }
  | { readonly action: 'protocol-error'; readonly error: DialerProtocolError }
  | { readonly action: 'deliver'; readonly raw: string }

export type DialerProtocolError =
  | 'reply-before-hello'
  | 'traffic-before-ack'
  | 'malformed-reply'
  | 'second-ack'

export interface DialerDeps {
  /** Absent lets the acceptor infer from the endpoint (ADR 5 D4.3). */
  readonly peerRole?: PeerRole
  readonly credential: PeerCredential
  readonly caps?: readonly string[]
  readonly build?: PeerBuild
  /**
   * INERT identity-shaped fields. Sent for logs and for the operator-facing name
   * request; the acceptor resolves no identity from them, and a dialer that
   * expects otherwise has misread ADR 3 D7.
   */
  readonly claims?: PeerIdentityClaims
  readonly support?: { wire: number; min: number }
}

export interface HandshakeDialer {
  readonly state: DialerState
  /** The hello to send. Calling it twice is a bug and throws rather than re-handshaking. */
  hello(): PeerHello
  receive(raw: string): DialerStep
}

export const createHandshakeDialer = (deps: DialerDeps): HandshakeDialer => {
  let state: DialerState = 'unsent'
  const support = deps.support ?? localVersionSupport()
  const offered = deps.caps ?? []

  return {
    get state() {
      return state
    },
    hello(): PeerHello {
      if (state !== 'unsent')
        throw new Error(`hello already sent (dialer state: ${state}) — re-handshake is not a thing`)
      state = 'awaiting-ack'
      return {
        type: 'peerHello',
        v: support.wire,
        ...(deps.peerRole === undefined ? {} : { peerRole: deps.peerRole }),
        caps: [...offered],
        ...(deps.build === undefined ? {} : { build: deps.build }),
        credential: deps.credential,
        ...(deps.claims === undefined ? {} : { claims: deps.claims }),
      }
    },
    receive(raw: string): DialerStep {
      if (state === 'unsent') {
        state = 'failed'
        return { action: 'protocol-error', error: 'reply-before-hello' }
      }
      if (state === 'failed') return { action: 'protocol-error', error: 'malformed-reply' }

      let reply: ReturnType<typeof PeerHelloReply.parse> | null = null
      try {
        reply = PeerHelloReply.parse(JSON.parse(raw))
      } catch {
        reply = null
      }

      if (state === 'established') {
        // A second ack is a protocol violation; ordinary traffic is delivered.
        if (reply !== null) {
          state = 'failed'
          return { action: 'protocol-error', error: 'second-ack' }
        }
        return { action: 'deliver', raw }
      }

      // awaiting-ack
      if (reply === null) {
        // THE PRODUCTION WEDGE, named. Application traffic arrived before the
        // handshake reply; the connection is not usable and the caller must not
        // silently retry into the same ordering.
        state = 'failed'
        return { action: 'protocol-error', error: 'traffic-before-ack' }
      }
      if (reply.type === 'peerHelloRejected') {
        state = 'failed'
        return { action: 'rejected', reply }
      }
      state = 'established'
      return {
        action: 'established',
        agreedVersion: reply.v,
        // Intersect the acceptor's answer with what this end actually offered, so
        // an acceptor cannot switch on a capability this end never advertised.
        caps: negotiateCapabilities(reply.caps, offered),
        ...(reply.name === undefined ? {} : { name: reply.name }),
        ...(reply.issuedToken === undefined ? {} : { issuedToken: reply.issuedToken }),
      }
    },
  }
}
