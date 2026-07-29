import type { DaemonHandshake, DaemonHandshakeReply } from '../messages/daemon-handshake'
import {
  CLIENT_PLANE_CLASS,
  CONTROL_PLANE_CLASS,
  DAEMON_PLANE_CLASS,
  SERVER_PLANE_CLASS,
} from '../messages/message-class'
import type { PlaneClass } from './plane'
import type { PresenceRoomClientMessage, PresenceRoomServerMessage } from './presence-rooms'
import type { ScopedFeedServerMessage } from './scoped-feed'

/**
 * THE TOTALITY INVENTORY — ADR 7 D6, extended by Amendment 1 D16.
 *
 * Predicate: every message type on every surface maps to EXACTLY ONE
 * plane·class, and the mapping COMPILES. The four post-auth WS unions carry
 * their classification in `messages/message-class.ts` (the defining source, kept
 * next to the unions so a new frame is a compile error there); this module adds
 * the surfaces that live outside those unions — pre-auth handshake, the tRPC/HTTP
 * control and bulk surfaces, the messaging substrate, workflows — and the frames
 * ADR 7 Amendment 1 classified BEFORE they land on the wire.
 *
 * Counts are RE-DERIVED from the code at the implementing baseline, never copied
 * from prose (D6's discipline, restated by D16). `inventory.test.ts` re-derives
 * them from the zod unions and fails if a table and its union disagree.
 */

/** Pre-auth handshake (ADR 7 D6.5). Framing/auth strategy is ADR 5 / POD-317. */
export const HANDSHAKE_PLANE_CLASS = {
  pair: 'control.handshake',
  hello: 'control.handshake',
  paired: 'control.handshake',
  pairRejected: 'control.handshake',
  helloOk: 'control.handshake',
  helloRejected: 'control.handshake',
} as const satisfies Record<
  DaemonHandshake['type'] | DaemonHandshakeReply['type'],
  'control.handshake'
>

/**
 * Rooms and identity-carrying presence (Amendment 1 D16.1/D16.2). All stream ·
 * live in BOTH directions, including the answer to a join (D10.4): a room
 * subscription dies with the connection and must never be queued or replayed.
 *
 * These frames are not yet members of `ClientMessage` / `ServerMessage` — POD-1078
 * lands them there, and the counts below stay a statement about today's tree. The
 * classification binds now precisely so the implementer does not pick the plane.
 */
export const PRESENCE_ROOM_CLIENT_PLANE_CLASS = {
  presenceSubscribe: 'stream.live',
  presenceUnsubscribe: 'stream.live',
  presenceUpdate: 'stream.live',
} as const satisfies Record<PresenceRoomClientMessage['type'], 'stream.live'>

export const PRESENCE_ROOM_SERVER_PLANE_CLASS = {
  presenceRoomState: 'stream.live',
  presenceRoomDelta: 'stream.live',
  presenceRoomClosed: 'stream.live',
} as const satisfies Record<PresenceRoomServerMessage['type'], 'stream.live'>

/**
 * Multi-user control-plane frames (Amendment 1 D16.3). `rescope` is a new frame
 * and is control · entity — it changes which durable rows a replica may hold and
 * must be ordered against the feed. A WATERMARK gains no row: ADR 2
 * Amendment 1 D13 makes it the existing `metadataDelta` frame with a covered
 * range and an empty change list. `evict` gains no row either: it is a new value
 * in the change-op enum, not a frame.
 */
export const SCOPED_FEED_PLANE_CLASS = {
  rescope: 'control.entity',
} as const satisfies Record<ScopedFeedServerMessage['type'], 'control.entity'>

/** Non-WS surfaces the gateway owns (ADR 7 D6.6–D6.8). */
export interface SurfaceClassification {
  readonly surface: string
  readonly planeClass: PlaneClass
  readonly note: string
}

