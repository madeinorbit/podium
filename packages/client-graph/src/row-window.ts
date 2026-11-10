import { lazy } from '@podium/mobx-helpers'
import { action, compareShallow, observable } from 'mobx'

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

  @action appear(id: string) {
    this.appeared.add(id)
    this.anchor = id
  }

  @action disappear(id: string) {
    this.appeared.delete(id)
    if (id === this.anchor && this.appeared.size) this.anchor = [...this.appeared].at(-1)!
  }

  @lazy get windowStart(): number {
    return Math.max(
      0,
      this.source().findIndex((row) => this.id(row) === this.anchor) - ROW_WINDOW_SIZE / 2,
    )
  }

  @lazy get windowEnd(): number {
    return this.appeared.size ? this.windowStart + ROW_WINDOW_SIZE : this.windowStart
  }

  @lazy({ equals: compareShallow }) get visibleRows(): readonly T[] {
    return this.source().slice(this.windowStart, this.windowEnd)
  }
}
