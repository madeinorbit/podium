import type { WorkspaceIdentity } from '@podium/identity'
import { createLogger } from '@podium/logger'

/** Specification section 11: ten seconds of polling, five seconds for a run. */
export const MEMBERSHIP_CATCH_UP_INTERVAL_MS = 10_000
export const MEMBERSHIP_CATCH_UP_MAX_DELAY_MS = 15_000

export type MembershipCatchUpScheduler = (every: number, run: () => Promise<void>) => () => void

const schedule: MembershipCatchUpScheduler = (every, run) => {
  const timer = setInterval(() => {
    void run()
  }, every)
  timer.unref?.()
  return () => clearInterval(timer)
}

export interface MembershipCatchUpStatus {
  state: 'current' | 'retrying' | 'degraded'
  consecutiveFailures: number
  maximumDelayMs: number
}

/** Hosted only. No second authorization fact: catch-up writes the ordinary member row. */
export function startMembershipCatchUp(
  workspace: Pick<WorkspaceIdentity, 'catchUp'>,
  scheduler: MembershipCatchUpScheduler = schedule,
) {
  const log = createLogger('server:membership-catch-up')
  let failures = 0
  let stopped = false
  let running: Promise<void> | undefined
  const run = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (running) return running
    running = workspace
      .catchUp()
      .then(
        () => {
          failures = 0
        },
        (err) => {
          failures += 1
          const detail = { err, consecutiveFailures: failures }
          if (failures >= 3)
            log.error('membership catch-up degraded; retrying on the next tick', detail)
          else log.warn('membership catch-up failed; retrying on the next tick', detail)
        },
      )
      .finally(() => {
        running = undefined
      })
    return running
  }
  const cancel = scheduler(MEMBERSHIP_CATCH_UP_INTERVAL_MS, run)
  return {
    status: (): MembershipCatchUpStatus => ({
      state: failures >= 3 ? 'degraded' : failures > 0 ? 'retrying' : 'current',
      consecutiveFailures: failures,
      maximumDelayMs: MEMBERSHIP_CATCH_UP_MAX_DELAY_MS,
    }),
    async stop() {
      stopped = true
      cancel()
      await running
    },
  }
}
