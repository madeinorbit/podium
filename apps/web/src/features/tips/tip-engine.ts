import { lazy } from '@podium/mobx-helpers'
import { action, observableRef, reaction } from 'mobx'
import {
  TIP_IDS,
  type TipCard,
  type TipId,
  type TipLog,
  type TipMoment,
  type TipOutcome,
} from './types'

export const TIP_QUIET_MS = 3_000
export const TIP_GAP_MS = 20_000
interface Registration {
  id: TipId
  read(): TipMoment
  wasActive: boolean
}
interface Pending {
  registration: Registration
  replay: boolean
}
export interface ShowingTip extends Pending {
  index: number
  card: TipCard
}

/** UI state for the single shell host. Deadlines use one timer, never a polling clock. */
export class TipEngine {
  @observableRef accessor registrations: readonly Registration[] = []
  @observableRef accessor current: ShowingTip | null = null
  private pending: Pending[] = []
  private lastInput = -Infinity
  private lastClosed = -Infinity
  private timer: ReturnType<typeof setTimeout> | undefined
  private connected = false
  constructor(
    readonly log: TipLog,
    private readonly anchorExists: (name: string) => boolean,
    private readonly now = Date.now,
    private readonly gap = TIP_GAP_MS,
  ) {}
  @lazy get progress(): number {
    return TIP_IDS.filter((id) => this.log.isSeen(id)).length
  }
  @lazy get badgeVisible(): boolean {
    return (
      this.log.ready &&
      this.log.enabled &&
      this.registrations.length > 0 &&
      this.progress < TIP_IDS.length
    )
  }
  connect(): () => void {
    this.connected = true
    const stop = reaction(
      () => [this.log.ready, this.log.enabled, ...TIP_IDS.map((id) => this.log.isSeen(id))],
      () => this.reconcile(),
      { fireImmediately: true },
    )
    return () => {
      stop()
      this.connected = false
      clearTimeout(this.timer)
      this.hideWithoutOutcome()
    }
  }
  @action register(id: TipId, read: () => TipMoment): () => void {
    const registration: Registration = { id, read, wasActive: false }
    this.registrations = [...this.registrations, registration]
    this.refresh()
    return () => this.unregister(registration)
  }
  @action private unregister(registration: Registration): void {
    this.registrations = this.registrations.filter((r) => r !== registration)
    this.pending = this.pending.filter((p) => p.registration !== registration)
    if (this.current?.registration === registration) this.close('dismissed')
  }
  /** Called after a registration's render. Inline card arrays need no memoization. */
  @action refresh(): void {
    for (const registration of this.registrations) {
      // Before hydration isSeen may conservatively return true. Preserve the edge.
      if (!this.log.ready) {
        registration.wasActive = false
        continue
      }
      const active = registration.read().active
      if (active && !registration.wasActive && !this.log.isSeen(registration.id)) {
        this.enqueue(registration, false)
      }
      registration.wasActive = active
    }
    this.pending = this.pending.filter((p) => p.replay || p.registration.read().active)
    if (this.current && !this.current.replay && !this.current.registration.read().active)
      this.close('dismissed')
    this.schedule()
  }
  @action replay(id: TipId): void {
    // Several mounted copies can register one moment (a hidden chat offer beside
    // the visible native one). Replay the copy whose first anchor is on screen.
    const candidates = this.registrations.filter((r) => r.id === id)
    const registration =
      candidates.find((r) => {
        const card = r.read().cards[0]
        return !!card && this.anchorExists(card.anchor)
      }) ?? candidates[0]
    if (!registration || !this.log.ready || !this.log.enabled) return
    this.enqueue(registration, true)
    this.schedule()
  }
  private enqueue(registration: Registration, replay: boolean): void {
    if (
      this.current?.registration.id === registration.id ||
      this.pending.some((p) => p.registration.id === registration.id)
    )
      return
    this.pending.push({ registration, replay })
  }
  @action input(): void {
    this.lastInput = this.now()
    this.schedule()
  }
  @action wake(): void {
    this.schedule()
  }
  @action private reconcile(): void {
    if (!this.log.ready || !this.log.enabled) this.hideWithoutOutcome()
    if (this.log.ready) {
      this.pending = this.pending.filter((p) => p.replay || !this.log.isSeen(p.registration.id))
      this.refresh()
    } else this.schedule()
  }
  private schedule(): void {
    clearTimeout(this.timer)
    if (
      !this.connected ||
      this.current ||
      !this.log.ready ||
      !this.log.enabled ||
      !this.pending.length
    )
      return
    const wait = Math.max(
      0,
      this.lastInput + TIP_QUIET_MS - this.now(),
      this.lastClosed + this.gap - this.now(),
    )
    this.timer = setTimeout(() => this.drain(), wait)
  }
  @action private drain(): void {
    if (!this.log.ready || !this.log.enabled || this.current) return
    while (this.pending.length) {
      const pending = this.pending.shift()
      if (!pending) break
      const { registration, replay } = pending
      const moment = registration.read()
      if ((!replay && (!moment.active || this.log.isSeen(registration.id))) || !moment.cards.length)
        continue
      const card = moment.cards[0]
      if (!card || !this.anchorExists(card.anchor)) continue
      this.current = { ...pending, index: 0, card }
      this.log.record(registration.id, 'shown')
      card.onShow?.()
      return
    }
  }
  @action next(): void {
    const current = this.current
    if (!current) return
    const cards = current.registration.read().cards.slice(0, 2)
    const card = cards[current.index + 1]
    if (!card) {
      this.close('finished')
      return
    }
    if (!this.anchorExists(card.anchor)) {
      this.close('dismissed')
      return
    }
    current.card.onHide?.()
    this.current = { ...current, index: current.index + 1, card }
    card.onShow?.()
  }
  @action close(outcome: Exclude<TipOutcome, 'shown'>): void {
    const current = this.current
    if (!current) return
    this.hideWithoutOutcome()
    this.log.record(current.registration.id, outcome)
    if (outcome === 'skipped-all') this.pending = []
    this.schedule()
  }
  @action private hideWithoutOutcome(): void {
    const current = this.current
    if (!current) return
    this.current = null
    this.lastClosed = this.now()
    current.card.onHide?.()
  }
}
