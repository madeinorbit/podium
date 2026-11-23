import { createLogger } from '@podium/logger'
import { reportLifecycleProgress } from '@podium/runtime/lifecycle-channel'

const log = createLogger('server:boot')

/** Monotonic process age includes module loading before startServer is entered. */
export function bootStage(stage: string, startedAt: number): void {
  log.info('boot stage completed', {
    stage,
    durationMs: Math.round(process.uptime() * 1000),
    stageDurationMs: Math.round(performance.now() - startedAt),
  })
  // A supervisor waiting on a handover stretches its deadline while these
  // arrive (POD-6618): a first boot after migrations can take far longer than
  // the stall budget and still be healthy.
  reportLifecycleProgress(stage)
}
