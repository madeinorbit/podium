/**
 * The Authority's entity vocabulary ↔ the engine's collection vocabulary,
 * GENERATED from the record declarations in `@podium/model`
 * (`records/declarations.ts`, POD-7084).
 *
 * These are two different names for one thing and the difference is not
 * cosmetic: the wire (and therefore every `EntityRecord` the kernel Replica
 * holds) names entities in the SINGULAR — `session`, `issueProjection` — because an
 * envelope is about one row. The engine's read model names COLLECTIONS, so it is
 * plural. Each declaration spells out its `replicaKind`: a mapping guessed by
 * appending an `s` would have silently dropped `automationRun` →
 * `automationRuns`. The table used to be written out here by hand;
 * `kinds.test.ts` holds the generated one to that last hand-written table.
 *
 * WHY UNKNOWN ENTITIES ARE NOT AN ERROR HERE. ADR 2 D4's lenient-parsing rule
 * says a replica that does not know a kind must still advance its cursor past
 * it rather than quarantining it into an invisible permanent gap. By the time a
 * record reaches this module the kernel has already made that decision; this
 * module only answers "does the engine render this kind?", and `undefined` means
 * "not mine" — never "corrupt".
 */

import {
  REPLICA_KIND_OF,
  type RecordKind,
  type RecordReplicaKind,
  recordOfReplicaKind,
} from '@podium/model'
import type { ReplicaKind, ReplicaRows } from '../contract'

/** Every declared record type has a collection in `ReplicaRows`, and only those do. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const replicaRowsMatchTheDeclarations: Same<ReplicaKind, RecordReplicaKind> = true
void replicaRowsMatchTheDeclarations

/** Kernel entity name → engine collection kind. */
const ENTITY_TO_KIND: Readonly<Record<RecordKind, ReplicaKind>> = REPLICA_KIND_OF

/** The entity names the engine's read model renders. */
export type KernelEntity = RecordKind

const KIND_TO_ENTITY = Object.fromEntries(
  Object.entries(ENTITY_TO_KIND).map(([entity, kind]) => [kind, entity]),
) as Record<ReplicaKind, KernelEntity>

/** Only current replica kinds survive hydration and feed admission. */
export function retainReplicaEntity(entity: string): boolean {
  return Object.hasOwn(ENTITY_TO_KIND, entity)
}

/** `undefined` for an entity this read model does not render (D4 leniency). */
export function kindForEntity(entity: string): ReplicaKind | undefined {
  return retainReplicaEntity(entity) ? ENTITY_TO_KIND[entity as KernelEntity] : undefined
}

/** Total the other way: every engine kind has exactly one entity name. */
export function entityForKind(kind: ReplicaKind): KernelEntity {
  return KIND_TO_ENTITY[kind]
}

/**
 * The row's own identity, as the engine's collections key it: the
 * declaration's row key. `sessions` key on `sessionId`, the per-user and
 * per-machine records on their composite feed ids (imported where each is
 * declared, never re-spelled: an id derived two ways is an id that can
 * disagree), and everything else on `id`.
 */
export function rowKey<K extends ReplicaKind>(kind: K, row: ReplicaRows[K]): string {
  return recordOfReplicaKind(kind)!.rowKey(row as never)
}
