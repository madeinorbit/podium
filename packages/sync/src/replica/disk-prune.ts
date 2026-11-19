/**
 * DISK PRUNING (POD-7162, design POD-7157 "Layer 1: local storage", "Pruning").
 *
 * Local storage keeps every instance the device has fetched, bounded by a size
 * budget per client type (the policy's `diskBudgetMb`) and an age limit per
 * instance (`diskMaxIdleDays`: time since a view last read it). Pruning brings
 * it back within both: it removes WHOLE instances, least recently read first,
 * until the disk index's byte total is within the budget and no instance is
 * past its age. It never removes:
 *  - a policy collection, an instance in memory (held or warm), or one a view,
 *    a fetch or a disk load is using (the `pinned` set);
 *  - a record a kept instance holds, or what a kept record comes with (the
 *    rows it brings, holder `^` + its key, and the records it points to: an
 *    issue's parent, found from the stub table), transitively;
 *  - a record whose row is in memory;
 *  - a stub. An issue falls back to its stub; a record without one leaves.
 *
 * Removing an instance drops its marker; each of its members nothing kept
 * holds any more leaves the disk (or falls to its stub), and so, in turn, do
 * the rows it brought. Which records something kept holds is a walk UP the
 * index: a record is kept when one of its holders is a kept instance (a marker
 * on the device not dropped by this prune) or a kept record, or a kept record
 * points to it. Both are read from the index alone; nothing reads the disk.
 *
 * THE WORK IS SLICED. The Replica runs one slice per idle moment (or when the
 * page or app goes to the background), never during a fetch, a disk load, a
 * feed apply or a render, and commits each slice in ONE transaction: the rows
 * leaving, the stubs they fall to and the markers dropped, with their index
 * entries. A slice stops planning after `maxRows` rows or when `overTime()`
 * says so, between two members of an instance: a record and everything it
 * takes with it (what it brings, the parent it points to) always leave in
 * the same slice, so no record is left on the device held by nothing.
 *
 * An instance a slice could not finish keeps its marker, marked as being
 * pruned (`pruning`: its state is no longer `indexed`, so a disk load cannot
 * answer it and a read goes to the server), and holds the members it still
 * has. The next slice takes it up first, whatever the budget, and drops its
 * marker with its last member. A crash between slices leaves each committed
 * slice whole, and an instance being pruned is finished by the next one. A
 * read of it in between fetches it from the server, which marks it whole
 * again, and pruning leaves it (it is in memory then).
 *
 * An instance is removed only once the ones before it are done, so what is
 * removed is a prefix of the least-recently-read order.
 */

import { recordOf } from '@podium/model'
import {
  COMES_WITH_HOLDER,
  comesWithHolderKey,
  type DiskIndexReader,
  isComesWithHolder,
  pointerTargetOf,
  splitRowKey,
} from './disk-index'
import { comesWithOf } from './holdings'
import type { CacheMutation, CacheOperation, InstanceOperation } from './ports'

const MB = 1024 * 1024
export const DAY_MS = 86_400_000

/** At most this long of main-thread work per slice (the brief's bound), planning and commit. */
export const PRUNE_SLICE_MS = 50
/** Planning stops after this long, leaving the rest of the slice to the commit. */
export const PRUNE_PLAN_MS = 20
/** At most this many records leave (or fall to their stub) in one slice's transaction. */
export const PRUNE_SLICE_ROWS = 1_000

/** The disk's bounds: its byte total, and how long an instance may stay unread. */
export interface DiskBudget {
  readonly bytes: number
  readonly maxIdleMs: number
}

export const diskBudgetOf = (mb: number, days: number): DiskBudget => ({
  bytes: mb * MB,
  maxIdleMs: days * DAY_MS,
})

/**
 * What a record leaves on the device when pruned: the bytes of the stub it
 * falls back to, `'gone'` (its kind has no stub: it leaves), or `'keep'`
 * (its stub cannot be built: it stays whole).
 */
export type PruneFallback = number | 'gone' | 'keep'

export interface PruneInput {
  readonly index: DiskIndexReader
  /** Instances never removed: the policy's, in memory, held by a view, being fetched or loaded. */
  readonly pinned: ReadonlySet<string>
  /** Whether a record's whole row is in memory (kept). */
  resident(rowKey: string): boolean
  /** The records a record points to as far as the device knows without a disk read (its parent). */
  pointsTo(rowKey: string): Iterable<string>
  /** The records known to point to a record (its children; records in memory naming it). */
  pointedBy(rowKey: string): Iterable<string>
  /** What a record leaves when pruned. */
  fallback(rowKey: string): PruneFallback
  readonly now: number
  readonly budget: DiskBudget
  /** Stop after this many records (default: unbounded). */
  readonly maxRows?: number
  /** Stop when this says so (checked between records). */
  readonly overTime?: () => boolean
}

