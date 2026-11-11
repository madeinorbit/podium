import { lazy } from '@podium/mobx-helpers'
import { action, compareShallow, createAtom, observable, reaction } from 'mobx'

export const ROW_WINDOW_SIZE = 40

/** Viewport state shared by native lists. It holds row identity, never record facts. */
export class RowWindow<T> {
  constructor(
    private readonly source: () => readonly T[],
    private readonly id: (row: T) => string,
  ) {}
  /** Native appearance events describe the viewport; rich row observers stay bounded. */
  private readonly appeared = observable.set<string>()
  @observable private accessor anchor = ''

  /** Index only row identities. Scrolling reuses it until the source changes. */
  @lazy private get positions(): ReadonlyMap<string, number> {
    return new Map(this.source().map((row, index) => [this.id(row), index]))
  }

  // Map.has tracks each key; a MobX set shares one membership atom.
  private readonly active = observable.map<string, true>()
  private stopSlots: (() => void) | undefined
  /** Own the membership publisher only while native slots observe it. The
   * lifetime atom never changes; only changed membership keys notify their slots. */
  private readonly slots = createAtom(
    'RowWindow.slots',
    () => {
      this.stopSlots = reaction(
        () => this.visibleRows,
        (rows) => {
          const next = new Set(rows.map(this.id))
          for (const id of this.active.keys()) if (!next.has(id)) this.active.delete(id)
          for (const id of next) this.active.set(id, true)
        },
        { fireImmediately: true },
      )
    },
    action(() => {
      this.stopSlots?.()
      this.stopSlots = undefined
      this.active.clear()
      this.appeared.clear()
      this.anchor = ''
    }),
  )

  /** Read in the slot, never in the list's row map. */
  has(id: string): boolean {
    if (this.slots.reportObserved()) return this.active.has(id)
    const index = this.positions.get(id) ?? -1
    return index >= this.windowStart && index < this.windowEnd
  }

  @action appear(id: string) {
    // Native callbacks can arrive after filtering or deleting their row.
    if (!this.positions.has(id)) return
    this.appeared.add(id)
    this.anchor = id
  }

  @action disappear(id: string) {
    this.appeared.delete(id)
    if (id === this.anchor && this.appeared.size) this.anchor = [...this.appeared].at(-1)!
  }

  @lazy get windowStart(): number {
    return Math.max(0, (this.positions.get(this.anchor) ?? -1) - ROW_WINDOW_SIZE / 2)
  }

  @lazy get windowEnd(): number {
    return this.appeared.size ? this.windowStart + ROW_WINDOW_SIZE : this.windowStart
  }

  @lazy({ equals: compareShallow }) get visibleRows(): readonly T[] {
    return this.source().slice(this.windowStart, this.windowEnd)
  }
}
