import type { ServerMessage } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for publication worker')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function sessions(bytes: string): string[] {
  const message = JSON.parse(bytes) as ServerMessage
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
      revision: () => 1,
      allowedSessionIds: () => allowedSessionIds,
    })
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
    expect(registry.modules.sessions.publicationMetrics().completedJobs).toBe(2)
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
    const clientId = registry.modules.sessions.attachClient(() => {}, {
      sendPrepared: (bytes) => encoded.push(bytes),
      principal: 'alice',
      scope: 'principal:alice',
      serverRole: 'standalone',
      protocolVersion: 1,
      revision: () => revision,
      allowedSessionIds: () => allowed,
    })
    await until(() => encoded.length === 1)
    expect(sessions(encodedAt(encoded, 0))).toEqual([first, revoked])

    revision += 1
    allowed = [first]
    registry.modules.sessions.refreshClientPublication(clientId)
    await until(() => encoded.length === 2)
    expect(sessions(encodedAt(encoded, 1))).toEqual([first])
    expect(encoded[1]).not.toContain(revoked)
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
      revision: () => 0,
      allowedSessionIds: () => [sessionId],
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
