import { DEPLOYMENT, perf } from '../../perf/registry'

/**
 * THE ISSUE-REPUBLISH PORTS ARE GONE (POD-1574), and their absence is the point.
 *
 * This coordinator used to carry `issueGeneration()`, `listSessions()` and a
 * full-issue-list republish port, gated by a dirty check against a generation
 * counter that no writer ever incremented — so the gate was true once per
 * process and false forever after, while its skip counter reported as a healthy
 * optimization.
 *
 * It was not fixed by finding the missing writer, because there is none to find:
 * neither issue representation carries a session-derived field any more.
 * `IssueProjection` never did (`@podium/model` projections/issue-projection.ts —
 * "a session change cannot dirty an issue projection ... because the data to do
 * otherwise is not reachable from the signature"), and POD-797 removed
 * `sessions`, `sessionSummary` and `unread` from the legacy `IssueWire`
 * (entities/issue.ts). A session-list change has nothing on an issue to
 * reconcile, so the republish it triggered is deleted rather than repaired.
 */
export interface SessionBroadcastPorts {
  hasPendingVolatile(): boolean
  scheduleVolatileCapture(): void
  flushVolatileCaptures(): void
  flushDeltas(): void
}

/** Coalesces model-view publication independently of lifecycle transitions. */
export class SessionBroadcastCoordinator {
  private cooldown: ReturnType<typeof setTimeout> | null = null
  private pending = false
  private runningGeneration = -1

  constructor(private readonly ports: SessionBroadcastPorts) {}

  broadcast(): void {
    if (this.ports.hasPendingVolatile()) {
      this.pending = true
      this.ports.scheduleVolatileCapture()
      return
    }
    if (this.cooldown) {
      this.pending = true
      return
    }
    this.run()
    this.cooldown = setTimeout(() => {
      this.cooldown = null
      if (!this.pending) return
      this.pending = false
      try {
        this.broadcast()
      } catch (error) {
        console.warn('[podium] coalesced session broadcast failed', error)
      }
    }, 0)
    this.cooldown.unref?.()
  }

  flush(): void {
    if (this.cooldown) {
      clearTimeout(this.cooldown)
      this.cooldown = null
    }
    if (this.pending || this.ports.hasPendingVolatile()) {
      this.pending = false
      this.run()
    }
    this.ports.flushDeltas()
  }

  private run(): void {
    const startedAt = performance.now()
    if (this.runningGeneration !== -1) {
      this.pending = true
      perf.record('phase', 'sessionsBroadcast.total', performance.now() - startedAt, DEPLOYMENT)
      return
    }
    this.runningGeneration = -2
    try {
      this.ports.flushVolatileCaptures()
    } finally {
      this.runningGeneration = -1
    }
    perf.record('phase', 'sessionsBroadcast.total', performance.now() - startedAt, DEPLOYMENT)
  }
}
