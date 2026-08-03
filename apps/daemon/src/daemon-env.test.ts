import { asSessionId } from '@podium/model'
import { expect, it } from 'vitest'
import { sessionRelayEnv } from './daemon'

it('sessionRelayEnv binds the session id into env + relay URL (new name only)', () => {
  const env = sessionRelayEnv(
    asSessionId('sess-42'),
    'http://127.0.0.1:45778/agent/sess-42',
    'blue',
    'codex',
  )
  expect(env).toEqual({
    PODIUM_INSTANCE: 'blue',
    PODIUM_SESSION_INSTANCE: 'blue',
    PODIUM_SESSION_ID: 'sess-42',
    PODIUM_SESSION_RELAY: 'http://127.0.0.1:45778/agent/sess-42',
    PODIUM_AGENT_RELAY: 'http://127.0.0.1:45778/agent/sess-42',
  })
  // No dual injection: the legacy env name is never written.
  expect(env).not.toHaveProperty('PODIUM_ISSUE_RELAY')
})

// POD-1375: a shell IS the operator at a terminal, not a delegate. Binding
// PODIUM_AGENT_RELAY there made the `podium` CLI adopt a constrained-agent
// identity and refuse the human's own operator commands (`issue promote`,
// `reparent`) inside their own terminal.
it('sessionRelayEnv withholds the agent-identity relay from a shell session', () => {
  const env = sessionRelayEnv(
    asSessionId('sess-7'),
    'http://127.0.0.1:45778/agent/sess-7',
    'blue',
    'shell',
  )
  expect(env).not.toHaveProperty('PODIUM_AGENT_RELAY')
  // …but the session-scoped transport is still bound: a shell must keep reaching
  // its own daemon endpoint (browser shim, `podium worktree`).
  expect(env).toEqual({
    PODIUM_INSTANCE: 'blue',
    PODIUM_SESSION_INSTANCE: 'blue',
    PODIUM_SESSION_ID: 'sess-7',
    PODIUM_SESSION_RELAY: 'http://127.0.0.1:45778/agent/sess-7',
  })
})

it('sessionRelayEnv binds the agent-identity relay for every non-shell kind', () => {
  for (const kind of ['claude-code', 'codex', 'grok', 'opencode', 'cursor'] as const) {
    const env = sessionRelayEnv(asSessionId('s1'), 'http://127.0.0.1:45778/agent/s1', 'blue', kind)
    expect(env.PODIUM_AGENT_RELAY, kind).toBe('http://127.0.0.1:45778/agent/s1')
  }
})
