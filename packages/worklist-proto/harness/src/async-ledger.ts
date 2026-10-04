/**
 * POD-5466: the deferred work a count window owes, and whether it has run.
 *
 * The pool screen meter counts the work between an action and the end of its
 * window. App code defers work: `queueMicrotask` coalescing in the sources,
 * `setTimeout` load windows and retirement sweeps in the runtime. A window
 * that closes before that work runs leaves it to fire in a later window, or
 * between windows, so the same commit counted different numbers on each run,
 * more of them under load.
 *
 * The ledger wraps the global schedulers while a meter runs. Every callback
 * is tagged with the window it was scheduled in (callbacks scheduled by a
 * tracked callback inherit its tag). `settle(tag)` waits until no microtask
 * and no timer due within `maxDelayMs` that carries the tag is still pending.
 * A callback that runs inside a window it was not scheduled in is recorded as
 * FOREIGN: its work was charged to the wrong action, which is the defect the
 * meter must refuse.
 *
 * HELD timers. A timer longer than `holdBeyondMs` (the runtime's 60 s
 * awaiting-truth sweep, the header's 60 s quota poll) is minute-scale app
 * behaviour, not part of any click. Left on the wall clock it fired in
 * whichever window was open a minute later, and a slower run reached more
 * windows: measured on e6c2313ca2, the 4x long-press, navigate-by-ref and
 * heartbeat windows ran it and everything it cascaded into. The ledger never
 * starts such a timer while the meter runs; it records it, so the clicks are
 * measured as if they happened within one second of each other, every run.
 *
 * VIRTUAL WALL CLOCK. App logic also reads `Date.now()` directly: the
 * mark-read-on-view throttle (`reactions.ts`, 1.2 s) fired at once when more
 * than 1.2 s of wall time had passed since the last one and otherwise armed a
 * timer, so a slower run wrote more read receipts and every reader over them
 * recomputed once more (measured: `consumer:mobile-session` 56,302 rows once,
 * twice or three times per 4x window between two runs of one commit). While
 * the ledger is installed `Date` reads a clock that stands still inside a
 * window and moves only by `advance(ms)`, between windows.
 */

type Tag = string | null

interface Pending {
  readonly kind: 'microtask' | 'timeout' | 'interval'
  readonly tag: Tag
  readonly delayMs: number
  readonly site: string
}

export type { Tag as LedgerTag }

export interface ForeignRun {
  readonly window: string
  readonly scheduledIn: Tag
  readonly kind: Pending['kind']
  readonly delayMs: number
  readonly site: string
}

export interface AsyncLedger {
  /** Name the open window; `null` between windows. */
  open(tag: string): void
  /** Move the virtual wall clock forward (between windows only). */
  advance(ms: number): void
  close(): void
  /**
   * Wait until `tag` owes nothing short: no tracked microtask and no tracked
   * timeout with delay ≤ `maxDelayMs` scheduled under it is pending. `poll`
   * runs between turns (the pool's coalesced load flush). Throws after
   * `deadlineMs` of wall time, naming what is still pending.
   */
  settle(
    tag: Tag,
    options: { maxDelayMs: number; deadlineMs: number; poll?: () => void },
  ): Promise<void>
  /** Callbacks that ran inside a window other than the one they came from. */
  takeForeign(): ForeignRun[]
  /** What is pending now, by tag (diagnosis). */
  pending(): readonly Pending[]
  /** Timers held back (longer than `holdBeyondMs`), still uncleared. */
  held(): readonly Pending[]
  dispose(): void
}

