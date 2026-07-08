import type { ServerMessage } from '@podium/protocol'

/**
 * Server→client message classification (issue #190).
 *
 * Every ServerMessage type is deliberately classified as either:
 *
 * - `durable`: carries entity truth a reconnecting client must be able to
 *   recover. These messages may ONLY be produced by the write funnel's publish
 *   tail (modules/funnel — oplog append before fan-out) so `sync.changesSince`
 *   never has a hole. A raw fan-out of one of these is a bug.
 * - `live`: a genuinely ephemeral stream or connection-scoped frame (terminal
 *   output, spinner-rate title/state updates, keystroke draft sync, pings,
 *   attention toasts). Loss on disconnect is fine — the durable truth either
 *   doesn't exist or arrives via a later durable snapshot/delta. These are
 *   fanned out raw via {@link LiveServerMessage}-typed sends.
 *
 * The `satisfies` clause makes the registry TOTAL over ServerMessage: adding a
 * message type without classifying it here is a compile error, so an
 * unclassified raw send can't slip in.
 */
export const MESSAGE_CLASS = {
  // Durable entity snapshots/deltas — funnel-only.
  sessionsChanged: 'durable',
  issuesChanged: 'durable',
  issueUpdated: 'durable',
  conversationsChanged: 'durable',
  metadataDelta: 'durable',

  // Connection-scoped handshake/keepalive frames (single client, not fan-out).
  welcome: 'live',
  attached: 'live',
  pong: 'live',

  // Ephemeral per-session streams: the durable truth lands in the next
  // sessionsChanged / transcript lake read; these only keep open views hot.
  outputFrame: 'live',
  transcriptDelta: 'live',
  controllerChanged: 'live',
  geometry: 'live',
  agentExit: 'live',
  sessionTitleChanged: 'live',
  sessionAgentStateChanged: 'live',
  sessionDraftChanged: 'live',
  headlessActivity: 'live',

  // Advisory broadcasts re-served in full on attach — not (yet) oplog entities.
  // machinesChanged is a candidate for a durable entity kind; that is a
  // deliberate follow-up, not a silent reclassification here.
  machinesChanged: 'live',
  hostMetricsChanged: 'live',
  attentionEvent: 'live',
} as const satisfies Record<ServerMessage['type'], 'durable' | 'live'>

/** The message types a raw (non-funnel) send may carry. */
export type LiveMessageType = {
  [K in keyof typeof MESSAGE_CLASS]: (typeof MESSAGE_CLASS)[K] extends 'live' ? K : never
}[keyof typeof MESSAGE_CLASS]

/** A ServerMessage that is classified live-only — the ONLY shape accepted by
 *  the raw client fan-out helpers. Durable messages fail this type. */
export type LiveServerMessage = Extract<ServerMessage, { type: LiveMessageType }>
