/**
 * THE PUSH/PULL SEAM (POD-376).
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM, STATED PLAINLY
 * ---------------------------------------------------------------------------
 *
 * The kernel Replica PULLS its world: every rung of ADR 2 D7's ladder that
 * terminates at re-bootstrap calls `AuthorityReadPort.bootstrap()` and walks the
 * chunks it yields. The server PUSHES: `FeedServing.attach` reads the world and
 * sends `feedBootstrap` in one synchronous pass, and there is no client message
 * that asks for one.
 *
 * Neither side is wrong. The server's design is what makes a bootstrap contiguous
 * with the delta that follows — the world and the position it was read at are
 * taken in the same pass, so nothing can land between them. The Replica's design
 * is what makes "discard the cache and re-bootstrap" one function rather than six
 * call sites. This module is the seam between them, and it is a real seam rather
 * than an adapter: it has a waiting rule, a staleness rule and a failure mode,
 * and all three are decisions.
 *
 * ---------------------------------------------------------------------------
 * A SLOT, NOT A QUEUE — AND WHY THAT IS THE SAFE DIRECTION
 * ---------------------------------------------------------------------------
 *
 * Pushed bootstraps are not requests to be honoured in order; each one is "the
 * world, as of now", and a newer one strictly supersedes an older one. A QUEUE
 * would hand a walk that starts today a world read yesterday, install it, and set
 * a cursor from it — a cursor AHEAD of data that a later frame would then find
 * contiguous. That is the torn state ADR 6 D4.2 exists to forbid, arriving
 * through the client's own buffering.
 *
 * So: one slot, last-write-wins, and a walk consumes it only if it was offered
 * AFTER the walk began. A stale slot is dropped, not installed.
 *
 * ---------------------------------------------------------------------------
 * IF NOTHING IS IN THE SLOT, ASK — AND ASKING MEANS RECONNECTING
 * ---------------------------------------------------------------------------
 *
 * See `SocketHub.requestFreshWorld`. A fresh socket is admitted, served its world
 * at `throughSeq`, and framed from exactly there, which is the same one-pass
 * guarantee obtained the only way the protocol offers it. The alternative — wait
 * forever for a push that has no reason to come — is a replica wedged in
 * `bootstrapping` with a blank UI, which is the one posture ADR 2 D7 never
 * permits.
 *
 * The wait is BOUNDED. A timeout throws, the Replica's own bootstrap-attempt
 * ladder catches it (`maxBootstrapAttempts`, D6.5 restart-not-resume), and the
 * failure surfaces as `bootstrap-failed` with the prior slice still visible. An
 * unbounded await here would convert a dead server into a permanently
 * bootstrapping client, which looks like a hang and reports nothing.
 */

import type { BootstrapChunk } from '@podium/sync/replica'

/** How long one chunk may take to arrive before the walk is failed. Generous:
 *  it bounds a pathology (no server, no admission, refused wire version), not a
 *  slow bootstrap — a large world arrives as one frame on one socket. */
export const BOOTSTRAP_CHUNK_TIMEOUT_MS = 30_000

export interface BootstrapSourceDeps {
  /**
   * Make the server send a world. Bound to `SocketHub.requestFreshWorld`.
   *
   * Called ONLY when the slot is empty at the start of a walk. A walk that
   * already has a fresh world must not reconnect: reconnecting on every
   * re-bootstrap regardless would turn one dropped frame into a socket cycle.
   */
  requestFreshWorld(): void
  /** Injected so tests drive the timeout without waiting. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export class PushedBootstrapSource {
  /** The most recent world, and when it was offered. Superseded, never queued. */
  private slot: { chunk: BootstrapChunk; offeredAt: number } | undefined
  private waiter: ((chunk: BootstrapChunk) => void) | undefined
  private failWaiter: ((error: Error) => void) | undefined
  /**
   * A monotonic counter standing in for a clock.
   *
   * NOT `Date.now()`. The rule this serves is "offered after the walk began", and
   * two events inside one millisecond are ordinary here — a walk starting in the
   * same tick as a frame arriving is the common case on a fast reconnect, not an
   * edge. A wall clock would compare them equal and the `>` would drop a world
   * that was in fact fresh, wedging the walk until the timeout. A counter cannot.
   */
  private tick = 0

  constructor(private readonly deps: BootstrapSourceDeps) {}

  /** A `feedBootstrap` arrived. Supersedes whatever was in the slot. */
  offer(chunk: BootstrapChunk): void {
    this.tick += 1
    const waiter = this.waiter
    if (waiter !== undefined) {
      // Handed straight to the walk that is waiting — never parked in the slot
      // first. Parking it would leave a consumed world behind for the NEXT walk
      // to find and treat as fresh.
      this.waiter = undefined
      this.failWaiter = undefined
      waiter(chunk)
      return
    }
    this.slot = { chunk, offeredAt: this.tick }
  }

  /**
   * The Replica's `AuthorityReadPort.bootstrap()`.
   *
   * Yields chunks until `last`. Each chunk after the first is awaited without a
   * re-request: a multi-chunk world is one server-side stream, and asking again
   * mid-walk would start a second one.
   */
  async *bootstrap(): AsyncGenerator<BootstrapChunk> {
    const startedAt = (this.tick += 1)
    let first = true
    for (;;) {
      const chunk = await this.take(first ? startedAt : undefined)
      first = false
      yield chunk
      if (chunk.last) return
    }
  }

  /** The socket dropped: any pending walk is failed rather than left hanging, and
   *  the slot is cleared because a world from a dead connection has no position
   *  the next connection will resume from. */
  reset(reason: string): void {
    this.slot = undefined
    const fail = this.failWaiter
    this.waiter = undefined
    this.failWaiter = undefined
    fail?.(new Error(`bootstrap abandoned: ${reason}`))
  }

  private take(freshAfter: number | undefined): Promise<BootstrapChunk> {
    if (freshAfter !== undefined) {
      const held = this.slot
      this.slot = undefined
      if (held !== undefined && held.offeredAt > freshAfter) return Promise.resolve(held.chunk)
      // Either nothing was pushed, or what was pushed predates this walk and has
      // just been dropped. Both mean: ask, then wait.
      this.deps.requestFreshWorld()
    }
    return new Promise<BootstrapChunk>((resolve, reject) => {
      const setTimer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
      const clearTimer = this.deps.clearTimer ?? ((h) => clearTimeout(h as never))
      const timer = setTimer(() => {
        if (this.waiter !== settle) return
        this.waiter = undefined
        this.failWaiter = undefined
        reject(
          new Error(
            `no feedBootstrap within ${BOOTSTRAP_CHUNK_TIMEOUT_MS}ms. The replica keeps its last ` +
              `slice (D7 stale-visible) and the bootstrap ladder retries; it does not wedge.`,
          ),
        )
      }, BOOTSTRAP_CHUNK_TIMEOUT_MS)
      const settle = (chunk: BootstrapChunk): void => {
        clearTimer(timer)
        resolve(chunk)
      }
      this.waiter = settle
      this.failWaiter = (error) => {
        clearTimer(timer)
        reject(error)
      }
    })
  }
}
