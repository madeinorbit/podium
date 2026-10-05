/**
 * POD-4565 (Ma1) — the coarse clock as deadlines, so a tick wakes only the
 * derivations whose answer it changes.
 *
 * A time rule never asks "what time is it"; it asks "has `t` passed"
 * (`reached(t)`, true when `coarseNow >= t`): a defer lapsing
 * (`deferUntil <= now`), a finished row leaving its 24 h grace. A derivation
 * that reads the clock VALUE would re-run on every 60 s tick and re-read its
 * row; one that reads a deadline re-runs only when the tick crosses it
 * (methodology #8 changes no view; #8b crosses the grace rows only).
 *
 * TRACKING. `reached(t)` before `t`: observes the atom for `t` (created on
 * first use, dropped from the registry when nothing observes it). After `t`:
 * observes the one `rewind` atom, which fires only if the clock moves
 * BACKWARD (a new engine can hand an arm an earlier clock only through a new
 * arm, but the channel does not promise monotony, so a rewind is handled).
 * `advance(now)` fires the atoms of the deadlines it crosses, found by binary
 * search in the sorted registry: O(crossed + log registered), never a walk.
 *
 * `now` is a plain field read inside derivations. It is safe because every
 * answer it produces is paired with an atom that fires when that answer can
 * change (the crossing, or the rewind); `clock.test.ts` pins both directions.
 *
 * EVERY UNTRACKED READ A DERIVATION MAKES IN `pool/` (M3 N1), each paired
 * with a tracked read or an atom that fires when its answer can change, or
 * an identity memo whose answer for a key never changes:
 * 1. this clock's `now` (above);
 * 2. the residency registry (`residency.ts` `isCold`, reached through
 *    `loading`/`known`): plain maps, each id's answer paired with that id's
 *    atom, observed before the plain read and fired by `notify` on every
 *    registry change;
 * 3. the relation engine's plain twins (`relations.ts` `coldForward`,
 *    `coldBuckets`) and its residency probe: `one`/`bucket` observe the
 *    row's residency atom before reading a twin, and every twin write
 *    reports it changed (`ColdSlots.changed`);
 * 4. the pool's object memo (`pool.ts` `MobxPool.object`, the plain
 *    `models` maps), reached through `knownIssue`, `issueObject` and the
 *    inputs' `session`, `sessionActivity` and `parts`: an identity memo (an
 *    id answers one object while the row lives), and every value read off
 *    the object is its own tracked read; `knownIssue` answers an object only
 *    after a tracked presence probe (the issue table's `has`, else the
 *    residency atom);
 * 5. the cached groups' memo (`cached.ts` `cachedGroup`, the plain `live`
 *    map): an identity memo of each object's computed, whose `get` is the
 *    tracked read;
 * 6. the groups' node memo (`worklist/groups.ts` `WorklistGroups.nodes`,
 *    read by `keys`): an identity memo of each group's node, whose values are
 *    tracked.
 * 7. the sidebar's per-state/per-project computed memos (`worklist/sidebar.ts`
 *    `sectionViews`, `worklist/sidebar-roster.ts` `bands`): identity memos,
 *    whose `get` tracks the resident lanes and row reader. Roster ownership,
 *    locations, project membership and expiry registries are read only during
 *    maintenance, inside the existing publication or clock action; derivations
 *    read the observable candidate/path lanes and cold-lane summaries instead.
 * Nothing else: every table, bucket, forward, lane and overlay read is an
 * observable read. What a list filed each id under (`worklist/sorted-lanes.ts`
 * `SortedLanes.filed`) is read only by the filing itself, inside an action,
 * never by a derivation: a lane's reader reads the lane, and anything about
 * a member (a group's label, the head's rank) from the member, tracked.
 */

import { createAtom, type IAtom } from 'mobx'
import { debugName } from './debug-name'

export class DeadlineClock {
  /** Sorted, unique deadlines someone is waiting on. */
  private readonly deadlines: number[] = []
  private readonly atoms = new Map<number, IAtom>()
  private readonly rewind: IAtom = createAtom(debugName(() => 'pool.clock.rewind') ?? 'Atom')
  /** Deadlines crossed (fired) since construction. */
  crossings = 0

  constructor(private now: number) {}

  /** The current `coarseNow`, untracked (residency reads it inside ingest: `residency.ts` `now`). */
  get current(): number {
    return this.now
  }

  /** `coarseNow >= t`, tracked so that the answer's change wakes the reader. */
  reached(t: number): boolean {
    if (this.now >= t) {
      this.rewind.reportObserved()
      return true
    }
    let atom = this.atoms.get(t)
    if (atom === undefined) {
      const created = createAtom(debugName(() => `pool.clock@${t}`) ?? 'Atom', undefined, () => this.forget(t, created))
      atom = created
      this.atoms.set(t, created)
      this.deadlines.splice(this.indexOf(t), 0, t)
    }
    atom.reportObserved()
    return false
  }

  /** `coarseNow > t`: `reached` at the next representable instant after `t`. */
  passed(t: number): boolean {
    return this.reached(nextUp(t))
  }

  /** Move the clock. Call inside an action. */
  advance(now: number): void {
    const before = this.now
    this.now = now
    if (now < before) {
      this.rewind.reportChanged()
      return
    }
    const end = this.indexOf(nextUp(now)) // deadlines <= now
    if (end === 0) return
    const crossed = this.deadlines.splice(0, end)
    for (const t of crossed) {
      const atom = this.atoms.get(t)
      this.atoms.delete(t)
      this.crossings += 1
      atom?.reportChanged()
    }
  }

  /** Drop every registration (disposal). */
  clear(): void {
    this.deadlines.length = 0
    this.atoms.clear()
  }

  /** Nothing observes `atom` any more: stop waiting on `t`, unless a newer atom took it over. */
  private forget(t: number, atom: IAtom): void {
    if (this.atoms.get(t) !== atom) return
    this.atoms.delete(t)
    const at = this.indexOf(t)
    if (this.deadlines[at] === t) this.deadlines.splice(at, 1)
  }

  /** First index whose deadline is >= t. */
  private indexOf(t: number): number {
    let lo = 0
    let hi = this.deadlines.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if ((this.deadlines[mid] as number) < t) lo = mid + 1
      else hi = mid
    }
    return lo
  }
}

/** The smallest double greater than `x` (exact, so `now > x` is `now >= nextUp(x)`). */
export function nextUp(x: number): number {
  if (Number.isNaN(x) || x === Number.POSITIVE_INFINITY) return x
  if (x === 0) return Number.MIN_VALUE
  const bits = new Float64Array([x])
  const word = new BigInt64Array(bits.buffer)
  word[0] = (word[0] as bigint) + (x > 0 ? 1n : -1n)
  return bits[0] as number
}
