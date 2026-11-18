/**
 * POD-7168 — DERIVE A LARGE LIST'S ROWS OVER SEVERAL TASKS.
 *
 * Opening the operator's 970-issue deck derived every row's word, bucket and
 * roll-up for the first time in ONE reaction: a main-thread task of seconds.
 * The answers were right; only their first computation was too big for one
 * task. A warm-up derives the rows a slice at a time, each slice under a time
 * budget, and keeps what it derived observed, so the screen's own reading
 * afterwards finds every row cached. The screen counts as settled once the
 * warm-up has gone through the list once; later rows (a member that arrives
 * after) are derived in the background without unsettling it.
 *
 * It runs only while a reaction reads `done` (a drawn screen): the warm-up
 * starts when the first one does and stops with the last. A read with no
 * reaction (a test, a one-off answer) and a list below `minimum` answer at
 * once, as before: they derive in their own read.
 */

import { action, autorun, createAtom, observable } from 'mobx'
import { LOADING } from './loading'

/** Run `run` in the next task: a message, not a timer, so a browser does not clamp it. */
function nextTask(run: () => void): () => void {
  let cancelled = false
  const go = () => {
    if (!cancelled) run()
  }
  if (typeof MessageChannel === 'function') {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      go()
    }
    channel.port2.postMessage(undefined)
  } else setTimeout(go, 0)
  return () => {
    cancelled = true
  }
}

export interface SlicedWarmupOptions {
  /** Time one slice may take, in ms. */
  readonly budgetMs?: number
  /** Lists shorter than this are derived where they are read. */
  readonly minimum?: number
}

export class SlicedWarmup {
  /** How far the warm-up has gone through the list. */
  @observable private accessor through = 0
  /** It has gone through the list once. */
  @observable private accessor complete = false
  private stop: (() => void) | null = null
  private cancel: (() => void) | null = null
  private readonly budgetMs: number
  private readonly minimum: number
  private readonly demand = createAtom(
    'SlicedWarmup.demand',
    () => this.start(),
    () => this.halt(),
  )

  constructor(
    private readonly items: () => readonly string[] | typeof LOADING,
    private readonly warm: (id: string) => void,
    options: SlicedWarmupOptions = {},
  ) {
    this.budgetMs = options.budgetMs ?? 30
    this.minimum = options.minimum ?? 200
  }

  /**
   * TRACKED: whether the rows have been derived once. True at once for a read
   * no reaction tracks and for a short list: those derive in their own read.
   */
  get done(): boolean {
    if (!this.demand.reportObserved()) return true
    if (this.complete) return true
    const list = this.items()
    return list === LOADING || list.length < this.minimum
  }

  dispose(): void {
    this.halt()
  }

  private start(): void {
    if (this.stop !== null) return
    this.stop = autorun(() => {
      const list = this.items()
      if (list === LOADING) return
      if (list.length < this.minimum) return
      const began = performance.now()
      const through = Math.min(this.through, list.length)
      // What earlier slices derived: cached, and kept observed by this read.
      for (let at = 0; at < through; at += 1) this.read(list[at]!)
      let next = through
      while (
        next < list.length &&
        (next === through || performance.now() - began < this.budgetMs)
      ) {
        this.read(list[next]!)
        next += 1
      }
      this.settle(next, next >= list.length)
    })
  }

  private halt(): void {
    this.stop?.()
    this.stop = null
    this.cancel?.()
    this.cancel = null
  }

  private read(id: string): void {
    try {
      this.warm(id)
    } catch (error) {
      // A row still loading is read again when it changes.
      if (error !== LOADING) throw error
    }
  }

  /** Move on in the next task: the page draws and takes input in between. */
  private settle(through: number, finished: boolean): void {
    this.cancel?.()
    this.cancel = null
    if (through === this.through && (!finished || this.complete)) return
    this.cancel = nextTask(
      action(() => {
        this.cancel = null
        this.through = through
        if (finished) this.complete = true
      }),
    )
  }
}
