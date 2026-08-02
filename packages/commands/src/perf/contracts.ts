/**
 * THE TWO PERF DIAGNOSTIC WRITES — `perf.report · perf.reset` [POD-701].
 *
 * Switch-latency instrumentation: `report` pushes a client switch-trace into the
 * server's rolling ring, `reset` clears the ring. The `snapshot` read on the same
 * router stays a query.
 *
 * ---------------------------------------------------------------------------
 * THIS FAMILY HAS NO OWNERSHIP-MATRIX ROW, AND SAYING SO IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * Every other family in this cutover reads its `visibility` off a row in ADR 1's
 * matrix. There is no row for the perf registry, and that is a genuine gap rather
 * than an oversight in this file: the registry is a PROCESS-LOCAL, IN-MEMORY ring
 * that is never persisted, never replicated and never survives a restart, so it
 * has no durable aggregate to be a row about.
 *
 * The reason this is written down instead of quietly resolved is the trap the
 * coordinator named after POD-306 and POD-351: `visibilityClassOf` resolves an
 * UNKNOWN row to `personal` by ADR 9 D4's default-closed backstop, and the
 * backstop returns the SAME answer for "deliberately classified personal" and
 * "nobody ever classified this". A contract that silently accepted `personal`
 * here would be indistinguishable from one whose author never looked — and it
 * would be WRONG, because a deployment-wide diagnostic ring is not one person's
 * data.
 *
 * So the class below is `deployment-substrate`, declared, with the reasoning:
 * ADR 9 D3 rule 1 — a property of the DEPLOYMENT rather than of a person. The
 * registry keeps a deployment-wide ring (what `perf.snapshot` serves) AND
 * per-principal partitions (what `snapshotFor` serves). The snapshot read still
 * names the deployment, not one person — the partitions do not change what the
 * admin-grade read measures.
 *
 * The missing matrix row is reported as discovered work rather than added here:
 * the matrix is ADR 1's and its totality test is POD-304/POD-1071's, so a router
 * cutover minting a row would be deciding another issue's question. See the
 * `discovered-from` issue filed against POD-314.
 */

import { clientSwitchTraceSchema } from '@podium/protocol'
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

/** `trpc` alone — the web client reports its own switch traces and the diagnostics
 *  panel resets them. No CLI verb, no MCP tool, measured rather than assumed. */
const SERVED_ON: readonly TransportTag[] = ['trpc']

/** ADR 9 D3 rule 1, declared rather than defaulted — see the header. */
const PERF_VISIBILITY: VisibilityClass = 'deployment-substrate'

/**
 * ONLINE-ONLY, and for this family the reason is unusually clean: a latency
 * measurement REPLAYED LATER IS NOT A LATENCY MEASUREMENT. The ring is a rolling
 * window over recent switches, so a trace queued through an offline period and
 * drained afterwards would land in a window it did not happen in and silently
 * corrupt the diagnostic it exists to feed. `reset` is worse — a queued reset
 * would clear a window the operator is in the middle of reading.
 */
const PERF_DELIVERY: DeliveryPolicy = {
  class: 'online-only',
  outboxReconciliation:
    'NEVER queued. The ring is a rolling window over RECENT switches, so a trace drained after an ' +
    'offline period lands in a window it did not occur in — the measurement would be corrupted by ' +
    'the very mechanism meant to preserve it — and a queued `reset` would clear a window an ' +
    'operator is reading. There is nothing to reconcile because a dropped diagnostic sample is the ' +
    'correct outcome, not a lost write.',
  applyTimeReauthorization:
    'Not reachable in practice, since the class forbids queuing; stated for totality (ADR 3 D8). If ' +
    'a trace were ever held and replayed, it would be re-authorized live at apply and dropped on ' +
    'refusal — a diagnostic sample is never worth surfacing an error to the user over.',
}

/**
 * Reviewed, and this is the family where the answer required actually reading the
 * payload rather than asserting it is fine.
 *
 * A switch trace carries a `sessionId` and named phase marks. It carries NO
 * transcript text, no cwd, no repo path and no command line — the schema
 * (`clientSwitchTraceSchema` in `@podium/protocol`) is the enumeration, and it is
 * the SAME instance the wire validates with, so this claim cannot drift from what
 * is actually accepted. `sessionId` is not redacted: it is the correlation key the
 * whole diagnostic turns on, and the server already logs it in the one-line perf
 * summary the operator reads.
 */
const PERF_REDACTION: RedactionPolicy = {
  reviewed: true,
  inputPaths: [],
  outputPaths: [],
  note:
    'A switch trace is a `sessionId` plus named phase marks with millisecond offsets — no ' +
    'transcript text, no cwd, no repo path, no command line. `clientSwitchTraceSchema` is the ' +
    'enumeration AND the instance the wire validates with, so this review cannot drift from what is ' +
    'accepted. `sessionId` stays unredacted: it is the correlation key the diagnostic exists to ' +
    'provide, and it already appears in the server’s own perf log line.',
}

/**
 * `not-applicable` on the actor half, which is the honest answer and not a gap.
 *
 * ADR 3 Amendment 1 D17's rule is that attribution is a PAIR and neither half may
 * come from payload. It does not require every command to HAVE one: this writes an
 * in-memory diagnostic ring with no durable accountability row, so there is nothing
 * for a principal to be stamped into. The *perf partition* a report lands in is a
 * separate concern — that key is the transport-derived feed principal at the
 * handler (POD-1230), never a field of the trace body, and never this policy's
 * actor/onBehalfOf pair. `onBehalfOf: 'none-representable'` follows, and the
 * classification lint checks the combination that would be incoherent — a human
 * with no actor — rather than this one.
 */
