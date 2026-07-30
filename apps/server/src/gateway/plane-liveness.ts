/**
 * PER-PLANE LIVENESS POLICY — the heartbeat, the dead-socket sweep and the
 * outbound backpressure cap, stated per PLANE rather than inlined at two socket
 * call sites (POD-389; POD-391 owns the policy SHAPE, so this is deliberately the
 * smallest object that carries today's behaviour unchanged).
 *
 * BEHAVIOUR IS PRESERVED EXACTLY. The intervals, the two-sweep reaping rule and
 * the 16 MB buffer cap are the shipped values, moved not retuned — a daemon whose
 * message loop is wedged (a huge inbound frame, a sync block) leaves its TCP
 * socket OPEN, so `close` never fires and the detach never runs; every
 * daemon-routed tRPC then hangs to timeout and the UI shows the empty
 * new-install screen with no self-heal. Terminating it within two intervals is
 * what fires `close` → `detachDaemon` → re-queue → sessions freed.
 */

/** Minimal slice of a `ws` socket the heartbeat sweep needs (kept tiny for tests). */
export interface HeartbeatSocket {
  readyState: number
  ping(): void
  terminate(): void
}

export interface PlaneLivenessPolicy {
  /** Which peer plane this governs — used in diagnostics and by POD-391. */
  readonly peer: 'client' | 'daemon'
  /** Sweep cadence; a socket that misses two consecutive sweeps is terminated. */
  readonly heartbeatIntervalMs: number
  /** Outbound buffered bytes above which the socket is terminated, not grown. */
  readonly sendBufferLimitBytes: number
}

/**
 * The browser answers protocol pings at the network layer (no app code), so this
 * catches a client whose socket died without a close frame — laptop sleep, a
 * dropped proxy hop, a phone out of range — well before the OS TCP timeout.
 * Reaping it promptly stops us broadcasting into a dead socket and frees the
 * controller role for the reconnecting tab.
 */
export const CLIENT_PLANE_LIVENESS: PlaneLivenessPolicy = {
  peer: 'client',
  heartbeatIntervalMs: 15_000,
  // A runaway agent (`yes`, a huge paste echo) emits frames faster than a slow or
  // backgrounded client drains; without a cap `ws` queues the unsent bytes in
  // THIS process's memory without limit — GBs in seconds — and OOMs the shared
  // server, killing every session. 16 MB is far above a healthy transient
  // backlog; a client this far behind is effectively dead, and it reconnects and
  // full-replays off the bounded 256 KB ring.
  sendBufferLimitBytes: 16 * 1024 * 1024,
}

/** The same sweep applied to the single `/daemon` socket, at a tighter cadence. */
export const DAEMON_PLANE_LIVENESS: PlaneLivenessPolicy = {
  peer: 'daemon',
  heartbeatIntervalMs: 10_000,
  sendBufferLimitBytes: CLIENT_PLANE_LIVENESS.sendBufferLimitBytes,
}

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
