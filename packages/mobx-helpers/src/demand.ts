import { createAtom, type IAtom, onBecomeUnobserved } from 'mobx'

// Public admission avoids constructing a keyed atom for imperative probes.
// Demand itself belongs to each key's observation hooks, never this atom.
const admission = createAtom('demand.trackedRead')

export interface DemandAtomOptions<Key> {
  onObserved?: (key: Key) => void
  onUnobserved?: (key: Key) => void
  borrowAtom?: (key: Key) => IAtom | undefined
}

/** Keyed atoms retained only while observed. Hooks own acquisition/release;
 * imperative reads neither acquire demand nor disturb another reader. */
export function createDemandAtoms<Key>(
  name: (key: Key) => string,
  options: DemandAtomOptions<Key> = {},
) {
  const atoms = new Map<Key, IAtom>()
  const borrowedStops = new Map<Key, () => void>()
  const release = (key: Key, atom: IAtom) => {
    if (atoms.get(key) !== atom) return
    atoms.delete(key)
    borrowedStops.get(key)?.()
    borrowedStops.delete(key)
    options.onUnobserved?.(key)
  }
  return {
    get size() { return atoms.size },
    has: (key: Key) => atoms.has(key),
    get: (key: Key) => atoms.get(key),
    keys: () => atoms.keys(),
    values: () => atoms.values(),
    [Symbol.iterator]: () => atoms[Symbol.iterator](),
    observe(key: Key): boolean {
      if (!admission.reportObserved()) return false
      const known = atoms.get(key)
      if (known) return known.reportObserved()
      const borrowed = options.borrowAtom?.(key)
      if (borrowed) {
        if (!borrowed.reportObserved()) return false
        atoms.set(key, borrowed)
        borrowedStops.set(key, onBecomeUnobserved(borrowed, () => release(key, borrowed)))
        options.onObserved?.(key)
        return true
      }
      const atom = createAtom(name(key), () => {
        atoms.set(key, atom)
        options.onObserved?.(key)
      }, () => release(key, atom))
      return atom.reportObserved()
    },
    /** Owner teardown detaches borrowed hooks; old atoms cannot release a
     * replacement entry if their former observers later leave. */
    clear(): void {
      for (const stop of borrowedStops.values()) stop()
      borrowedStops.clear()
      atoms.clear()
    },
  }
}
