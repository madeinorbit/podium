import {
  encodePairingEnvelope,
  MachineJoinEnvelope,
  type MachineJoinEnvelope as MachineJoinEnvelopeType,
} from '@podium/protocol'

/** Compatibility name for the v1 daemon-join schema. The codec now lives in RN-safe protocol. */
export const JoinPayload = MachineJoinEnvelope
export type JoinPayload = MachineJoinEnvelopeType

export function encodeJoin(p: JoinPayload): string {
  return encodePairingEnvelope(JoinPayload.parse(p))
}

/** Decode + validate. Throws on malformed base64url, bad JSON, or schema mismatch. */
export function decodeJoin(token: string): JoinPayload {
  // Preserve the original v1 decoder's deliberately permissive Buffer semantics:
  // deployed join tokens may have acquired standard-base64 characters, whitespace,
  // or padding while passing through shells and copy/paste surfaces. Mobile v2 uses
  // the strict protocol decoder; this compatibility facade remains v1-only.
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
  } catch {
    throw new Error('invalid join token (not JSON)')
  }
  return JoinPayload.parse(value)
}
