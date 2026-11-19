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

import { autorun, createAtom, observable, runInAction, untracked } from 'mobx'
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
  /** It has gone through the list once. */
  @observable private accessor complete = false
  private watch: (() => void) | null = null
  private cancel: (() => void) | null = null
  /*
   * POD-7178 — EACH SLICE KEEPS ITS OWN ROWS OBSERVED. One reaction over
   * every row derived so far re-read the whole list on each slice and on
   * each later burst that moved any row: 970 rows times their fields, a cost
   * of the tree, not of the change. Each slice is its own reaction now, so a
   * row that moves re-reads only its slice, and a new slice reads only its
   * own rows.
   */
  private readonly slices = new Set<Slice>()
  private readonly sliceOf = new Map<string, Slice>()
  /** List rows no slice holds yet, in list order. */
  private pending: string[] = []
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
    if (this.watch !== null) return
    // Only the list is tracked here; the rows are each slice's own reads.
    this.watch = autorun(() => {
      const list = this.items()
      if (list === LOADING || list.length < this.minimum) return
      // untracked-read: warmup-list-plan
      untracked(() => this.plan(list))
    })
  }

  /** The list moved: rows that left it leave their slices, new rows queue. */
  private plan(list: readonly string[]): void {
    const listed = new Set(list)
    for (const slice of [...this.slices]) {
      if (slice.ids.every((id) => listed.has(id))) continue
      // A row left: its slice stops, and its other rows queue again.
      this.drop(slice)
    }
    this.pending = list.filter((id) => !this.sliceOf.has(id))
    if (this.pending.length > 0 && this.cancel === null) this.step()
    else this.next()
  }

  /** Derive one slice under the budget, as its own reaction, then move on in the next task. */
  private step(): void {
    this.cancel = null
    if (this.watch === null) return
    if (this.pending.length === 0) {
      this.next()
      return
    }
    const ids: string[] = []
    const slice: Slice = { ids, stop: () => {} }
    let first = true
    this.slices.add(slice)
    slice.stop = autorun(() => {
      if (!first) {
        // A row of this slice moved: re-read this slice's rows, no others.
        for (const id of ids) this.read(id)
        return
      }
      // The first run takes rows from the queue up to the budget.
      first = false
      const began = performance.now()
      while (
        this.pending.length > 0 &&
        (ids.length === 0 || performance.now() - began < this.budgetMs)
      ) {
        const id = this.pending.shift()!
        ids.push(id)
        this.sliceOf.set(id, slice)
        this.read(id)
      }
      // untracked-read: warmup-slice-next
      untracked(() => this.next())
    })
  }

  /** Move on in the next task: the page draws and takes input in between. */
  private next(): void {
    if (this.cancel !== null) return
    if (this.pending.length === 0 && this.complete) return
    this.cancel = nextTask(() => {
      this.cancel = null
      if (this.pending.length > 0) this.step()
      else if (!this.complete)
        runInAction(() => {
          this.complete = true
        })
    })
  }

  private drop(slice: Slice): void {
    slice.stop()
    this.slices.delete(slice)
    for (const id of slice.ids) if (this.sliceOf.get(id) === slice) this.sliceOf.delete(id)
  }

  private halt(): void {
    this.watch?.()
    this.watch = null
    this.cancel?.()
    this.cancel = null
    for (const slice of [...this.slices]) this.drop(slice)
    this.pending = []
  }

  private read(id: string): void {
    try {
      this.warm(id)
    } catch (error) {
      // A row still loading is read again when it changes.
      if (error !== LOADING) throw error
    }
  }
}

interface Slice {
  readonly ids: string[]
  stop: () => void
}
