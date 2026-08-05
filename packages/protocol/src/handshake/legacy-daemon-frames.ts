/**
 * THE ONE LEGACY ADAPTER — ADR 5 D3.1 and POD-308.
 *
 * "The *mechanism* is permanent; any N/N−1 legacy adapter is a separately
 * expiring deletion-audit item (POD-308), not a second protocol." This file is
 * that adapter and nothing more: it translates today's `pair` / `hello` frames
 * (`../messages/daemon-handshake.ts`) into the permanent hello envelope on the
 * way in, and the permanent reply back into `paired` / `helloOk` /
 * `pairRejected` / `helloRejected` on the way out.
 *
 * Everything downstream — version negotiation, role resolution, the strategy
 * modules, the principal — sees only the permanent envelope. That is the point:
 * a legacy peer must not reach a second auth path, because two auth paths is how
 * one of them stops getting the fixes.
 *
 * WHEN THIS FILE DIES: when no shipped daemon still sends `pair`/`hello`. It is
 * deliberately one small file with one dependency direction so deleting it is a
 * deletion, not a refactor.
 */

import type { z } from 'zod'
import type {
  DaemonHandshake,
  DaemonHandshakeReply,
  PairFrame,
} from '../messages/daemon-handshake'
import { WIRE_VERSION } from '../version'
import type { PeerHello, PeerHelloReply } from './envelope'

/** Did this raw frame come from a pre-envelope daemon? */
export const isLegacyDaemonFrame = (parsed: unknown): boolean => {
  if (typeof parsed !== 'object' || parsed === null) return false
  const type = (parsed as { type?: unknown }).type
  return type === 'pair' || type === 'hello'
}

/**
 * Legacy frame → permanent envelope.
 *
 * The legacy `hello` carries `machineId` alongside its token. It becomes
 * `machineHint` (a lookup narrowing) plus an INERT claim — never the resolved
 * identity, which comes from the record the token verified against.
 */
export const helloFromLegacyDaemonFrame = (frame: DaemonHandshake): PeerHello =>
  frame.type === 'pair'
    ? {
        type: 'peerHello',
        // A legacy peer never negotiated a version on the frame; it is on the
        // upgrade query string (`?v=`), which the gateway already gates. Wire
        // version 1 is the only version those peers speak.
        v: WIRE_VERSION,
        peerRole: 'machine',
        caps: [],
        credential: { kind: 'pairCode', code: frame.code },
        claims: legacyClaims(frame),
      }
    : {
        type: 'peerHello',
        v: WIRE_VERSION,
        peerRole: 'machine',
        caps: [],
        credential: { kind: 'machineToken', token: frame.token, machineHint: frame.machineId },
        claims: { machineId: frame.machineId, hostname: frame.hostname },
      }

const legacyClaims = (frame: z.infer<typeof PairFrame>): PeerHello['claims'] => ({
  machineId: frame.machineId,
  hostname: frame.hostname,
  ...(frame.name === undefined ? {} : { name: frame.name }),
})

/**
 * Permanent reply → legacy reply. `paired` must carry the minted token and the
 * settled name; `helloOk` carries the settled name and the current server key.
 * The rejection branch keeps
 * today's human-readable reason where the strategy supplied one — and falls back
 * to the closed reason code otherwise, which discloses nothing.
 */
export const legacyReplyFor = (
  frame: DaemonHandshake,
  reply: PeerHelloReply,
): DaemonHandshakeReply => {
  if (reply.type === 'peerHelloRejected') {
    const reason = reply.message ?? reply.reason
    return frame.type === 'pair'
      ? { type: 'pairRejected', reason }
      : { type: 'helloRejected', reason }
  }
  if (frame.type === 'pair')
    return {
      type: 'paired',
      // A pair that produced no token is a contract violation upstream, not a
      // recoverable state: the daemon would persist nothing and loop.
      token: reply.issuedToken ?? '',
      // The id the ACCEPTOR resolved, falling back to the peer's proposal only
      // when the acceptor did not name one.
      machineId: reply.assignedId ?? frame.machineId,
      name: reply.name ?? frame.name ?? frame.hostname,
      ...(reply.updatePubkey === undefined ? {} : { updatePubkey: reply.updatePubkey }),
    }
  return {
    type: 'helloOk',
    name: reply.name ?? frame.hostname,
    ...(reply.updatePubkey === undefined ? {} : { updatePubkey: reply.updatePubkey }),
  }
}
