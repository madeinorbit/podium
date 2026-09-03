import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../../relay'
import { RepoRegistry } from '../../repo-registry'
import { SuperagentService } from './index'

/**
 * THE REAPER'S FENCE (POD-3258). A reap reads the pending turns and finishes the
 * ones past their budget; what stops a turn being reaped twice is
 * `dispatchedTurnIds` plus the finish itself, and neither exists until
 * `finishPendingTurn` has run. So an overlapping reap reading the list first
 * sees the same turn still pending and reports it lost a second time to a caller
 * who has already been told.
 *
 * The probe re-enters from inside `listPendingTurns` — the reap's first act, and
 * where the awaited store read will park. One call means the overlapping tick
 * was refused.
 */
describe('SuperagentService turn reaper single-flight (POD-3258)', () => {
  const REAP_MS = 1_000

  it('skips a reap that lands on a reap already running', () => {
    vi.useFakeTimers()
    try {
      const registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
      const repos = new RepoRegistry(registry, registry.sessionStore)
      const sa = new SuperagentService(registry.modules, repos, registry.sessionStore, {
        reapIntervalMs: REAP_MS,
      })

      let calls = 0
      let reentered = false
      const spy = vi
        .spyOn(registry.sessionStore.superagent, 'listPendingTurns')
        .mockImplementation(() => {
          calls += 1
          if (!reentered) {
            reentered = true
            // Fire the interval again from inside the pass.
            vi.advanceTimersByTime(REAP_MS)
          }
          return []
        })

      vi.advanceTimersByTime(REAP_MS)

      expect(reentered).toBe(true)
      expect(calls).toBe(1)
      spy.mockRestore()
      sa.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a later, non-overlapping reap runs normally', () => {
    vi.useFakeTimers()
    try {
      const registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
      const repos = new RepoRegistry(registry, registry.sessionStore)
      const sa = new SuperagentService(registry.modules, repos, registry.sessionStore, {
        reapIntervalMs: REAP_MS,
      })

      let calls = 0
      const spy = vi
        .spyOn(registry.sessionStore.superagent, 'listPendingTurns')
        .mockImplementation(() => {
          calls += 1
          return []
        })

      vi.advanceTimersByTime(REAP_MS)
      vi.advanceTimersByTime(REAP_MS)

      expect(calls).toBe(2)
      spy.mockRestore()
      sa.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
