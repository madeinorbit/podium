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

import type { FeedServerFrame, FeedSinkPort } from '@podium/terminal-client'
import type { Replica as KernelReplica } from '@podium/sync/replica'
import type { PushedBootstrapSource } from './bootstrap-source'
import { toBootstrapChunk, toDeltaFrame, toRescopeFrame, toResyncFrame } from './frames'

export interface FeedSinkDeps {
  readonly replica: KernelReplica
  readonly bootstraps: PushedBootstrapSource
  /** Observability seam. Every frame passes through it, including the ignored
   *  ones — an ignored frame nobody can count is indistinguishable from one that
   *  never arrived. */
  onFrame?: (kind: FeedServerFrame['type'], seq: number | null) => void
}

export class FeedSink implements FeedSinkPort {
  constructor(private readonly deps: FeedSinkDeps) {}

  /**
   * The socket is up.
   *
   * `connect()` and not "bootstrap": the Replica decides which. From `cold` it
   * takes D7-2-COLD and pulls a world; from `stale` — the reload and the
   * reconnect case — it takes D7-1-RESUME and heals from the persisted cursor.
   * A consumer that chose between them would be re-deciding the first rung of the
   * ladder from outside the state machine that owns it.
   */
  connected(): void {
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
    this.deps.bootstraps.reset('socket closed')
    this.deps.replica.disconnect()
  }

  frame(frame: FeedServerFrame): void {
    switch (frame.type) {
      case 'feedBootstrap':
        this.deps.onFrame?.(frame.type, frame.seq)
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
