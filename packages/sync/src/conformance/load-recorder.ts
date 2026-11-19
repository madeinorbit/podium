/**
 * POD-7163 — THE LOAD RECORDER: what a device asks the server for while a test
 * opens its screens, on a simulated clock (design POD-7157, "Testing rules").
 *
 * - Requests: every first download and collection fetch, and every attempt
 *   made while the test has the device offline (refused before the server).
 * - Hops (Solid's ASYNC_WATERFALL): a load is one hop after another when it
 *   was asked for once that load's answer had been taken in, so the flush that
 *   installed it could have caused it. Loads asked for together share a hop.
 *   This counts a load the earlier answer did not cause as a hop too, never
 *   the other way round: the check can be too strict, never blind. The deck
 *   bug (POD-7155) was an unbounded chain of these.
 * - LOADING spans (Solid's LONG_HOLD): from a screen's opening to its readers'
 *   first answer, on the simulated clock. A relapse (LOADING again after an
 *   answer) is counted: a screen that loses its data shows one.
 *
 * Simulated time moves only by what the test declares: the fake fetch time of
 * each answer, the loader's batch window, and a frame for each install burst
 * the device runs (an install is a main-thread task followed by a render, so
 * an answer installed in many bursts keeps its screen LOADING for many frames:
 * the install freeze of POD-7165). It is a test check, not production code.
 */
import { expect } from 'vitest'
import { instanceKey } from '../replica/cache-state'
import { LOADER_WINDOW_MS } from '../replica/loader'
import type { BootstrapChunk, InstanceRequest } from '../replica/types'

/** One frame of the screen. */
export const FRAME_MS = 16
/** The fake fetch time: from a request to its answer, network and server. */
export const FETCH_MS = 80
/** POD-7159: what reading one instance from the device's disk takes (IndexedDB: a few ms). */
export const DISK_MS = 5

/**
 * The longest LOADING an opening from the server may show: per hop, the
 * loader's batch window, the fake fetch time and one frame to install, plus
 * the frame the screen opened in.
 */
export function serverLoadingBudget(hops: number, fetchMs = FETCH_MS): number {
  return hops * (LOADER_WINDOW_MS + fetchMs + FRAME_MS) + FRAME_MS
}

/** The longest LOADING an opening from the device's disk may show (design: under 100 ms). */
export const DISK_LOADING_BUDGET_MS = 100

interface Timer {
  readonly due: number
  readonly order: number
  readonly run: () => void
}

/** A clock that moves only when the test runs what is due on it. */
export class SimClock {
  private at = 0
  private order = 0
  private readonly timers: Timer[] = []

  now(): number {
    return this.at
  }

  /** Run `run` once the clock reaches `ms` from now; returns its cancel (a `LoaderSchedule`). */
  readonly schedule = (run: () => void, ms: number): (() => void) => {
    const timer: Timer = { due: this.at + Math.max(0, ms), order: this.order++, run }
    this.timers.push(timer)
    return () => {
      const at = this.timers.indexOf(timer)
      if (at >= 0) this.timers.splice(at, 1)
    }
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.schedule(resolve, ms)
    })
  }

  /** Work that takes simulated time where it runs (an install burst: a frame). */
  spend(ms: number): void {
    this.at += ms
  }

  get pending(): number {
    return this.timers.length
  }

  /** Move to the earliest timer and run every timer due then; false when none is set. */
  next(): boolean {
    if (this.timers.length === 0) return false
    this.timers.sort((a, b) => a.due - b.due || a.order - b.order)
    const due = this.timers[0]!.due
    this.at = Math.max(this.at, due)
    while (this.timers.length > 0 && this.timers[0]!.due <= this.at) this.timers.shift()!.run()
    return true
  }
}

export interface RecordedLoad {
  /** The route: the first download, a collection fetch, or a server query (search). */
  readonly route: 'bootstrap' | 'collections' | 'query'
  readonly hop: number
  readonly collections: readonly string[]
  readonly instances: readonly InstanceRequest[]
  readonly askedAt: number
  answeredAt: number | undefined
  /** Asked for while the test had the device offline: refused, never served. */
  readonly offline: boolean
  readonly window: number
}

/** A point the recorder counts from (`mark`). */
export interface LoadWindow {
  readonly id: number
  readonly from: number
  readonly at: number
}