export interface PrunePlan {
  /** The instances whose markers this slice drops, least recently read first. */
  readonly drop: readonly string[]
  /** Records that fall back to their stub. */
  readonly stub: readonly string[]
  /** Records that leave the device. */
  readonly remove: readonly string[]
  /**
   * The instance this slice began or took up and could not finish: marked as
   * being pruned, and no longer holding the members it looked at that
   * something else keeps (so every slice moves it on).
   */
  readonly pruning?: { readonly key: string; readonly kept: readonly string[] }
  /** The disk's estimated byte total before and after this slice. */
  readonly bytesBefore: number
  readonly bytesAfter: number
  /** Nothing is left to do: within budget, nothing past its age, no instance half pruned. */
  readonly done: boolean
  /** Still over budget with nothing left that may go (everything left is pinned or kept). */
  readonly stuck: boolean
}

/** One instance pruning may remove. */
export interface PruneCandidate {
  readonly key: string
  /** When a view last read it. */
  readonly at: number
  /** A disk load cannot answer it (being pruned, or its members unknown): it goes whatever the budget. */
  readonly unanswerable: boolean
}

/**
 * The instances pruning may remove: those a disk load cannot answer first
 * (one being pruned is finished before anything else starts), then least
 * recently read first.
 */
export function pruneCandidates(
  index: DiskIndexReader,
  pinned: ReadonlySet<string>,
): readonly PruneCandidate[] {
  const out: PruneCandidate[] = []
  for (const key of index.instanceKeys()) {
    if (pinned.has(key) || index.inMemory(key)) continue
    const state = index.instance(key)
    out.push({ key, at: state?.lastReadAt ?? 0, unanswerable: state?.indexed !== true })
  }
  return out.sort(
    (a, b) =>
      Number(b.unanswerable) - Number(a.unanswerable) ||
      a.at - b.at ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )
}

/**
 * Plan one slice of a prune. Pure over its input: the Replica commits what it
 * returns in one transaction, and plans the next slice from the index as that
 * commit left it.
 */
export function planPrune(input: PruneInput): PrunePlan {
  const { index, budget, now } = input
  const maxRows = input.maxRows ?? Number.POSITIVE_INFINITY
  const overTime = input.overTime ?? (() => false)
  const dropped = new Set<string>()
  const pruned = new Map<string, 'stub' | 'remove'>()
  const bytesBefore = index.bytes
  let bytes = bytesBefore

  /** Records known not kept: stays true for the whole plan (pruning only removes support). */
  const notKept = new Set<string>()
  /** Records known kept: only until the next instance is dropped. */
  let keptNow = new Set<string>()
  const visiting = new Set<string>()
  let cut = false

  /** A kept instance: on the device, answerable from disk, not dropped by this prune. */
  const alive = (instance: string): boolean =>
    !dropped.has(instance) && index.instance(instance)?.indexed === true
  const fallbacks = new Map<string, PruneFallback>()
  const fallbackOf = (row: string): PruneFallback => {
    let fallback = fallbacks.get(row)
    if (fallback === undefined) {
      fallback = input.fallback(row)
      fallbacks.set(row, fallback)
    }
    return fallback
  }

  /** Whether something kept holds the record whole (walking up its holders and pointers). */
  const kept = (row: string): boolean => {
    if (keptNow.has(row)) return true
    if (notKept.has(row) || pruned.has(row)) return false
    if (visiting.has(row)) {
      cut = true
      return false
    }
    const entry = index.record(row)
    if (entry === undefined || entry.level !== 'main') {
      notKept.add(row)
      return false
    }
    // In memory, or with no stub to fall back to: it stays whole, and so does what it comes with.
    if (input.resident(row) || fallbackOf(row) === 'keep') {
      keptNow.add(row)
      return true
    }
    visiting.add(row)
    const outer = cut
    cut = false
    let yes = false
    for (const holder of entry.holders) {
      yes = isComesWithHolder(holder) ? kept(holder.slice(COMES_WITH_HOLDER.length)) : alive(holder)
      if (yes) break
    }
    if (!yes)
      for (const source of input.pointedBy(row)) {
        if (source === row) continue
        yes = kept(source)
        if (yes) break
      }
    visiting.delete(row)
    if (yes) keptNow.add(row)
    // A "no" reached through a record still being decided may change once it is.
    else if (!cut) notKept.add(row)
    cut = outer || cut
    return yes
  }

  let rows = 0
  /** Members taken up this slice: the time limit applies once there was some work. */
  let work = 0
  const spent = (): boolean => rows >= maxRows || (work > 0 && overTime())
  const queue: string[] = []
  /** Prune a record if nothing kept holds it, and with it everything it takes along. */
  const take = (first: string): void => {
    queue.push(first)
    while (queue.length > 0) {
      const row = queue.pop() as string
      if (pruned.has(row)) continue
      const entry = index.record(row)
      if (entry === undefined || entry.level !== 'main' || kept(row)) continue
      const fallback = fallbackOf(row)
      if (fallback === 'keep') continue
      pruned.set(row, fallback === 'gone' ? 'remove' : 'stub')
      bytes -= entry.bytes - (fallback === 'gone' ? 0 : fallback)
      rows += 1
      for (const member of index.membersOf(comesWithHolderKey(row))) queue.push(member)
      for (const target of input.pointsTo(row)) if (target !== row) queue.push(target)
    }
  }

  const drop: string[] = []
  let pruning: PrunePlan['pruning']
  let stopped = false
  const candidates = pruneCandidates(index, input.pinned)
  let at = 0
  for (; at < candidates.length; at += 1) {
    const candidate = candidates[at] as PruneCandidate
    const aged = now - candidate.at > budget.maxIdleMs
    if (!candidate.unanswerable && !aged && bytes <= budget.bytes) break
    if (spent()) {
      stopped = true
      break
    }
    dropped.add(candidate.key)
    // What was kept may have been kept by this instance alone.
    keptNow = new Set()
    let finished = true
    const keptMembers: string[] = []
    for (const member of [...index.membersOf(candidate.key)]) {
      if (spent()) {
        finished = false
        break
      }
      work += 1
      take(member)
      if (!pruned.has(member) && index.record(member)?.level === 'main') {
        keptMembers.push(member)
        rows += 1
      }
    }
    if (!finished) {
      // Its marker stays, as being pruned; the next slice finishes it first.
      pruning = { key: candidate.key, kept: keptMembers }
      stopped = true
      break
    }
    drop.push(candidate.key)
  }
  const next = candidates[at] as PruneCandidate | undefined
  const more =
    stopped ||
    (next !== undefined &&
      (next.unanswerable || bytes > budget.bytes || now - next.at > budget.maxIdleMs))
  const stub: string[] = []
  const remove: string[] = []
  for (const [row, how] of pruned) (how === 'stub' ? stub : remove).push(row)
  return {
    drop,
    ...(pruning === undefined ? {} : { pruning }),
    stub,
    remove,
    bytesBefore,
    bytesAfter: bytes,
    done: !more,
    stuck: !more && bytes > budget.bytes,
  }
}

