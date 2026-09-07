import { createLogger } from '@podium/logger'
import { DEPLOYMENT, perf } from '../../perf/registry'

const log = createLogger('server:sessions')

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
  drainVolatileSlice(): Promise<{ remaining: number }>
  flushVolatileCaptures(): Promise<unknown>
  flushDeltas(): void
}

/** Coalesces model-view publication independently of lifecycle transitions. */
export class SessionBroadcastCoordinator {
  private cooldown: ReturnType<typeof setTimeout> | null = null
  private pending = false
  private running: Promise<void> | null = null

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
    void this.runScheduled()
    this.cooldown = setTimeout(() => {
      this.cooldown = null
      if (!this.pending) return
      this.pending = false
      try {
        this.broadcast()
      } catch (error) {
        log.warn('coalesced session broadcast failed', { err: error })
      }
    }, 0)
    this.cooldown.unref?.()
  }

  /** Background work owns its errors; the repository retains and retries dirty entries. */
  async runScheduled(): Promise<void> {
    this.pending = false
    try {
      await this.capture(false)
    } catch (error) {
      log.warn('coalesced session broadcast failed', { err: error })
    }
  }

  /** Explicit callers own completion and failure of the full-drain barrier. */
  async flush(): Promise<void> {
    if (this.cooldown) {
      clearTimeout(this.cooldown)
      this.cooldown = null
    }
    this.pending = false
    if (this.running) await this.running
    await this.capture(true)
  }

  private capture(full: boolean): Promise<void> {
    if (this.running) return this.running
    const run = async () => {
      const startedAt = performance.now()
      try {
        if (full) {
          await this.ports.flushVolatileCaptures()
        } else {
          const { remaining } = await this.ports.drainVolatileSlice()
          if (remaining > 0) this.ports.scheduleVolatileCapture()
        }
        this.ports.flushDeltas()
      } finally {
        this.running = null
        perf.record('phase', 'sessionsBroadcast.total', performance.now() - startedAt, DEPLOYMENT)
      }
    }
    this.running = Promise.resolve().then(run)
    return this.running
  }
}
