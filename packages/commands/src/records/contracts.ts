/**
 * GENERIC SYNCED EDITS: THE THREE COMMANDS, PER KIND (ADR 12 D3, POD-6391).
 *
 * Clients get `create(kind, id, fields)`, `edit(ref, patch, expectedRevision?)`
 * and `remove(ref)` for plain data, and nothing else. On the wire each is one
 * contract PER KIND, `records.<kind>.<op>`, generated from the kind's declaration
 * (`./declare.ts`, `./kinds.ts`):
 *
 *  - The entry point's coarse check runs BEFORE parsing (ADR 12 D2 step 2), so it
 *    can only see the command's name. One name per kind lets that check, and the
 *    contract's policy, visibility and conflict class, be the kind's own instead
 *    of a single `records.edit` whose every column would have to say "depends".
 *  - The client API stays three functions; it picks the name from the kind.
 *
 * INPUTS. A patch parses over EVERY declared field (all roles), strict: a field
 * the kind does not declare is `invalid` at parse. A declared field that is not
 * `spec` parses and is then refused `unauthorized` by the server AFTER the target
 * check, which is D2's order: the parse says what the input is, the permission
 * says whether this caller may do it.
 */

import { Revision } from '@podium/model'
import { z } from 'zod'
import type { AnyCommandContract, CommandContract } from '../contract'
import {
  createFields,
  type RecordOp,
  recordCommandName,
  type SyncedKindDeclaration,
} from './declare'
import { SYNCED_KINDS } from './kinds'

const CREATES_NOTHING = {
  creates: [],
  note: 'Changes or removes an existing record; mints nothing, so there is no owner to assign.',
} as const

/** A non-empty patch over the declared fields. */
function patchSchema(d: SyncedKindDeclaration): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [name, f] of Object.entries(d.fields)) shape[name] = f.schema.optional()
  return z
    .object(shape)
    .strict()
    .refine((patch) => Object.values(patch).some((v) => v !== undefined), {
      message: 'a patch names at least one field',
    })
}

/** What a create carries: spec and key fields (required where declared) and the
 *  kind's placement inputs (always required). */
function createFieldsSchema(d: SyncedKindDeclaration): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const name of createFields(d)) {
    const f = d.fields[name]
    if (f === undefined) continue
    shape[name] = f.required ? f.schema : f.schema.optional()
  }
  for (const [name, schema] of Object.entries(d.placement ?? {})) shape[name] = schema
  return z.object(shape).strict()
}

export function recordEditInput(d: SyncedKindDeclaration) {
  return z.object({
    id: d.ref,
    patch: patchSchema(d),
    expectedRevision: Revision.optional(),
  })
}

export function recordCreateInput(d: SyncedKindDeclaration) {
  if (d.newId === undefined) throw new Error(`${d.kind} declares no device id shape`)
  return z.object({ id: d.newId, fields: createFieldsSchema(d) })
}

export function recordRemoveInput(d: SyncedKindDeclaration) {
  return z.object({ id: d.ref, expectedRevision: Revision.optional() })
}

function base(d: SyncedKindDeclaration, op: RecordOp) {
  const opPolicy = d.ops[op]
  if (opPolicy === undefined) throw new Error(`${d.kind} does not offer ${op}`)
  return {
    name: recordCommandName(d.kind, op),
    version: 1,
    visibility: d.visibility,
    policy: opPolicy.policy,
    exposure: d.exposure,
    delivery: d.delivery,
    redaction: d.redaction,
    attribution: d.attribution,
    errorConsistency: d.errorConsistency,
  }
}

/** The contracts one kind serves, by op. An op the kind does not offer is absent. */
export function recordContracts(
  d: SyncedKindDeclaration,
): Partial<Record<RecordOp, CommandContract>> {
  const out: Partial<Record<RecordOp, CommandContract>> = {}
  if (d.ops.create !== undefined) {
    if (d.creates === undefined) throw new Error(`${d.kind} offers create without \`creates\``)
    out.create = {
      ...base(d, 'create'),
      input: recordCreateInput(d),
      ownership: d.creates,
      // A create appends a new record; an id that exists is refused, never
      // overwritten (ADR 12 D4), so there is no older value to arbitrate against.
      conflict: 'append',
    }
  }
  if (d.ops.edit !== undefined) {
    out.edit = {
      ...base(d, 'edit'),
      input: recordEditInput(d),
      ownership: CREATES_NOTHING,
      conflict: d.conflict,
    }
  }
  if (d.ops.remove !== undefined) {
    out.remove = {
      ...base(d, 'remove'),
      input: recordRemoveInput(d),
      ownership: CREATES_NOTHING,
      conflict: d.conflict,
    }
  }
  return out
}

/** Every generated contract of these kinds, by wire name. */
export function recordContractTable(
  kinds: readonly SyncedKindDeclaration[],
): Record<string, AnyCommandContract> {
  const table: Record<string, AnyCommandContract> = {}
  for (const d of kinds) {
    for (const contract of Object.values(recordContracts(d))) {
      if (contract === undefined) continue
      if (table[contract.name] !== undefined) throw new Error(`${contract.name} is declared twice`)
      table[contract.name] = contract
    }
  }
  return table
}

/** The generic record commands this build serves, by wire name. */
export const RECORD_CONTRACTS: Readonly<Record<string, AnyCommandContract>> =
  recordContractTable(SYNCED_KINDS)
