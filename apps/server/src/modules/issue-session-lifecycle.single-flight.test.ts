import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../relay'
import { CLOSED_ISSUE_SWEEP_INTERVAL_MS } from './issue-session-lifecycle'

/**
 * THIS ONE WAS ALREADY EXPOSED (POD-3258). It is not waiting for the async store
 * to become a hazard: `sweepClosedIssues` already awaits `stopClosedIssueNow`
 * per issue inside its loop, so on any boot slow enough the startup pass is
 * still in that loop when the first periodic tick fires. Both then work from the
 * snapshot they each took before the other's stops landed.
 *
 * The registry arms the sweep as it builds, so the test drives the interval it
 * armed rather than starting a second one. The probe re-enters from inside
 * `issues.reports.list` — the sweep's first act — and the count that matters is
 * how many times the listing is asked for.
 */
describe('IssueSessionLifecycle closed-issue sweep single-flight (POD-3258)', () => {
  function harness() {
    const registry = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    let calls = 0
    let onList: () => void = () => {}
    const spy = vi.spyOn(registry.modules.issues.reports, 'list').mockImplementation(() => {
      calls += 1
      onList()
      return []
    })
    return {
      registry,
      calls: () => calls,
      setOnList: (fn: () => void) => {
        onList = fn
      },
      done: () => {
        spy.mockRestore()
        registry.modules.issueSessionLifecycle.dispose()
      },
    }
  }

  it('skips a tick that lands on a sweep already running', () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      let reentered = false
      h.setOnList(() => {
        if (reentered) return
        reentered = true
        // Fire the interval again from inside the pass.
        vi.advanceTimersByTime(CLOSED_ISSUE_SWEEP_INTERVAL_MS)
      })

      vi.advanceTimersByTime(CLOSED_ISSUE_SWEEP_INTERVAL_MS)

      expect(reentered).toBe(true)
      expect(h.calls()).toBe(1)
      h.done()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a later, non-overlapping tick sweeps normally', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      await vi.advanceTimersByTimeAsync(CLOSED_ISSUE_SWEEP_INTERVAL_MS)
      await vi.advanceTimersByTimeAsync(CLOSED_ISSUE_SWEEP_INTERVAL_MS)

      expect(h.calls()).toBe(2)
      h.done()
    } finally {
      vi.useRealTimers()
    }
  })
})
