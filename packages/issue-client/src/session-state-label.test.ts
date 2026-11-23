import { isSessionReconnecting, type SessionId, toIssueTreeSession } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { sessionStateLabel } from './commands'

/**
 * The CLI's session word reads the server's shown status, which the server
 * derives through the shared rule from its own daemon links (ADR 12 D1,
 * POD-6646): the same input gives the same answer the web and phone give.
 */
describe('CLI session state over the derived reconnecting', () => {
  const row = (status: string, machineOnline: boolean | undefined) =>
    toIssueTreeSession({
      sessionId: 's1' as SessionId,
      agentKind: 'codex',
      status,
      machineOnline,
      agentState: { phase: 'working' },
    })

  it.each([
    ['live', false],
    ['starting', false],
    ['live', true],
    ['live', undefined],
    ['hibernated', false],
    ['exited', false],
  ] as const)('%s on a machine online=%s', (status, online) => {
    const label = sessionStateLabel(row(status, online))
    expect(label === 'reconnecting').toBe(isSessionReconnecting(status, online))
  })

  it('names the phase of a live session whose machine is online', () => {
    expect(sessionStateLabel(row('live', true))).toBe('working')
    expect(sessionStateLabel(row('live', false))).toBe('reconnecting')
  })
})
