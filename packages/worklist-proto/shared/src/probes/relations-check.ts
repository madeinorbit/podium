/**
 * POD-4564 (L6b) — the relation check: every declared relation, both
 * directions, held to the feed's rows through the arm's own accessor.
 *
 * WHY. Two of the five mistakes live in the graph, not on the screen: an
 * evicted row left in an inverse collection (P2) and a relation maintained in
 * one direction (P5). In the K exercises the MobX arm failed SOFT on both
 * (every read re-checked the table, so the screen stayed right) and only a
 * bucket-level unit test saw them (K MobX E). A bucket-level test is
 * arm-private; this check is not: every round-three pool implements the
 * shared `RelationReader` (L5a) and hands it to `reads.wrapRelations` (arm
 * contract), so `capturingFence` catches that reader on the way in and the
 * probe reads it RAW (uncounted, after the reads cell was taken).
 *
 * THE TWO INVARIANTS, per single-valued relation R on `from` with inverse I
 * on `to` (schema doc §4), over the rows the feed holds now:
 * 1. NO GHOSTS: every id a collection `many(to, y, I)` yields, for a row y
 *    the feed holds, is a row the feed holds (§4.3: a delete removes the row
 *    from "every collection holding it").
 * 2. BOTH DIRECTIONS AGREE: `one(from, x, R) = y` (non-null) implies x is in
 *    `many(to, y, I)`; and x in `many(to, y, I)` implies `one(from, x, R) = y`
 *    (§4.1/§4.2: attach and detach "both directions").
 *
 * WHAT IT DOES NOT CHECK: that R resolves to the RIGHT target (that is the
 * declared resolver's job, and the arm's gate: POD-4567's `diffRelations`
 * resolves from scratch per arm). A pool that attaches both directions to the
 * wrong row passes this and fails its rebuild. A reference held to a target
 * the feed no longer has is allowed (§4.3: "the holder keeps the reference
 * id"), and a collection of an absent target is not read.
 */

import type { RowSource } from '../arm'
import type { ReadFence, RelationReader } from '../instrument/reads'
import { type EntityName, type ModelSchema, SCHEMA } from '../schema'
import type { RelationRef } from './probe'

/** A fence that behaves exactly like `inner` and remembers the relation accessor the arm hands it. */
export interface CapturingFence {
  readonly fence: ReadFence
  /** The raw accessor the arm passed to `wrapRelations`, or null if it never did. */
  relations(): RelationReader | null
}

export function capturingFence(inner: ReadFence): CapturingFence {
  let captured: RelationReader | null = null
  const fence: ReadFence = {
    get enabled() {
      return inner.enabled
    },
    wrapSource: (source) => inner.wrapSource(source),
    wrapTables: (tables, options) => inner.wrapTables(tables, options),
    wrapRelations: (reader) => {
      captured = reader
      return inner.wrapRelations(reader)
    },
    touch: (entity, id, via) => inner.touch(entity, id, via),
    isBorrowed: (value) => inner.isBorrowed(value),
    assertNoCopies: (root) => inner.assertNoCopies(root),
    stats: () => inner.stats(),
    reset: () => inner.reset(),
  }
  return { fence, relations: () => captured }
}

/** Every single-valued relation the schema declares (`belongsTo`, `prefix`, outgoing `edge`). */
export function declaredLinks(schema: ModelSchema = SCHEMA): RelationRef[] {
  const out: RelationRef[] = []
  for (const from of Object.keys(schema) as EntityName[]) {
    for (const [relation, spec] of Object.entries(schema[from].relations)) {
      if (spec.kind === 'hasMany') continue
      if (spec.kind === 'edge' && spec.direction === 'in') continue
      out.push({ from, relation })
    }
  }
  return out
}

/** The ids the feed holds now, per entity it carries (`repo` rows are not a feed kind). */
export function feedRowIds(source: RowSource): Partial<Record<EntityName, ReadonlySet<string>>> {
  return {
    issue: new Set(source.snapshot('issue').map((row) => row.id)),
    session: new Set(source.snapshot('session').map((row) => row.id)),
    worktree: new Set(source.snapshot('worktree').map((row) => row.id)),
  }
}

export interface RelationCheck {
  /** Bounded to `MAX_PROBLEMS` lines; empty when both invariants hold. */
  problems: string[]
  /** How many problems there were in all. */
  total: number
  /** Edges looked at (both directions), so a check that saw nothing is visible. */
  edges: number
}

const MAX_PROBLEMS = 12

export function checkRelations(
  reader: RelationReader,
  rows: Partial<Record<EntityName, ReadonlySet<string>>>,
  scope: readonly RelationRef[] = declaredLinks(),
  schema: ModelSchema = SCHEMA,
): RelationCheck {
  const problems: string[] = []
  let total = 0
  let edges = 0
  const report = (line: string): void => {
    total += 1
    if (problems.length < MAX_PROBLEMS) problems.push(line)
  }
  for (const { from, relation } of scope) {
    const spec = schema[from].relations[relation]
    if (spec === undefined) throw new Error(`[relation-check] ${from}.${relation} is not declared`)
    const { to, inverse } = spec
    const fromIds = rows[from]
    const toIds = rows[to]
    if (fromIds !== undefined) {
      for (const x of fromIds) {
        const y = reader.one(from, x, relation)
        if (y === null) continue
        edges += 1
        if (toIds !== undefined && !toIds.has(y)) continue // a kept reference id (§4.3)
        if (![...reader.many(to, y, inverse)].includes(x)) {
          report(
            `one-way: ${from}:${x}.${relation} = ${to}:${y}, but ${to}:${y}.${inverse} does not hold ${x}`,
          )
        }
      }
    }
    if (toIds !== undefined) {
      for (const y of toIds) {
        for (const x of reader.many(to, y, inverse)) {
          edges += 1
          if (fromIds !== undefined && !fromIds.has(x)) {
            report(`ghost: ${to}:${y}.${inverse} holds ${from}:${x}, which the feed no longer has`)
            continue
          }
          const back = reader.one(from, x, relation)
          if (back !== y) {
            report(
              `one-way: ${to}:${y}.${inverse} holds ${x}, but ${from}:${x}.${relation} = ${back ?? 'null'}`,
            )
          }
        }
      }
    }
  }
  return { problems, total, edges }
}
