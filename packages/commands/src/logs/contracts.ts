/**
 * THE CLIENT-LOG FAMILY — `logs.forward · logs.crash · logs.setLevel`
 * ([spec:2026-08-11-logging-strategy-design]).
 *
 * Two ingestion writes and one operator command. The first two are a client
 * reporting itself; the third is the valve the whole design exists to open —
 * raising one running client so a problem on a user's machine can be diagnosed
 * without shipping them a new build. That asymmetry is why they sit at different
 * role floors, and each contract says so where it is declared.
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

import { MachineIdField } from '@podium/model'
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
  machineId: z.string().max(128).pipe(MachineIdField).optional(),
})

/** The spec's client flushes at 50 records; 500 leaves four flushes' worth of
 *  headroom for a client draining a backlog and still bounds one call. */
export const MAX_FORWARDED_RECORDS = 500
/** A crash ships the WHOLE ring buffer, whose default capacity is 500 — so this
 *  is that, doubled, for a client configured with a deeper recorder. */
export const MAX_CRASH_SNAPSHOT_RECORDS = 1000

/** Ceiling on a client's self-reported drop count. See `logsForwardInput.dropped`:
 *  a bound low enough to refuse a real report would wedge a returning client's
 *  queue, so this one exists only to keep the field a number. */
export const MAX_REPORTED_DROPS = 1_000_000

export const logsForwardInput = z.object({
  origin: logOrigin,
  records: z.array(forwardedLogRecord).min(1).max(MAX_FORWARDED_RECORDS),
  /**
   * Records the CLIENT lost before this batch — its own bounded queue overflowed,
   * or a batch went unsendable and was discarded rather than retried forever.
   *
   * OPTIONAL, and counted apart from anything the server drops (POD-3167). A gap
   * in a per-origin file is otherwise ambiguous: a quiet client and a client
   * whose forwarding queue is overflowing look identical to whoever reads the
   * file, and the two have different fixes. The server writes this count into
   * the file as a marker record and reports its OWN drops separately, so neither
   * number can be mistaken for the other. Absent means "none to report", which
   * is what a healthy client sends and what every client sent before this field
   * existed — so an older client is not misread as a lossless one, it simply
   * makes no claim.
   *
   * The cap is DELIBERATELY FAR above anything a client should report, and it is
   * not the batch cap. Unreported drops accumulate across an outage, so a bound
   * near the batch size would make a long-offline client's first batch back
   * SCHEMA-INVALID — and a batch the server refuses is a batch that fails
   * identically on every retry, at the head of a FIFO queue. The client clamps
   * its own report to the same number for the same reason.
   */
  dropped: z.number().int().nonnegative().max(MAX_REPORTED_DROPS).optional(),
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

// ---------------------------------------------------------------------------
// logs.setLevel
// ---------------------------------------------------------------------------

/**
 * WHICH CONNECTED CLIENTS A RAISE IS FOR.
 *
 * Every field is optional and they AND together, so the empty selector means
 * "every client connected right now". That is the honest default for a
 * self-hosted install where the operator and the user are the same person and
 * there are two clients, and it is what makes the command usable before anybody
 * has looked up an id.
 *
 * `role` and `machineId` are the client's own self-description as it arrived in
 * `hello`, and are exactly what the server files that client's forwarded records
 * under — so the operator reading `clients/mobile-m1.ndjson` types what they are
 * already looking at. `clientId` is the server-minted connection id, which is
 * the only way to name ONE of two browser tabs.
 */
export const logLevelTarget = z.object({
  /** The server-minted connection id (`c3`), as reported by a previous call. */
  clientId: z.string().max(64).optional(),
  role: z.string().max(64).optional(),
  machineId: z.string().max(128).pipe(MachineIdField).optional(),
})

/** 24 hours, the same cap the wire frame carries. Restated rather than imported
 *  for the reason the level enum is: `@podium/protocol` is a dependency of this
 *  package and the value cannot travel the other way. */
export const MAX_SET_LEVEL_TTL_MS = 24 * 60 * 60 * 1000

export const logsSetLevelInput = z.object({
  /** `null` puts the matched clients back to their boot default. */
  level: forwardedLogLevel.nullable(),
  /** How long the raise lasts. Absent leaves the duration to the client's own
   *  default, which is the thing holding the timer. */
  ttlMs: z.number().int().positive().max(MAX_SET_LEVEL_TTL_MS).optional(),
  /** Absent means every connected client — see {@link logLevelTarget}. */
  target: logLevelTarget.optional(),
})

/**
 * THE OPERATOR SURFACE the whole forwarding design exists to serve
 * (POD-1920): raise one user's client to `debug` while it is running, so a
 * problem on their machine can be diagnosed without shipping them a new build.
 *
 * ONE KNOB. `level` is the client's whole verbosity — it lands in `setLogLevel`
 * there, and the forwarding sink pins no threshold of its own, so console and
 * forwarded stream move together. There is deliberately no second field for the
 * forwarding side; two controls that can disagree about what a client is
 * reporting is the failure this design refuses.
 *
 * ADMIN, unlike the two ingestion commands above, and the asymmetry is the
 * point. `forward` and `crash` are a client reporting ITSELF and are ordinary
 * member traffic. This one reaches ACROSS to somebody else's running client and
 * changes what it does — an administrative act on the deployment, and the only
 * command in this family a member has no business attempting.
 */
export const logsSetLevelContract = {
  name: 'logs.setLevel',
  version: 1,
  visibility: LOGS_VISIBILITY,
  input: logsSetLevelInput,
  policy: {
    action: 'manage',
    roleFloor: 'admin',
    resource: 'global',
    confirmation: 'none',
    rationale:
      'ADMIN, where the rest of this family is member: forwarding your own diagnostics is ' +
      'ordinary client traffic, while reaching into another user’s running client and changing ' +
      'what it emits is an administrative act on the deployment. `manage` rather than `write` ' +
      'because it mutates no state at all — it pushes a frame at live connections, and a client ' +
      'that has gone offline in the meantime simply is not among them. `resource: global` for ' +
      'the same reason as its siblings: the target is the deployment’s set of connected ' +
      'clients, not a row and not a machine. No confirmation — the act is bounded by a TTL and ' +
      'reversible by re-issuing it with a null level.',
  },
  exposure: SERVED_ON,
  delivery: {
    class: 'online-only',
    outboxReconciliation:
      'NEVER queued, and this is the strongest case in the family. The command addresses ' +
      'CONNECTIONS that exist right now; a raise held through an offline period and delivered ' +
      'later would arrive at whichever clients happen to be connected then, after the incident ' +
      'it was issued for, turning up a client nobody is investigating. Re-issuing is one ' +
      'keystroke and is always the right answer.',
    applyTimeReauthorization:
      'Not reachable in practice, since the class forbids queuing; stated for totality (ADR 3 ' +
      'D8). A held command would be re-authorized live at apply and dropped on refusal.',
  },
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note:
      'Carries no user data in either direction. The input is a level, a duration and a ' +
      'selector over self-descriptions clients already sent in `hello`; the output is the list ' +
      'of connections it reached, which is the same self-description echoed back so the ' +
      'operator can see WHO they just turned up. Nothing here is content.',
  },
  ownership: CREATES_NOTHING,
  attribution: LOGS_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    // Nothing to distinguish: the command reports what it reached and never
    // refuses one connection out of a selection. `resource` is `global`, so
    // readiness §3.1.4 M5's machine carve-out does not apply here.
    distinguishesUnauthorizedFromUnreachable: false,
    note:
      'A `clientId` naming no connection is not an error: the reply reports the connections it ' +
      'reached, and an unmatched selector reaches none. So an unknown id and a client that just ' +
      'disconnected are INDISTINGUISHABLE, deliberately — the alternative is an endpoint that ' +
      'answers "no such client", which is a liveness oracle over other people’s sessions ' +
      '(D20.3). The operator’s remedy is the same in both cases: look at what came back.',
  },
  conflict: 'n/a',
} as const satisfies CommandContract<typeof logsSetLevelInput>

