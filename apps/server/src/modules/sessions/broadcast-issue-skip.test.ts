import type { ServerMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'

// POD-722: a session broadcast must republish the issue list ONLY when a session
// field that feeds issue wire data changed. The session-switch hot path (attach +
// detach, ~2 broadcasts per switch — POD-701) moves only clientCount/controllerId/
// epoch, none of which surface as issue member state, so publishIssues() — the
// O(issues×sessions) rebuild — must be skipped while sessionsChanged still fans out.
describe('POD-722 session broadcast skips issue republish when no issue field changed', () => {
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

  it('a legacy attach/detach after a zero-client normalized bypass does NOT emit issuesChanged', () => {
    const { reg, s1, clientId, inbox } = setup()

    // setup first flush has zero clients. With normalized emission default-on,
    // that takes the vacuous no-legacy-client bypass; it must still advance the
    // issue-relevant projection cache. The later legacy client attach-time
    // issuesChanged paint is cleared above, then this full switch moves only
    // clientCount/controllerId. A stale bypass cache used to misclassify it and
    // emit a spurious O(world) issuesChanged rebuild.
    reg.modules.sessions.onClientMessage(clientId, { type: 'attach', sessionId: s1 })
    reg.modules.sessions.onClientMessage(clientId, { type: 'detach', sessionId: s1 })
    reg.modules.sessions.flushBroadcasts()

    expect(inbox.some((m) => m.type === 'sessionsChanged')).toBe(true)
    expect(inbox.some((m) => m.type === 'issuesChanged')).toBe(false)
    reg.dispose()
  })

  it('a workState change republishes issues (issuesChanged fires)', () => {
    const { reg, s1, inbox } = setup()

    reg.modules.sessions.setWorkState({ sessionId: s1, workState: 'testing' })
    reg.modules.sessions.flushBroadcasts()

    expect(inbox.some((m) => m.type === 'sessionsChanged')).toBe(true)
    expect(inbox.some((m) => m.type === 'issuesChanged')).toBe(true)
    reg.dispose()
  })
})
