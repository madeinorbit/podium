import { describe, expect, it } from 'vitest'
import {
  type AgentComputingFields,
  CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS,
  isAgentComputing,
  isAgentConfirmedComputing,
} from './agent-computing'

const NOW = Date.parse('2026-08-26T10:00:00.000Z')

function row(over: Partial<AgentComputingFields> = {}): AgentComputingFields {
  return {
    status: 'live',
    archived: false,
    lastActiveAt: new Date(NOW).toISOString(),
    agentState: { phase: 'working', since: new Date(NOW).toISOString() },
    ...over,
  }
}

describe('isAgentComputing', () => {
  it('counts a live agent mid-turn, including context compaction', () => {
    expect(isAgentComputing(row())).toBe(true)
    expect(isAgentComputing(row({ agentState: { phase: 'compacting' } }))).toBe(true)
  })

  it('counts a reconnecting agent: the daemon link dropped, not the agent', () => {
    expect(isAgentComputing(row({ status: 'reconnecting' }))).toBe(true)
  })

  it('confirms only a process whose daemon is currently connected', () => {
    expect(isAgentConfirmedComputing(row(), NOW)).toBe(true)
    expect(isAgentConfirmedComputing(row({ status: 'starting' }), NOW)).toBe(false)
    expect(isAgentConfirmedComputing(row({ status: 'reconnecting' }), NOW)).toBe(false)
    expect(isAgentConfirmedComputing(row({ status: 'hibernated' }), NOW)).toBe(false)
    expect(isAgentConfirmedComputing(row({ status: 'exited' }), NOW)).toBe(false)
  })

  it('requires activity within the last fifteen minutes', () => {
    const stale = new Date(NOW - CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS - 1).toISOString()
    expect(
      isAgentConfirmedComputing(
        row({ lastActiveAt: stale, agentState: { phase: 'working', since: stale } }),
        NOW,
      ),
    ).toBe(false)
    expect(
      isAgentConfirmedComputing(
        row({ lastActiveAt: undefined, agentState: { phase: 'working' } }),
        NOW,
      ),
    ).toBe(false)
  })

  // The phase outlives the process on purpose — exit preserves the final turn
  // diagnosis, hibernation preserves the attention colour — so liveness is part
  // of the question (POD-730).
  it('refuses a preserved working phase once the process is gone or parked', () => {
    expect(isAgentComputing(row({ status: 'exited' }))).toBe(false)
    expect(isAgentComputing(row({ status: 'hibernated' }))).toBe(false)
    expect(isAgentComputing(row({ archived: true }))).toBe(false)
  })

  it('refuses every phase that is not computing, and a session with no harness state', () => {
    for (const phase of ['idle', 'needs_user', 'errored', 'ended']) {
      expect(isAgentComputing(row({ agentState: { phase } }))).toBe(false)
    }
    expect(isAgentComputing(row({ agentState: undefined }))).toBe(false)
  })
})