/**
 * The one transaction a slice commits: the stubs its issues fall back to (the
 * stub table's value, at the record's feed number), the records that leave,
 * then the markers it drops and the one it marks as being pruned. `stubOf`
 * gives a record's stub value.
 */
export function pruneMutation(
  plan: Pick<PrunePlan, 'drop' | 'pruning' | 'stub' | 'remove'>,
  index: DiskIndexReader,
  stubOf: (entity: string, entityId: string) => unknown,
): CacheMutation {
  const operations: CacheOperation[] = []
  for (const key of plan.stub) {
    const { entity, entityId } = splitRowKey(key)
    const seq = index.record(key)?.seq ?? 0
    operations.push({
      kind: 'upsert',
      entity,
      entityId,
      value: stubOf(entity, entityId),
      provenance: { seq },
      part: 'stub',
      asOf: seq,
      force: true,
    })
  }
  for (const key of plan.remove) {
    const { entity, entityId } = splitRowKey(key)
    operations.push({ kind: 'remove', entity, entityId })
  }
  const instances: InstanceOperation[] = plan.drop.map((key) => ({ kind: 'drop', key }))
  if (plan.pruning !== undefined)
    instances.push({ kind: 'pruning', key: plan.pruning.key, kept: plan.pruning.kept })
  return { operations, ...(instances.length === 0 ? {} : { instances }) }
}

/** The records a record points to through a comes-with ("X's parent", "a session's issue"). */
export function pointerTargets(kind: string, value: unknown, now: number): string[] {
  const out: string[] = []
  for (const spec of comesWithOf(kind, value, [], now)) {
    const target = pointerTargetOf(spec)
    if (target !== undefined) out.push(target)
  }
  return out
}

/**
 * Whether a record kind comes with its parent by its parent link (an issue
 * comes with the issue it is under): then the stub table's children of a
 * record are the records that point to it.
 */
export function comesWithParent(kind: string): boolean {
  const declaration = recordOf(kind)
  const link = declaration?.parentLink
  if (declaration === undefined || link === undefined) return false
  return declaration.comesWith.some(
    (entry) => entry.key === link && entry.collection === `${kind}.one`,
  )
}
