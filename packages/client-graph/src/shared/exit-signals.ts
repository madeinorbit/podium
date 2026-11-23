import { createAtom, type IAtom } from 'mobx'

/**
 * TRACKED exit evidence, addressed by pool row (POD-7422).
 *
 * The replica keeps how a row left the view in a plain map, and the pool reads
 * it before the row's table slot: a reader that gets REMOVED has observed
 * nothing about that row. When the row comes back with a payload equal to the
 * one the pool already holds (a cleared layout choice written again, painted
 * before the server confirmed it), no table slot moves, and the reader would
 * keep its stale answer. So a read that finds an exit observes that row's
 * signal here, and every publication that names the row moves it, whether or
 * not its payload changed.
 *
 * Only rows read while an exit stands hold a signal; it is dropped when its
 * last reader stops observing it. A present row costs nothing: a removal
 * reaches its readers through the table slot they already observe.
 */
export class ExitSignals {
  private readonly atoms = new Map<string, IAtom>()

  /** Observe the exit evidence of `key` (`kind:id`) from the current derivation. */
  observe(key: string): void {
    let atom = this.atoms.get(key)
    const created = atom === undefined
    if (atom === undefined) {
      const made = createAtom(`exit:${key}`, undefined, () => {
        if (this.atoms.get(key) === made) this.atoms.delete(key)
      })
      this.atoms.set(key, made)
      atom = made
    }
    // Read outside a derivation: nothing will ever unobserve it.
    if (!atom.reportObserved() && created) this.atoms.delete(key)
  }

  /** A publication named `key`: its exit may have moved. */
  moved(key: string): void {
    this.atoms.get(key)?.reportChanged()
  }

  /** A replacement: every exit may have moved. */
  movedAll(): void {
    for (const atom of [...this.atoms.values()]) atom.reportChanged()
  }

  /** Rows read while an exit stood, still observed (tests and meters). */
  get size(): number {
    return this.atoms.size
  }
}
