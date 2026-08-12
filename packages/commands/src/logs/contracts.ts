/**
 * THE TWO CLIENT-LOG INGESTION WRITES — `logs.forward · logs.crash`
 * (chunk 3 of [spec:2026-08-11-logging-strategy-design]).
 *
 * A client (web, desktop webview, mobile) keeps its own ring buffer and forwards
 * what matters to ITS OWN SERVER: `forward` is the routine batch, `crash` is the
 * one-shot "I died, here is the flight recorder". Both are server-side ingestion
 * with no client code in this chunk — these contracts are the shape chunks 4 and
 * 5 build their forwarding sinks against.
 *
 * ---------------------------------------------------------------------------
 * NO CONSENT GATE ON THIS HOP, AND THAT IS A DECISION WITH A REASON
 * ---------------------------------------------------------------------------
 *
 * Podium is self-hosted: the client's server is the USER'S OWN server, so
 * forwarding a log line to it discloses nothing to anybody — it moves the user's
 * data from one of their processes to another. The consent gate sits one hop
 * further out, where a scrubbed crash SIGNATURE may leave the installation
 * entirely (`telemetry.recordCrash`, the existing `crash` tier). The design spec
 * states this in "Client → server forwarding"; it is written here too because
 * this is the contract a reviewer reads when asking "why is there no consent
 * check on an endpoint that accepts logs".
 *
 * ---------------------------------------------------------------------------
 * BOUNDS ARE PART OF THE CONTRACT, NOT OF THE HANDLER
 * ---------------------------------------------------------------------------
 *
 * An ingestion endpoint that accepts an unbounded array is a disk-filler with an
 * authentication check in front of it. Every collection and every string below
 * is capped in the SCHEMA, so an oversized batch is refused by the transport
 * before a handler sees it, and the cap is visible to the client author writing
 * the batching sink rather than discoverable by exceeding it in production.
 *
 * The caps are deliberately generous against the spec's own client behaviour
 * (flush every 5 s or 50 records) so a client that batches correctly never meets
 * them: they exist to bound the worst case, not to shape the normal one.
 */

import { z } from 'zod'
import type {
  AttributionPolicy,
  CommandContract,
  DeliveryPolicy,
  ErrorConsistency,
  RedactionPolicy,
  TransportTag,
  VisibilityClass,
} from '../contract'

/** `trpc` alone. Clients reach their server over /trpc; there is no CLI verb for
 *  "forward a log line" and no agent that should be able to write into another
 *  origin's log file, so the relay and MCP transports stay closed. */
const SERVED_ON: readonly TransportTag[] = ['trpc']

/**
 * ADR 9 D3 rule 1, declared rather than defaulted — the same reasoning
 * `perf/contracts.ts` sets out at length. Forwarded client logs and crash events
 * are a property of the DEPLOYMENT: they land in the server's log directory
 * under a per-origin file, they are read by whoever operates the install, and
 * they are pruned by a server-wide retention budget. They are not one person's
 * rows, so resolving the missing ownership-matrix row to `personal` through ADR
 * 9 D4's backstop would be the wrong answer arrived at by not looking.
 */
const LOGS_VISIBILITY: VisibilityClass = 'deployment-substrate'

/**
 * ONLINE-ONLY, for the reason the forwarding design already gives on the client
 * side: the queue is bounded and drops oldest when the server is unreachable.
 *
 * That is the whole reconciliation story, and it is deliberate rather than
 * missing. A log batch queued through an offline period and drained an hour
 * later arrives after the incident it describes, out of order with respect to
 * everything the server logged in between, and having displaced newer records
 * from a bounded queue to get there. A dropped diagnostic record is the correct
 * outcome; a resurrected one is a worse artifact than a gap.
 */
const LOGS_DELIVERY: DeliveryPolicy = {
  class: 'online-only',
  outboxReconciliation:
    'NEVER queued. The client-side forwarding sink is bounded and drops oldest under backpressure ' +
    '(design spec, "Client → server forwarding"): a batch drained after an offline period lands ' +
    'out of order with the server’s own records, describes an incident that has passed, and got ' +
    'there by displacing newer records from a bounded queue. A dropped diagnostic record is the ' +
    'correct outcome, so there is nothing to reconcile.',
  applyTimeReauthorization:
    'Not reachable in practice, since the class forbids queuing; stated for totality (ADR 3 D8). A ' +
    'held batch would be re-authorized live at apply and dropped on refusal — a forwarded log line ' +
    'is never worth surfacing an error to the user over.',
}

