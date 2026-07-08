import { expect, it } from 'vitest'
import { issueRelayEnv } from './daemon'

it('issueRelayEnv binds the session id into env + relay URL', () => {
  const env = issueRelayEnv('sess-42', 'http://127.0.0.1:45778/issue/sess-42')
  expect(env).toEqual({
    PODIUM_SESSION_ID: 'sess-42',
    PODIUM_ISSUE_RELAY: 'http://127.0.0.1:45778/issue/sess-42',
  })
})
