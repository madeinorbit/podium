import { autorun, createAtom, reaction, runInAction, type IAtom } from 'mobx'

const MAX_DELAY = 2_147_483_647
const HOUR = 3_600_000
/** The app supplies its browser visibility or native AppState boundary. */
export interface ClockWakeSource {
  isActive(): boolean
  subscribe(wake: () => void): () => void
}

let wakeSource: ClockWakeSource | undefined
const wakeReaders = new Set<() => void>()
let detachWake: (() => void) | undefined

function awake(): boolean { return wakeSource?.isActive() ?? true }

/** Install the platform boundary; its subscription exists only while time is observed. */
export function setClockWakeSource(source: ClockWakeSource | undefined): void {
  if (wakeSource === source) return
  detachWake?.(); detachWake = undefined
  wakeSource = source
  if (wakeReaders.size) detachWake = wakeSource?.subscribe(refreshClocks)
  refreshClocks()
}

/** Recheck exact deadlines immediately after a suspended app resumes. */
export function refreshClocks(): void {
  runInAction(() => { for (const wake of [...wakeReaders]) wake() })
}

function watchWake(wake: () => void): () => void {
  wakeReaders.add(wake)
  if (!detachWake) detachWake = wakeSource?.subscribe(refreshClocks)
  return () => {
    wakeReaders.delete(wake)
    if (!wakeReaders.size) { detachWake?.(); detachWake = undefined }
  }
}

class PrecisionClock {
  private value = Date.now()
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopWake: (() => void) | undefined
  observed = false
  readonly atom: IAtom
  constructor(readonly precision: number) {
    this.atom = createAtom(`clock.now.${precision}`, () => {
      this.observed = true
      this.value = Date.now()
      this.stopWake = watchWake(this.wake)
      this.schedule()
    }, () => {
      this.observed = false
      this.cancel()
      this.stopWake?.(); this.stopWake = undefined
      clocks.delete(this.precision)
    })
  }
  read(): number { return this.atom.reportObserved() ? this.value : Date.now() }
  private cancel(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined }
  private schedule(): void {
    this.cancel()
    if (!awake()) return
    this.timer = setTimeout(this.wake, this.precision)
  }
  private wake = (): void => {
    this.cancel()
    if (awake()) {
      const value = Date.now()
      if (value !== this.value) {
        this.value = value
        runInAction(() => this.atom.reportChanged())
      }
      if (this.stopWake) this.schedule()
    }
  }
}

const clocks = new Map<number, PrecisionClock>()
/** One timer per precision, created on first observation and dropped with the last. */
export function now(precision = 60_000): number {
  if (!Number.isFinite(precision) || precision <= 0) throw new RangeError('Clock precision must be positive and finite')
  let clock = clocks.get(precision)
  if (!clock) { clock = new PrecisionClock(precision); clocks.set(precision, clock) }
  const value = clock.read()
  // Imperative reads must not accumulate an unobserved precision registry.
  if (!clock.observed) clocks.delete(precision)
  return value
}

/** Age labels share seconds below one hour and minutes above it. */
export function nowForAge(since: number | string, baseMs = 0): number {
  const start = typeof since === 'string' ? Date.parse(since) : since
  return now(Date.now() - start + baseMs < HOUR ? 1_000 : 60_000)
}

/** A cached scalar external store for React; only subscription observes time. */
export function clockStore(read: () => number, enabled = true) {
  let value = read()
  return {
    getSnapshot: () => value,
    subscribe(changed: () => void): () => void {
      if (!enabled) return () => {}
      return autorun(() => {
        const next = read()
        if (next !== value) { value = next; changed() }
      })
    },
  }
}

/** Exact, observed deadlines. A numeric seed is an explicitly manual test clock. */
export class DeadlineClock {
  private readonly deadlines: number[] = []
  private readonly atoms = new Map<number, IAtom>()
  private readonly rewind = createAtom('clock.rewind')
  private timer: ReturnType<typeof setTimeout> | undefined
  private scheduledAt: number | undefined
  private stopWake: (() => void) | undefined
  private readonly manual: boolean
  private value: number
  crossings = 0

  constructor(seed?: number) { this.manual = seed !== undefined; this.value = seed ?? Date.now() }
  get current(): number { return this.peekNow() }
  peekNow(): number { return this.manual ? this.value : Date.now() }

  reached(t: number): boolean {
    if (this.peekNow() >= t) { this.rewind.reportObserved(); return true }
    if (!Number.isFinite(t)) return false
    let atom = this.atoms.get(t)
    if (!atom) {
      const created = createAtom(`clock.deadline.${t}`, () => {
        this.atoms.set(t, created)
        this.deadlines.splice(this.indexOf(t), 0, t)
        this.schedule()
      }, () => this.forget(t, created))
      atom = created
    }
    atom.reportObserved()
    return false
  }
  passed(t: number): boolean { return this.reached(nextUp(t)) }

  /** One registration for a maintained index's next due entry. */
  at(t: number, due: () => void): () => void {
    return reaction(() => this.reached(t), reached => { if (reached) due() }, { fireImmediately: true })
  }

  /** Advance a manual fixture, or recheck the wall clock on wake. */
  advance(value: number): void {
    runInAction(() => {
      const before = this.value
      this.value = value
      if (value < before) this.rewind.reportChanged()
      const end = this.indexOf(nextUp(value))
      const crossed = this.deadlines.splice(0, end)
      for (const t of crossed) {
        const atom = this.atoms.get(t)
        this.atoms.delete(t)
        this.crossings++
        atom?.reportChanged()
      }
      this.schedule()
    })
  }
  clear(): void {
    this.deadlines.length = 0; this.atoms.clear()
    this.cancel(); this.stopWake?.(); this.stopWake = undefined
  }
  private wake = (): void => {
    this.cancel()
    if (awake()) this.advance(Date.now())
  }
  private cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined; this.scheduledAt = undefined
  }
  private schedule(): void {
    if (this.manual) return
    const next = this.deadlines[0]
    if (next === undefined) { this.cancel(); this.stopWake?.(); this.stopWake = undefined; return }
    this.stopWake ??= watchWake(this.wake)
    if (!awake()) { this.cancel(); return }
    if (next === this.scheduledAt) return
    this.cancel(); this.scheduledAt = next
    // Epoch milliseconds are integral; passed(t) must wait through the next ms.
    this.timer = setTimeout(this.wake, Math.min(MAX_DELAY, Math.max(0, Math.ceil(next - Date.now()))))
  }
  private forget(t: number, atom: IAtom): void {
    if (this.atoms.get(t) !== atom) return
    this.atoms.delete(t)
    const at = this.indexOf(t)
    if (this.deadlines[at] === t) this.deadlines.splice(at, 1)
    this.schedule()
  }
  private indexOf(t: number): number {
    let lo = 0, hi = this.deadlines.length
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.deadlines[mid]! < t) lo = mid + 1; else hi = mid }
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

/** Shared wall-clock deadline scheduler; subscriptions own every registration. */
export const deadlineClock = new DeadlineClock()
