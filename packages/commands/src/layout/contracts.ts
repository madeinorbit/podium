/**
 * LAYOUT WRITE FAMILY (POD-1350) — `layout.set` · `layout.clear`.
 *
 * Sidebar and tab layout are §3.3 per-user state: one person, never shared,
 * non-grantable. Until this family they lived only in client ui-state, so a
 * second device could not follow the first. The durable home is
 * `user_layout` keyed `(user_id, key)`; this file is the command half that
 * makes those rows writable through the Outbox (POD-402) rather than through
 * local persistence.
 *
 * ---------------------------------------------------------------------------
 * ONE PATCH COMMAND, KEYED BY THE CLOSED VOCABULARY
 * ---------------------------------------------------------------------------
 * Admissible keys are `@podium/model`'s {@link isLayoutKey} — the SAME list
 * POD-403's routing table classifies as per-user-replicated. A free-form key
 * fails the input schema before a handler exists, so a key cannot silently
 * grow a server row that ui-state still treats as device-local.
 *
 * The response is a full {@link LayoutSnapshot} for the calling principal
 * (every key they have set). POD-403 hydrates from that one object; legacy
 * local values are forwarded once via this command then deleted from ui-state.
 *
 * ---------------------------------------------------------------------------
 * NOT `personal`, AND NOT A SETTINGS PATH
 * ---------------------------------------------------------------------------
 * `visibility: 'per-user-state'` — the class ADR 9 D3 rule 4 reserves for
 * facts that differ per reader and are never grantable. A `personal`
 * classification would key a per-user fact as a shareable one (POD-351 /
 * POD-731 trap). Resource is `none` because the row IS the principal: there
 * is no shared entity to gate, and no "share my dock tab" verb.
 */

import { isLayoutKey, MutationIdField } from '@podium/model'
import { z } from 'zod'
import type {
  AttributionPolicy,
  CommandContract,
  CreationOwnership,
  DeliveryPolicy,
  ErrorConsistency,
  RedactionPolicy,
  TransportTag,
} from '../contract'

// ---------------------------------------------------------------------------
// Input: a closed-vocabulary patch
// ---------------------------------------------------------------------------

/**
 * A patch of layout keys → JSON values. Empty is refused: a write that names
 * no key is not a write.
 *
 * Values stay `unknown` — leaf shapes belong to the ui-state module that already
 * reads them; restating every map and enum here would be a second vocabulary.
 */
const layoutValuesPatch = z
  .record(z.string(), z.unknown())
  .superRefine((values: Record<string, unknown>, ctx: z.RefinementCtx) => {
    const keys = Object.keys(values)
    if (keys.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a layout patch must name at least one key',
      })
    }
    for (const key of keys) {
      if (!isLayoutKey(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message:
            `'${key}' is not a replicated layout key — see isLayoutKey / DEVICE_LOCAL_UI_KEYS ` +
            '(POD-1350 / POD-403 routing table)',
        })
      }
    }
  })

export const layoutSetInput = z.object({
  values: layoutValuesPatch,
  mutationId: z.string().max(128).pipe(MutationIdField).optional(),
})
export type LayoutSetInput = z.infer<typeof layoutSetInput>

/** Forget one or more layout keys (reset to client default). Empty refused. */
export const layoutClearInput = z.object({
  keys: z
    .array(z.string())
    .min(1)
    .superRefine((keys: string[], ctx: z.RefinementCtx) => {
      for (const [i, key] of keys.entries()) {
        if (!isLayoutKey(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i],
            message: `'${key}' is not a replicated layout key`,
          })
        }
      }
    }),
  mutationId: z.string().max(128).pipe(MutationIdField).optional(),
})
export type LayoutClearInput = z.infer<typeof layoutClearInput>

// ---------------------------------------------------------------------------
// Shared cells
// ---------------------------------------------------------------------------

const SERVED_ON: readonly TransportTag[] = ['trpc', 'outbox']

const LAYOUT_DELIVERY: DeliveryPolicy = {
  class: 'offline-eligible',
  outboxReconciliation:
    'MAY be queued. A layout write is INERT while it waits — it arms nothing and places no ' +
    'work on compute — and the row is SINGLE-WRITER keyed `(userId, key)`, so the only race is ' +
    'the same person on another device. Exposed on `outbox` because POD-402 routes every ' +
    'replicated per-user write through the Outbox; POD-403 never writes these keys to local ' +
    'ui-state as authority.',
  applyTimeReauthorization:
    'Re-authorized at every apply against the delegation resolved LIVE (ADR 9 D5 A1 / ADR 3 D8): ' +
    'the OWNING USER is re-checked at drain. A principal who is no longer the key\'s user has the ' +
    'entry refused and dead-lettered rather than retried — a rights change is not transient ' +
    '(ADR 3 Amendment 1 D16).',
}