interface Span {
  readonly openedAt: number
  loading: boolean
  /** The first answer, if it came. */
  answeredAt: number | undefined
  /** LOADING again after an answer. */
  relapses: number
}

/** One row of the recorder's report: a screen's opening. */
export interface ScreenReport {
  readonly screen: string
  readonly requests: number
  readonly hops: number
  /** Simulated ms from opening to the first answer; Infinity while it never came. */
  readonly loadingMs: number
  readonly relapses: number
}

/** The two load routes the Replica reads (`AuthorityReadPort`). */
interface LoadRoutes {
  bootstrap(signal?: AbortSignal, view?: readonly InstanceRequest[]): AsyncIterable<BootstrapChunk>
  collections?(
    instances: readonly InstanceRequest[],
    signal?: AbortSignal,
  ): AsyncIterable<BootstrapChunk>
}

/** What a fetch made while offline fails with, as the browser's does. */
export class OfflineError extends TypeError {
  constructor() {
    super('Failed to fetch (the test has the device offline)')
  }
}

export class LoadRecorder {
  readonly clock: SimClock
  readonly loads: RecordedLoad[] = []
  /** The fake fetch time of every answer from here on. */
  fetchMs: number
  /** Refuse every load before it reaches the server, counting the attempt. */
  offline = false
  /** Answer chunks served so far (the device's progress, for a fixture that waits for quiet). */
  chunks = 0
  private windowId = 0
  private answeredHop = 0
  private readonly spans = new Map<string, Span>()
  private readonly opened = new Map<string, LoadWindow>()

  constructor(options: { readonly clock?: SimClock; readonly fetchMs?: number } = {}) {
    this.clock = options.clock ?? new SimClock()
    this.fetchMs = options.fetchMs ?? FETCH_MS
  }

  /** Route the server's load routes through the recorder, in place; returns the server. */
  attach<T extends LoadRoutes>(server: T): T {
    const bootstrap = server.bootstrap.bind(server)
    server.bootstrap = (signal, view) =>
      this.answer('bootstrap', view ?? [], () => bootstrap(signal, view))
    const collections = server.collections?.bind(server)
    if (collections !== undefined)
      server.collections = (instances, signal) =>
        this.answer('collections', instances, () => collections(instances, signal))
    return server
  }

  /** Route a server query (a search page) through the recorder. */
  query<A extends unknown[], R>(ask: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return async (...args: A) => {
      const load = this.record('query', [])
      if (this.offline) throw new OfflineError()
      await this.clock.sleep(this.fetchMs)
      try {
        return await ask(...args)
      } finally {
        this.answered(load)
      }
    }
  }

  /** Start counting: what is asked for from here is in this window, from hop 1. */
  mark(): LoadWindow {
    this.windowId += 1
    this.answeredHop = 0
    return { id: this.windowId, from: this.loads.length, at: this.clock.now() }
  }

  loadsSince(window: LoadWindow): readonly RecordedLoad[] {
    return this.loads.slice(window.from)
  }

  /** Every load asked for since the window, offline attempts included. */
  requestsSince(window: LoadWindow): number {
    return this.loadsSince(window).length
  }

  /** The longest chain of loads since the window, each asked for once the one before it was in. */
  hopsSince(window: LoadWindow): number {
    return Math.max(0, ...this.loadsSince(window).map((load) => load.hop))
  }

  /**
   * Open a screen and fail when its loads chain further than `max` hops (the
   * declared maxima: deck 2, board 1, issue page 2, search 1).
   */
  async expectHops<T>(open: () => Promise<T>, max: number, what = 'the opening'): Promise<T> {
    const window = this.mark()
    const opened = await open()
    const hops = this.hopsSince(window)
    expect(
      hops,
      `${what} took ${hops} load hops, more than ${max}:\n${this.describe(window)}`,
    ).toBeLessThanOrEqual(max)
    return opened
  }

  /** The loads since a window, one line each with the instances it named, for a failure message. */
  describe(window: LoadWindow): string {
    const named = (instance: InstanceRequest) =>
      instance.args === undefined
        ? instance.collection
        : `${instance.collection}${JSON.stringify(instance.args)}`
    return this.loadsSince(window)
      .map((load) => {
        const shown = load.instances.slice(0, 6).map(named).join(', ')
        const more = load.instances.length > 6 ? ` and ${load.instances.length - 6} more` : ''
        return `  hop ${load.hop} at ${load.askedAt} ms: ${load.route}${load.offline ? ' (offline)' : ''} ${shown}${more}`
      })
      .join('\n')
  }

