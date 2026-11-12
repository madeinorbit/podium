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
  // Work and Search can present the same section at once during a tab transition.
  // One cell disappearing must not deactivate another cell for the same row.
  private readonly appeared = observable.map<unknown, string>()
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
    return (
      index >= 0 &&
      ((index >= this.windowStart && index < this.windowEnd) ||
        [...this.appeared.values()].includes(id))
    )
  }

  @action appear(id: string, owner: unknown = id) {
    // Native callbacks can arrive after filtering or deleting their row.
    if (!this.positions.has(id)) return
    this.appeared.set(owner, id)
    this.anchor = id
  }

  @action disappear(id: string, owner: unknown = id) {
    if (this.appeared.get(owner) !== id) return
    this.appeared.delete(owner)
    if (id === this.anchor && this.appeared.size) this.anchor = [...this.appeared.values()].at(-1)!
  }

  @lazy get windowStart(): number {
    return Math.max(0, (this.positions.get(this.anchor) ?? -1) - ROW_WINDOW_SIZE / 2)
  }

  /** Always a full window: the top rows before native cells report appearing (first
   * render, so text is there on tab open), and the last anchor after they all leave
   * (a hidden tab), so returning never shows placeholders. */
  @lazy get windowEnd(): number {
    return this.windowStart + ROW_WINDOW_SIZE
  }

  @lazy({ equals: compareShallow }) get visibleRows(): readonly T[] {
    const rows = this.source()
    const visible = rows.slice(this.windowStart, this.windowEnd)
    // Native prefetch and tab transitions need not report appearances in order.
    // The window bounds prefetch, never rows the native list still displays.
    for (const id of new Set(this.appeared.values())) {
      const index = this.positions.get(id)
      if (index !== undefined && (index < this.windowStart || index >= this.windowEnd))
        visible.push(rows[index]!)
    }
    return visible
  }
}
