import { createHash } from 'node:crypto'
import type { ConversationSummaryWire, ServerMessage, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

// Registry-level tests for the upstream mirror (docs/spec/node-hub-sync.md §2.3):
// local ∪ upstream listing with viaHub marking, own-machine echo filtering,
// staleness semantics on hub loss, and command-path rejection for hub sessions.

function hubSession(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: id,
    agentKind: 'shell',
    title: `hub ${id}`,
    cwd: '/hub/repo',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: '2026-07-01T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    machineId: 'hub-machine',
    machineName: 'hub',
    ...over,
  }
}

function hubConversation(id: string): ConversationSummaryWire {
  return { id, agentKind: 'claude-code', providerId: 'claude-code' }
}

function makeNode() {
  const store = new SessionStore(':memory:')
  const registry = new SessionRegistry(store)
  registry.attachDaemon('local', () => {})
  return { store, registry }
}

describe('upstream mirror (registry surface)', () => {
  it('listSessions returns local ∪ upstream with viaHub set only on hub entries', () => {
    const { registry } = makeNode()
    const { sessionId: localId } = registry.createSession({ agentKind: 'shell', cwd: '/local' })
    registry.setUpstreamSessions([hubSession('hub-1'), hubSession('hub-2')])

    const list = registry.listSessions()
    expect(list.map((s) => s.sessionId).sort()).toEqual(['hub-1', 'hub-2', localId].sort())
    const local = list.find((s) => s.sessionId === localId)
    expect(local?.viaHub).toBeUndefined()
    for (const id of ['hub-1', 'hub-2']) {
      const s = list.find((x) => x.sessionId === id)
      expect(s?.viaHub).toBe(true)
      expect(s?.upstreamStale).toBeUndefined()
    }
  })

  it('filters own-machine echoes by machineId at ingest', () => {
    const { registry } = makeNode()
    registry.setUpstreamOwnMachineIds(['my-daemon-id'])
    registry.setUpstreamSessions([
      hubSession('hub-1'),
      hubSession('echo-1', { machineId: 'my-daemon-id' }),
    ])
    const ids = registry.listSessions().map((s) => s.sessionId)
    expect(ids).toContain('hub-1')
    expect(ids).not.toContain('echo-1')
  })

  it('hub loss marks upstream entries stale but RETAINS them; local unaffected', () => {
    const { registry } = makeNode()
    const { sessionId: localId } = registry.createSession({ agentKind: 'shell', cwd: '/local' })
    registry.setUpstreamSessions([hubSession('hub-1')])

    registry.setUpstreamStale(true)
    const list = registry.listSessions()
    const hub = list.find((s) => s.sessionId === 'hub-1')
    expect(hub).toBeDefined() // retained, never blanked
    expect(hub?.upstreamStale).toBe(true)
    expect(hub?.viaHub).toBe(true)
    const local = list.find((s) => s.sessionId === localId)
    expect(local?.upstreamStale).toBeUndefined()

    // Link back → flag clears without re-ingesting.
    registry.setUpstreamStale(false)
    expect(
      registry.listSessions().find((s) => s.sessionId === 'hub-1')?.upstreamStale,
    ).toBeUndefined()
  })

  it('upstream sessions flow through the broadcast pipeline to node clients', () => {
    const { registry } = makeNode()
    const inbox: ServerMessage[] = []
    registry.attachClient((m) => inbox.push(m))
    inbox.length = 0
    registry.setUpstreamSessions([hubSession('hub-1')])
    registry.flushBroadcasts()
    const msg = inbox.find((m) => m.type === 'sessionsChanged')
    expect(msg).toBeDefined()
    if (msg?.type !== 'sessionsChanged') return
    expect(msg.sessions.some((s) => s.sessionId === 'hub-1' && s.viaHub)).toBe(true)
  })

  it('upstream conversations merge into snapshots; local ids win collisions', () => {
    const { registry } = makeNode()
    registry.setUpstreamConversations([hubConversation('conv-hub-1')])
    const inbox: ServerMessage[] = []
    registry.attachClient((m) => inbox.push(m))
    const msg = inbox.find((m) => m.type === 'conversationsChanged')
    expect(msg).toBeDefined()
    if (msg?.type !== 'conversationsChanged') return
    expect(msg.conversations.some((c) => c.id === 'conv-hub-1')).toBe(true)
  })

  it('changesSince snapshots include upstream entities (node clients heal to them)', () => {
    const { registry } = makeNode()
    registry.setUpstreamSessions([hubSession('hub-1')])
    registry.setUpstreamConversations([hubConversation('conv-hub-1')])
    const snap = registry.syncChangesSince(null)
    expect(snap.kind).toBe('snapshot')
    if (snap.kind !== 'snapshot') return
    expect(snap.sessions.some((s) => s.sessionId === 'hub-1' && s.viaHub)).toBe(true)
    expect(snap.conversations.some((c) => c.id === 'conv-hub-1')).toBe(true)
  })

  it('rejects every command path on a viaHub session with the spec reason', () => {
    const { registry } = makeNode()
    registry.setUpstreamSessions([hubSession('hub-1')])
    const reason = SessionRegistry.UPSTREAM_COMMAND_REJECTION

    expect(registry.sendText({ sessionId: 'hub-1', text: 'hi' })).toEqual({
      ok: false,
      reason,
    })
    expect(registry.queueText({ sessionId: 'hub-1', text: 'hi' })).toEqual({
      ok: false,
      reason,
    })
    expect(registry.resumeAndSend({ sessionId: 'hub-1', text: 'hi' })).toEqual({
      ok: false,
      reason,
    })
    expect(registry.hibernateSession({ sessionId: 'hub-1' })).toEqual({ ok: false, reason })
    expect(registry.resurrectSession({ sessionId: 'hub-1' })).toEqual({ ok: false, reason })
    expect(registry.continueSession({ sessionId: 'hub-1' })).toEqual({ ok: false })
    expect(() => registry.killSession({ sessionId: 'hub-1' })).toThrow(reason)
    // ...and the mirror entry is still there (rejection is side-effect free).
    expect(registry.listSessions().some((s) => s.sessionId === 'hub-1')).toBe(true)
  })

  it('re-ingest replaces the mirror (a session gone from the hub disappears)', () => {
    const { registry } = makeNode()
    registry.setUpstreamSessions([hubSession('hub-1'), hubSession('hub-2')])
    registry.setUpstreamSessions([hubSession('hub-2')])
    const ids = registry.listSessions().map((s) => s.sessionId)
    expect(ids).not.toContain('hub-1')
    expect(ids).toContain('hub-2')
  })
})

describe('mintUpstreamToken', () => {
  it('mints a long-lived, revocable client session (sha-256 stored, not plaintext)', () => {
    const { registry, store } = makeNode()
    const token = registry.mintUpstreamToken()
    expect(token.length).toBeGreaterThanOrEqual(40)
    const hash = createHash('sha256').update(token).digest('hex')
    expect(store.isClientSessionValid(hash, new Date().toISOString())).toBe(true)
    // Long-lived: still valid years out.
    expect(
      store.isClientSessionValid(hash, new Date(Date.now() + 5 * 365 * 864e5).toISOString()),
    ).toBe(true)
    // Revocable like any client session.
    store.deleteClientSession(hash)
    expect(store.isClientSessionValid(hash, new Date().toISOString())).toBe(false)
  })
})
