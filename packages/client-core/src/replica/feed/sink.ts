/**
 * THE CLIENT'S FEED CONSUMER (POD-376) — the transport's frames, into the kernel
 * Replica, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * No gap detection, no cursor arithmetic, no heal, no retry, no visibility check.
 * Every one of those lives in `Replica`, and a consumer that did any of them
 * would be a second place the D7 ladder lives — which is how the two ends of a
 * ladder come to disagree about which rung they are on. What is here is a
 * translation and a lifecycle, and both are total.
 *
 * The one judgement call it makes is what to do with a frame it cannot translate,
 * and that is stated at {@link FeedSink.frame}.
 */

import { createLogger } from '@podium/logger'
import type { Replica as KernelReplica } from '@podium/sync/replica'
import type { FeedHelloFields, FeedServerFrame, FeedSinkPort } from '../../socket-transport'
import type { PushedBootstrapSource } from './bootstrap-source'
import { toBootstrapChunk, toDeltaFrame, toRescopeFrame, toResyncFrame } from './frames'

const log = createLogger('client:feed-sink')

export interface FeedSinkDeps {
  readonly replica: KernelReplica
  readonly bootstraps: PushedBootstrapSource
  /** Observability seam. Every frame passes through it, including the ignored
   *  ones — an ignored frame nobody can count is indistinguishable from one that
   *  never arrived. */
  onFrame?: (kind: FeedServerFrame['type'], seq: number | null) => void
}

export class FeedSink implements FeedSinkPort {
  /**
   * This connection presented a position and has not yet been answered
   * (POD-2061).
   *
   * The server answers a resuming `hello` in one of two ways — a `feedResume`
   * grant, or the ordinary world it sends when it will not resume us — and until
   * one of them arrives, whether a world is coming is genuinely unknown. That is
   * the whole reason this field exists: {@link connected} can no longer arm the
   * push/pull seam on the strength of a promise, so the arming moves to the
   * moment the world actually shows up. See {@link frame}.
   */
  private awaitingCursorVerdict = false

  constructor(private readonly deps: FeedSinkDeps) {}

  /**
   * Where this replica stands, as `hello` carries it (POD-2061).
   *
   * `null` for a replica with no cursor — a cold client has nothing to resume
   * from and must be served a world, which is exactly what an absent field asks
   * for. The Replica's cursor is the ONE position on this side (ADR 2 D10 commits
   * it with the rows it certifies), so this reads it rather than tracking a
   * second copy that could disagree with the store by one frame.
   */
  helloFields(): FeedHelloFields | null {
    const cursor = this.deps.replica.cursor
    if (cursor === null) return null
    return { feedCursor: { feedId: cursor.feedId, epoch: cursor.epoch, seq: cursor.seq } }
  }

  /**
   * The socket is up.
   *
   * `connect()` and not "bootstrap": the Replica decides which. From `cold` it
   * takes D7-2-COLD and pulls a world; from `stale` — the reload and the
   * reconnect case — it takes D7-1-RESUME and heals from the persisted cursor.
   * A consumer that chose between them would be re-deciding the first rung of the
   * ladder from outside the state machine that owns it.
   */
  connected(worldPromised: boolean): void {
    this.awaitingCursorVerdict = !worldPromised
    // A PROMISED WORLD IS ARMED HERE, AND ONLY A PROMISED ONE. Such a socket is
    // served one initial world unconditionally, so telling the push/pull seam
    // before the Replica starts its ladder lets a cold walk wait for the world
    // already in flight instead of replacing the socket to request another.
    //
    // A RESUMING socket has no such promise to pass on: it may be answered with
    // `feedResume` and nothing else. Arming here anyway would park an `expected`
    // flag no world ever clears, and the next walk — for an unrelated reason,
    // possibly minutes later — would consume it as though a world were on its
    // way and wait out the 30 s timeout instead of asking. So this side arms on
    // ARRIVAL instead (see {@link frame}), which is strictly narrower: it can
    // never claim a world that is not there.
    if (worldPromised) this.deps.bootstraps.expectWorld()
    // NOT WHILE A WALK IS WAITING. A re-bootstrap asks the transport for a fresh
    // world, and the transport delivers one by reconnecting — so this fires in the
    // middle of the very walk that requested it. `Replica.connect()` from
    // `bootstrapping` restarts the ladder, which abandons that walk and asks
    // again: the loop a live run produced as "the ladder is not resolving
    // downward". The walk is already waiting and the world is already on its way;
    // the correct action here is none.
    if (this.deps.bootstraps.isWalking()) return
    this.deps.replica.connect()
  }

