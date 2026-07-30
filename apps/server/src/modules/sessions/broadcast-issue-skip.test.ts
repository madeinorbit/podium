import type { SessionId } from '@podium/model'
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
  const bind = (sessionId: SessionId) =>
    ({ type: 'bind', sessionId, cmd: 'claude', cwd: '/repo/w', agentKind: 'claude-code', geometry: G }) as const

  function setup() {
    const reg = new SessionRegistry()
    reg.gateway.attachDaemon('local', () => {})
    reg.issues.create({ repoPath: '/repo', title: 'an issue', startNow: false })
    const s1 = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/repo/w' }).sessionId
    reg.gateway.routeDaemonFrame('local', bind(s1))
    reg.modules.sessions.flushBroadcasts()
    const inbox: ServerMessage[] = []
    const clientId = reg.clientGateway.attachClient((m) => inbox.push(m))
    reg.modules.sessions.flushBroadcasts()
    // Clear the bootstrap traffic; from here on we watch only what our churn emits.
    inbox.length = 0
    return { reg, s1, clientId, inbox }
  }

  it('an attach-then-detach fans out sessionsChanged but NOT issuesChanged', () => {
    const { reg, s1, clientId, inbox } = setup()

    // A full session switch: attach the new session, detach the old — only
    // clientCount/controllerId move, so no issue payload can change.
    reg.clientGateway.routeClientFrame(clientId, { type: 'attach', sessionId: s1 })
    reg.clientGateway.routeClientFrame(clientId, { type: 'detach', sessionId: s1 })
    reg.modules.sessions.flushBroadcasts()

    // WHAT POD-1203 CHANGED, and it is the stronger half of POD-722's claim.
    // Attach-then-detach is an A→B→A on clientCount/controllerId: the volatile
    // capture dedups it to NO durable change, because the final state equals the
    // one the client already has. The old pipeline fanned out a full session
    // snapshot anyway ("it still invalidates the legacy snapshot pipeline once"),
    // which is work done to tell a client something it already knew — the exact
    // cost POD-701 measured on this path. Serving from the feed means a churn
    // that changed nothing sends nothing.
    expect(inbox.some((m) => m.type === 'sessionsChanged')).toBe(false)
    expect(inbox.some((m) => m.type === 'issuesChanged')).toBe(false)
    // The paired half: this client is not simply deaf. A REAL change reaches it
    // through the same sink — without this, the assertions above are equally
    // satisfied by a connection that was never served at all.
    reg.modules.sessions.setWorkState({ sessionId: s1, workState: 'testing' })
    reg.modules.sessions.flushBroadcasts()
    expect(inbox.some((m) => m.type === 'sessionsChanged')).toBe(true)
    reg.dispose()
  })

  it('a workState change publishes the SESSION row; the issue row is deduped, as it always was for a delta client', () => {
    // WHAT POD-1203 CHANGED, AND WHO IT CHANGES IT FOR — worth stating exactly,
    // because it looks like a regression and is not one for any shipped client.
    //
    // `issueProjection` (packages/sync/src/change-log.ts, POD-210) excludes an
    // issue's DERIVED session fields — `sessions`, `sessionSummary`, `unread` —
    // from change detection, because the wire embeds every member SessionMeta and
    // re-recording it on each heartbeat was ~81MB/day of ledger churn. So a
    // workState flip appends a SESSION row and no ISSUE row.
    //
    // Before the cutover a non-cap client was compensated by the snapshot
    // fan-out. A CAP client never was: `fanOutSnapshot` skipped delta clients
    // unless `snapshotToCapClients` was set, and the issue publish path never set
    // it. Every shipped build announces `metadataDelta`, so every real client has
    // always seen exactly what this test now asserts — the embedded copy
    // refreshes when a stable issue field moves or on the next bootstrap, and the
    // live state a user sees comes from the `session` entity, which DID update.
    const { reg, s1, inbox } = setup()

    reg.modules.sessions.setWorkState({ sessionId: s1, workState: 'testing' })
    reg.modules.sessions.flushBroadcasts()

    expect(inbox.some((m) => m.type === 'sessionsChanged')).toBe(true)
    expect(inbox.some((m) => m.type === 'issuesChanged')).toBe(false)

    // THE PAIRED HALF, without which the line above is satisfied by an issue
    // pipeline that publishes nothing at all: a STABLE issue field still fans out
    // through the same sink, on the same connection.
    inbox.length = 0
    const issue = reg.issues.list('/repo')[0]
    expect(issue).toBeDefined()
    reg.issues.update(issue!.id, { title: 'renamed' })
    reg.modules.sessions.flushBroadcasts()
    expect(inbox.some((m) => m.type === 'issuesChanged')).toBe(true)
    reg.dispose()
  })
})