const LAYOUT_REDACTION: RedactionPolicy = {
  reviewed: true,
  inputPaths: [],
  outputPaths: [],
  note:
    'Nothing redacted. Layout keys are shell chrome (dock tab, panel mode, section collapses) — ' +
    'not credentials, not notification routing addresses, not unsent prose. The closed vocabulary ' +
    'contains no secret-value path by construction.',
}

const LAYOUT_OWNERSHIP: CreationOwnership = {
  creates: [],
  note:
    'Mints nothing. A layout row is materialised by the store on first write and IS the user by ' +
    'its key; there is nothing for inheritanceOnCreate to decide (ADR 9 D3 rule 4 — per-user ' +
    'state is non-grantable).',
}

const LAYOUT_ATTRIBUTION: AttributionPolicy = {
  actor: 'from-capability',
  onBehalfOf: 'from-delegation',
  wirePlacement: 'separate-field',
  reservedWireKeys: ['actor', 'onBehalfOf'],
  rationale:
    'Both halves stamped from the transport principal, never from payload. The only address these ' +
    'commands carry is a layout KEY from the closed vocabulary; Amendment 1 D17 forbids a routing ' +
    'address doubling as the accountability record.',
}

const CLOSED_VOCABULARY_ERRORS: ErrorConsistency = {
  callerSuppliedTargetId: false,
  note:
    'The caller supplies a KEY from a CLOSED public vocabulary (isLayoutKey), never an entity id. ' +
    'Every admissible key exists as an address on every instance; an unknown key fails as a schema ' +
    'error, disclosing only that the vocabulary is closed. There is no hidden entity whose ' +
    'existence an error could confirm.',
}

// ---------------------------------------------------------------------------
// layout.set
// ---------------------------------------------------------------------------

/**
 * Write one or more layout keys for the calling principal.
 *
 * `visibility: 'per-user-state'` — never `personal`. Offline-eligible and on
 * the Outbox so a layout change made offline still drains as a command.
 */
export const layoutSetContract = {
  name: 'layout.set',
  version: 1,
  visibility: 'per-user-state',
  input: layoutSetInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'none',
    confirmation: 'none',
    rationale:
      'A member writes their OWN layout rows. `resource: "none"` because the row IS the principal ' +
      '(keyed userId) — there is no shared entity to gate and no grant verb on this class (ADR 9 D3 ' +
      'rule 4). No confirmation: every leaf is reversible by writing it again or clearing it. No ' +
      'machineVerb: a layout write places no work on owned compute.',
  },
  exposure: SERVED_ON,
  delivery: LAYOUT_DELIVERY,
  redaction: LAYOUT_REDACTION,
  ownership: LAYOUT_OWNERSHIP,
  attribution: LAYOUT_ATTRIBUTION,
  errorConsistency: CLOSED_VOCABULARY_ERRORS,
  conflict: 'single-writer',
  cli: { summary: 'Write sidebar/tab layout keys for the calling user' },
} as const satisfies CommandContract<typeof layoutSetInput>

// ---------------------------------------------------------------------------
// layout.clear
// ---------------------------------------------------------------------------

/** Delete layout keys so the client falls back to defaults. */
export const layoutClearContract = {
  name: 'layout.clear',
  version: 1,
  visibility: 'per-user-state',
  input: layoutClearInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'none',
    confirmation: 'none',
    rationale:
      'A member forgets their OWN layout choices. Same self-scoped floor as layout.set; absence of ' +
      'the row is the only spelling of "never set" (matching SessionReadState / preferences).',
  },
  exposure: SERVED_ON,
  delivery: LAYOUT_DELIVERY,
  redaction: LAYOUT_REDACTION,
  ownership: LAYOUT_OWNERSHIP,
  attribution: LAYOUT_ATTRIBUTION,
  errorConsistency: CLOSED_VOCABULARY_ERRORS,
  conflict: 'single-writer',
  cli: { summary: 'Clear sidebar/tab layout keys for the calling user' },
} as const satisfies CommandContract<typeof layoutClearInput>

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export const LAYOUT_CONTRACTS = {
  'layout.set': layoutSetContract,
  'layout.clear': layoutClearContract,
} as const

export type LayoutContractName = keyof typeof LAYOUT_CONTRACTS
export const LAYOUT_CONTRACT_NAMES = Object.keys(LAYOUT_CONTRACTS) as LayoutContractName[]
