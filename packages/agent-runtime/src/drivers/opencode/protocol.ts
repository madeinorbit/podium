/**
 * THE PINNED opencode WIRE SHAPES (POD-1761 W5; plan §2).
 *
 * ---------------------------------------------------------------------------
 * READ OFF A LIVE SERVER, NOT OFF A DOCUMENT
 * ---------------------------------------------------------------------------
 *
 * Every schema below was pinned from `GET /doc` on opencode 1.18.16 and then
 * EXERCISED against a running server — a real turn, a real bash permission ask
 * answered `once`, a real question ask answered by label. The recorded frames
 * live in `./__fixtures__` and `./protocol.test.ts` parses them with these exact
 * schemas, so the day upstream renames a field the test goes red here rather
 * than the driver going quiet in production.
 *
 * Three shapes contradicted what the repo believed, and each is called out at
 * its definition below, because rediscovering them costs an afternoon:
 * the permission reply ROUTE, the create-vs-prompt MODEL key asymmetry, and the
 * `?directory=` query parameter without which the event stream is silently
 * empty.
 *
 * ---------------------------------------------------------------------------
 * WHY ZOD, AND WHY NON-STRICT
 * ---------------------------------------------------------------------------
 *
 * Parsing rather than casting is what makes the version gate meaningful: a gate
 * that admits a version whose payloads then flow through as `undefined` has
 * checked a number and nothing else. The objects are deliberately NOT `.strict()`
 * — opencode adds fields to these payloads constantly (it added `variant` to the
 * session model mid-1.18) and an added field is not a breaking change. A REMOVED
 * or RENAMED one is, and that is exactly what a non-strict object still catches.
 *
 * The union of event arms is deliberately PARTIAL. opencode's `/doc` lists 89
 * event types; this driver consumes eleven. An arm we do not consume must be
 * IGNORED, never rejected — {@link parseOpencodeEvent} returns `null` for it,
 * because a driver that failed on `pty.created` would break every time upstream
 * shipped a feature we do not use.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** `ses_…`. UNBRANDED BY DECISION: an opencode-native session id, not a Podium
 *  `SessionId`. The two are related only by the binding. */
export const OpencodeSessionId = z.string().min(1)
export type OpencodeSessionId = z.infer<typeof OpencodeSessionId>

// ---------------------------------------------------------------------------
// REST payloads
// ---------------------------------------------------------------------------

/**
 * `POST /session?directory=<abs>` → 200.
 *
 * Only the fields the driver reads are declared. `title`, `directory` and
 * `model` are what the binding and the state projection need; the cost/token
 * accounting rides `usage()`.
 */
export const OpencodeSession = z.object({
  id: OpencodeSessionId,
  directory: z.string().optional(),
  title: z.string().optional(),
  parentID: z.string().optional(),
  version: z.string().optional(),
  model: z
    .object({
      /** NOTE THE KEY. Create and read call it `id`; PROMPT calls the same
       *  thing `modelID` — see {@link OpencodePromptBody}. Getting this
       *  backwards yields a 400 whose message names neither field. */
      id: z.string(),
      providerID: z.string(),
      variant: z.string().optional(),
    })
    .optional(),
  tokens: z
    .object({
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({ read: z.number(), write: z.number() }),
    })
    .optional(),
  cost: z.number().optional(),
  time: z.object({ created: z.number(), updated: z.number().optional() }).optional(),
})
export type OpencodeSession = z.infer<typeof OpencodeSession>

/** One permission rule on a session's ruleset — how the driver ASKS opencode to
 *  ask us. `action: 'ask'` is what turns a tool call into a `permission.asked`. */
export interface OpencodePermissionRule {
  permission: string
  pattern: string
  action: 'ask' | 'allow' | 'deny'
}

/**
 * `POST /session/{id}/prompt_async?directory=<abs>` → **204 No Content**.
 *
 * 204 IS THE ACK, and it is the whole basis of this driver's `accepted` receipt:
 * opencode has taken the turn. It is emphatically NOT "the turn finished" — the
 * blocking sibling `POST /session/{id}/message` is the one that waits, and the
 * plan is explicit that using it would make `accepted` mean the wrong thing.
 */
export interface OpencodePromptBody {
  parts: readonly { type: 'text'; text: string }[]
  /** THE ASYMMETRY: `modelID` here, `id` on the session. */
  model?: { providerID: string; modelID: string }
  agent?: string
  system?: string
  variant?: string
}

