import { createDemandAtoms } from '@podium/mobx-helpers'
import type { IssueBodyField, IssueBodyWire } from '@podium/model/browser'
import { action, observable } from 'mobx'
import { LOADING } from './loading'

/**
 * AN ISSUE'S BODIES, FETCHED WHEN SHOWN (POD-6767, design POD-6253 §2).
 *
 * The synced issue record carries a header per body (`brief` and `description`): a digest and a size. The body itself is
 * read here. A reader asks for one field of one issue at the digest its
 * header names; the answer is the body held for that field with whether it is
 * the asked digest's, or `LOADING` while nothing is held yet.
 *
 * - Requests made within {@link BODY_WINDOW_MS} of each other go out as one
 *   `issues.bodies` call (at most {@link BODY_BATCH_IDS} issues each).
 * - One body is kept per field with its digest, so an issue write that leaves a body alone
 *   keeps the copy held here; a header that moves asks again, and the copy
 *   held meanwhile is answered as not current, so a screen keeps its text and
 *   an edit form waits for the new one.
 * - A body is kept for the pool's life. It is what the reader opened, so the
 *   set grows with what a person looks at, not with the instance.
 * - Failed ids retry with exponential backoff from 1 to 30 seconds while a
 *   reader observes them. One timer and serial batches serve pending reads;
 *   reconnect resumes them promptly. The last reader drops queued retries
 *   and their marks, so the next read can ask again.
 *
 * The fetch is bound by the app (`bind`), so the data layer names no
 * transport. Before it is bound, requests wait.
 */
export const BODY_WINDOW_MS = 50
export const BODY_BATCH_IDS = 50
const BODY_RETRY_MS = 1_000
const BODY_RETRY_MAX_MS = 30_000

/** The app's `issues.bodies` call. */
export type IssueBodyFetch = (ids: readonly string[]) => Promise<readonly IssueBodyWire[]>

/** A held body: its value and whether it is the one the header names. */
export interface HeldIssueBody {
  readonly value: unknown
  readonly current: boolean
}

/** What a model reads: the held body (a load starts unless it is current), or
 *  `LOADING` when nothing is held yet. */
export interface IssueBodyReader {
  read(issueId: string, field: IssueBodyField, digest: string): HeldIssueBody | typeof LOADING
  /** UNTRACKED: remember the text a row paints for a field. */
  remember(issueId: string, field: IssueBodyField, value: unknown): void
}

const keyOf = (issueId: string, field: IssueBodyField) => `${issueId}\u0000${field}`

interface BodyBinding {
  readonly fetch: IssueBodyFetch
  stopReconnect?: () => void
}

export class IssueBodyStore implements IssueBodyReader {
  /** The body held for each issue field, by the digest it was fetched at. */
  private readonly held = observable.map<
    string,
    { readonly digest: string; readonly value: unknown }
  >({}, { deep: false })
  /** The text a row last painted for an issue field (an edit the log had not
   *  settled), untracked: when the paint retires and the header moves, it is
   *  shown until the body at the new digest arrives, so a saved edit never
   *  flashes the text it replaced. Dropped once a current body is read. */
  private readonly painted = new Map<string, unknown>()
  /** Field/digest pairs asked for per issue, cleared when its fetch answers. */
  private readonly asked = new Map<string, Set<string>>()
  private readonly readers = createDemandAtoms<string>((id) => `issueBody:${id}`, {
    onUnobserved: (id) => {
      if (this.retryAt.has(id)) this.release(id)
    },
  })
  /** Issues waiting for the next call. */
  private readonly queue = new Set<string>()
  /** Failed issues stay queued, but reads cannot bring their retry forward. */
  private readonly retryAt = new Map<string, number>()
  private readonly retryDelay = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private timerAt = Infinity
  private binding: BodyBinding | undefined
  private flight: { readonly binding: BodyBinding; readonly ids: Set<string> } | undefined

  /** Bind the app's fetch and reconnect signal; returns the unbind. Pending
   *  requests resume without another read, including after a reconnect. */
  bind(fetch: IssueBodyFetch, onReconnect?: (retry: () => void) => () => void): () => void {
    if (this.binding !== undefined) this.unbind(this.binding)
    const binding: BodyBinding = { fetch }
    this.binding = binding
    const resume = () => {
      if (this.binding !== binding) return
      // Keep retry membership until it settles or loses its readers, even
      // when reconnect makes it immediately due.
      for (const id of this.retryAt.keys()) this.retryAt.set(id, 0)
      this.retryDelay.clear()
      this.arm()
    }
    binding.stopReconnect = onReconnect?.(resume)
    resume()
    return () => this.unbind(binding)
  }

