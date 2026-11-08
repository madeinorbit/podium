/**
 * GENERIC SYNCED EDITS ON THE SYNC WRITE ENTRY POINT (ADR 12 D3/D4, POD-6391).
 *
 * One handler per operation, for every kind that declares itself in
 * `@podium/commands`' `records/kinds.ts`. A kind supplies only an ADAPTER: how to
 * find its target, how to read a record's revision, and how to write a create,
 * a patch or a removal through the entry point's unit of work. Everything a
 * plain data write must get right is here, once:
 *
 *  - FIELD PERMISSION, in the target step (ADR 12 D2 step 4, before dedup): a
 *    patch may set `spec` fields only. A `status`, `label` or `key` field is
 *    refused `unauthorized`; an undeclared field never parsed.
 *  - THE CONFLICT RULE (ADR 1), PER FIELD (POD-6403): a field's own rule, else
 *    its kind's.
 *      `exp-rev`: an edit that names such a field must name the revision it was
 *      made against; the record's current revision is read inside the unit of
 *      work (the write lease holds every other writer off) and a stale one is
 *      `conflict`. A remove follows the kind's rule.
 *      `single-writer`, `field-LWW`: the patched fields alone are written, in
 *      commit order, and no revision is asked for. Only the fields a patch names
 *      are touched, so two edits of different fields both land.
 *  - CLEARING (POD-6403): an edit's `unset` names optional spec cells to make
 *    absent; the parse admits nothing else. The adapter receives them beside
 *    the patch.
 *  - THE REPLY: an edit or remove whose adapter reports the record's revision
 *    after the write answers `{ revision }`, so the device that queued the next
 *    edit of the same record can make it against that revision (its own chain,
 *    POD-6403); any other answers `{ ok: true }`.
 *  - DEVICE IDS (ADR 12 D4): a create's id shape is checked at parse (the
 *    contract's `newId`); an id that exists is `conflict`, never overwritten; the
 *    same envelope again is the entry point's dedup replay. Labels (an issue's
 *    `seq`) are the adapter's to fill inside the same write.
 *  - FRESH RECORDS (POD-6400): a field a create leaves out gets the kind's
 *    declared default here, before the adapter runs, so the stored record is
 *    the one the creating device painted (`@podium/commands` `records/fresh.ts`).
 *
 * The adapter's writes run inside the entry point's unit of work and provenance
 * scope, so its change rows carry the command's mutationId and the reply its
 * receipt, as for every other command on the path.
 */

import {
  createFields,
  editNeedsRevision,
  fieldConflict,
  freshCreateFields,
  type RecordOp,
  recordContracts,
  type SyncedKindDeclaration,
  specFields,
} from '@podium/commands'
import { SyncWriteRefused } from '../sync-write/entry'
import type {
  SyncTargetContext,
  SyncWriteContext,
  SyncWriteRegistry,
  SyncWriteTarget,
} from '../sync-write/registry'

type Fields = Readonly<Record<string, unknown>>

/** What a kind supplies. Every method runs on the entry point's path; the
 *  write methods inside its one unit of work. */
export interface RecordAdapter {
  /**
   * The target this op addresses, for the entry point's `authorize`; `undefined`
   * refuses (missing and invisible are one answer). For a create, `id` is the
   * new id and the target is whatever the record is created UNDER.
   */
  target(
    op: RecordOp,
    id: string,
    ctx: SyncTargetContext,
    /** An edit's fields (set and cleared): a kind whose fields have different
     *  gates (a session's stop and its rename) picks the gate from them. */
    edited?: { readonly patch: Fields; readonly unset: readonly string[] },
  ): Promise<SyncWriteTarget>
  /**
   * The record as the Authority holds it now, or `undefined` when there is none.
   * Required for an `exp-rev` kind (its revision) and for a kind that offers
   * create (the collision check). Read inside the unit of work.
   */
  read?(id: string): Promise<{ readonly revision?: number } | undefined>
  create?(ctx: SyncWriteContext, id: string, fields: Fields): Promise<unknown>
  /** `unset`: optional spec cells this edit makes absent (POD-6403). The
   *  result may carry the record's `revision` after the write; it is the reply. */
  edit?(
    ctx: SyncWriteContext,
    id: string,
    patch: Fields,
    expectedRevision: number | undefined,
    unset: readonly string[],
  ): Promise<unknown>
  remove?(ctx: SyncWriteContext, id: string, expectedRevision: number | undefined): Promise<unknown>
}

interface EditInput {
  readonly id: string
  readonly patch: Fields
  readonly unset?: readonly string[]
  readonly expectedRevision?: number
}
interface CreateInput {
  readonly id: string
  readonly fields: Fields
}
interface RemoveInput {
  readonly id: string
  readonly expectedRevision?: number
}

function refuse(kind: 'conflict' | 'target-not-found'): never {
  throw new SyncWriteRefused({ kind })
}