// ---------------------------------------------------------------------------
// logs.setDaemonLevel
// ---------------------------------------------------------------------------

/**
 * WHICH DAEMONS A RAISE IS FOR (POD-3156).
 *
 * ONE FIELD, where the client selector has three, and the two it does not have
 * are missing for reasons rather than for later.
 *
 * There is no `clientId`, because there is no such thing: a machine has exactly
 * one daemon socket, so the machine IS the connection id. There is no `role`
 * either — every peer on this plane is a daemon, and a field whose only legal
 * value is `daemon` is a filter that cannot filter.
 *
 * An absent selector means EVERY machine with a live daemon, which is the same
 * default the client family takes and is what makes the command usable before
 * anybody has looked up a machine id.
 */
export const daemonLogLevelTarget = z.object({
  machineId: z.string().max(128).pipe(MachineIdField).optional(),
})

export const logsSetDaemonLevelInput = z.object({
  /** `null` puts the matched daemons back to their boot default AND stops them
   *  forwarding. */
  level: forwardedLogLevel.nullable(),
  /** How long the raise lasts. Absent leaves the duration to the daemon's own
   *  default, which is the thing holding the timer. */
  ttlMs: z.number().int().positive().max(MAX_SET_LEVEL_TTL_MS).optional(),
  /** Absent means every daemon online right now — see {@link daemonLogLevelTarget}. */
  target: daemonLogLevelTarget.optional(),
})