/**
 * REVIEWED, and this is the family where the review has to admit what it cannot
 * enumerate.
 *
 * A forwarded record's `fields` are FREE-FORM by construction: the logger's
 * record shape is four reserved keys plus whatever the call site attached, and
 * an ingestion endpoint that accepted only a fixed field list would silently
 * discard the context that makes a crash readable. So the honest statement is
 * not "no PII can arrive here" — it is that this hop does not leave the user's
 * own infrastructure, and the hard gate sits where data actually departs:
 * `scrubError` inside `telemetry.recordCrash`, which drops the message entirely
 * and keeps only install-relative frames.
 *
 * `inputPaths` is therefore empty and says so on purpose. Redacting `msg` or
 * `err.stack` on the way into the user's own log file would destroy the artifact
 * — a stack with the frames removed is not a crash report — while doing nothing
 * about what leaves the machine, which is already scrubbed downstream.
 */
const LOGS_REDACTION: RedactionPolicy = {
  reviewed: true,
  inputPaths: [],
  outputPaths: [],
  note:
    'Forwarded records carry free-form fields by construction (the logger’s record shape is four ' +
    'reserved keys plus call-site context), so this endpoint cannot enumerate what arrives — and ' +
    'must not, since a stack with its frames redacted is not a crash report. Nothing is redacted ' +
    'on the way in because this hop stays inside the user’s own installation: the client’s server ' +
    'IS the user’s server. The hard gate is one hop further out, at `scrubError` inside ' +
    '`telemetry.recordCrash`, which drops the message and keeps only install-relative frames. ' +
    'Outputs carry no user data at all — a count and an event id.',
}

/**
 * `not-applicable` on the actor half, for `perf`'s reason and one more.
 *
 * Neither command writes a durable accountability row: `forward` appends to a
 * rotating log file and `crash` writes a crash-event file, both of which are
 * operational artifacts rather than aggregates with an owner. The ORIGIN — role,
 * version, machine — is on the wire and is what the server files the records
 * under, but it is a self-description used for grouping, NEVER for authorization
 * (D17's rule is that attribution may not come from payload; this is not
 * attribution, and calling it that would be the mistake).
 *
 * Who was allowed to call is settled by the transport before the handler runs.
 */
const LOGS_ATTRIBUTION: AttributionPolicy = {
  actor: 'not-applicable',
  onBehalfOf: 'none-representable',
  wirePlacement: 'not-on-the-wire',
  reservedWireKeys: [],
  rationale:
    'No durable accountability row exists to stamp: `forward` appends to a rotating log file and ' +
    '`crash` writes a crash-event file. The `origin` fields on the wire (role, version, machine) ' +
    'are a self-description used to FILE the records and to group them, never to decide whether ' +
    'the call is allowed — that is settled by the transport before the handler runs. Naming them ' +
    'attribution would invert D17 by letting payload speak for the caller.',
}

/** Neither command addresses a row by a caller-supplied id, so D20.3's
 *  existence-oracle question does not arise. `origin` is a label, not an
 *  address: an unknown role creates a new per-origin file rather than reporting
 *  that something does not exist. */
const LOGS_ERRORS: ErrorConsistency = {
  callerSuppliedTargetId: false,
  note:
    'Neither command addresses an existing row. `origin` labels the records and, when unseen ' +
    'before, opens a new per-origin file rather than answering "no such thing" — so there is ' +
    'nothing to probe and D20.3’s question does not arise rather than being answered permissively.',
}

/**
 * Log levels, restated here rather than imported, because the architecture
 * manifest does not let this package reach the logger: `@podium/commands` is L1
 * with `deps: ['packages/protocol', 'packages/model']`, and `@podium/logger` is
 * a zod-free L0 leaf that could not export a schema anyway.
 *
 * A restatement is a drift risk, so it is CHECKED rather than trusted — by
 * `apps/server/src/modules/logs/service.test.ts` ("the restated level enum
 * cannot drift from the logger's"), which can import both and asserts
 * `forwardedLogLevel.options` equals the logger's `LEVELS` exactly. The check
 * lives there because that is the nearest place both are legal imports.
 */
export const forwardedLogLevel = z.enum(['error', 'warn', 'info', 'debug', 'trace'])

/** Longest single field or message accepted. A record that exceeds it is
 *  refused with the batch rather than silently truncated — a truncated stack is
 *  a stack that lies about where it ends. */
const MAX_TEXT = 8192

export const forwardedError = z.object({
  name: z.string().max(256),
  message: z.string().max(MAX_TEXT),
  stack: z
    .string()
    .max(MAX_TEXT * 4)
    .optional(),
})

/**
 * ONE FORWARDED RECORD, in the logger's own NDJSON shape.
 *
 * `.catchall` rather than a closed object: free-form fields are the point of the
 * record shape (`sessionId`, `durationMs`, whatever the call site bound), and a
 * strict schema would drop exactly the context a reader needs. The `unknown`
 * values are bounded by the whole-payload caps below, not individually — a
 * deeply nested field is a JSON parse the transport already survived.
 */
