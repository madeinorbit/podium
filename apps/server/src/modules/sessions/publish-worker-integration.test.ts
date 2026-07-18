import type { ServerMessage } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../../relay'

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for publication worker')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function decoded(bytes: string): ServerMessage {
  return JSON.parse(bytes) as ServerMessage
}

function sessions(bytes: string): string[] {
  const message = decoded(bytes)
  if (message.type !== 'sessionsChanged') throw new Error('expected sessionsChanged')
  return message.sessions.map((session) => session.sessionId)
}

function encodedAt(publications: string[], index: number): string {
  const bytes = publications.at(index)
  if (bytes === undefined) throw new Error(`missing encoded publication ${index}`)
  return bytes
}

describe('SessionsService publication worker integration', () => {
  const registries: SessionRegistry[] = []
  afterEach(() => {
    for (const registry of registries.splice(0)) registry.dispose()
  })

  it('groups equal ViewKeys onto shared bytes while the main authority filters worlds', async () => {
    const registry = new SessionRegistry()
    registries.push(registry)
    const aliceSession = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/alice',
    }).sessionId
    const bobSession = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/bob',
    }).sessionId
    registry.modules.sessions.flushBroadcasts()

    const aliceA: string[] = []
    const aliceB: string[] = []
    const bob: string[] = []
    const objectMessages: ServerMessage[] = []
    const authority = (principal: string, allowedSessionIds: string[]) => ({
      principal,
      scope: `principal:${principal}`,
      serverRole: 'standalone',
      protocolVersion: 1,
      global: false,
      snapshot: () => ({
        revision: 1,
        allowedSignature: JSON.stringify([...allowedSessionIds].sort()),
        allowedSessionIds,
      }),
    })
    const listSessions = vi.spyOn(registry.modules.sessions, 'listSessions')
    registry.modules.sessions.attachClient((message) => objectMessages.push(message), {
      sendPrepared: (bytes) => aliceA.push(bytes),
      ...authority('alice', [aliceSession]),
    })
    registry.modules.sessions.attachClient((message) => objectMessages.push(message), {
      sendPrepared: (bytes) => aliceB.push(bytes),
      ...authority('alice', [aliceSession]),
    })
    registry.modules.sessions.attachClient((message) => objectMessages.push(message), {
      sendPrepared: (bytes) => bob.push(bytes),
      ...authority('bob', [bobSession]),
    })

    await until(() => aliceA.length > 0 && aliceB.length > 0 && bob.length > 0)
    expect(sessions(encodedAt(aliceA, -1))).toEqual([aliceSession])
    expect(sessions(encodedAt(aliceB, -1))).toEqual([aliceSession])
    expect(sessions(encodedAt(bob, -1))).toEqual([bobSession])
    expect(aliceA.at(-1)).toBe(aliceB.at(-1))
    expect(objectMessages.some((message) => message.type === 'sessionsChanged')).toBe(false)
    expect(objectMessages.every((message) => message.type === 'welcome')).toBe(true)
    expect(registry.modules.sessions.publicationMetrics().completedJobs).toBe(2)
    expect(listSessions).not.toHaveBeenCalled()
  })

  it('rebuilds a stable ViewKey after authorization revocation without leaking the removed id', async () => {
    const registry = new SessionRegistry()
    registries.push(registry)
    const first = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/one',
    }).sessionId
    const revoked = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/two',
    }).sessionId
    registry.modules.sessions.flushBroadcasts()

    let revision = 1
    let allowed = [first, revoked]
    const encoded: string[] = []
    const objectMessages: ServerMessage[] = []
    const clientId = registry.modules.sessions.attachClient(
      (message) => objectMessages.push(message),
      {
        sendPrepared: (bytes) => encoded.push(bytes),
        principal: 'alice',
        scope: 'principal:alice',
        serverRole: 'standalone',
        protocolVersion: 1,
        global: false,
        snapshot: () => ({
          revision,
          allowedSignature: JSON.stringify([...allowed].sort()),
          allowedSessionIds: allowed,
        }),
      },
    )
    registry.modules.sessions.onClientMessage(clientId, {
      type: 'hello',
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      caps: ['metadataDelta'],
    })
    await until(() => encoded.length === 1)
    expect(sessions(encodedAt(encoded, 0))).toEqual([first, revoked])

    revision += 1
    allowed = [first]
    registry.modules.sessions.refreshClientPublication(clientId)
    await until(() => encoded.length === 2)
    expect(sessions(encodedAt(encoded, 1))).toEqual([first])
    expect(encoded[1]).not.toContain(revoked)
    expect(encoded.every((bytes) => decoded(bytes).type === 'sessionsChanged')).toBe(true)
    expect(objectMessages.every((message) => message.type === 'welcome')).toBe(true)
  })

  it('publishes hidden-only source ranges without leaking ids and visible removes to their world', async () => {
    const registry = new SessionRegistry()
    registries.push(registry)
    const aliceSession = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/alice',
    }).sessionId
    const bobSession = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/bob-secret',
    }).sessionId
    registry.modules.sessions.flushBroadcasts()

    const attach = (principal: string, allowedSessionIds: string[]) => {
      const encoded: string[] = []
      const objects: ServerMessage[] = []
      const id = registry.modules.sessions.attachClient((message) => objects.push(message), {
        sendPrepared: (bytes) => encoded.push(bytes),
        principal,
        scope: 'principal:' + principal,
        serverRole: 'standalone',
        protocolVersion: 1,
        global: false,
        snapshot: () => ({
          revision: 1,
          allowedSignature: JSON.stringify(allowedSessionIds),
          allowedSessionIds,
        }),
      })
      registry.modules.sessions.onClientMessage(id, {
        type: 'hello',
        clientId: '',
        viewport: { cols: 80, rows: 24, dpr: 1 },
        caps: ['metadataDelta'],
      })
      return { encoded, objects }
    }
    const alice = attach('alice', [aliceSession])
    const bob = attach('bob', [bobSession])
    await until(() => alice.encoded.length === 1 && bob.encoded.length === 1)

    registry.modules.sessions.killSession({ sessionId: bobSession })
    registry.modules.sessions.flushBroadcasts()
    await until(() => alice.encoded.length === 2 && bob.encoded.length === 2)

    const aliceDelta = decoded(encodedAt(alice.encoded, 1))
    const bobDelta = decoded(encodedAt(bob.encoded, 1))
    expect(aliceDelta).toMatchObject({ type: 'metadataDelta', changes: [] })
    expect(aliceDelta.type === 'metadataDelta' && aliceDelta.fromExclusive).toBeTypeOf('number')
    expect(alice.encoded[1]).not.toContain(bobSession)
    expect(alice.encoded[1]).not.toContain('bob-secret')
    expect(bobDelta).toMatchObject({
      type: 'metadataDelta',
      changes: [{ entity: 'session', id: bobSession, op: 'remove' }],
    })
    expect(alice.objects.every((message) => message.type === 'welcome')).toBe(true)
    expect(bob.objects.every((message) => message.type === 'welcome')).toBe(true)
  })

  it('sequences an immediate mutation behind the prepared bootstrap', async () => {
    const registry = new SessionRegistry()
    registries.push(registry)
    const first = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/first',
    }).sessionId
    registry.modules.sessions.flushBroadcasts()
    const encoded: string[] = []
    const clientId = registry.modules.sessions.attachClient(() => {}, {
      sendPrepared: (bytes) => encoded.push(bytes),
      principal: 'operator',
      scope: 'all',
      serverRole: 'standalone',
      protocolVersion: 1,
      global: true,
      snapshot: () => ({
        revision: 0,
        allowedSignature: 'global',
        allowedSessionIds: [],
      }),
    })
    registry.modules.sessions.onClientMessage(clientId, {
      type: 'hello',
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      caps: ['metadataDelta'],
    })
    const second = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/second',
    }).sessionId
    registry.modules.sessions.flushBroadcasts()

    await until(() => encoded.length > 0)
    expect(decoded(encodedAt(encoded, 0)).type).toBe('sessionsChanged')
    const visible = new Set(sessions(encodedAt(encoded, 0)))
    for (const bytes of encoded.slice(1)) {
      const message = decoded(bytes)
      expect(message.type).toBe('metadataDelta')
      if (message.type !== 'metadataDelta') continue
      for (const change of message.changes) {
        if (change.entity !== 'session') continue
        if (change.op === 'remove') visible.delete(change.id)
        else visible.add(change.id)
      }
    }
    expect(visible).toEqual(new Set([first, second]))
  })

  it('fails scoped catch-up closed to the authorized session world', () => {
    const registry = new SessionRegistry()
    registries.push(registry)
    const visible = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/visible',
    }).sessionId
    const hidden = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/hidden-secret',
    }).sessionId
    registry.modules.sessions.flushBroadcasts()

    const result = registry.modules.sessions.syncChangesSince(0, {
      principal: 'alice',
      scope: 'principal:alice',
      serverRole: 'standalone',
      protocolVersion: 1,
      global: false,
      snapshot: () => ({
        revision: 1,
        allowedSignature: visible,
        allowedSessionIds: [visible],
      }),
    })

    expect(result).toMatchObject({
      kind: 'snapshot',
      sessions: [{ sessionId: visible }],
      issues: [],
      conversations: [],
      automations: [],
      automationRuns: [],
      diagnostics: [],
    })
    expect(JSON.stringify(result)).not.toContain(hidden)
    expect(JSON.stringify(result)).not.toContain('hidden-secret')
  })

  it('rebuilds the bootstrap under hello capabilities and sends it exactly once', async () => {
    const registry = new SessionRegistry()
    registries.push(registry)
    const sessionId = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/cap-race',
    }).sessionId
    registry.modules.sessions.flushBroadcasts()
    const encoded: string[] = []
    const clientId = registry.modules.sessions.attachClient(() => {}, {
      sendPrepared: (bytes) => encoded.push(bytes),
      principal: 'operator',
      scope: 'all',
      serverRole: 'standalone',
      protocolVersion: 1,
      global: true,
      snapshot: () => ({
        revision: 0,
        allowedSignature: 'global',
        allowedSessionIds: [],
      }),
    })
    registry.modules.sessions.onClientMessage(clientId, {
      type: 'hello',
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      caps: ['metadataDelta'],
    })

    await until(() => encoded.length === 1)
    expect(sessions(encodedAt(encoded, 0))).toEqual([sessionId])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(encoded).toHaveLength(1)
  })
})
