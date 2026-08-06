import type { SessionMeta } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { agentErrorKey } from './AgentOutcomeHaptics'

describe('agentErrorKey', () => {
  it('identifies one errored-state arrival and ignores other phases', () => {
    const working = {
      sessionId: 'session-1',
      agentState: { phase: 'working', since: '2026-08-06T12:00:00Z' },
    } as unknown as SessionMeta
    const errored = {
      sessionId: 'session-1',
      agentState: {
        phase: 'errored',
        since: '2026-08-06T12:01:00Z',
        error: { class: 'process_exit', message: 'Agent exited', retryable: true },
      },
    } as unknown as SessionMeta

    expect(agentErrorKey(working)).toBeNull()
    expect(agentErrorKey(errored)).toBe('2026-08-06T12:01:00Z:process_exit')
    expect(agentErrorKey(errored)).toBe(agentErrorKey(errored))
  })
})
