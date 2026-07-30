/**
 * VERSION AND CAPABILITY NEGOTIATION — ADR 5 D3.1/D3.3 and D4.
 *
 * Both are role-blind on purpose: this module never learns which role it is
 * negotiating for. The framing is common; only authentication differs (D5). If a
 * role name ever appears in this file, the boundary has been drawn in the wrong
 * place.
 *
 * ORDER IS PART OF THE CONTRACT: version is negotiated BEFORE any credential is
 * examined, so an incompatible peer is refused without ever reaching an auth
 * strategy. That ordering is what the handshake-order regression tests pin
 * (`./acceptor.order.test.ts`).
 */

import { versionSupport } from '../version'
import {
  type HandshakeRejectReason,
  localVersionSupport,
  type PeerHelloRejected,
} from './envelope'

export type VersionOutcome =
  | { readonly ok: true; readonly agreed: number }
  | { readonly ok: false; readonly rejection: PeerHelloRejected }

/**
 * ADR 5 D3.1: incompatible peers FAIL CLOSED, and the refusal carries the
 * support window so the peer can tell its user to update rather than failing
 * later on a malformed frame.
 */
export const negotiateVersion = (
  offered: number,
  support: { wire: number; min: number } = localVersionSupport(),
): VersionOutcome => {
  const verdict = versionSupport(offered, support.wire, support.min)
  if (verdict === 'ok') return { ok: true, agreed: offered }
  return {
    ok: false,
    rejection: {
      type: 'peerHelloRejected',
      reason: 'unsupported-version' satisfies HandshakeRejectReason,
      message: verdict === 'too-old' ? 'peer wire version too old' : 'peer wire version too new',
      support,
    },
  }
}

/**
 * RESERVED capability tokens — ADR 5 D4.2's table, verbatim. H1 peers must not
 * emit them; an H1 acceptor must ignore them if seen: no auth elevation, no
 * routing to unimplemented modules, no product behavior.
 *
 * They are listed (rather than merely "unknown tokens are ignored") so the
 * conformance case of D4.4 has something concrete to inject, and so a future
 * implementer who wires one up has to delete a line that says RESERVED.
 */
export const RESERVED_CAPS = [
  'peerRole:node',
  'upstream.sync',
  'upstream.push',
  'viaHub',
  'upstreamStale',
  'pendingSync',
] as const
export type ReservedCap = (typeof RESERVED_CAPS)[number]

/** `feed.<id>` advertisement — reserved by PREFIX, so a whole family is inert. */
export const RESERVED_CAP_PREFIXES = ['feed.'] as const

export const isReservedCap = (token: string): boolean =>
  (RESERVED_CAPS as readonly string[]).includes(token) ||
  RESERVED_CAP_PREFIXES.some((prefix) => token.startsWith(prefix))

export interface CapabilityNegotiation {
  /** Tokens both sides speak — the ONLY set the connection may act on. */
  readonly accepted: readonly string[]
  /** Offered tokens this build does not implement. Ignored, kept for logs. */
  readonly ignored: readonly string[]
  /**
   * Offered tokens that are RESERVED (D4.2). Separated from `ignored` so a
   * conformance test can assert "seen, and still not granted", and so an
   * operator log can say a peer is emitting something it must not.
   */
  readonly reserved: readonly string[]
}

/**
 * ADR 5 D3.3: additive open string tokens; unknown caps are ignored; absence
 * means legacy defaults. The result is an INTERSECTION — never the offer echoed
 * back — so a peer cannot grant itself a capability by naming it.
 */
export const negotiateCapabilities = (
  offered: readonly string[],
  supported: readonly string[],
): CapabilityNegotiation => {
  const supportedSet = new Set(supported)
  const accepted: string[] = []
  const ignored: string[] = []
  const reserved: string[] = []
  for (const token of offered) {
    if (isReservedCap(token)) {
      // Reserved tokens are never accepted, even if this build happens to list
      // one as supported — a reserved token has no H1 meaning to grant.
      reserved.push(token)
      continue
    }
    if (supportedSet.has(token)) accepted.push(token)
    else ignored.push(token)
  }
  return { accepted, ignored, reserved }
}
