/**
 * THE STANDARD EFFECT STATUS AND THE GENERIC EFFECT RECORD (ADR 12 D5 E2, POD-6357).
 *
 * An EFFECT is a change outside the database: git, a file, a process, a scan.
 * When it happens once, its intent and its progress are DATA on a synced record,
 * so every device sees the same answer to "did it happen?":
 *
 *  - the client creates the record (`pending`) through `sync.submit`;
 *  - after the commit, the one generic trigger hands it to the executor
 *    registered for its kind, which claims it by moving it to `running`;
 *  - the executor writes the outcome back as status, never as a reply.
 *
 * The status group is the same wherever an effect lives: on a natural record
 * when there is one (a chat `message`, mapped by {@link messageEffect}), and
 * otherwise on the small generic record {@link EffectRecordWire}.
 *
 * `unknown` IS AN OUTCOME, NOT AN ERROR. The executor lost track after the
 * effect may have happened (a crash mid-merge, a machine that went away). The UI
 * offers a check or a retry; the system never retries a `running` record
 * silently, because doing it twice may be worse than not knowing.
 */

import { z } from 'zod'
import { deviceIdSchema } from '../ids/device-id'
import { defineMachine } from '../state-machine'
import type { AutomationRunWire } from './automation'
import type { MessageDeliveryStatus } from './message-delivery'

export const EFFECT_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
  'unknown',
] as const
export const EffectStatus = z.enum(EFFECT_STATUSES)
export type EffectStatus = z.infer<typeof EffectStatus>

/**
 * The allowed moves.
 *
 *  - `pending` is claimed into `running` by exactly one executor run (the store
 *    writes `WHERE status IN allowedFrom('running')`, which is `pending` alone,
 *    so a second trigger finds nothing to claim). It may also end without a
 *    run: `expired` past its deadline, `cancelled` on request, `failed` when no
 *    executor can take it, `succeeded` when the work is found already done.
 *  - `running` ends, or becomes `unknown` when the executor lost track.
 *  - `unknown` is settled later by a check (or a person's cancel).
 */
export const EffectLifecycle = defineMachine('effect', {
  states: EFFECT_STATUSES,
  edges: {
    pending: ['running', 'succeeded', 'failed', 'cancelled', 'expired'],
    running: ['succeeded', 'failed', 'cancelled', 'unknown'],
    unknown: ['succeeded', 'failed', 'cancelled'],
    succeeded: [],
    failed: [],
    cancelled: [],
    expired: [],
  },
  terminal: ['succeeded', 'failed', 'cancelled', 'expired'],
})

export const isEffectFinished = (status: EffectStatus): boolean =>
  EffectLifecycle.isTerminal(status)

/**
 * A status as a client reads it off the wire. A client built before a status
 * was added must not refuse the row (a feed row that fails to parse is dropped
 * and refetched forever), so it reads one it does not know as `unknown`: it
 * cannot tell, and says so, claiming neither success nor failure.
 */
export const readEffectStatus = (status: string): EffectStatus =>
  (EFFECT_STATUSES as readonly string[]).includes(status) ? (status as EffectStatus) : 'unknown'

export const EffectStatusOnWire = z.string().transform(readEffectStatus)

export const EffectError = z.object({
  /** Stable and machine-readable (`conflict`, `timeout`, `deadline`, `no-executor`). */
  code: z.string().min(1),
  /** For a person. */
  message: z.string(),
})
export type EffectError = z.infer<typeof EffectError>

/** The standard field group (ADR 12 D5 E2). Timestamps are ISO strings. */
export const EffectGroup = z.object({
  status: EffectStatusOnWire,
  error: EffectError.optional(),
  /** A `pending` record past this expires and never runs. */
  deadline: z.string().optional(),
  /** Runs started: one per claim. */
  attempts: z.number().int().min(0),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  /** Kind-specific progress while running: chat's `typing`, a merge's `rebasing`. */
  stage: z.string().optional(),
})
export type EffectGroup = z.infer<typeof EffectGroup>

/** What an effect acts on, and so who sees it: the readers of the target. */
export const EFFECT_TARGET_KINDS = ['issue', 'session', 'machine'] as const
export const EffectTargetKind = z.enum(EFFECT_TARGET_KINDS)
export type EffectTargetKind = z.infer<typeof EffectTargetKind>

export const EffectTarget = z.object({ kind: EffectTargetKind, id: z.string().min(1) })
export type EffectTarget = z.infer<typeof EffectTarget>

export const EffectIdField = z.string().min(1).brand<'EffectId'>()
export type EffectId = z.infer<typeof EffectIdField>

/**
 * A HUMAN GATE'S DECISION (POD-6674). Some effects wait for a person before
 * they may run: an agent's approval request is an effect record that stays
 * `pending` until its person decides. The decision is the record's one spec
 * field, written once (the first decision wins, checked by revision): `approve`
 * lets the trigger run it, `deny` ends it `cancelled` in the same write.
 */