const PERF_ATTRIBUTION: AttributionPolicy = {
  actor: 'not-applicable',
  onBehalfOf: 'none-representable',
  wirePlacement: 'not-on-the-wire',
  reservedWireKeys: [],
  rationale:
    'Deliberately no accountability pair. The ring is in-memory and has no durable row, so ' +
    'there is no audit record to stamp — D17 forbids attribution coming from payload, it does ' +
    'not require a diagnostic sample to invent an actor. The sample still partitions by the ' +
    'transport-derived feed principal at the report seam (POD-1230); that is a selection key, ' +
    'not this policy field. Stated rather than left off, so "this command has no attribution" ' +
    'and "the author forgot the field" cannot look alike.',
}

/** Neither takes a caller-supplied target id: `report` addresses no row and
 *  `reset` takes no input at all, so D20's existence-oracle question does not
 *  arise. Stated rather than defaulted. */
const PERF_ERRORS: ErrorConsistency = {
  callerSuppliedTargetId: false,
  note:
    'Neither command addresses a row. `report` appends to the ring and `reset` takes no input, so ' +
    'there is no caller-supplied id to iterate and no existence to leak — Amendment 1 D20.3’s ' +
    'question does not arise rather than being answered permissively.',
}

const CREATES_NOTHING = {
  creates: [],
  note: 'Appends to or clears an in-memory diagnostic ring. Mints no entity, persists nothing, and survives no restart.',
} as const

// ---------------------------------------------------------------------------
// perf.report
// ---------------------------------------------------------------------------

/** THE SHARED SCHEMA INSTANCE, not a restatement of it. `clientSwitchTraceSchema`
 *  is what the shipped procedure validated with and what the client builds
 *  against; re-declaring its shape here would be a second declaration that a
 *  golden wire fixture could not tell apart from this one (POD-305). */
export const perfReportInput = clientSwitchTraceSchema

export const perfReportContract = {
  name: 'perf.report',
  version: 1,
  visibility: PERF_VISIBILITY,
  input: perfReportInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'global',
    confirmation: 'none',
    rationale:
      'A `write` on deployment-wide state, so `resource: global` — there is no row and no machine ' +
      'to gate against, and saying `none` would imply a self-addressed or additive command whose ' +
      'target is the caller. `roleFloor: member`: every client reports its own switch traces as a ' +
      'matter of course, and an admin floor would silence the instrumentation for exactly the users ' +
      'whose latency is being measured. No confirmation — it appends one sample to a rolling ring.',
  },
  exposure: SERVED_ON,
  delivery: PERF_DELIVERY,
  redaction: PERF_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: PERF_ATTRIBUTION,
  errorConsistency: PERF_ERRORS,
} as const satisfies CommandContract<typeof perfReportInput>

// ---------------------------------------------------------------------------
// perf.reset
// ---------------------------------------------------------------------------

/** Takes nothing. `.passthrough()` rather than a strict empty object, kept
 *  deliberately: the shipped procedure had no `.input(…)` at all and therefore
 *  accepted anything, and a strict object would begin refusing extra keys shipped
 *  clients may already send — a wire change wearing a tidy-up's clothes. */
export const perfResetInput = z.object({}).passthrough().optional()

/**
 * `manage`, where `report` is `write`, and the asymmetry is deliberate.
 *
 * Appending your own sample and DESTROYING every principal's samples are not the
 * same authority. `reset` discards deployment-wide diagnostic state that other
 * people may be mid-investigation on, and it is unrecoverable — the ring is the
 * only copy. Grading both `write` would let any client wipe the instrumentation.
 */
export const perfResetContract = {
  name: 'perf.reset',
  version: 1,
  visibility: PERF_VISIBILITY,
  input: perfResetInput,
  policy: {
    action: 'manage',
    roleFloor: 'admin',
    resource: 'global',
    confirmation: 'none',
    rationale:
      'MANAGE and `admin`, where `report` is `write`/`member`, because appending your own sample ' +
      'and destroying everyone’s are different authorities. The ring is the only copy: a reset is ' +
      'unrecoverable and can discard state another operator is mid-investigation on, so it is an ' +
      'administrative act on deployment-wide substrate rather than an ordinary write. ' +
      'NOTHING ENFORCES THIS GRADE TODAY AND THE CONTRACT MUST NOT PRETEND OTHERWISE: the tRPC ' +
      'transport does not gate on `roleFloor`, and every /trpc caller is the OPERATOR by ' +
      'construction (the login guard authenticated the human), so behaviour is unchanged by this ' +
      'cutover — as it must be. What this records is the grade the command SHOULD carry once ' +
      'POD-1075 lands a real (user, device, capability) principal, so that the answer is written ' +
      'down by someone who examined the command rather than inferred later from its name. No ' +
      'confirmation: the grade is the gate, and a diagnostic ring is not user data.',
  },
  exposure: SERVED_ON,
  delivery: PERF_DELIVERY,
  redaction: PERF_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: PERF_ATTRIBUTION,
  errorConsistency: PERF_ERRORS,
} as const satisfies CommandContract<typeof perfResetInput>

export const PERF_CONTRACTS = {
  report: perfReportContract,
  reset: perfResetContract,
} as const

export type PerfContractName = keyof typeof PERF_CONTRACTS

export const PERF_CONTRACT_NAMES = Object.keys(PERF_CONTRACTS).sort() as PerfContractName[]
