/**
 * THE CLIENT MUX'S ROUTING TABLE — which FEATURE PORT owns each inbound client
 * frame (POD-390, the `/client` mirror of `daemon-frame-routing.ts`).
 *
 * The gateway owns no feature logic. What it owns is this table: a total,
 * compile-checked map from `ClientMessage['type']` to the port that handles it.
 * Adding a client frame without naming its owner is a compile error here.
 *
 * THE PLANE IS NOT RE-DERIVED HERE. ADR 7's inventory (`CLIENT_PLANE_CLASS`) is
 * the single classification source; this module READS it and refuses anything it
 * cannot classify. POD-317's "no local reclassification" rule is why no plane
 * literal appears in this file.
 *
 * FAIL CLOSED. `clientPortsFor` / `clientPlaneClassFor` return `null` for an
 * unknown type and the mux DROPS such a frame. An unknown input that fell
 * through to a `default:` — which is what the pre-extraction `switch` did, its
 * default being "silently do nothing" — is an unknown input failing OPEN the
 * moment any port gains a catch-all. Both lookups must answer, so a frame
 * classified in ADR 7's inventory but forgotten here (or the reverse) is refused
 * rather than guessed at.
 */

import { CLIENT_PLANE_CLASS, type ClientMessage, type PlaneClass } from '@podium/protocol'

/**
 * The ports the client edge routes to.
 *
 * `transport` is the gateway's OWN port and holds exactly one frame: `ping`,
 * whose reply is `pong`. A liveness echo has no feature content — it was only in
 * the sessions switch because the switch was there — and naming it as its own
 * owner keeps the table honest about the fact that the gateway answers it.
 */
export const CLIENT_PORT_IDS = ['sessions', 'presence', 'transport'] as const
export type ClientPortId = (typeof CLIENT_PORT_IDS)[number]

/**
 * Frame → owning port, TOTAL over `ClientMessage`. Single-owner throughout: no
 * client frame is dual-routed today, and the array shape is kept (rather than a
 * bare id) so adding a second owner later is a table edit, not a type change —
 * the daemon table already carries one such row (`scanResult`).
 */
export const CLIENT_FRAME_PORTS = {
  // ---- session-owned: everything that names a session, plus the connection's
  // own negotiation (`hello` carries caps + the reconnect reclaim, both of which
  // are session-view state).
  hello: ['sessions'],
  attach: ['sessions'],
  detach: ['sessions'],
  input: ['sessions'],
  resize: ['sessions'],
  requestControl: ['sessions'],
  redrawRequest: ['sessions'],
  transcriptSubscribe: ['sessions'],
  transcriptUnsubscribe: ['sessions'],
  presence: ['presence'],
  viewState: ['sessions'],
  setSessionDraft: ['sessions'],
  draftEdit: ['sessions'],
  sessionOpenUrlCallback: ['sessions'],
  sessionOpenUrlDismiss: ['sessions'],

  // ---- gateway stream port ----
  presenceSubscribe: ['presence'],
  presenceUnsubscribe: ['presence'],
  presenceUpdate: ['presence'],

  // ---- gateway transport ----
  ping: ['transport'],
} as const satisfies Record<ClientMessage['type'], readonly [ClientPortId, ...ClientPortId[]]>

/** The session-owned subset, as a type — the sessions port's frame argument. */
export type SessionsClientFrameType = {
  [K in keyof typeof CLIENT_FRAME_PORTS]: (typeof CLIENT_FRAME_PORTS)[K] extends readonly [
    'sessions',
  ]
    ? K
    : never
}[keyof typeof CLIENT_FRAME_PORTS]

export type SessionsClientFrame = Extract<ClientMessage, { type: SessionsClientFrameType }>

/**
 * Which port(s) own a frame, or `null` when the type is unknown. A null answer
 * means REFUSE — the gateway never guesses an owner, exactly as it never guesses
 * a plane.
 */
export const clientPortsFor = (type: string): readonly ClientPortId[] | null => {
  const table: Record<string, readonly ClientPortId[]> = CLIENT_FRAME_PORTS
  return table[type] ?? null
}

/** The frame's ADR 7 plane·class, read from the inventory. Never re-derived. */
export const clientPlaneClassFor = (type: string): PlaneClass | null => {
  const table: Record<string, PlaneClass> = CLIENT_PLANE_CLASS
  return table[type] ?? null
}
