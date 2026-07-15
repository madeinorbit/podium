import { expect, it } from 'vitest'
import { agentRelayEnv } from './daemon'

it('agentRelayEnv binds the session id into env + relay URL (new name only)', () => {
  const env = agentRelayEnv('sess-42', 'http://127.0.0.1:45778/agent/sess-42')
  expect(env).toEqual({
    PODIUM_SESSION_ID: 'sess-42',
    PODIUM_AGENT_RELAY: 'http://127.0.0.1:45778/agent/sess-42',
  })
  // No dual injection: the legacy env name is never written.
  expect(env).not.toHaveProperty('PODIUM_ISSUE_RELAY')
})