export const EFFECT_DECISIONS = ['approve', 'deny'] as const
export const EffectDecision = z.enum(EFFECT_DECISIONS)
export type EffectDecision = z.infer<typeof EffectDecision>

/** The stage of a gated record nobody has decided yet. */
export const AWAITING_DECISION_STAGE = 'awaiting-approval'

/**
 * The effect kind of an agent's approval request: a management operation (an
 * update, a channel switch, a workflow publish…) that waits for its person.
 * Its input is `ApprovalEffectInput` (`@podium/protocol`).
 */
export const APPROVAL_EFFECT_KIND = 'approval'

/** A new effect record's id: `eff_<uuid>`, minted on the device (ADR 12 D4). */
export const NewEffectId = deviceIdSchema('eff_')

/**
 * The generic effect record, as the feed carries it. `input` is what the
 * executor's kind publishes of its input: a kind may keep bulky or sensitive
 * input off the feed (a file write publishes its path and hash, not the text).
 */
export const EffectRecordWire = z.object({
  id: EffectIdField,
  /** The executor's kind: `issue.merge`, `file.write`, `machine.scan`, … */
  kind: z.string().min(1),
  target: EffectTarget,
  input: z.unknown(),
  /** The executor's small, kind-specific answer (a merge's commit, a scan's repos). */
  result: z.unknown().optional(),
  /** Cancel is an edit (ADR 12 D5): honoured before the run, or at the executor's safe points. */
  cancelRequested: z.boolean(),
  /**
   * A gated kind's decision (POD-6674): `null` while it waits for its person,
   * then `approve` or `deny`. Absent on a kind with no human gate.
   */
  decision: EffectDecision.nullable().optional(),
  /**
   * Who a gated record is routed to (POD-6674): the people offered its
   * decision, set when it is asked. Absent: its creator.
   */
  deciders: z.array(z.string()).optional(),
  effect: EffectGroup,
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number().int(),
})
export type EffectRecordWire = z.infer<typeof EffectRecordWire>

/** An effect's place in the standard status, with its own stage where it has one. */
export interface EffectView {
  readonly status: EffectStatus
  readonly stage?: string
}

/**
 * CHAT CONFORMS (ADR 12 D5 E2). The message row keeps its own delivery status,
 * which has more steps than the standard set; this is how every "in progress"
 * surface reads it. The steps between `stored` and `confirmed` are one
 * `running` effect at different stages.
 */
export function messageEffect(status: MessageDeliveryStatus): EffectView {
  switch (status) {
    case 'stored':
      return { status: 'pending' }
    case 'dispatched':
    case 'reached-machine':
    case 'typing':
    case 'typed':
    case 'accepted':
      return { status: 'running', stage: status }
    case 'confirmed':
      return { status: 'succeeded' }
    case 'cancelled':
    case 'failed':
    case 'expired':
    case 'unknown':
      return { status }
  }
}

/**
 * The detail an automation run carries while its fire is under way: the
 * scheduler reserves the occurrence before it spawns, and finishes the row
 * after (`modules/automations/service.ts`). Written by the scheduler only.
 */
export const AUTOMATION_RUN_RESERVED = 'reserved'

/**
 * AUTOMATION RUNS CONFORM (ADR 12 D5 E2, POD-6418). A run row is one scheduled
 * fire: an effect the scheduler performs once, recorded on its own natural
 * record. Like chat, it keeps its own outcome vocabulary, and this is how every
 * "in progress" surface reads it.
 *
 *  - a reserved occurrence (outcome `error`, detail `reserved`) is a fire under
 *    way: `running`, at the stage `spawning`;
 *  - `spawned`: the session started and took the prompt: `succeeded`;
 *  - `error`: the fire failed, with its detail: `failed`;
 *  - `missed`: the occurrence passed while the server could not fire it and is
 *    not backfilled. That is an expiry by definition: past its time, never run;
 *  - `skipped_overlap`: the previous fire's session was still live, so this one
 *    was deliberately not run: `cancelled`, by the schedule's own rule.
 *
 * There is no `pending` and no `unknown`: the scheduler writes a row only when it
 * fires, and a reserved row it lost track of is resumed by the next pass, not
 * left to guess (`applyObservedOccurrence`).
 */
export function automationRunEffect(
  run: Pick<AutomationRunWire, 'outcome' | 'detail'>,
): EffectView {
  switch (run.outcome) {
    case 'spawned':
      return { status: 'succeeded' }
    case 'error':
      return run.detail === AUTOMATION_RUN_RESERVED
        ? { status: 'running', stage: 'spawning' }
        : { status: 'failed' }
    case 'missed':
      return { status: 'expired' }
    case 'skipped_overlap':
      return { status: 'cancelled' }
  }
}