/** `POST /permission/{requestID}/reply?directory=<abs>` → 200 `true`.
 *
 *  THE ROUTE THE PLAN GOT WRONG. The older `POST /session/{id}/permissions/{id}`
 *  still exists in 1.18.16; this is the one that was exercised end-to-end, and
 *  its three replies are exactly the vocabulary spec §4 asked for. */
export type OpencodePermissionReply = 'once' | 'always' | 'reject'

/** `POST /question/{requestID}/reply?directory=<abs>` → 200 `true`.
 *
 *  ANSWERS ARE LABELS, NOT INDICES — one array of selected labels per question,
 *  in question order. A driver that sent indices would be answering a different
 *  question every time the options reordered. */
export type OpencodeQuestionAnswers = readonly (readonly string[])[]

// ---------------------------------------------------------------------------
// Transcript material
// ---------------------------------------------------------------------------

/**
 * A message's `info` — the half `packages/transcript`'s opencode mapper reads as
 * `messageData`.
 *
 * DECLARED LOOSELY ON PURPOSE. The mapper takes a JSON STRING and reads `role`
 * out of it; re-declaring opencode's whole message shape here would be a second
 * source of truth for a structure only that mapper interprets. What this schema
 * pins is the part the DRIVER reads: identity, role, and the times that make an
 * event's `at` a real event time.
 */
export const OpencodeMessageInfo = z
  .object({
    id: z.string().min(1),
    sessionID: OpencodeSessionId,
    role: z.enum(['user', 'assistant', 'system']),
    time: z
      .object({ created: z.number().optional(), completed: z.number().optional() })
      .optional(),
    modelID: z.string().optional(),
    providerID: z.string().optional(),
    /** `stop`, `length`, … — present once the assistant turn closes. */
    finish: z.string().optional(),
    tokens: z
      .object({
        input: z.number().optional(),
        output: z.number().optional(),
        reasoning: z.number().optional(),
        cache: z.object({ read: z.number(), write: z.number() }).partial().optional(),
      })
      .passthrough()
      .optional(),
    cost: z.number().optional(),
  })
  .passthrough()
export type OpencodeMessageInfo = z.infer<typeof OpencodeMessageInfo>

/**
 * One part — the half the mapper reads as `partData`.
 *
 * PASSTHROUGH IS LOAD-BEARING HERE, not laziness: `opencodePartToItems` reads
 * `text`, `tool`, `state.input`, `state.output` and `callID` off the RAW part,
 * and stripping unknown keys would hand it an object with the tool payload
 * removed. The driver reads only `type`, `id` and `messageID`; everything else
 * is carried through verbatim to the one place that understands it.
 */
export const OpencodePart = z
  .object({
    id: z.string().min(1),
    messageID: z.string().min(1),
    sessionID: OpencodeSessionId,
    type: z.string().min(1),
    time: z.object({ start: z.number().optional(), end: z.number().optional() }).optional(),
  })
  .passthrough()
export type OpencodePart = z.infer<typeof OpencodePart>

/** `GET /session/{id}/message?directory=<abs>` → the session's full history. */
export const OpencodeMessageWithParts = z.object({
  info: OpencodeMessageInfo,
  parts: z.array(OpencodePart),
})
export type OpencodeMessageWithParts = z.infer<typeof OpencodeMessageWithParts>

// ---------------------------------------------------------------------------
// SSE events — the eleven arms this driver consumes
// ---------------------------------------------------------------------------

/** `session.status`'s payload. `retry` is opencode telling us it is re-attempting
 *  a provider call — the session is still WORKING, which is why the reducer must
 *  not read it as idle. */
export const OpencodeSessionStatus = z.union([
  z.object({ type: z.literal('idle') }),
  z.object({ type: z.literal('busy') }),
  z.object({
    type: z.literal('retry'),
    attempt: z.number(),
    message: z.string(),
    next: z.number(),
  }),
])
export type OpencodeSessionStatus = z.infer<typeof OpencodeSessionStatus>

/** One prompt inside a `question.asked`. */
export const OpencodeQuestionInfo = z.object({
  question: z.string(),
  header: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
  multiple: z.boolean().optional(),
  /** The harness's own "and a free-text row is offered" flag. */
  custom: z.boolean().optional(),
})
export type OpencodeQuestionInfo = z.infer<typeof OpencodeQuestionInfo>

