import {
  decodePairingEnvelope,
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
  return JoinPayload.parse(decodePairingEnvelope(token))
}