/** The fields of a patch a client may not write. */
export function forbiddenPatchFields(d: SyncedKindDeclaration, patch: Fields): string[] {
  const writable = new Set(specFields(d))
  return Object.keys(patch).filter((name) => patch[name] !== undefined && !writable.has(name))
}

/** The fields an edit names: those it sets and those it clears. */
const namedFields = (input: EditInput): string[] => [
  ...Object.keys(input.patch).filter((name) => input.patch[name] !== undefined),
  ...(input.unset ?? []),
]

/** What an edit or remove answers: the record's revision after the write, when
 *  the adapter reports one, so the device's next edit of it can chain. */
function replyOf(result: unknown): { revision: number } | { ok: true } {
  const revision = (result as { revision?: unknown } | null | undefined)?.revision
  return typeof revision === 'number' ? { revision } : { ok: true }
}

/** Register one kind's generic commands on the entry point. */
export function registerRecordKind(
  registry: SyncWriteRegistry,
  d: SyncedKindDeclaration,
  adapter: RecordAdapter,
): void {
  const contracts = recordContracts(d)
  const anyRevision =
    d.conflict === 'exp-rev' ||
    Object.keys(d.fields).some((name) => fieldConflict(d, name) === 'exp-rev')
  const needsRead = anyRevision || contracts.create !== undefined
  if (needsRead && adapter.read === undefined) {
    throw new Error(`records: ${d.kind} must say how to read a record`)
  }
  const read = async (id: string) => await adapter.read?.(id)

  /** The revision an `exp-rev` write was made against, checked now. */
  const arbitrate = async (
    id: string,
    expected: number | undefined,
    needsRevision: boolean,
  ): Promise<void> => {
    const current = await read(id)
    if (current === undefined) refuse('target-not-found')
    if (!needsRevision) return
    if (expected === undefined) {
      throw new SyncWriteRefused({ kind: 'invalid', details: ['expectedRevision'] })
    }
    if (current.revision !== expected) refuse('conflict')
  }

  if (contracts.edit !== undefined) {
    const edit = adapter.edit
    if (edit === undefined) throw new Error(`records: ${d.kind} offers edit without a writer`)
    registry.register({
      contract: contracts.edit,
      target: async (input, ctx) => {
        const { id, patch, unset = [] } = input as EditInput
        if (forbiddenPatchFields(d, patch).length > 0) return undefined
        const writable = new Set(specFields(d))
        if (unset.some((name) => !writable.has(name))) return undefined
        return await adapter.target('edit', id, ctx, { patch, unset })
      },
      handle: async (ctx, input) => {
        const edited = input as EditInput
        const { id, patch, unset = [] } = edited
        const expected = edited.expectedRevision ?? ctx.expectedRevision
        // Only an edit naming an exp-rev field is held to a revision; a plain
        // field's last writer wins (POD-6403).
        if (needsRead) await arbitrate(id, expected, editNeedsRevision(d, namedFields(edited)))
        return replyOf(await edit(ctx, id, patch, expected, unset))
      },
    })
  }

  if (contracts.create !== undefined) {
    const create = adapter.create
    if (create === undefined) throw new Error(`records: ${d.kind} offers create without a writer`)
    const allowed = new Set([...createFields(d), ...Object.keys(d.placement ?? {})])
    registry.register({
      contract: contracts.create,
      target: async (input, ctx) => {
        const { id, fields } = input as CreateInput
        // The contract's schema is strict over these already; held here too, so
        // a create can never carry a label or status field past a looser schema.
        if (Object.keys(fields).some((name) => !allowed.has(name))) return undefined
        return await adapter.target('create', id, ctx)
      },
      handle: async (ctx, input) => {
        const { id, fields } = input as CreateInput
        // A create never overwrites (ADR 12 D4). The same envelope again never
        // reaches here: the entry point's dedup answers it as a replay.
        if ((await read(id)) !== undefined) {
          // An idempotent create (a pin) keeps the record it finds.
          if (d.recreate === 'keep') return { ok: true }
          refuse('conflict')
        }
        // The declared defaults (POD-6400), the same ones the creating device
        // painted: a field the create left out is stored as declared.
        return await create(ctx, id, freshCreateFields(d, fields))
      },
    })
  }

  if (contracts.remove !== undefined) {
    const remove = adapter.remove
    if (remove === undefined) throw new Error(`records: ${d.kind} offers remove without a writer`)
    registry.register({
      contract: contracts.remove,
      target: async (input, ctx) => await adapter.target('remove', (input as RemoveInput).id, ctx),
      handle: async (ctx, input) => {
        const { id } = input as RemoveInput
        const expected = (input as RemoveInput).expectedRevision ?? ctx.expectedRevision
        // A kind whose existence is the record (a pin) removes idempotently:
        // removing what is not there is done, not unknown.
        if (d.recreate === 'keep' && (await read(id)) === undefined) return { ok: true }
        if (needsRead) await arbitrate(id, expected, d.conflict === 'exp-rev')
        return replyOf(await remove(ctx, id, expected))
      },
    })
  }
}
