/**
 * EFFECT RECORDS: THE THREE COMMANDS (ADR 12 D5 E2, POD-6357).
 *
 * A one-shot effect (a merge, a file write, a scan, a clone, an interrupt) is
 * asked for by creating a record, and its progress and outcome come back as the
 * record's status. A client has three commands and no others:
 *
 *  - `effects.create`: a new record, `pending`, with a device-minted `eff_<uuid>`
 *    id (ADR 12 D4). After the commit the server's one trigger hands it to the
 *    executor registered for `kind`.
 *  - `effects.cancel`: cancel is an edit (ADR 12 D5). A record that has not started
 *    ends `cancelled` in the same write; a running one is flagged for its executor,
 *    which honours it at its own safe points.
 *  - `effects.dismiss`: take an ended record (or an `unknown` one nobody can settle)
 *    off the feed.
 *
 * NOT GENERIC RECORDS (`records.<kind>.*`): those apply `exp-rev`, `single-writer`
 * or `field-LWW` to plain data. An effect record's lifecycle is a state machine
 * (`cmd`): its status is only ever the executor's, and its rule is
 * {@link EFFECT_CONFLICT_RULE}.
 *
 * The executor's kind decides the rest at the server: its input schema, the
 * permission on the target, the deadline. A kind this server does not serve is
 * refused, never stored.
 */

import { EffectIdField, EffectTarget, NewEffectId } from '@podium/model'
import { z } from 'zod'
import type {
  AttributionPolicy,
  CommandContract,
  CommandPolicy,
  CreationOwnership,
  DeliveryPolicy,
  ErrorConsistency,
  RedactionPolicy,
  TransportTag,
} from '../contract'
import { ISSUE_ATTRIBUTION, REAUTHORIZATION } from '../issues/cells'

/** The longest a record may wait before it runs: past it, it expires unrun. */
export const EFFECT_MAX_DEADLINE_MS = 24 * 60 * 60 * 1000

export const EffectsCreateInput = z
  .object({
    id: NewEffectId,
    /** The executor's kind: `issue.merge`, `file.write`, `machine.scan`, … */
    kind: z.string().min(1).max(64),
    target: EffectTarget,
    /** The kind's own input; the server parses it with the kind's schema. */
    input: z.unknown(),
    /** How long it may wait to start. Defaults to the kind's own deadline. */
    deadlineMs: z.number().int().positive().max(EFFECT_MAX_DEADLINE_MS).optional(),
  })
  .strict()
export type EffectsCreateInput = z.infer<typeof EffectsCreateInput>

export const EffectsCancelInput = z.object({ id: EffectIdField }).strict()
export type EffectsCancelInput = z.infer<typeof EffectsCancelInput>

export const EffectsDismissInput = z.object({ id: EffectIdField }).strict()
export type EffectsDismissInput = z.infer<typeof EffectsDismissInput>

export const EFFECT_CONFLICT_RULE =
  'A state machine (`EffectLifecycle`, ADR 12 D5 E2). Create appends: an existing id is refused, never ' +
  'overwritten. Cancel and dismiss are guarded writes on the current status (cancel applies to ' +
  '`pending`, `running` and `unknown`; dismiss to an ended or `unknown` record) and are no-ops when ' +
  'already applied. Every status move is the executor’s, written as `UPDATE … WHERE status IN ' +
  'allowedFrom(to)`, so of two triggers exactly one claims the record.'

/**
 * `sync.submit` is served over tRPC. The relay is named too: an agent's
 * `issues.action` (POD-6394) creates its effect record as the agent, over the
 * transport it arrived on. The other adapters come with POD-6359.
 */
const SUBMIT_ONLY: readonly TransportTag[] = ['trpc', 'relay']

const EFFECT_DELIVERY: DeliveryPolicy = {
  class: 'offline-eligible',
  outboxReconciliation:
    'QUEUED through the client outbox onto `sync.submit` (ADR 12 D2/D6). The entry point dedups by the ' +
    'envelope mutationId; a create carries its own device id, so a replay after a lost reply is the same ' +
    'record. The record shows `pending` at once and its status follows from the feed (ADR 12 D7). A ' +
    'record that arrives after its deadline expires unrun.',
  applyTimeReauthorization: REAUTHORIZATION,
}

const EFFECT_REDACTION: RedactionPolicy = {
  reviewed: true,
  inputPaths: ['input'],
  outputPaths: [],
  note:
    'An executor input can carry content (a file write carries the text), so `input` is redacted from ' +
    'logs; the feed carries only what the kind publishes of it.',
}

const EFFECT_ERRORS: ErrorConsistency = {
  callerSuppliedTargetId: true,
  invisibleFailsAs: 'nonexistent',
  distinguishesUnauthorizedFromUnreachable: false,
  note:
    'A record, or a target, the caller may not see fails exactly as an unknown one; a kind this server ' +
    'does not serve fails the same way.',
}

const ATTRIBUTION: AttributionPolicy = ISSUE_ATTRIBUTION

const CREATE_POLICY: CommandPolicy = {
  action: 'write',
  roleFloor: 'member',
  resource: 'none',
  confirmation: 'none',
  rationale:
    'The role floor here; the permission on the TARGET is the executor kind’s own (a merge needs write ' +
    'on the issue, a scan use of the machine), checked live in the target step.',
}

const ON_RECORD_POLICY: CommandPolicy = {
  action: 'write',
  roleFloor: 'member',
  resource: 'none',
  confirmation: 'none',
  rationale:
    'Whoever may create an effect of this kind on this target may cancel or dismiss it: the same live ' +
    'target check, read off the stored record.',
}

const CREATES_EFFECT: CreationOwnership = {
  creates: ['effect'],
  owner: 'on-behalf-of-human',
  visibility: 'personal',
  inheritanceOnCreate: 'on-behalf-of-human',
  note: 'Owned by the creator’s on-behalf-of human; everyone who may read the target sees it too.',
}

const CREATES_NOTHING: CreationOwnership = {
  creates: [],
  note: 'Changes or removes an existing record; mints nothing.',
}

const base = {
  version: 1,
  visibility: 'personal',
  exposure: SUBMIT_ONLY,
  delivery: EFFECT_DELIVERY,
  redaction: EFFECT_REDACTION,
  attribution: ATTRIBUTION,
  errorConsistency: EFFECT_ERRORS,
} as const

export const effectsCreateContract: CommandContract<typeof EffectsCreateInput> = {
  ...base,
  name: 'effects.create',
  input: EffectsCreateInput,
  policy: CREATE_POLICY,
  ownership: CREATES_EFFECT,
  conflict: 'append',
}

export const effectsCancelContract: CommandContract<typeof EffectsCancelInput> = {
  ...base,
  name: 'effects.cancel',
  input: EffectsCancelInput,
  policy: ON_RECORD_POLICY,
  ownership: CREATES_NOTHING,
  conflict: 'cmd',
  conflictRule: EFFECT_CONFLICT_RULE,
}

export const effectsDismissContract: CommandContract<typeof EffectsDismissInput> = {
  ...base,
  name: 'effects.dismiss',
  input: EffectsDismissInput,
  policy: ON_RECORD_POLICY,
  ownership: CREATES_NOTHING,
  conflict: 'cmd',
  conflictRule: EFFECT_CONFLICT_RULE,
}

/** The effect commands, by wire name. */
export const EFFECT_CONTRACTS = {
  'effects.create': effectsCreateContract,
  'effects.cancel': effectsCancelContract,
  'effects.dismiss': effectsDismissContract,
} as const
