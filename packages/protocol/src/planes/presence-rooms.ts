import { z } from 'zod'
import { IssueId, SessionId } from '@podium/model'
import { AgentIdentityId, UserId } from './principal'

/**
 * Rooms and identity-carrying presence — ADR 7 Amendment 1 D9/D10/D16.1/D16.2.
 *
 * Rooms are a SUBSCRIPTION CONCEPT INSIDE THE STREAM PORT, not a fourth plane
 * (D10.1). Every frame here is stream · live in both directions, including the
 * answer to a join (D10.4): a room subscription dies with the connection and
 * must never be queued, replayed, retried from an outbox, or treated as
 * offline-class.
 *
 * These frames are members of the post-auth `ClientMessage` and
 * `ServerMessage` unions. D16 classified them before landing so the
 * implementer could not pick another plane; `planes/inventory.ts` now checks
 * the landed unions and this module's unions together for totality.
 */

/**
 * The CLOSED set of room-bearing entity kinds (D10.2). Extended only by
 * amending ADR 7, alongside the entity class's visibility classification on
 * ADR 1's matrix — so a kind cannot acquire a room without acquiring a
 * visibility class (ADR 9 D4's default-closed totality).
 */
export const ROOM_KINDS = ['session', 'issue'] as const
export type RoomKind = (typeof ROOM_KINDS)[number]

/**
 * Reserved, deliberately NOT joinable yet: the collaborative document arrives
 * when ADR 1's amendment lands the `op-stream` conflict class. Listed so the
 * path is not foreclosed and so nobody reads the closed set above as final.
 */
export const RESERVED_ROOM_KINDS = ['document'] as const

/**
 * A room identifier is an ENTITY REFERENCE with a branded id — never a free
 * string. A free-string room namespace has no owner, no totality test and,
 * decisively, nothing to check a permission against (D10.2).
 */
export const RoomRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), id: SessionId }),
  z.object({ kind: z.literal('issue'), id: IssueId }),
])
export type RoomRef = z.infer<typeof RoomRef>

/**
 * WHO — stamped by the server from the authenticated transport principal
 * (ADR 3 D7, D9.1). No inbound frame carries an identity field, so a spoofed
 * identity is unrepresentable rather than merely rejected. The agent variant
 * carries ADR 3 D17's attribution pair, so "your agent is watching this
 * session" needs no second identity concept.
 */
export const PresenceIdentity = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), user: UserId }),
  z.object({
    kind: z.literal('agent'),
    agentIdentity: AgentIdentityId,
    onBehalfOf: UserId,
  }),
])
export type PresenceIdentity = z.infer<typeof PresenceIdentity>

/**
 * WHAT — an OPAQUE per-room payload (cursor, selection, viewport, "typing").
 * ADR 7 does not define its contents: the payload is the room kind's business
 * and the port must not interpret it (D9.3). Its only normative properties are
 * that it is bounded in size, idempotent FULL STATE (never a delta), and
 * carries no durable truth.
 */
export const PresencePayload = z.unknown()
export type PresencePayload = unknown

/**
 * The bound in (D9.3) made concrete. A cap is a port property, so it lives with
 * the port rather than with each feature; the value is a starting point that
 * POD-317 may tighten, not a protocol constant other code should branch on.
 */
export const PRESENCE_PAYLOAD_MAX_BYTES = 4 * 1024

/** UTF-8 byte length without depending on a platform `TextEncoder`. */
const utf8Bytes = (s: string): number => {
  let bytes = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return bytes
}

export const presencePayloadWithinBudget = (payload: PresencePayload): boolean => {
  if (payload === undefined) return true
  try {
    const json = JSON.stringify(payload)
    if (json === undefined) return false
    return utf8Bytes(json) <= PRESENCE_PAYLOAD_MAX_BYTES
  } catch {
    // Unserializable payloads are refused, not truncated: the port cannot
    // bound what it cannot measure.
    return false
  }
}

/** One member of a room, as the server reports it. */
export const PresenceMember = z.object({
  identity: PresenceIdentity,
  payload: PresencePayload.optional(),
  /**
   * D9.5's forward mapping of today's `{ type: 'presence', visible }` bit: a
   * RESERVED FIELD on the presence record, still consumed by the notification
   * router — which under multi-user must ask "is THIS user watching?" rather
   * than "is anybody watching?". Not a separate frame, and not fanned out any
   * differently from the rest of the record.
   */
  visible: z.boolean().optional(),
})
export type PresenceMember = z.infer<typeof PresenceMember>

// ---- client → server (stream · live) ----

/** Join a room. Visibility-gated, default-closed (D14). */
export const PresenceSubscribeMessage = z.object({
  type: z.literal('presenceSubscribe'),
  room: RoomRef,
  /**
   * Optional correlation token: a per-frame token INSIDE the stream port, not
   * promotion to control · command (D10.4).
   */
  token: z.string().min(1).optional(),
})

/** Explicit leave. Disconnect and heartbeat-reap leaves are derived (D10.6). */
export const PresenceUnsubscribeMessage = z.object({
  type: z.literal('presenceUnsubscribe'),
  room: RoomRef,
})

/**
 * Publish this connection's payload into a joined room. Carries NO identity:
 * the server stamps it from the transport (D9.1).
 */
export const PresenceUpdateMessage = z.object({
  type: z.literal('presenceUpdate'),
  room: RoomRef,
  payload: PresencePayload.optional(),
  visible: z.boolean().optional(),
})

export const PresenceRoomClientMessage = z.discriminatedUnion('type', [
  PresenceSubscribeMessage,
  PresenceUnsubscribeMessage,
  PresenceUpdateMessage,
])
export type PresenceRoomClientMessage = z.infer<typeof PresenceRoomClientMessage>

// ---- server → client (stream · live) ----

/** Full occupancy snapshot, sent on join — never "wait for the next tick" (D10.5). */
export const PresenceRoomStateMessage = z.object({
  type: z.literal('presenceRoomState'),
  room: RoomRef,
  members: z.array(PresenceMember),
  token: z.string().min(1).optional(),
})

/** Member joined / left / updated in one room (D10.6). */
export const PresenceRoomDeltaMessage = z.object({
  type: z.literal('presenceRoomDelta'),
  room: RoomRef,
  change: z.enum(['joined', 'left', 'updated']),
  member: PresenceMember,
})

/**
 * This connection is no longer subscribed. ONE shape for every cause — join
 * refused, entity nonexistent, visibility lost, or evicted under D11.5 — with
 * no reason code (D14.3): a subscribe frame that answers differently is an
 * existence oracle with a convenient polling interface.
 */
export const PresenceRoomClosedMessage = z.object({
  type: z.literal('presenceRoomClosed'),
  room: RoomRef,
  token: z.string().min(1).optional(),
})

export const PresenceRoomServerMessage = z.discriminatedUnion('type', [
  PresenceRoomStateMessage,
  PresenceRoomDeltaMessage,
  PresenceRoomClosedMessage,
])
export type PresenceRoomServerMessage = z.infer<typeof PresenceRoomServerMessage>

/**
 * Design point for per-member per-room publish rate (readiness §3.4, D11.2),
 * enforced as a SERVER-SIDE cap: updates above it are discarded, not buffered.
 * A rate, not a delivery guarantee.
 */
export const PRESENCE_PUBLISH_RATE_HZ = { min: 30, max: 60 } as const
