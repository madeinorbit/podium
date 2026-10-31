import { action, observable } from 'mobx'
import { TIP_IDS, type TipId, type TipLog, type TipOutcome } from './types'

/** Temporary, host-scoped log. The account source replaces this in production. */
export class MemoryTipLog implements TipLog {
  @observable accessor ready = true
  @observable accessor enabled = true
  private readonly seen = observable.set<TipId>()
  isSeen(id: TipId): boolean {
    return this.seen.has(id)
  }
  @action record(id: TipId, outcome: TipOutcome): void {
    if (outcome === 'skipped-all') {
      for (const tip of TIP_IDS) this.seen.add(tip)
      this.enabled = false
    } else if (outcome !== 'shown') this.seen.add(id)
  }
  @action setEnabled(on: boolean): void {
    this.enabled = on
  }
}
