/**
 * The Authority's entity vocabulary ↔ the engine's collection vocabulary.
 *
 * These are two different names for one thing and the difference is not
 * cosmetic: the wire (and therefore every `EntityRecord` the kernel Replica
 * holds) names entities in the SINGULAR — `session`, `issue` — because an
 * envelope is about one row. The engine's read model names COLLECTIONS, so it is
 * plural. A cutover that guessed the mapping by appending an `s` would have
 * silently dropped `automationRun` → `automationRuns` on a rule that does not
 * hold, so the mapping is written out and total.
 *
 * WHY UNKNOWN ENTITIES ARE NOT AN ERROR HERE. ADR 2 D4's lenient-parsing rule
 * says a replica that does not know a kind must still advance its cursor past
 * it rather than quarantining it into an invisible permanent gap. By the time a
 * record reaches this module the kernel has already made that decision; this
 * module only answers "does the engine render this kind?", and `undefined` means
 * "not mine" — never "corrupt".
 */

import { layoutRowId } from '@podium/model'
import type { ReplicaKind, ReplicaRows } from '../contract'

/** Kernel entity name → engine collection kind. */
const ENTITY_TO_KIND = {
  session: 'sessions',
  issue: 'issues',
  // The POD-796/POD-822 normalized kinds. Their entity spellings are NOT guessed
  // — they are `MetadataEntityKind`'s literals in protocol's `messages/sync.ts`
  // (`issueProjection`, `issueDep`, `repo`), which is the vocabulary the wire
  // actually uses. `entityForKind` is documented as TOTAL over `ReplicaKind`, so
  // widening the contract without widening this table would have quietly made it
  // partial: all three would have answered `undefined` through a signature that
  // says it cannot.
  issueProjection: 'issueProjections',
  issueDep: 'issueDeps',
  repo: 'repos',
  /** POD-1772's curated issue events. Same rule as the three kinds above: the
   *  entity spelling is `MetadataEntityKind`'s literal, not a guess. */
  issueEvent: 'issueEvents',
  conversation: 'conversations',
  automation: 'automations',
  automationRun: 'automationRuns',
  // POD-1350's per-user layout rows. The hub has demuxed this entity since that
  // issue and the authority has always included it in bootstrap; it was absent
  // HERE, so the rows reached the client and landed in no collection. That is
  // what made the shell's layout network-only and gave every reload a default
  // frame before the stored one (POD-571).
  userLayout: 'userLayouts',
} as const satisfies Record<string, ReplicaKind>

/** The entity names the engine's read model renders. */
export type KernelEntity = keyof typeof ENTITY_TO_KIND

const KIND_TO_ENTITY = Object.fromEntries(
  Object.entries(ENTITY_TO_KIND).map(([entity, kind]) => [kind, entity]),
) as Record<ReplicaKind, KernelEntity>

/** `undefined` for an entity this read model does not render (D4 leniency). */
export function kindForEntity(entity: string): ReplicaKind | undefined {
  return (ENTITY_TO_KIND as Record<string, ReplicaKind | undefined>)[entity]
}

/** Total the other way: every engine kind has exactly one entity name. */
export function entityForKind(kind: ReplicaKind): KernelEntity {
  return KIND_TO_ENTITY[kind]
}

/**
 * The row's own identity, as the engine's collections key it.
 *
 * `sessions` keys on `sessionId` and everything else on `id` — the same split
 * `replica.ts` makes. It is repeated rather than imported because the legacy
 * module's copy lives inside a TanStack collection factory this path must not
 * construct; a shared helper would have dragged the collection layer with it.
 */
export function rowKey<K extends ReplicaKind>(kind: K, row: ReplicaRows[K]): string {
  if (kind === 'sessions') return (row as ReplicaRows['sessions']).sessionId
  // A layout row's identity is the authority's (userId, key) composite — the id
  // its own change rows are logged under. `layoutRowId` is imported rather than
  // re-spelled: an id derived two ways is an id that can disagree, and a remove
  // op that misses leaves a reset key painted forever.
  if (kind === 'userLayouts') {
    const layout = row as ReplicaRows['userLayouts']
    return layoutRowId(layout.userId, layout.key)
  }
  return (row as ReplicaRows['issues']).id
}