export const forwardedLogRecord = z
  .object({
    ts: z.string().min(1).max(64),
    level: forwardedLogLevel,
    ns: z.string().min(1).max(256),
    msg: z.string().max(MAX_TEXT),
    err: forwardedError.optional(),
  })
  .catchall(z.unknown())

/** Who is sending. All three are the client's self-description; the server uses
 *  them to name the per-origin file and to tag the records. */
export const logOrigin = z.object({
  /** `web` | `desktop` | `mobile` | anything a future runtime calls itself. */
  role: z.string().min(1).max(64),
  /** The client's app version, so a log file can be read against a build. */
  v: z.string().max(64).optional(),
  machineId: z.string().max(128).optional(),
})

/** The spec's client flushes at 50 records; 500 leaves four flushes' worth of
 *  headroom for a client draining a backlog and still bounds one call. */
export const MAX_FORWARDED_RECORDS = 500
/** A crash ships the WHOLE ring buffer, whose default capacity is 500 — so this
 *  is that, doubled, for a client configured with a deeper recorder. */
export const MAX_CRASH_SNAPSHOT_RECORDS = 1000

export const logsForwardInput = z.object({
  origin: logOrigin,
  records: z.array(forwardedLogRecord).min(1).max(MAX_FORWARDED_RECORDS),
})

export const logsCrashInput = z.object({
  origin: logOrigin,
  err: forwardedError,
  /** The flight recorder. Empty is legal: a crash on boot has nothing buffered
   *  yet, and refusing it would lose the earliest crashes there are. */
  snapshot: z.array(forwardedLogRecord).max(MAX_CRASH_SNAPSHOT_RECORDS).default([]),
  /** Producer-supplied extras — a React component stack, the current route. */
  context: z.record(z.string().max(128), z.unknown()).optional(),
})

const CREATES_NOTHING = {
  creates: [],
  note:
    'Appends to a rotating per-origin log file, or writes one crash-event file under a bounded ' +
    'retention budget. Mints no entity and no row: the crash event id names a file, not an ' +
    'aggregate anything else may address.',
} as const

// ---------------------------------------------------------------------------
// logs.forward
// ---------------------------------------------------------------------------

export const logsForwardContract = {
  name: 'logs.forward',
  version: 1,
  visibility: LOGS_VISIBILITY,
  input: logsForwardInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'global',
    confirmation: 'none',
    rationale:
      'A `write` on deployment-wide state — the server’s log directory — so `resource: global`: ' +
      'there is no row and no machine to gate against, and `none` would imply a self-addressed ' +
      'command whose target is the caller. `roleFloor: member` because every client forwards its ' +
      'own diagnostics as a matter of course, and an admin floor would blind the operator to ' +
      'exactly the clients whose failures are being investigated. No confirmation: it appends ' +
      'records to a rotating file that is already size-bounded.',
  },
  exposure: SERVED_ON,
  delivery: LOGS_DELIVERY,
  redaction: LOGS_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: LOGS_ATTRIBUTION,
  errorConsistency: LOGS_ERRORS,
  conflict: 'append',
} as const satisfies CommandContract<typeof logsForwardInput>

// ---------------------------------------------------------------------------
// logs.crash
// ---------------------------------------------------------------------------

export const logsCrashContract = {
  name: 'logs.crash',
  version: 1,
  visibility: LOGS_VISIBILITY,
  input: logsCrashInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'global',
    confirmation: 'none',
    rationale:
      'Same grade as `logs.forward` and for the same reason: a client reporting its own death is ' +
      'the ordinary case, not an administrative act, and a floor above `member` would drop crash ' +
      'reports from precisely the sessions that need them. The write is bounded twice over — the ' +
      'payload caps in the schema, and the store’s 50-event / 30-day retention — so a client that ' +
      'crash-loops costs a bounded amount of disk rather than an unbounded one.',
  },
  exposure: SERVED_ON,
  delivery: LOGS_DELIVERY,
  redaction: LOGS_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: LOGS_ATTRIBUTION,
  errorConsistency: LOGS_ERRORS,
  conflict: 'append',
} as const satisfies CommandContract<typeof logsCrashInput>

export const LOGS_CONTRACTS = {
  forward: logsForwardContract,
  crash: logsCrashContract,
} as const

export type LogsContractName = keyof typeof LOGS_CONTRACTS

export const LOGS_CONTRACT_NAMES = Object.keys(LOGS_CONTRACTS) as LogsContractName[]

export type ForwardedLogRecord = z.infer<typeof forwardedLogRecord>
export type LogOrigin = z.infer<typeof logOrigin>
export type LogsForwardInput = z.infer<typeof logsForwardInput>
export type LogsCrashInput = z.infer<typeof logsCrashInput>
