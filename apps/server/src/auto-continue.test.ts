import { asSessionId } from '@podium/model'
import type { AgentRuntimeState } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutoContinueController, type AutoContinueDeps } from './auto-continue'

const errored = (retryable = true): AgentRuntimeState => ({
  phase: 'errored',
  since: '2026-06-24T00:00:00Z',
  nativeSubagentCount: 0,
  error: { class: 'server_error', retryable },
})
const working = (): AgentRuntimeState => ({
  phase: 'working',
  since: '2026-06-24T00:00:00Z',
  nativeSubagentCount: 0,
})

function harness(initial: { live?: boolean; state?: AgentRuntimeState; enabled?: boolean } = {}) {
  const sessionId = asSessionId('s1')
  const sent: string[] = []
  let live = initial.live ?? true
  let state = initial.state
  let enabled = initial.enabled ?? true
  const deps: AutoContinueDeps = {
    isEnabled: async () => enabled,
    sendContinue: (id) => sent.push(id),
    getSession: (id) => (id === sessionId ? { live, state } : undefined),
  }
  return {
    c: new AutoContinueController(deps),
    sent,
    sessionId,
    setState: (s: AgentRuntimeState | undefined) => {
      state = s
    },
    setLive: (v: boolean) => {
      live = v
    },
    setEnabled: (v: boolean) => {
      enabled = v
    },
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('AutoContinueController', () => {
  it('sends one continue immediately on a fresh retryable error', async () => {
    const h = harness({ state: errored() })
    await h.c.onStateChange(h.sessionId, errored())
    expect(h.sent).toEqual(['s1'])
  })

  it('escalates the cooldown 10s -> 20s -> 40s while still errored', async () => {
    const h = harness({ state: errored() })
    await h.c.onStateChange(h.sessionId, errored())
    expect(h.sent.length).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.sent.length).toBe(2)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(h.sent.length).toBe(3)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(h.sent.length).toBe(4)
  })

  it('caps the cooldown at 5 minutes', async () => {
    const h = harness({ state: errored() })
    await h.c.onStateChange(h.sessionId, errored())
    // sends at t = 0, 10s, 30s, 70s, 150s, 310s (gaps 10,20,40,80,160 then capped 300)
    await vi.advanceTimersByTimeAsync(310_000)
    expect(h.sent.length).toBe(6)
    await vi.advanceTimersByTimeAsync(299_000)
    expect(h.sent.length).toBe(6) // an uncapped 6th gap would be 320s; cap makes it 300s
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.sent.length).toBe(7)
  })

  it('resets the backoff after the agent recovers, then re-errors', async () => {
    const h = harness({ state: errored() })
    await h.c.onStateChange(h.sessionId, errored())
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.sent.length).toBe(2)
    h.setState(working())
    await h.c.onStateChange(h.sessionId, working())
    expect(h.c.isActive(h.sessionId)).toBe(false)
    h.setState(errored())
    await h.c.onStateChange(h.sessionId, errored())
    expect(h.sent.length).toBe(3) // immediate nudge again
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.sent.length).toBe(4) // gap reset to 10s, not 40s
  })

  it('stops nudging once disabled (checked on the next tick)', async () => {
    const h = harness({ state: errored() })
    await h.c.onStateChange(h.sessionId, errored())
    h.setEnabled(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.sent.length).toBe(1)
    expect(h.c.isActive(h.sessionId)).toBe(false)
  })

  it('onSettingsChanged(false) cancels running loops immediately', async () => {
    const h = harness({ state: errored() })
    await h.c.onStateChange(h.sessionId, errored())
    expect(h.c.isActive(h.sessionId)).toBe(true)
    await h.c.onSettingsChanged(false, [])
    expect(h.c.isActive(h.sessionId)).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.sent.length).toBe(1)
  })

  it('onSettingsChanged(true, ids) arms already-errored sessions', async () => {
    const h = harness({ state: errored() })
    await h.c.onSettingsChanged(true, [h.sessionId])
    expect(h.sent).toEqual(['s1'])
  })

  it('never arms on a non-retryable error', async () => {
    const h = harness({ state: errored(false) })
    await h.c.onStateChange(h.sessionId, errored(false))
    expect(h.c.isActive(h.sessionId)).toBe(false)
    expect(h.sent).toEqual([])
  })

  it('never sends into a non-live session', async () => {
    const h = harness({ state: errored(), live: false })
    await h.c.onStateChange(h.sessionId, errored())
    expect(h.sent).toEqual([])
    expect(h.c.isActive(h.sessionId)).toBe(false)
  })

  it('keeps a single loop per session (no duplicate nudges)', async () => {
    const h = harness({ state: errored() })
    await h.c.onStateChange(h.sessionId, errored())
    await h.c.onStateChange(h.sessionId, errored())
    expect(h.sent.length).toBe(1)
  })

  it('onSessionGone cancels the loop', async () => {
    const h = harness({ state: errored() })
    await h.c.onStateChange(h.sessionId, errored())
    h.c.onSessionGone(h.sessionId)
    expect(h.c.isActive(h.sessionId)).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.sent.length).toBe(1)
  })
})
