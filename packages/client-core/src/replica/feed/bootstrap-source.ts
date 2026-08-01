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
  /**
   * Set between asking for a world and receiving one. See {@link reset}: it is
   * what tells a self-inflicted socket close apart from a real drop.
   */
  private requesting = false

  constructor(private readonly deps: BootstrapSourceDeps) {}

  /** A `feedBootstrap` arrived. Supersedes whatever was in the slot. */
  offer(chunk: BootstrapChunk): void {
    this.tick += 1
    this.requesting = false
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

  /**
   * The socket dropped.
   *
   * TWO CASES, AND COLLAPSING THEM IS A HEAL LOOP — measured against a live
   * server, not reasoned about. A re-bootstrap ASKS for a reconnect
   * ({@link BootstrapSourceDeps.requestFreshWorld}), so the very next thing that
   * happens is the socket closing, which arrives here. Failing the waiter on that
   * close abandons the walk that requested it; the Replica retries down its
   * ladder, asks again, and the cycle repeats until `settled()` gives up with "the
   * ladder is not resolving downward". That is exactly what the live run produced.
   *
   * So a close that this source CAUSED is not an abandonment: the walk keeps
   * waiting, and the world arrives on the socket that replaces the one that just
   * went away. Any other close — a real network drop, a shutdown — still fails the
   * walk, because there is then nothing coming.
   */
  reset(reason: string): boolean {
    this.slot = undefined
    if (this.requesting) {
      this.requesting = false
      return true
    }
    const fail = this.failWaiter
    this.waiter = undefined
    this.failWaiter = undefined
    fail?.(new Error('bootstrap abandoned: ' + reason))
    return false
  }

  /** True while a walk is waiting for a world. Read by the sink, which must not
   *  re-enter the Replica's `connect()` and disturb a walk already in flight. */
  isWalking(): boolean {
    return this.waiter !== undefined
  }

  private take(freshAfter: number | undefined): Promise<BootstrapChunk> {
    let ask = false
    if (freshAfter !== undefined) {
      const held = this.slot
      this.slot = undefined
      if (held !== undefined && held.offeredAt > freshAfter) return Promise.resolve(held.chunk)
      // Either nothing was pushed, or what was pushed predates this walk and has
      // just been dropped. Both mean: ask — but NOT yet. See below.
      ask = true
    }
    const pending = new Promise<BootstrapChunk>((resolve, reject) => {
      const setTimer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
      const clearTimer = this.deps.clearTimer ?? ((h) => clearTimeout(h as never))
      const timer = setTimer(() => {
        if (this.waiter !== settle) return
        this.waiter = undefined
        this.failWaiter = undefined
        this.requesting = false
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
    /**
     * ASK ONLY ONCE THE WAITER IS REGISTERED, AND THIS ORDER IS LOAD-BEARING.
     *
     * `requestFreshWorld` is not required to be asynchronous. Over a real socket
     * it is (`forceClose` → reconnect → admission → push), but the seam is a plain
     * callback and a caller that pushes SYNCHRONOUSLY is entirely reasonable —
     * every test harness does. Asking before the promise existed meant `offer`
     * found no waiter, parked the world in the slot, and the walk then waited for
     * a push that had already happened: a deadlock reachable only from the fast
     * path, which is the shape that survives a review and hangs a suite.
     *
     * Registering first makes both timings identical: a synchronous push lands on
     * the waiter, an asynchronous one lands on the waiter, and the slot is only
     * ever used for a world nobody was waiting for.
     */
    if (ask) {
      this.requesting = true
      this.deps.requestFreshWorld()
    }
    return pending
  }
}
