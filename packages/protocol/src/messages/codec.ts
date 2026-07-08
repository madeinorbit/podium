import { z } from 'zod'
import { ClientMessage } from './client'
import { ControlMessage } from './control'
import { DaemonMessage } from './daemon'
import { DaemonHandshake, DaemonHandshakeReply } from './daemon-handshake'
import { ConversationSummaryWire } from './discovery'
import { HostMetricsWire } from './host'
import { IssueWire } from './issues'
import { ServerMessage } from './server'
import { SessionMeta } from './runtime-state'
import { MetadataChange } from './sync'

// Codecs. parse* functions throw on malformed JSON (SyntaxError) or on a schema
// mismatch (ZodError); callers handle both.
// ---- codec ----
// The handshake frames (pair/hello and their replies) ride the same wire but are
// deliberately outside the Control/Daemon unions — they're exchanged before a
// daemon is authenticated. encode() must still serialize them on both sides.
type AnyMessage =
  | ClientMessage
  | ServerMessage
  | DaemonMessage
  | ControlMessage
  | DaemonHandshake
  | DaemonHandshakeReply

export function encode(msg: AnyMessage): string {
  return JSON.stringify(msg)
}

export function parseClientMessage(raw: string): ClientMessage {
  return ClientMessage.parse(JSON.parse(raw))
}
export function parseServerMessage(raw: string): ServerMessage {
  return ServerMessage.parse(JSON.parse(raw))
}

/** Server messages carrying a homogeneous array we can quarantine per-element. */
const COLLECTION_MESSAGE_ELEMENTS: Record<string, { key: string; element: z.ZodTypeAny }> = {
  sessionsChanged: { key: 'sessions', element: SessionMeta },
  issuesChanged: { key: 'issues', element: IssueWire },
  conversationsChanged: { key: 'conversations', element: ConversationSummaryWire },
  hostMetricsChanged: { key: 'hosts', element: HostMetricsWire },
  // One poisoned change row must not blank the stream — but unlike list messages,
  // a DROPPED change is a cursor gap the client can't see, so the SocketHub treats
  // any quarantined metadataDelta element as a gap and heals via changesSince.
  metadataDelta: { key: 'changes', element: MetadataChange },
}

export interface LenientServerMessage {
  /** The parsed message, or null only if the structural envelope was invalid. */
  message: ServerMessage | null
  /** How many array elements were quarantined (invalid) and dropped. */
  dropped: number
}

/**
 * Like {@link parseServerMessage}, but for the collection-bearing messages
 * (`sessionsChanged`/`issuesChanged`/`conversationsChanged`/`hostMetricsChanged`)
 * it validates each array element individually and DROPS the invalid ones instead
 * of failing the whole batch. One poisoned element (e.g. a session with an
 * out-of-enum agentKind) can no longer blank an entire list on the client.
 *
 * Throws only when the frame is structurally unparseable (bad JSON, or an envelope
 * whose non-array fields fail validation) — the caller should catch + log that, and
 * inspect `dropped` to surface quarantined elements.
 */
export function parseServerMessageLenient(raw: string): LenientServerMessage {
  const json = JSON.parse(raw) as Record<string, unknown>
  const spec = typeof json?.type === 'string' ? COLLECTION_MESSAGE_ELEMENTS[json.type] : undefined
  const arr = spec ? json[spec.key] : undefined
  if (spec && Array.isArray(arr)) {
    const good: unknown[] = []
    let dropped = 0
    for (const el of arr) {
      const r = spec.element.safeParse(el)
      if (r.success) good.push(r.data)
      else dropped++
    }
    return { message: ServerMessage.parse({ ...json, [spec.key]: good }), dropped }
  }
  return { message: ServerMessage.parse(json), dropped: 0 }
}
export function parseDaemonMessage(raw: string): DaemonMessage {
  return DaemonMessage.parse(JSON.parse(raw))
}
export function parseControlMessage(raw: string): ControlMessage {
  return ControlMessage.parse(JSON.parse(raw))
}
