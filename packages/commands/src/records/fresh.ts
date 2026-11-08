/**
 * WHAT A NEW RECORD LOOKS LIKE (POD-6400).
 *
 * A create carries only what a person chose: an issue's title, maybe its
 * priority. The wire row has many more cells, and the server fills them in
 * inside the create. For the creating device to paint the record at once, it
 * must know the whole row before the server answers, and know it the SAME way
 * the server does. So each kind that offers create declares it once:
 *
 *  - a field's `default` (`./declare.ts`): what a create that leaves the field
 *    out stores, in the field's own spelling. The server's generic create
 *    applies it ({@link freshCreateFields}); the device paints it.
 *  - `fresh.cells`: wire cells that are not fields, set to the same constant on
 *    every new record (an issue starts in `backlog`, unarchived). The family's
 *    create reads them from here rather than restating them.
 *  - `fresh.pending`: the cells only the server can assign (an issue's `seq`,
 *    its owner, its timestamps). The device paints a PLACEHOLDER, computed from
 *    what it knows (when it queued the create, who it is), and readers treat
 *    the cell as pending until the server's row lands and replaces the paint.
 *    A placeholder that returns `undefined` paints the cell absent, which only
 *    an optional cell may be.
 *
 * {@link freshRow} builds the whole wire row from those. {@link freshProblems}
 * holds the declaration to "the row is whole": every cell the wire requires is
 * covered, and every value parses as its cell, checked where the kind is
 * declared.
 *
 * This file imports types only from `./declare.ts`, which imports it.
 */

import type { z } from 'zod'
import type { SyncedKindDeclaration } from './declare'

type Values = Readonly<Record<string, unknown>>

/** What the creating device knows when it paints a placeholder. */
export interface FreshContext {
  /** When the create was queued, as an ISO timestamp. */
  readonly at: string
  /** The person creating it, when the device knows; `null` otherwise. */
  readonly by: string | null
  /**
   * The ids of the rows of `entity` this device holds whose `field` equals
   * `value`, for a placeholder that places the record by what the create names
   * (an issue's repo, by its path). A guess for display only: the server's
   * value replaces it when the row lands. Absent: the device knows no rows.
   */
  readonly known?: (entity: string, field: string, value: unknown) => readonly string[]
}

export interface FreshRecord {
  /** Wire cells that are not fields, and the constant every new record holds. */
  readonly cells: Readonly<Record<string, unknown>>
  /** Wire cells the server assigns, and what the device paints until it does. */
  readonly pending: Readonly<Record<string, (ctx: FreshContext, fields: Values) => unknown>>
}

/** The fields a create may carry (spec and key), as `./declare.ts#createFields`. */
const createable = (d: SyncedKindDeclaration): string[] =>
  Object.entries(d.fields)
    .filter(([, f]) => f.role === 'spec' || f.role === 'key')
    .map(([name]) => name)

/** A create's fields with every declared default applied where the create left
 *  the field out. Other inputs (placement) pass through unchanged. */
export function freshCreateFields(d: SyncedKindDeclaration, fields: Values): Values {
  const out: Record<string, unknown> = { ...fields }
  for (const name of createable(d)) {
    const f = d.fields[name]
    if (f !== undefined && 'default' in f && out[name] === undefined) out[name] = f.default
  }
  return out
}

/** The cells the server assigns in a create; a reader treats them as pending
 *  while a create's paint is all there is. */
export const pendingCells = (d: SyncedKindDeclaration): string[] =>
  Object.keys(d.fresh?.pending ?? {})

const DOC_KEYS: ReadonlySet<string> = new Set(['value', 'revision', 'opsTail'])

/** Whether a wire cell is an op-stream document: an object whose keys are the
 *  document's (`value`, `revision`, `opsTail`) and that has a `value`. */
function isDocumentCell(schema: unknown): boolean {
  let s = schema as { _def?: { innerType?: unknown }; shape?: unknown } | undefined
  while (s?._def?.innerType !== undefined) s = s._def.innerType as typeof s
  const shape = s?.shape
  if (shape === null || typeof shape !== 'object') return false
  const keys = Object.keys(shape)
  return keys.includes('value') && keys.every((k) => DOC_KEYS.has(k))
}