export const NON_WS_SURFACE_INVENTORY = [
  {
    surface: 'tRPC entity reads / catch-up (sync.changesSince, list/get queries)',
    planeClass: 'control.entity',
    note: 'Catch-up of entity truth; a certified reply under ADR 2 Amd 1 D13.',
  },
  {
    surface: 'tRPC mutations across the namespace set',
    planeClass: 'control.command',
    note: 'Offline-class per ADR 3 D4; MutationEnvelope/MutationResult are this class.',
  },
  {
    surface: 'tRPC features.state',
    planeClass: 'control.command',
    note: 'Control-plane query, explicitly NOT stream (ADR 7 D6.6).',
  },
  {
    surface: 'tRPC workflows.*',
    planeClass: 'control.command',
    note: 'No WS *Changed family today; promotion to entity is an ADR 7 amendment (D6.8).',
  },
  {
    surface: 'Operator/agent mail (messages.* tRPC + agent-relay procs)',
    planeClass: 'control.command',
    note: 'Delivery ledger is feature storage, not a plane (D6.7).',
  },
  {
    surface:
      'HTTP bulk: sessions.transcriptRead, large files.read, GET /files/asset, /files/artifact',
    planeClass: 'bulk.bulk',
    note: 'Paged, lazy, point-to-point; never fanned out (D6.6).',
  },
  {
    surface: 'POST /mcp',
    planeClass: 'control.command',
    note: 'Command surface (D6.6).',
  },
  {
    surface: 'Agent relay HTTP /agent/<sessionId> (daemon loopback only)',
    planeClass: 'control.command',
    note: 'AGENT RELAY ONLY — never the browser; the D2 port rule governs it.',
  },
  {
    surface: '/auth/*, /setup/*',
    planeClass: 'control.handshake',
    note: 'Version + role auth surface (ADR 5); /health and /version are ops, not a plane.',
  },
] as const satisfies readonly SurfaceClassification[]

/**
 * OUTSIDE the three peer planes, stated so the inventory is honest about it
 * (D6.7): external chat adapters sit on the in-process bus plus webhook/long-poll
 * ([spec:SP-5d81]), with NO tRPC on the external edge, and the in-process
 * `EventBus` is not a wire plane at all — features translate bus → plane sends.
 */
export const OUTSIDE_THE_PLANES = [
  'External chat (Telegram adapter): bus + webhook/long-poll, no tRPC edge',
  'In-process EventBus (apps/server/src/modules/bus.ts)',
] as const

/** Every post-auth WS table, keyed by the union it is total over. */
export const POST_AUTH_PLANE_CLASS_TABLES = {
  ServerMessage: SERVER_PLANE_CLASS,
  ClientMessage: CLIENT_PLANE_CLASS,
  ControlMessage: CONTROL_PLANE_CLASS,
  DaemonMessage: DAEMON_PLANE_CLASS,
} as const

/** Frames classified ahead of their wire landing (Amendment 1 D16). */
export const PENDING_FRAME_PLANE_CLASS_TABLES = {
  PresenceRoomClientMessage: PRESENCE_ROOM_CLIENT_PLANE_CLASS,
  PresenceRoomServerMessage: PRESENCE_ROOM_SERVER_PLANE_CLASS,
  ScopedFeedServerMessage: SCOPED_FEED_PLANE_CLASS,
} as const

const countOf = (table: Record<string, PlaneClass>): number => Object.keys(table).length

/**
 * Counts re-derived from the tables above. `inventory.test.ts` checks each against
 * its zod union, so these numbers cannot drift from the code the way a number in
 * prose can.
 */
export const PLANE_INVENTORY_COUNTS = {
  ServerMessage: countOf(SERVER_PLANE_CLASS),
  ClientMessage: countOf(CLIENT_PLANE_CLASS),
  ControlMessage: countOf(CONTROL_PLANE_CLASS),
  DaemonMessage: countOf(DAEMON_PLANE_CLASS),
  postAuthWsTotal:
    countOf(SERVER_PLANE_CLASS) +
    countOf(CLIENT_PLANE_CLASS) +
    countOf(CONTROL_PLANE_CLASS) +
    countOf(DAEMON_PLANE_CLASS),
  handshake: countOf(HANDSHAKE_PLANE_CLASS),
  pendingFrames:
    countOf(PRESENCE_ROOM_CLIENT_PLANE_CLASS) +
    countOf(PRESENCE_ROOM_SERVER_PLANE_CLASS) +
    countOf(SCOPED_FEED_PLANE_CLASS),
} as const

/**
 * Classify one type on one surface. Returns `null` for an unknown type — a
 * gateway that cannot classify a frame must refuse it, never guess a plane
 * (POD-317's "no local reclassification" rule).
 */
export const planeClassOf = (
  surface: keyof typeof POST_AUTH_PLANE_CLASS_TABLES,
  type: string,
): PlaneClass | null => {
  const table: Record<string, PlaneClass> = POST_AUTH_PLANE_CLASS_TABLES[surface]
  return table[type] ?? null
}
