/**
 * PER-PLANE LIVENESS AND BACKPRESSURE POLICY (POD-391, completing POD-389/390).
 *
 * ADR 7 Amendment 1 D11 settles the shape this file takes, and it settles it two
 * ways that pull in opposite directions:
 *
 *   - Backpressure is **per plane**: "solvable with a per-plane budget on one
 *     socket" (D11, rejected alternatives). So the outbound cap is a property OF
 *     A PLANE, and the plane is what must own it.
 *   - Heartbeats are **not** per-feature and not re-timed: "the existing 15s
 *     client / 10s daemon sweeps … No presence-specific timer is introduced"
 *     (D11.6). So the cadences below are frozen by the ADR, not open for retune.
 *
 * WHAT POD-391 CHANGED, THEREFORE: nothing about the values, everything about
 * where they BIND. Before this, `heartbeatIntervalMs` and `sendBufferLimitBytes`
 * were fields a CALLER read and re-applied — `ws-server.ts` built two
 * `setInterval`s and passed each the matching constant, and the two sockets each
 * passed `POLICY.sendBufferLimitBytes` into `safeSend` by hand. Every one of
 * those call sites could name the *other* plane's constant and still compile,
 * type-check and pass. A policy that a caller has to apply correctly is not a
 * policy. Here the plane applies itself: `sink()` is the only way to obtain an
 * outbound sink for a socket on this plane, and `startHeartbeat()` is the only
 * way to schedule its sweep. Neither takes a limit or an interval as an argument.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TWO PLANES ARE DIFFERENT — the part that is not a parameter
 * ---------------------------------------------------------------------------
 * The sweep ALGORITHM is genuinely one algorithm (D11.6 forbids a second timer),
 * and the cap MECHANISM is genuinely one mechanism (terminate-on-exceed, the
 * "verified policy" D11 names). What differs is not the shape of either but the
 * BLAST RADIUS of each firing, and that is why the two constants below carry
 * separate rationales rather than one shared sentence:
 *
 *   DAEMON PLANE — 1:1, and the socket IS the machine. Terminating it detaches a
 *   whole machine: `close` → `detachDaemon` → every in-flight daemon-routed tRPC
 *   re-queues and every session on that host is orphaned until it reconnects.
 *   The cap and the sweep here are a LAST RESORT against a wedged host, and the
 *   tighter 10s cadence is bought precisely because the failure being detected
 *   (a daemon whose message loop is wedged leaves its TCP socket OPEN, so
 *   `close` never fires and nothing self-heals) is otherwise silent and total.
 *
 *   CLIENT PLANE — 1:many, and the socket is one recipient of a fan-out the
 *   subscription registry chose (POD-390: every byte to a client socket goes
 *   through `deliver` / `deliverPrepared` / `broadcast`). Terminating one client
 *   costs that client a reconnect and a replay off the bounded 256 KB ring, and
 *   costs the other recipients nothing. So the cap here exists to stop ONE slow
 *   recipient from consuming the shared process's memory on behalf of everybody —
 *   it protects the fan-out, not the victim — and the looser 15s cadence is
 *   affordable because the failure it detects (a browser that went away without a
 *   close frame) is neither silent nor total: the tab reconnects on its own.
 *
 * The asymmetry that matters operationally is therefore the INVERSE of what the
 * numbers suggest: the plane that is swept LESS often is the one where reaping is
 * cheap, and the plane swept more often is the one where reaping hurts most. That
 * is deliberate — on the daemon plane the alternative to reaping is a permanent
 * outage with no self-heal, which is why POD-389 introduced the sweep there at
 * all.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS STILL NOT
 * ---------------------------------------------------------------------------
 * D11 §5 requires a SECOND, LOWER budget for room/presence fan-out beneath the
 * socket budget, so that a colleague dragging a cursor cannot escalate into a
 * control-plane reconnect: "`safeSend`'s single-limit model is no longer the
 * whole backpressure story". That budget belongs to POD-1078 (presence rooms) and
 * is deliberately NOT built here — there is no room fan-out to charge against it
 * yet. What this file gives POD-1078 is the seam: a plane budget is now an object
 * with a method, so a sub-budget is a second sink obtained from the same policy
 * rather than a third literal at a fourth call site.
 */

