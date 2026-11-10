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
 * - A body is kept by its digest, so an issue write that leaves a body alone
 *   keeps the copy held here; a header that moves asks again, and the copy
 *   held meanwhile is answered as not current, so a screen keeps its text and
 *   an edit form waits for the new one.
 * - A body is kept for the pool's life. It is what the reader opened, so the
 *   set grows with what a person looks at, not with the instance.
 *
 * The fetch is bound by the app (`bind`), so the data layer names no
 * transport. Before it is bound, requests wait.
 */
export const BODY_WINDOW_MS = 50
export const BODY_BATCH_IDS = 50

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
  /** `issue field digest` triples asked for and not yet answered. */
  private readonly asked = new Set<string>()
  /** Issues waiting for the next call. */
  private readonly queue = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private fetch: IssueBodyFetch | undefined

  /** Bind the app's fetch; returns the unbind. Waiting requests go out. */
  bind(fetch: IssueBodyFetch): () => void {
    this.fetch = fetch
    if (this.queue.size > 0) this.arm()
    return () => {
      if (this.fetch === fetch) this.fetch = undefined
    }
  }

  /** TRACKED: the body held for the field (current when it is at `digest`),
   *  or `LOADING`; anything but the current body queues a load. */
  read(issueId: string, field: IssueBodyField, digest: string): HeldIssueBody | typeof LOADING {
    const key = keyOf(issueId, field)
    const held = this.held.get(key)
    if (held !== undefined && held.digest === digest) {
      this.painted.delete(key)
      return { value: held.value, current: true }
    }
    const ask = `${key}\u0000${digest}`
    if (!this.asked.has(ask)) {
      this.asked.add(ask)
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

  private arm(): void {
    if (this.timer !== undefined || this.fetch === undefined) return
    // Out of the reading derivation: the load starts after it.
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, BODY_WINDOW_MS)
  }

  private async flush(): Promise<void> {
    const fetch = this.fetch
    if (fetch === undefined) return
    const ids = [...this.queue]
    this.queue.clear()
    for (let start = 0; start < ids.length; start += BODY_BATCH_IDS) {
      const batch = ids.slice(start, start + BODY_BATCH_IDS)
      let bodies: readonly IssueBodyWire[]
      try {
        bodies = await fetch(batch)
      } catch {
        // Asked again on the next read: a reopened issue, a redrawn screen.
        this.forget(batch)
        continue
      }
      // An answer at another digest (the body moved meanwhile) is held too.
      // The ask stays answered: the stale header does not ask again, and the
      // header that catches up names a new digest, which does.
      this.put(bodies)
    }
  }

  private forget(ids: readonly string[]): void {
    const prefixes = ids.map((id) => `${id}\u0000`)
    for (const ask of [...this.asked]) {
      if (prefixes.some((prefix) => ask.startsWith(prefix))) this.asked.delete(ask)
    }
  }
}
