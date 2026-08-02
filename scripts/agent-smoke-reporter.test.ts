import { describe, expect, it } from 'vitest'
import {
  type AgentSmokeCase,
  agentSmokeCensusError,
  REAL_AGENT_CLIS,
  summarizeAgentSmokes,
} from './agent-smoke-reporter'

const oneCasePerCli = (state: AgentSmokeCase['state']): AgentSmokeCase[] =>
  REAL_AGENT_CLIS.map((cli) => ({
    fullName: `[real-agent:${cli}] turn and resume`,
    state,
  }))

describe('agent smoke census', () => {
  it('reports ran and skipped counts independently for every CLI', () => {
    const summary = summarizeAgentSmokes([
      ...oneCasePerCli('skipped'),
      { fullName: '[real-agent:claude] argv regression', state: 'passed' },
      { fullName: '[real-agent:codex] hook regression', state: 'failed' },
      { fullName: 'ordinary unit test', state: 'passed' },
    ])

    expect(summary).toEqual({
      claude: { passed: 1, failed: 0, skipped: 1, pending: 0 },
      codex: { passed: 0, failed: 1, skipped: 1, pending: 0 },
      opencode: { passed: 0, failed: 0, skipped: 1, pending: 0 },
      cursor: { passed: 0, failed: 0, skipped: 1, pending: 0 },
      grok: { passed: 0, failed: 0, skipped: 1, pending: 0 },
    })
    expect(agentSmokeCensusError(summary)).toBeUndefined()
  })

  it('fails a census where every CLI skipped', () => {
    expect(agentSmokeCensusError(summarizeAgentSmokes(oneCasePerCli('skipped')))).toBe(
      'every real-agent CLI smoke skipped; no real binary was exercised',
    )
  })

  it('fails when a CLI has no registered real-agent case', () => {
    const cases = oneCasePerCli('passed').filter(
      (test) => !test.fullName.includes('[real-agent:grok]'),
    )
    expect(agentSmokeCensusError(summarizeAgentSmokes(cases))).toBe(
      'real-agent smoke cases are missing for: grok',
    )
  })
})