import type { encode as encodeFn } from '@podium/protocol'
import { safeSend, safeSendEncoded, type SendSocket } from './ws-send'

/** Minimal slice of a `ws` socket the heartbeat sweep needs (kept tiny for tests). */
export interface HeartbeatSocket {
  readyState: number
  ping(): void
  terminate(): void
}

/**
 * The outbound paths a socket on a plane may write through, with that plane's
 * budget already applied. There is no un-capped variant and no overload taking a
 * limit: obtaining a sink is how a caller gets the cap.
 *
 * Both planes get both methods because the mechanism is shared, but only the
 * CLIENT plane uses `sendPrepared` — it is the publication worker's pre-encoded
 * bytes path (`client-socket.ts`), and it exists because re-encoding a
 * per-principal publication per recipient is the 1:many plane's cost, not the
 * 1:1 plane's. The daemon plane has one frame, one peer, one encode.
 */
export interface PlaneSink {
  /** Encode and send one frame, capped. */
  send(msg: Parameters<typeof encodeFn>[0]): void
  /** Send already-encoded bytes, capped. Client plane only, today. */
  sendPrepared(bytes: string): void
}

/**
 * The timer pair a sweep is scheduled on. Injectable so the cadence can be
 * asserted on a deterministic clock — a heartbeat test that waits real seconds
 * measures the host, not the policy, and this repo runs its lanes under load.
 */
export interface SweepTimers {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

/** A running sweep. `stop()` is idempotent from the caller's point of view. */
export interface PlaneHeartbeat {
  stop(): void
}

export interface PlaneLivenessPolicy {
  /** Which peer plane this governs. */
  readonly peer: 'client' | 'daemon'
  /** Sweep cadence; a socket that misses two consecutive sweeps is terminated. */
  readonly heartbeatIntervalMs: number
  /** Outbound buffered bytes above which the socket is terminated, not grown. */
  readonly sendBufferLimitBytes: number
  /**
   * The outbound sink for one socket on this plane. The ONLY way to write to a
   * peer socket with this plane's budget applied — callers no longer read the
   * limit off the policy and pass it along, so a call site cannot name the wrong
   * plane's number.
   */
  sink(ws: SendSocket): PlaneSink
  /**
   * Start this plane's dead-socket sweep over a LIVE socket set (`wss.clients`,
   * iterated afresh each tick) and its liveness marks. The interval is the
   * policy's own; there is no parameter for it.
   */
  startHeartbeat(
    sockets: Iterable<HeartbeatSocket>,
    alive: WeakSet<HeartbeatSocket>,
    timers?: SweepTimers,
  ): PlaneHeartbeat
}

const REAL_TIMERS: SweepTimers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms)
    // A sweep must never be the reason the process stays alive.
    handle.unref?.()
    return handle
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

/**
 * Build a plane policy that applies itself. Exported so a test can construct a
 * policy with values that are NOT the shipped ones — without that, a `sink()`
 * hard-coding 16 MB and a `startHeartbeat()` hard-coding 15_000 would be
 * indistinguishable from one reading the policy, since both shipped planes share
 * the same cap.
 */
export function definePlaneLiveness(spec: {
  peer: 'client' | 'daemon'
  heartbeatIntervalMs: number
  sendBufferLimitBytes: number
}): PlaneLivenessPolicy {
  const policy: PlaneLivenessPolicy = {
    peer: spec.peer,
    heartbeatIntervalMs: spec.heartbeatIntervalMs,
    sendBufferLimitBytes: spec.sendBufferLimitBytes,
    sink(ws) {
      // Read through `policy` rather than closing over `spec` so the budget that
      // binds is demonstrably THIS policy's, at send time.
      return {
        send: (msg) => safeSend(ws, msg, policy.sendBufferLimitBytes),
        sendPrepared: (bytes) => safeSendEncoded(ws, bytes, policy.sendBufferLimitBytes),
      }
    },
    startHeartbeat(sockets, alive, timers = REAL_TIMERS) {
      const handle = timers.setInterval(
        () => sweepPlaneLiveness(sockets, alive),
        policy.heartbeatIntervalMs,
      )
      return { stop: () => timers.clearInterval(handle) }
    },
  }
  return policy
}