  /**
   * The socket ended.
   *
   * The Replica goes `stale` — visible, never blank — and any bootstrap walk in
   * flight is failed rather than left waiting on a connection that is gone. The
   * order matters: the source is reset FIRST, so the walk's rejection is observed
   * by a replica that has not yet been told to abandon it, which is what routes
   * the failure through `bootstrap-failed` instead of a stray unhandled rejection.
   */
  disconnected(): void {
    // The verdict, if it was ever coming, is not coming on this socket.
    this.awaitingCursorVerdict = false
    const requestedByBootstrap = this.deps.bootstraps.reset('socket closed')
    // A bootstrap obtains a fresh world by deliberately replacing the socket.
    // That close belongs to the in-flight walk: disconnecting the Replica would
    // increment its generation and discard the world the replacement socket is
    // about to deliver. Real drops still transition to stale/cold as before.
    if (!requestedByBootstrap) this.deps.replica.disconnect()
  }

  frame(frame: FeedServerFrame): void {
    switch (frame.type) {
      case 'feedBootstrap':
        this.deps.onFrame?.(frame.type, frame.seq)
        // THE CURSOR WAS REFUSED, and this frame IS the refusal (POD-2061). The
        // server had two answers available and chose the world, so the world is
        // owed to this connection exactly as it is on a non-resuming one — and
        // saying so here, rather than at `connected`, is what lets a walk that
        // starts LATER (the heal comes back `bootstrap-required`, D7-2) consume a
        // world that arrived EARLIER. Without this the freshness rule would drop
        // it as predating the walk and `requestFreshWorld` would cycle the socket
        // to fetch the world already sitting in the slot.
        if (this.awaitingCursorVerdict) {
          this.awaitingCursorVerdict = false
          this.deps.bootstraps.expectWorld()
        }
        // OFFERED, NOT APPLIED. A bootstrap is installed by the walk that asked
        // for it, inside one transaction, with the frames buffered during the
        // walk applied on top. Handing it to `receive()` instead would install a
        // world outside that transaction and lose the buffered frames.
        this.deps.bootstraps.offer(toBootstrapChunk(frame))
        return
      case 'feedDelta':
        this.deps.onFrame?.(frame.type, frame.seq)
        this.deps.replica.receive(toDeltaFrame(frame))
        return
      case 'feedRescope':
        this.deps.onFrame?.(frame.type, frame.seq)
        this.deps.replica.receive(toRescopeFrame(frame))
        return
      case 'feedResyncRequired':
        this.deps.onFrame?.(frame.type, null)
        this.deps.replica.receive(toResyncFrame(frame))
        return
      case 'feedResume': {
        // THE CURSOR WAS HONOURED: no world follows, and the deltas resume after
        // `seq` (POD-2061).
        //
        // NOTHING IS FED TO THE REPLICA, and that is the design rather than an
        // omission. The rows in `(cursor, head]` are the Replica's own rung-1
        // heal, which `connected` has already started; a second input carrying
        // the same position would be a second place the ladder is advanced from,
        // and this file exists to have exactly one. What the frame changes here
        // is only what is no longer expected: no world is coming, so no world is
        // armed for.
        this.awaitingCursorVerdict = false
        this.deps.onFrame?.(frame.type, frame.seq)
        // A GRANT AGAINST A POSITION WE DO NOT HOLD is a server that resumed
        // someone else's cursor. It is reported and NOT acted on: the heal
        // already running asks the same question over HTTP and its reply carries
        // the same identity, so a real mismatch lands on D7-4-EPOCH inside the
        // state machine that owns that rung. Acting here would be the second
        // ladder; saying nothing would make a server bug invisible.
        const cursor = this.deps.replica.cursor
        if (cursor !== null && (cursor.feedId !== frame.feedId || cursor.epoch !== frame.epoch)) {
          log.warn('feed resume granted against another feed identity', {
            granted: { feedId: frame.feedId, epoch: frame.epoch, seq: frame.seq },
            held: { feedId: cursor.feedId, epoch: cursor.epoch, seq: cursor.seq },
          })
        }
        return
      }
      default: {
        // TOTAL, and the exhaustiveness is the point: `FeedServerFrame` is
        // narrowed off the parsed `ServerMessage` union, so a new member of the
        // feed family fails to compile HERE rather than being silently ignored
        // at run time. The v1 dispatch table this replaces made exactly that
        // mistake reachable and documented it as deliberate; here it is a type
        // error instead of a comment.
        const unreachable: never = frame
        throw new Error(`FeedSink: unhandled feed frame ${JSON.stringify(unreachable)}`)
      }
    }
  }
}
