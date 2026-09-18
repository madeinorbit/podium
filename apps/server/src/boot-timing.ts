import { createLogger } from '@podium/logger'

const log = createLogger('server:boot')

/** Monotonic process age includes module loading before startServer is entered. */
export function bootStage(stage: string, startedAt: number): void {
  log.info('boot stage completed', {
    stage,
    durationMs: Math.round(process.uptime() * 1000),
    stageDurationMs: Math.round(performance.now() - startedAt),
  })
}