const withSession = { sessionID: OpencodeSessionId } as const

/**
 * The arms, keyed by their wire `type`.
 *
 * WHAT IS ABSENT AND WHY: `permission.v2.*` / `question.v2.*` exist in 1.18.16
 * beside these and carry the same information under the `/api/*` routes. The
 * driver speaks ONE generation, and it speaks the one whose round-trip it
 * actually proved against a live server. Consuming both would double every
 * interaction (each ask arrives twice) unless something deduped them, and that
 * dedupe would be inventing identity across two protocols — the exact move the
 * contract's `atLeastOnce` flag exists to make visible rather than paper over.
 */
export const OPENCODE_EVENT_ARMS = {
  'server.connected': z.object({}).passthrough(),
  'session.created': z.object({ ...withSession, info: OpencodeSession }),
  'session.updated': z.object({ ...withSession, info: OpencodeSession }),
  'session.status': z.object({ ...withSession, status: OpencodeSessionStatus }),
  'session.idle': z.object({ ...withSession }),
  'session.compacted': z.object({ ...withSession }),
  'session.error': z.object({
    sessionID: OpencodeSessionId.optional(),
    error: z.unknown().optional(),
  }),
  'message.updated': z.object({ ...withSession, info: OpencodeMessageInfo }),
  'message.part.updated': z.object({
    ...withSession,
    part: OpencodePart,
    /** Epoch ms. The only per-event time opencode puts on the wire, and the
     *  reason `at` is a real event time for the arm that matters most. */
    time: z.number().optional(),
  }),
  'message.part.delta': z.object({
    ...withSession,
    messageID: z.string().min(1),
    partID: z.string().min(1),
    field: z.string(),
    delta: z.string().optional(),
  }),
  'permission.asked': z.object({
    id: z.string().min(1),
    ...withSession,
    /** The permission CLASS, which for tool consent is the tool's own name
     *  (`bash`, `edit`). It is what a person reads as "what is being asked". */
    permission: z.string().min(1),
    /** The concrete thing being consented to — `["echo hello"]` for a bash ask. */
    patterns: z.array(z.string()),
    /** `{command: 'echo hello'}` for bash. The richest inputSummary source. */
    metadata: z.record(z.string(), z.unknown()),
    /** NON-EMPTY MEANS ALWAYS-ALLOW IS ON OFFER, and its entries are the RULE
     *  PATTERNS that would be persisted (`["echo *"]`) — which is precisely the
     *  material `PermissionAsk.suggestions` was reserved for. */
    always: z.array(z.string()),
    tool: z.object({ messageID: z.string(), callID: z.string() }).optional(),
  }),
  'permission.replied': z.object({
    ...withSession,
    requestID: z.string().min(1),
    reply: z.enum(['once', 'always', 'reject']),
  }),
  'question.asked': z.object({
    id: z.string().min(1),
    ...withSession,
    questions: z.array(OpencodeQuestionInfo),
    tool: z.object({ messageID: z.string(), callID: z.string() }).optional(),
  }),
  'question.replied': z.object({
    ...withSession,
    requestID: z.string().min(1),
    answers: z.array(z.array(z.string())),
  }),
  'question.rejected': z.object({ ...withSession, requestID: z.string().min(1) }),
} as const

export type OpencodeEventType = keyof typeof OPENCODE_EVENT_ARMS

/**
 * `GET /permission` and `GET /question` — the OPEN asks, straight from the
 * server.
 *
 * THE SCHEMAS ARE THE EVENT ARMS, REUSED RATHER THAN RESTATED, and that is a
 * fact about opencode rather than a shortcut: `PermissionRequest` and the
 * `permission.asked` payload are the same object in `/doc`, as are
 * `QuestionRequest` and `question.asked`'s. Declaring them twice would be two
 * places to update when one of them grows a field.
 *
 * WHY THE DRIVER READS THESE AT ALL, given that it consumes the ask EVENTS. The
 * SSE stream is live-only: an ask raised while a socket was down, or an ask a
 * human answered at an attached `opencode attach` TUI, is invisible to it. The
 * server's list is the truth, so `interactions()` and `send()` reconcile against
 * it — which is also what makes "a blocked session is by construction a session
 * with an open interaction" true across a reconnect rather than only within one.
 */