  /**
   * The instances asked for more than once since the window: data the device
   * had, lost and asked for again (the deck's tree under the trim, POD-7155).
   */
  refetchesSince(window: LoadWindow): readonly string[] {
    const seen = new Map<string, number>()
    for (const load of this.loadsSince(window))
      if (!load.offline)
        for (const instance of load.instances) {
          const key = instanceKey({ ...instance, part: instance.part ?? 'main' })
          seen.set(key, (seen.get(key) ?? 0) + 1)
        }
    return [...seen].filter(([, count]) => count > 1).map(([key]) => key)
  }

  /** A screen opens now: its LOADING span and its loads are counted from here. */
  open(screen: string): LoadWindow {
    const window = this.mark()
    this.opened.set(screen, window)
    this.spans.delete(screen)
    return window
  }

  /** What a screen's readers answer now: LOADING or not. Call it from a reaction. */
  loading(screen: string, isLoading: boolean): void {
    const now = this.clock.now()
    let span = this.spans.get(screen)
    if (span === undefined) {
      span = {
        openedAt: this.opened.get(screen)?.at ?? now,
        loading: isLoading,
        answeredAt: undefined,
        relapses: 0,
      }
      this.spans.set(screen, span)
    }
    if (!isLoading && span.answeredAt === undefined) span.answeredAt = now
    if (isLoading && !span.loading && span.answeredAt !== undefined) span.relapses += 1
    span.loading = isLoading
  }

  /** Simulated ms from a screen's opening to its first answer; Infinity while none came. */
  loadingMs(screen: string): number {
    const span = this.spans.get(screen)
    if (span === undefined) return Number.POSITIVE_INFINITY
    return span.answeredAt === undefined
      ? Number.POSITIVE_INFINITY
      : span.answeredAt - span.openedAt
  }

  relapses(screen: string): number {
    return this.spans.get(screen)?.relapses ?? 0
  }

  /** Fail when a screen showed LOADING longer than `budgetMs` of simulated time. */
  expectLoadingWithin(screen: string, budgetMs: number): void {
    const ms = this.loadingMs(screen)
    const window = this.opened.get(screen)
    expect(
      ms,
      `${screen} showed LOADING for ${ms} ms, longer than its ${budgetMs} ms budget:\n${window === undefined ? '' : this.describe(window)}`,
    ).toBeLessThanOrEqual(budgetMs)
  }

  /** Per screen opened: requests, hops, LOADING time and relapses. */
  report(): readonly ScreenReport[] {
    return [...this.opened].map(([screen, window]) => ({
      screen,
      requests: this.requestsSince(window),
      hops: this.hopsSince(window),
      loadingMs: this.loadingMs(screen),
      relapses: this.relapses(screen),
    }))
  }

  private record(
    route: RecordedLoad['route'],
    instances: readonly InstanceRequest[],
  ): RecordedLoad {
    const load: RecordedLoad = {
      route,
      // A server query (search) is the screen's question, not a load of
      // records: a request, never a hop. The records its answer names are.
      hop: route === 'query' ? 0 : this.answeredHop + 1,
      collections: [...new Set(instances.map((instance) => instance.collection))],
      instances: [...instances],
      askedAt: this.clock.now(),
      answeredAt: undefined,
      offline: this.offline,
      window: this.windowId,
    }
    this.loads.push(load)
    return load
  }

  private answered(load: RecordedLoad): void {
    load.answeredAt = this.clock.now()
    if (load.route !== 'query' && load.window === this.windowId)
      this.answeredHop = Math.max(this.answeredHop, load.hop)
  }

  private answer(
    route: 'bootstrap' | 'collections',
    instances: readonly InstanceRequest[],
    ask: () => AsyncIterable<BootstrapChunk>,
  ): AsyncIterable<BootstrapChunk> {
    const load = this.record(route, instances)
    const recorder = this
    return (async function* (): AsyncGenerator<BootstrapChunk> {
      // Offline, the attempt is counted and fails before it reaches the server.
      if (load.offline) throw new OfflineError()
      if (recorder.fetchMs > 0) await recorder.clock.sleep(recorder.fetchMs)
      try {
        for await (const chunk of ask()) {
          recorder.chunks += 1
          yield chunk
        }
      } finally {
        recorder.answered(load)
      }
    })()
  }
}
