import type { ServerMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'

// POD-797: session broadcasts retain their own POD-722 coalescing behavior but never
// republish the now-session-free issue residue.
describe('POD-797 session broadcasts never republish issue residue', () => {
  const G = { cols: 80, rows: 24 }
  const bind = (sessionId: string) =>
    ({
      type: 'bind',
      sessionId,
      cmd: 'claude',
      cwd: '/repo/w',
      agentKind: 'claude-code',
      geometry: G,
    }) as const

  function setup() {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    reg.issues.create({ repoPath: '/repo', title: 'an issue', startNow: false })
    const s1 = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/repo/w',
    }).sessionId
    reg.modules.sessions.onDaemonMessageFrom('local', bind(s1))
    reg.modules.sessions.flushBroadcasts()
    const inbox: ServerMessage[] = []
    const clientId = reg.modules.sessions.attachClient((m) => inbox.push(m))
    reg.modules.sessions.flushBroadcasts()
    // Clear the bootstrap traffic; from here on we watch only what our churn emits.
    inbox.length = 0
    return { reg, s1, clientId, inbox }
  }

  it('attach/detach emits sessionsChanged but not issuesChanged', () => {
    const { reg, s1, clientId, inbox } = setup()

    reg.modules.sessions.onClientMessage(clientId, { type: 'attach', sessionId: s1 })
    reg.modules.sessions.onClientMessage(clientId, { type: 'detach', sessionId: s1 })
    reg.modules.sessions.flushBroadcasts()

    expect(inbox.some((m) => m.type === 'sessionsChanged')).toBe(true)
    expect(inbox.some((m) => m.type === 'issuesChanged')).toBe(false)
    reg.dispose()
  })

  it('a workState change emits sessionsChanged but not issuesChanged', () => {
    const { reg, s1, inbox } = setup()

    reg.modules.sessions.setWorkState({ sessionId: s1, workState: 'testing' })
    reg.modules.sessions.flushBroadcasts()

    expect(inbox.some((m) => m.type === 'sessionsChanged')).toBe(true)
    expect(inbox.some((m) => m.type === 'issuesChanged')).toBe(false)
    reg.dispose()
  })
})