/**
 * THE OPERATOR SURFACE FOR THE FLEET (POD-3156): raise a REMOTE HOST'S daemon
 * from the coordinating server, so a machine that is misbehaving can be
 * diagnosed without an SSH session and a `journalctl` on the other end.
 *
 * ADMIN, like `logs.setLevel`, and more obviously so. This does not merely reach
 * into another user's browser tab — it turns up logging on a DIFFERENT HOST and
 * causes that host's records to cross the network to this one. `manage` because
 * it mutates no state at all: it pushes a frame at live daemon sockets, and a
 * machine that is offline simply is not among them.
 *
 * THE REDACTION ANSWER IS NOT THE CLIENT FAMILY'S, and the difference is the
 * whole reason the daemon side defaults to forwarding NOTHING. `logs.forward`
 * argues, correctly, that a browser shipping records to the user's own server
 * discloses nothing: it moves the user's data between the user's own processes.
 * That argument does not survive the hop to a remote machine — a daemon's
 * records carry that host's repository paths, branch names, worktree layout and
 * command output, and the server they land on is a different box that other
 * people may operate. So the control is not a scrubber (which would destroy the
 * artifact, exactly as it would for a crash stack); it is CONSENT BY DEFAULT
 * CLOSED plus a bounded window: nothing is forwarded until an admin raises a
 * named machine, the raise expires on the daemon's own timer, and `level: null`
 * ends it early.
 */
export const logsSetDaemonLevelContract = {
  name: 'logs.setDaemonLevel',
  version: 1,
  visibility: LOGS_VISIBILITY,
  input: logsSetDaemonLevelInput,
  policy: {
    action: 'manage',
    roleFloor: 'admin',
    resource: 'global',
    confirmation: 'none',
    rationale:
      'ADMIN, and the strongest case in this family for it: the act turns up logging on ANOTHER ' +
      'HOST and causes that host\u2019s records to cross the network to this server. `manage` ' +
      'rather than `write` because it mutates no state \u2014 it pushes a frame at live daemon ' +
      'sockets, and an offline machine simply is not among them. `resource: global` because the ' +
      'target is the deployment\u2019s set of connected daemons rather than one machine row; the ' +
      'selector NARROWS that set and does not change what is being addressed. No confirmation: ' +
      'the raise is bounded by a TTL the daemon holds and is reversible by re-issuing it with a ' +
      'null level.',
  },
  exposure: SERVED_ON,
  delivery: {
    class: 'online-only',
    outboxReconciliation:
      'NEVER queued, and unlike its client sibling this is enforced by the SENDER as well as the ' +
      'class: `MachinesService.toMachine` WOULD park a control frame for a briefly-offline ' +
      'machine and flush it on the next attach, so the fleet director sends only to machines with ' +
      'a live socket. A raise parked through a reboot would arrive at a host nobody is ' +
      'investigating and turn it up for a window nobody remembers opening.',
    applyTimeReauthorization:
      'Not reachable in practice, since nothing is queued; stated for totality (ADR 3 D8). A held ' +
      'command would be re-authorized live at apply and dropped on refusal.',
  },
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note:
      'The command itself carries no user data in either direction: a level, a duration, a ' +
      'machine id, and a reply naming the machines it reached. What it CAUSES to move is the ' +
      'subject of the review \u2014 a raised daemon forwards its own records, which carry that ' +
      'host\u2019s paths, branch and worktree names and command output. Those are not redacted, ' +
      'for the reason a crash stack is not: a log with its identifying detail removed does not ' +
      'answer the question it was raised to answer. The control is that forwarding is OFF by ' +
      'default on every daemon, is enabled only by this admin-floor command against a named ' +
      'machine, and expires on the daemon\u2019s own timer.',
  },
  ownership: CREATES_NOTHING,
  attribution: LOGS_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note:
      'A `machineId` naming no online daemon is not an error: the reply reports what it reached, ' +
      'and an unmatched selector reaches nothing. An unknown machine and one that is merely ' +
      'offline are therefore INDISTINGUISHABLE, deliberately \u2014 the alternative answers ' +
      '\u201cno such machine\u201d, which is a liveness oracle over the fleet (D20.3).',
  },
  conflict: 'n/a',
} as const satisfies CommandContract<typeof logsSetDaemonLevelInput>

export const LOGS_CONTRACTS = {
  forward: logsForwardContract,
  crash: logsCrashContract,
  setLevel: logsSetLevelContract,
  setDaemonLevel: logsSetDaemonLevelContract,
} as const

export type LogsContractName = keyof typeof LOGS_CONTRACTS

export const LOGS_CONTRACT_NAMES = Object.keys(LOGS_CONTRACTS) as LogsContractName[]

export type LogLevelTarget = z.infer<typeof logLevelTarget>
export type LogsSetLevelInput = z.infer<typeof logsSetLevelInput>
export type ForwardedLogRecord = z.infer<typeof forwardedLogRecord>
export type LogOrigin = z.infer<typeof logOrigin>
export type LogsForwardInput = z.infer<typeof logsForwardInput>
export type LogsCrashInput = z.infer<typeof logsCrashInput>
export type DaemonLogLevelTarget = z.infer<typeof daemonLogLevelTarget>
export type LogsSetDaemonLevelInput = z.infer<typeof logsSetDaemonLevelInput>
