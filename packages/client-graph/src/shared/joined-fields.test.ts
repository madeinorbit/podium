import { describe, expect, it } from 'vitest'
import { joinedFields, SESSION_JOIN_FIELDS } from './joined-fields'

// The session model's `condition` (POD-7062): the machine's logged-out harness
// speaks only for a session on that harness's own login.
describe('session condition', () => {
  const machine = { id: 'm1', name: 'Host', loggedOutHarnesses: ['claude-code'] }
  const session = { sessionId: 's1', machineId: 'm1', agentKind: 'claude-code' }
  const condition = (row: Record<string, unknown>) =>
    joinedFields('session', row, SESSION_JOIN_FIELDS, (kind) =>
      kind === 'machine' ? machine : undefined,
    ).condition

  it('is logged-out for a session on its harness login whose machine login is out', () => {
    expect(condition(session)).toBe('logged-out')
    expect(condition({ ...session, credentialId: null })).toBe('logged-out')
  })

  it.each([
    ['an API key', { credentialId: 'cred_api-key' }],
    ['a subscription home', { credentialId: 'cred_subscription-home' }],
    ['another member’s credential', { credentialId: 'cred_another-member' }],
    ['a legacy managed account', { accountId: 'acct_legacy' }],
  ])('never reads the machine login for a session on %s', (_name, credential) => {
    expect(condition({ ...session, ...credential })).toBeUndefined()
  })
})