  private unbind(binding: BodyBinding): void {
    if (this.binding !== binding) return
    this.binding = undefined
    binding.stopReconnect?.()
    this.clearTimer()
    if (this.flight?.binding === binding) {
      for (const id of this.flight.ids) this.queue.add(id)
      this.flight = undefined
    }
  }

  /** TRACKED: the body held for the field (current when it is at `digest`),
   *  or `LOADING`; anything but the current body queues a load. */
  read(issueId: string, field: IssueBodyField, digest: string): HeldIssueBody | typeof LOADING {
    this.readers.observe(issueId)
    const key = keyOf(issueId, field)
    const held = this.held.get(key)
    if (held !== undefined && held.digest === digest) {
      this.painted.delete(key)
      return { value: held.value, current: true }
    }
    const ask = `${field}\u0000${digest}`
    let asked = this.asked.get(issueId)
    if (!asked?.has(ask)) {
      if (asked === undefined) {
        asked = new Set()
        this.asked.set(issueId, asked)
      }
      asked.add(ask)
      this.queue.add(issueId)
      this.arm()
    }
    if (this.painted.has(key)) return { value: this.painted.get(key), current: false }
    return held === undefined ? LOADING : { value: held.value, current: false }
  }

  /** UNTRACKED: the text a row paints for a field now (see {@link painted}). */
  remember(issueId: string, field: IssueBodyField, value: unknown): void {
    this.painted.set(keyOf(issueId, field), value)
  }

  /** Put bodies the app already holds (a demo, a fixture). */
  @action put(bodies: readonly IssueBodyWire[]): void {
    for (const body of bodies) {
      this.held.set(keyOf(body.issueId, body.field), { digest: body.digest, value: body.value })
    }
  }

  private release(issueId: string): void {
    this.asked.delete(issueId)
    this.queue.delete(issueId)
    this.retryAt.delete(issueId)
    this.retryDelay.delete(issueId)
    if (this.queue.size === 0) this.clearTimer()
  }

  private arm(): void {
    if (this.binding === undefined || this.flight !== undefined || this.queue.size === 0) return
    const now = Date.now()
    if (this.timer !== undefined && this.timerAt <= now + BODY_WINDOW_MS) return
    let at = Infinity
    for (const id of this.queue) at = Math.min(at, this.retryAt.get(id) ?? now + BODY_WINDOW_MS)
    if (this.timer !== undefined && this.timerAt <= at) return
    this.clearTimer()
    this.timerAt = at
    // Out of the reading derivation: the load starts after it.
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        this.timerAt = Infinity
        void this.flush()
      },
      Math.max(0, at - now),
    )
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.timerAt = Infinity
  }

  private async flush(): Promise<void> {
    const binding = this.binding
    if (binding === undefined || this.flight !== undefined) return
    const now = Date.now()
    const ids = [...this.queue].filter((id) => (this.retryAt.get(id) ?? 0) <= now)
    for (const id of ids) this.queue.delete(id)
    const flight = { binding, ids: new Set(ids) }
    this.flight = flight
    try {
      for (let start = 0; start < ids.length; start += BODY_BATCH_IDS) {
        if (this.binding !== binding) return
        const batch = ids.slice(start, start + BODY_BATCH_IDS)
        let bodies: readonly IssueBodyWire[]
        try {
          bodies = await binding.fetch(batch)
        } catch {
          if (this.binding !== binding) return
          for (const id of batch) {
            flight.ids.delete(id)
            if (!this.readers.has(id)) {
              this.release(id)
              continue
            }
            const delay = this.retryDelay.get(id) ?? BODY_RETRY_MS
            this.retryDelay.set(id, Math.min(delay * 2, BODY_RETRY_MAX_MS))
            this.retryAt.set(id, Date.now() + delay)
            this.queue.add(id)
          }
          continue
        }
        if (this.binding !== binding) return
        // Publish before clearing marks: an answer ahead of its header must
        // not immediately ask again from the reading derivation.
        this.put(bodies)
        for (const id of batch) {
          // Only one body per field is held, so a later return to an earlier
          // digest must be free to fetch that text again.
          this.asked.delete(id)
          this.retryAt.delete(id)
          this.retryDelay.delete(id)
          flight.ids.delete(id)
        }
      }
    } finally {
      if (this.flight === flight) {
        this.flight = undefined
        this.arm()
      }
    }
  }
}
