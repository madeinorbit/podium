import {
  AutomationRunWire,
  AutomationWire,
  ConversationSummaryWire,
  HostMetricsWire,
  IssueWire,
  SessionMeta,
} from '@podium/model'
import type { z } from 'zod'
import { ClientMessage } from './client'
import { ControlMessage } from './control'
import { DaemonMessage } from './daemon'
import type { DaemonHandshake, DaemonHandshakeReply } from './daemon-handshake'
import {
  type FeedBootstrapMessage,
  FeedBootstrapMessageLenient,
  FeedChangeLenient,
  type FeedDeltaMessage,
  FeedDeltaMessageLenient,
} from './feed'
import { ServerMessage } from './server'
import {
  MetadataChangeLenient,
  type MetadataDeltaMessage,
  MetadataDeltaMessageLenient,
} from './sync'

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

/**
 * Server messages carrying a homogeneous array we can quarantine per-element:
 * which key holds the array, which schema each element must satisfy, and which
 * schema validates what is left once the bad elements are gone.
 *
 * `envelope` is the strict `ServerMessage` for most of them. The change-carrying
 * frames name a LENIENT envelope instead, because their element schema admits
 * rows the strict union rejects (a kind this build has no arm for), so
 * re-validating the survivors against `ServerMessage` would undo the quarantine.
 *
 * THE FEED FAMILY IS ON THIS TABLE BECAUSE OF POD-1610. It was not, and the cost
 * was the whole outage: one row a stale bundle could not read — an `issue` whose
 * payload had moved on — threw the entire `feedBootstrap`, so the client got no
 * rows at all and rendered an empty app. Every other collection on this wire had
 * already learned that one poisoned element must not blank a list; the frame
 * family that carries EVERYTHING had not.
 */
const QUARANTINABLE: Record<
  string,
  { key: string; element: z.ZodTypeAny; envelope?: z.ZodTypeAny }
> = {
  sessionsChanged: { key: 'sessions', element: SessionMeta },
  issuesChanged: { key: 'issues', element: IssueWire },
  conversationsChanged: { key: 'conversations', element: ConversationSummaryWire },
  automationsChanged: { key: 'automations', element: AutomationWire },
  automationRunsChanged: { key: 'automationRuns', element: AutomationRunWire },
  hostMetricsChanged: { key: 'hosts', element: HostMetricsWire },
  // Kind-tolerant ([spec:SP-3fe2] #258): unknown entity kinds PASS (the consumer
  // ignores the row but advances its cursor past it — a newer server must not
  // heal-loop an older client), while a kind this build HAS an arm for carrying
  // an invalid value is still quarantined.
  metadataDelta: {
    key: 'changes',
    element: MetadataChangeLenient,
    envelope: MetadataDeltaMessageLenient,
  },
  feedDelta: { key: 'changes', element: FeedChangeLenient, envelope: FeedDeltaMessageLenient },
  feedBootstrap: {
    key: 'changes',
    element: FeedChangeLenient,
    envelope: FeedBootstrapMessageLenient,
  },
}

/** What {@link parseServerMessageLenient} yields: the strict union, except the
 *  change-carrying frames, whose rows are kind-tolerant ([spec:SP-3fe2] #258 — a
 *  NEWER server may stream entity kinds this build doesn't know; consumers
 *  ignore those rows but must still see them to advance the cursor). */
export type ServerMessageLenient =
  | Exclude<ServerMessage, MetadataDeltaMessage | FeedDeltaMessage | FeedBootstrapMessage>
  | MetadataDeltaMessageLenient
  | FeedDeltaMessageLenient
  | FeedBootstrapMessageLenient

export interface LenientServerMessage {
  /** The parsed message, or null only if the structural envelope was invalid. */
  message: ServerMessageLenient | null
  /** How many array elements were quarantined (invalid) and dropped. */
  dropped: number
}

/**
 * Like {@link parseServerMessage}, but for every message on {@link QUARANTINABLE}
 * it validates each array element individually and DROPS the invalid ones instead
 * of failing the whole batch. One poisoned element (a session with an out-of-enum
 * agentKind, an issue row whose payload the build predates) can no longer blank
 * an entire list — or, for the feed frames, the entire app.
 *
 * A quarantined change is a cursor gap the client cannot see, so callers treat
 * `dropped > 0` as a gap: heal on the v1 wire, and — since POD-1610 — SURFACE it,
 * because a drop nobody can see is indistinguishable from a server with nothing
 * to say.
 *
 * Throws only when the frame is structurally unparseable (bad JSON, or an envelope
 * whose non-array fields fail validation) — the caller should catch + log that.
 */
export function parseServerMessageLenient(raw: string): LenientServerMessage {
  const json = JSON.parse(raw) as Record<string, unknown>
  const spec = typeof json?.type === 'string' ? QUARANTINABLE[json.type] : undefined
  const arr = spec ? json[spec.key] : undefined
  if (spec && Array.isArray(arr)) {
    const good: unknown[] = []
    let dropped = 0
    for (const el of arr) {
      const r = spec.element.safeParse(el)
      if (r.success) good.push(r.data)
      else dropped++
    }
    const envelope = spec.envelope ?? ServerMessage
    return {
      message: envelope.parse({ ...json, [spec.key]: good }) as ServerMessageLenient,
      dropped,
    }
  }
  return { message: ServerMessage.parse(json), dropped: 0 }
}
export function parseDaemonMessage(raw: string): DaemonMessage {
  return DaemonMessage.parse(JSON.parse(raw))
}
export function parseControlMessage(raw: string): ControlMessage {
  return ControlMessage.parse(JSON.parse(raw))
}
