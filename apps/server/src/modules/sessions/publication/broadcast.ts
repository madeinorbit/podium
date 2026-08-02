import type { SessionMeta } from '@podium/model'
import { DEPLOYMENT, perf } from '../../perf/registry'

export interface SessionBroadcastPorts {
  hasPendingVolatile(): boolean
  scheduleVolatileCapture(): void
  flushVolatileCaptures(): void
  generation(): number
  issueGeneration(): number
  listSessions(): SessionMeta[]
  schedulePublication(options: { includeDeltaCapable: boolean }): void
  publishIssues(sessions: SessionMeta[]): void
  flushDeltas(): void
}

/** Coalesces model-view publication independently of lifecycle transitions. */
export class SessionBroadcastCoordinator {
  private cooldown: ReturnType<typeof setTimeout> | null = null
  private pending = false
  private lastGeneration = -1
  private runningGeneration = -1
  private lastIssueGeneration = -1

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
      const generation = this.ports.generation()
      if (generation === this.lastGeneration) {
        perf.record('phase', 'sessionsBroadcast.total', performance.now() - startedAt, DEPLOYMENT)
        return
      }
      this.runningGeneration = generation
      const issueGeneration = this.ports.issueGeneration()
      const issueChanged = issueGeneration !== this.lastIssueGeneration
      const sessions = issueChanged ? this.ports.listSessions() : []
      const listedAt = performance.now()
      perf.record('phase', 'sessionsBroadcast.list', listedAt - startedAt, DEPLOYMENT)
      perf.record('phase', 'sessionsBroadcast.stringify', 0, DEPLOYMENT, 0)
      this.ports.schedulePublication({ includeDeltaCapable: false })
      const skipStartedAt = performance.now()
      if (!issueChanged) {
        perf.record(
          'phase',
          'sessionsBroadcast.publishIssuesSkipped',
          performance.now() - skipStartedAt,
          DEPLOYMENT,
        )
      } else {
        const issuesStartedAt = performance.now()
        this.ports.publishIssues(sessions)
        this.lastIssueGeneration = issueGeneration
        perf.record(
          'phase',
          'sessionsBroadcast.publishIssues',
          performance.now() - issuesStartedAt,
          DEPLOYMENT,
        )
      }
      this.lastGeneration = generation
    } finally {
      this.runningGeneration = -1
    }
    perf.record('phase', 'sessionsBroadcast.total', performance.now() - startedAt, DEPLOYMENT)
  }
}