/**
 * THE CLIENT PLANE — 1:many browser fan-out.
 *
 * 15s sweep: the browser answers protocol pings at the network layer (no app
 * code), so this catches a client whose socket died without a close frame —
 * laptop sleep, a dropped proxy hop, a phone out of range — well before the OS
 * TCP timeout. Reaping it promptly stops us broadcasting into a dead socket and
 * frees the controller role for the reconnecting tab. Frozen by ADR 7 Am. 1
 * D11.6, which names this exact cadence as the room-membership liveness rule.
 *
 * 16 MB cap: a runaway agent (`yes`, a huge paste echo) emits frames faster than
 * a slow or backgrounded client drains; without a cap `ws` queues the unsent
 * bytes in THIS process's memory without limit — GBs in seconds — and OOMs the
 * shared server, killing every session including the ones belonging to clients
 * that were keeping up. 16 MB is far above a healthy transient backlog, so what
 * starves when it binds is exactly one already-dead-in-practice recipient, and
 * it heals itself: it reconnects and full-replays off the bounded 256 KB ring.
 */
export const CLIENT_PLANE_LIVENESS: PlaneLivenessPolicy = definePlaneLiveness({
  peer: 'client',
  heartbeatIntervalMs: 15_000,
  sendBufferLimitBytes: 16 * 1024 * 1024,
})

/**
 * THE DAEMON PLANE — 1:1 host link.
 *
 * 10s sweep: a daemon whose message loop is wedged (a huge inbound frame, a sync
 * block) leaves its TCP socket OPEN, so `close` never fires and the detach never
 * runs; every daemon-routed tRPC then hangs to timeout and the UI shows the empty
 * new-install screen with no self-heal. Terminating it within two intervals is
 * what fires `close` → `detachDaemon` → re-queue → sessions freed. Tighter than
 * the client cadence because that failure is silent and total; frozen by ADR 7
 * Am. 1 D11.6.
 *
 * 16 MB cap: STATED INDEPENDENTLY, not derived from the client plane's. The value
 * is identical today and this is not a retune (POD-391 changed no shipped
 * number) — but writing it as `CLIENT_PLANE_LIVENESS.sendBufferLimitBytes` made
 * the two planes one decision, so a future client-side retune would silently
 * retune the daemon link, whose cap binding costs a machine detach rather than
 * one browser reconnect. D11's "per-plane budget" is a per-plane DECISION, and a
 * shared decision cannot be one. The rationale for 16 MB here is its own: the
 * server→daemon direction carries control frames and priorities, not terminal
 * output, so a daemon this far behind is not slow, it is wedged — the same
 * condition the sweep exists to reap, caught on the write path instead of the
 * timer.
 */
export const DAEMON_PLANE_LIVENESS: PlaneLivenessPolicy = definePlaneLiveness({
  peer: 'daemon',
  heartbeatIntervalMs: 10_000,
  sendBufferLimitBytes: 16 * 1024 * 1024,
})

/**
 * One heartbeat sweep: terminate any socket that hasn't ponged since the last
 * sweep (absent from `alive`), and ping the rest — clearing their liveness mark
 * so the next sweep terminates them unless a pong re-marks them first. A dead
 * socket is thus reaped within two intervals. Exported for deterministic unit
 * testing.
 */
export function sweepPlaneLiveness(
  sockets: Iterable<HeartbeatSocket>,
  alive: WeakSet<HeartbeatSocket>,
): void {
  for (const ws of sockets) {
    if (!alive.has(ws)) {
      ws.terminate()
      continue
    }
    alive.delete(ws)
    if (ws.readyState !== 1 /* OPEN */) continue
    try {
      ws.ping()
    } catch {
      // Socket went away between iterations — the next sweep terminates it.
    }
  }
}
