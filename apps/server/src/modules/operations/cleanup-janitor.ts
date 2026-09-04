import type { OperationClock, OperationEngine, OperationTimerHandle } from './engine'
import type { OperationRow } from './store'

export const DEFAULT_CLEANUP_JANITOR_INTERVAL_MS = 60_000

export class OperationCleanupJanitor {
  private running = false
  private timer: OperationTimerHandle | undefined

  constructor(
    private readonly deps: {
      engine: OperationEngine
      clock: OperationClock
      contextFor: (row: OperationRow) => unknown | Promise<unknown>
      intervalMs?: number
    },
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    queueMicrotask(() => void this.tick())
  }

  stop(): void {
    this.running = false
    if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer)
    this.timer = undefined
  }

  private async tick(): Promise<void> {
    if (!this.running) return
    try {
      await this.deps.engine.retryPendingCleanup(this.deps.contextFor)
    } catch {
      // Pending cleanup is durable; the next tick retries it.
    } finally {
      if (!this.running) return
      this.timer = this.deps.clock.setTimeout(
        () => {
          this.timer = undefined
          void this.tick()
        },
        this.deps.intervalMs ?? DEFAULT_CLEANUP_JANITOR_INTERVAL_MS,
      )
    }
  }
}
