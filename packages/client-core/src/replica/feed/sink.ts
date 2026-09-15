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
import { toDeltaFrame, toRescopeFrame, toResyncFrame } from './frames'

const log = createLogger('client:feed-sink')

export interface FeedSinkDeps {
  readonly replica: KernelReplica
  /** Observability seam. Every frame passes through it, including the ignored
   *  ones — an ignored frame nobody can count is indistinguishable from one that
   *  never arrived. */
  onFrame?: (kind: FeedServerFrame['type'], seq: number | null) => void
}

export class FeedSink implements FeedSinkPort {
  constructor(private readonly deps: FeedSinkDeps) {}

  readonly syncHttp = true

  requestRebootstrap(): void {
    this.deps.replica.requestRebootstrap()
  }

  /**
   * Where this replica stands, as `hello` carries it (POD-2061).
   *
   * `null` for a replica with no cursor — a cold client has nothing to resume
   * from and pulls its snapshot over HTTP. The Replica's cursor is the ONE position on this side (ADR 2 D10 commits
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
  connected(_worldPromised?: boolean): void {
    if (this.deps.replica.posture !== 'bootstrapping') this.deps.replica.connect()
  }

  disconnected(): void {
    this.deps.replica.transportDisconnected()
  }

  frame(frame: FeedServerFrame): void {
    switch (frame.type) {
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