/** The first stack frame outside this file and node internals: who scheduled it. */
function siteOf(stack: string | undefined): string {
  const lines = (stack ?? '').split('\n').slice(1)
  for (const line of lines) {
    if (line.includes('async-ledger')) continue
    if (line.includes('node:') || line.includes('node_modules/vitest')) continue
    const match = /\(?([^()\s]+:\d+:\d+)\)?\s*$/.exec(line.trim())
    if (match) return match[1]!.replace(/^.*\/(packages|apps)\//, '$1/')
  }
  return '(unknown)'
}

export function installAsyncLedger(options: {
  holdBeyondMs: number
  /** The virtual wall clock's start, fixed so absolute time is the same every run. */
  startAt: number
}): AsyncLedger {
  const g = globalThis as typeof globalThis & Record<string, unknown>
  const real = {
    setTimeout: g.setTimeout,
    clearTimeout: g.clearTimeout,
    setInterval: g.setInterval,
    clearInterval: g.clearInterval,
    queueMicrotask: g.queueMicrotask,
  }
  const pending = new Map<object, Pending>()
  const RealDate = Date
  let virtualNow = options.startAt
  class VirtualDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(virtualNow)
      else super(...(args as [string | number | Date]))
    }
    static override now(): number {
      return virtualNow
    }
  }
  g.Date = VirtualDate as DateConstructor
  const byHandle = new Map<unknown, object>()
  const foreign: ForeignRun[] = []
  /** Timers longer than `holdBeyondMs`, recorded and never started. */
  const held = new Map<object, Pending>()
  let window: Tag = null
  /** The tag of the callback running now, inherited by what it schedules. */
  let running: Tag | undefined

  const tagNow = (): Tag => (running !== undefined ? running : window)
  const run = (key: object, entry: Pending, fn: () => void): void => {
    if (entry.kind !== 'interval') pending.delete(key)
    if (window !== null && entry.tag !== window) {
      foreign.push({
        window,
        scheduledIn: entry.tag,
        kind: entry.kind,
        delayMs: entry.delayMs,
        site: entry.site,
      })
    }
    const outer = running
    running = entry.tag
    try {
      fn()
    } finally {
      running = outer
    }
  }

  g.queueMicrotask = (fn: () => void) => {
    const key = {}
    const entry: Pending = {
      kind: 'microtask',
      tag: tagNow(),
      delayMs: 0,
      site: siteOf(new Error().stack),
    }
    pending.set(key, entry)
    real.queueMicrotask.call(globalThis, () => run(key, entry, fn))
  }
  const timer =
    (kind: 'timeout' | 'interval') =>
    (fn: unknown, ms?: number, ...args: unknown[]): unknown => {
      if (typeof fn !== 'function') {
        const schedule = (kind === 'timeout' ? real.setTimeout : real.setInterval) as (
          ...a: unknown[]
        ) => unknown
        return schedule.call(globalThis, fn, ms, ...args)
      }
      const key = {}
      const entry: Pending = {
        kind,
        tag: tagNow(),
        delayMs: Math.max(0, Number(ms) || 0),
        site: siteOf(new Error().stack),
      }
      if (entry.delayMs > options.holdBeyondMs) {
        // Never started: a handle the app can clear, ref and unref like a real one.
        const handle: Record<string, unknown> = {}
        for (const method of ['ref', 'unref', 'refresh']) handle[method] = () => handle
        handle.hasRef = () => false
        held.set(handle, entry)
        return handle
      }
      pending.set(key, entry)
      const schedule = kind === 'timeout' ? real.setTimeout : real.setInterval
      const handle = schedule.call(
        globalThis,
        () => run(key, entry, () => (fn as (...a: unknown[]) => void)(...args)),
        ms,
      )
      byHandle.set(handle, key)
      return handle
    }
  const clear = (realClear: (h: never) => void) => (handle: unknown) => {
    if (held.delete(handle as object)) return
    const key = byHandle.get(handle)
    if (key !== undefined) {
      pending.delete(key)
      byHandle.delete(handle)
    }
    realClear.call(globalThis, handle as never)
  }
  g.setTimeout = timer('timeout') as typeof setTimeout
  g.setInterval = timer('interval') as typeof setInterval
  g.clearTimeout = clear(real.clearTimeout as never) as typeof clearTimeout
  g.clearInterval = clear(real.clearInterval as never) as typeof clearInterval

  const owed = (tag: Tag, maxDelayMs: number): Pending[] =>
    [...pending.values()].filter(
      (p) =>
        p.tag === tag &&
        (p.kind === 'microtask' || (p.kind === 'timeout' && p.delayMs <= maxDelayMs)),
    )

  return {
    open(tag) {
      if (window !== null) throw new Error(`[async ledger] ${tag} opened inside ${window}`)
      window = tag
    },
    advance(ms) {
      if (window !== null) throw new Error(`[async ledger] the clock moved inside ${window}`)
      virtualNow += ms
    },
    close() {
      window = null
    },
    async settle(tag, { maxDelayMs, deadlineMs, poll }) {
      const start = performance.now()
      // Turn the loop over until nothing short is owed: a microtask turn first,
      // then one real macrotask, so a timer that just became due can run.
      for (;;) {
        for (let turn = 0; turn < 8; turn++) {
          await Promise.resolve()
          poll?.()
        }
        if (owed(tag, maxDelayMs).length === 0) return
        if (performance.now() - start > deadlineMs) {
          const sites = owed(tag, maxDelayMs)
            .map((p) => `${p.kind}(${p.delayMs} ms) from ${p.site}`)
            .join('; ')
          throw new Error(`[async ledger] ${tag} did not settle in ${deadlineMs} ms: ${sites}`)
        }
        await new Promise<void>((resolve) => real.setTimeout.call(globalThis, resolve, 1))
        poll?.()
      }
    },
    takeForeign() {
      return foreign.splice(0, foreign.length)
    },
    pending() {
      return [...pending.values()]
    },
    held() {
      return [...held.values()]
    },
    dispose() {
      g.Date = RealDate
      g.setTimeout = real.setTimeout
      g.clearTimeout = real.clearTimeout
      g.setInterval = real.setInterval
      g.clearInterval = real.clearInterval
      g.queueMicrotask = real.queueMicrotask
    },
  }
}