/** Field values as the kind's wire row spells them: only declared fields, and
 *  an op-stream document (`{ value, … }` on the wire) as `{ value }`. */
export function wireCells(d: SyncedKindDeclaration, values: Values): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || !(name in d.fields)) continue
    out[name] = isDocumentCell(d.wire.shape[name]) ? { value } : value
  }
  return out
}

/**
 * The whole wire row a create paints on the device that made it: the pending
 * placeholders, the constant cells, then the create's own fields with their
 * defaults, under the new id. `undefined` for a kind with no fresh shape.
 */
export function freshRow(
  d: SyncedKindDeclaration,
  id: string,
  fields: Values,
  ctx: FreshContext,
): Record<string, unknown> | undefined {
  if (d.fresh === undefined) return undefined
  const row: Record<string, unknown> = {}
  for (const [name, placeholder] of Object.entries(d.fresh.pending)) {
    const value = placeholder(ctx, fields)
    if (value !== undefined) row[name] = value
  }
  Object.assign(row, d.fresh.cells, wireCells(d, freshCreateFields(d, fields)))
  if ('id' in d.wire.shape) row.id = id
  return row
}

/** Contexts a placeholder is checked under: a device that knows its person, and one that does not. */
const SAMPLE_CONTEXTS: readonly FreshContext[] = [
  { at: '2026-01-01T00:00:00.000Z', by: 'user_sample' },
  { at: '2026-01-01T00:00:00.000Z', by: null },
]

const acceptsAbsent = (schema: z.ZodTypeAny | undefined): boolean =>
  schema?.safeParse(undefined).success === true

/** Why a kind's fresh shape would not paint a whole row, for `declarationProblems`. */
export function freshProblems(d: SyncedKindDeclaration): string[] {
  const fresh = d.fresh
  if (fresh === undefined)
    return ['offers create without a fresh record (what a new one looks like)']
  const out: string[] = []
  const shape = d.wire.shape as Record<string, z.ZodTypeAny>
  for (const name of Object.keys(fresh.cells)) {
    if (!(name in shape)) out.push(`fresh cell ${name} is not on the ${d.kind} wire schema`)
    else if (name in d.fields) out.push(`fresh cell ${name} is a field (give it a default instead)`)
    else if (!shape[name]?.safeParse(fresh.cells[name]).success) {
      out.push(`fresh cell ${name} does not parse as the wire cell`)
    }
    if (name in fresh.pending) out.push(`fresh cell ${name} is also pending`)
  }
  for (const [name, placeholder] of Object.entries(fresh.pending)) {
    if (!(name in shape)) {
      out.push(`pending cell ${name} is not on the ${d.kind} wire schema`)
      continue
    }
    const f = d.fields[name]
    if (f !== undefined && (f.role === 'spec' || f.role === 'key')) {
      out.push(`pending cell ${name} is a ${f.role} field a create carries`)
    }
    for (const ctx of SAMPLE_CONTEXTS) {
      const value = placeholder(ctx, {})
      const ok =
        value === undefined ? acceptsAbsent(shape[name]) : shape[name]?.safeParse(value).success
      if (!ok) {
        out.push(`pending cell ${name}'s placeholder does not parse as the wire cell`)
        break
      }
    }
  }
  // The server fills label and status fields in: a paint that set one without
  // marking it pending would show an invented value as if it were known.
  for (const [name, f] of Object.entries(d.fields)) {
    if ((f.role === 'label' || f.role === 'status') && !(name in fresh.pending)) {
      out.push(`${f.role} field ${name} is not pending in the fresh record`)
    }
  }
  // Every cell the wire requires is covered by the id, a field the create must
  // carry or defaults, a constant, or a placeholder.
  for (const [name, schema] of Object.entries(shape)) {
    if (name === 'id' || acceptsAbsent(schema)) continue
    if (name in fresh.cells || name in fresh.pending) continue
    const f = d.fields[name]
    if (f !== undefined && (f.required || 'default' in f)) continue
    out.push(`a fresh ${d.title} has no ${name}: give it a default, a constant or a placeholder`)
  }
  return out
}
