import { describe, expect, it } from 'vitest'
import { type AgentComputingFields, isAgentComputing } from './agent-computing'

function row(over: Partial<AgentComputingFields> = {}): AgentComputingFields {
  return { status: 'live', archived: false, agentState: { phase: 'working' }, ...over }
}

describe('isAgentComputing', () => {
  it('counts a live agent mid-turn, including context compaction', () => {
    expect(isAgentComputing(row())).toBe(true)
    expect(isAgentComputing(row({ agentState: { phase: 'compacting' } }))).toBe(true)
  })

  it('counts a reconnecting agent: the daemon link dropped, not the agent', () => {
    expect(isAgentComputing(row({ status: 'reconnecting' }))).toBe(true)
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