export const OpencodePermissionRequest = OPENCODE_EVENT_ARMS['permission.asked']
export type OpencodePermissionRequest = z.infer<typeof OpencodePermissionRequest>

export const OpencodeQuestionRequest = OPENCODE_EVENT_ARMS['question.asked']
export type OpencodeQuestionRequest = z.infer<typeof OpencodeQuestionRequest>

/** One parsed event: the envelope's id, its type, and the narrowed payload. */
export type OpencodeEvent = {
  [K in OpencodeEventType]: {
    id: string
    type: K
    properties: z.infer<(typeof OPENCODE_EVENT_ARMS)[K]>
  }
}[OpencodeEventType]

/** The envelope every arm shares. Parsed first so an unconsumed type can be
 *  dropped without paying for its payload. */
const EventEnvelope = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  properties: z.unknown(),
})

/**
 * Parse one SSE `data:` payload.
 *
 * THREE OUTCOMES, AND THE MIDDLE ONE IS THE POINT:
 *   - a consumed arm that parses → the event;
 *   - a type we do not consume, or `server.heartbeat` → `null`, silently. This
 *     is the majority of the stream and must cost nothing;
 *   - a consumed arm that FAILS to parse → a thrown `OpencodeProtocolError`.
 *     That is the version gate's teeth: upstream renamed a field we read, and
 *     the driver says so loudly instead of driving a session on `undefined`.
 */
export function parseOpencodeEvent(raw: unknown): OpencodeEvent | null {
  const envelope = EventEnvelope.safeParse(raw)
  if (!envelope.success) return null
  const arm = OPENCODE_EVENT_ARMS[envelope.data.type as OpencodeEventType]
  if (!arm) return null
  const parsed = arm.safeParse(envelope.data.properties)
  if (!parsed.success) {
    throw new OpencodeProtocolError(envelope.data.type, parsed.error.message)
  }
  return {
    id: envelope.data.id,
    type: envelope.data.type,
    properties: parsed.data,
  } as OpencodeEvent
}

/** A shape this driver relies on stopped matching. Named so the spawn path can
 *  tell it apart from a transport failure — one is "upgrade broke us", the other
 *  is "the server went away", and they want opposite responses. */
export class OpencodeProtocolError extends Error {
  constructor(
    readonly eventType: string,
    detail: string,
  ) {
    super(`opencode event '${eventType}' no longer matches the pinned shape: ${detail}`)
    this.name = 'OpencodeProtocolError'
  }
}

/**
 * The event's own time, in epoch ms, or `undefined` when the arm carries none.
 *
 * WHY A FALLBACK IS TOLERABLE HERE, given that the causal envelope forbids
 * observe-time stamping. The harm the rule names is RE-DATING ON REPLAY: a
 * reattach that replays a transcript tail must not restamp every session to
 * "now". opencode's `/event` stream cannot cause that harm, because it does not
 * replay — a subscriber receives only what happens after it connects (verified:
 * a second subscription received none of the first run's events). Historical
 * facts reach this driver through `GET /session/{id}/message`, whose parts carry
 * real `time.start`/`time.end`, and those keep their true times.
 *
 * So: a payload time when the arm has one, and the SSE reader's arrival time —
 * which for a live stream is the event time to within the socket's latency —
 * when it does not. The substitution is confined to live events and is never
 * applied to anything that could be re-delivered.
 */
export function eventTimeMs(event: OpencodeEvent): number | undefined {
  switch (event.type) {
    case 'message.part.updated':
      return event.properties.time ?? event.properties.part.time?.end
    case 'message.updated':
      return event.properties.info.time?.completed ?? event.properties.info.time?.created
    case 'session.created':
    case 'session.updated':
      return event.properties.info.time?.updated ?? event.properties.info.time?.created
    default:
      return undefined
  }
}

/**
 * Which session an event is ABOUT, or `undefined` when it is about the server.
 *
 * THE CHILD-SESSION FILTER HANGS OFF THIS. opencode runs subagents as child
 * sessions with their own `ses_…` ids on the SAME event bus, so a driver that
 * did not compare this against its own session id would watch a subagent's
 * `session.idle` flip the parent to idle mid-turn — the exact failure the plan
 * warns about. Every consumer of the stream filters on it.
 */
export function eventSessionId(event: OpencodeEvent): OpencodeSessionId | undefined {
  if (event.type === 'server.connected') return undefined
  const properties = event.properties as { sessionID?: string }
  return properties.sessionID
}
