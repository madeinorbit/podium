import type { ServerMessage } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../../relay'
import { SessionPublicationActor } from './publish-worker-actor.js'
import { PublishWorkerClient, type PublishWorkerLike } from './publish-worker-client.js'
import type { PublishWorkerCommand, PublishWorkerResult } from './publish-worker-protocol.js'

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

type WorkerEvent = 'message' | 'error' | 'exit'

function controlledWorker() {
  const actor = new SessionPublicationActor()
  const handlers: Record<WorkerEvent, Array<(value: unknown) => void>> = {
    message: [],
    error: [],
    exit: [],
  }
  const worker: PublishWorkerLike & {
    sent: PublishWorkerCommand[]
    emit(event: WorkerEvent, value: unknown): void
    reply(index?: number): void
  } = {
    sent: [],
    postMessage(message) {
      const command = message as PublishWorkerCommand
      this.sent.push(command)
      if (command.type === 'reset') actor.reset(command.state)
      if (command.type === 'patch') actor.applyPatch(command.event)
    },
    on(event, handler) {
      handlers[event].push(handler as (value: unknown) => void)
    },
    terminate() {},
    emit(event, value) {
      for (const handler of handlers[event]) handler(value)
    },
    reply(index = -1) {
      const command = this.sent
        .filter(
          (candidate): candidate is Extract<PublishWorkerCommand, { type: 'prepare' }> =>
            candidate.type === 'prepare',
        )
        .at(index)
      if (!command) throw new Error('missing controlled prepare command')
      this.emit('message', {
        id: command.id,
        ok: true,
        durationMs: 1,
        publication: actor.prepare(command.input),
      } satisfies PublishWorkerResult)
    },
  }
  return worker
}

type ControlledWorker = ReturnType<typeof controlledWorker>

function registryWithControlledWorkers(workers: ControlledWorker[]): SessionRegistry {
  const publicationWorker = new PublishWorkerClient({
    spawn: () => {
      const worker = controlledWorker()
      workers.push(worker)
      return worker
    },
  })
  return new SessionRegistry(undefined, undefined, { publicationWorker })
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
    await until(() => encoded.length === 3)
    expect(decoded(encodedAt(encoded, 1))).toEqual({
      type: 'sessionViewDelta',
      removedSessionIds: [revoked],
    })
    expect(sessions(encodedAt(encoded, 2))).toEqual([first])
    expect(encoded[2]).not.toContain(revoked)
    expect(encoded.map((bytes) => decoded(bytes).type)).toEqual([
      'sessionsChanged',
      'sessionViewDelta',
      'sessionsChanged',
    ])
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

    const cursor = registry.modules.sessions.syncChangesSince(null).cursor
    registry.modules.sessions.sendMetadataDelta([
      { seq: cursor + 1, entity: 'issue', id: 'hidden-issue', op: 'remove' },
      {
        seq: cursor + 2,
        entity: 'conversation',
        id: 'hidden-conversation',
        op: 'remove',
      },
    ])
    await until(() => alice.encoded.length === 3 && bob.encoded.length === 3)

    for (const publication of [alice.encoded[2], bob.encoded[2]]) {
      expect(decoded(publication ?? '')).toMatchObject({ type: 'metadataDelta', changes: [] })
      expect(publication).not.toContain('hidden-issue')
      expect(publication).not.toContain('hidden-conversation')
    }
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

  it('retries a sole scoped bootstrap after worker crash without another trigger', async () => {
    const workers: ControlledWorker[] = []
    const registry = registryWithControlledWorkers(workers)
    registries.push(registry)
    const sessionId = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/crash-retry',
    }).sessionId
    registry.modules.sessions.flushBroadcasts()

    const encoded: string[] = []
    registry.modules.sessions.attachClient(() => {}, {
      sendPrepared: (bytes) => encoded.push(bytes),
      principal: 'alice',
      scope: 'principal:alice',
      serverRole: 'standalone',
      protocolVersion: 1,
      global: false,
      snapshot: () => ({
        revision: 1,
        allowedSignature: sessionId,
        allowedSessionIds: [sessionId],
      }),
    })

    expect(workers).toHaveLength(1)
    workers[0]?.emit('exit', 1)
    expect(workers).toHaveLength(2)
    expect(encoded).toEqual([])

    workers[1]?.reply()
    await until(() => encoded.length === 1)
    expect(sessions(encodedAt(encoded, 0))).toEqual([sessionId])
  })

  it('holds scoped deltas until a current delayed bootstrap is sent', async () => {
    const workers: ControlledWorker[] = []
    const registry = registryWithControlledWorkers(workers)
    registries.push(registry)
    const sessionId = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/ordering',
    }).sessionId
    registry.modules.sessions.flushBroadcasts()

    const encoded: string[] = []
    const clientId = registry.modules.sessions.attachClient(() => {}, {
      sendPrepared: (bytes) => encoded.push(bytes),
      principal: 'alice',
      scope: 'principal:alice',
      serverRole: 'standalone',
      protocolVersion: 1,
      global: false,
      snapshot: () => ({
        revision: 1,
        allowedSignature: sessionId,
        allowedSessionIds: [sessionId],
      }),
    })
    registry.modules.sessions.onClientMessage(clientId, {
      type: 'hello',
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      caps: ['metadataDelta'],
    })
    registry.modules.sessions.renameSession({ sessionId, name: 'renamed-before-bootstrap' })
    registry.modules.sessions.flushBroadcasts()

    expect(encoded).toEqual([])
    workers[0]?.reply()
    expect(encoded).toEqual([])
    workers.at(-1)?.reply()
    await until(() => encoded.length === 1)

    const bootstrap = decoded(encodedAt(encoded, 0))
    expect(bootstrap.type).toBe('sessionsChanged')
    expect(
      bootstrap.type === 'sessionsChanged'
        ? bootstrap.sessions.find((session) => session.sessionId === sessionId)?.name
        : undefined,
    ).toBe('renamed-before-bootstrap')

    registry.modules.sessions.renameSession({ sessionId, name: 'ordered-after-bootstrap' })
    registry.modules.sessions.flushBroadcasts()
    expect(encoded).toHaveLength(1)
    workers.at(-1)?.reply()
    await until(() => encoded.length === 2)

    const delta = decoded(encodedAt(encoded, 1))
    expect(delta.type).toBe('metadataDelta')
    expect(
      delta.type === 'metadataDelta'
        ? delta.changes.some(
            (change) =>
              change.entity === 'session' &&
              change.id === sessionId &&
              change.op === 'upsert' &&
              change.value?.name === 'ordered-after-bootstrap',
          )
        : false,
    ).toBe(true)
  })

  it('orders a view-revision removal before its current replacement and ignores stale work', async () => {
    const workers: ControlledWorker[] = []
    const registry = registryWithControlledWorkers(workers)
    registries.push(registry)
    const first = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/replacement-first',
    }).sessionId
    const revoked = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/replacement-revoked',
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
      global: false,
      snapshot: () => ({
        revision,
        allowedSignature: JSON.stringify(allowed),
        allowedSessionIds: allowed,
      }),
    })
    workers.at(-1)?.reply()
    await until(() => encoded.length === 1)
    registry.modules.sessions.onClientMessage(clientId, {
      type: 'hello',
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      caps: ['metadataDelta'],
    })
    encoded.length = 0

    revision = 2
    allowed = [first]
    registry.modules.sessions.refreshClientPublication(clientId)
    expect(decoded(encodedAt(encoded, 0))).toEqual({
      type: 'sessionViewDelta',
      removedSessionIds: [revoked],
    })
    const staleWorker = workers.at(-1)
    registry.modules.sessions.renameSession({ sessionId: first, name: 'replacement-current' })
    registry.modules.sessions.flushBroadcasts()

    staleWorker?.reply()
    expect(encoded).toHaveLength(1)
    workers.at(-1)?.reply()
    await until(() => encoded.length === 2)

    const replacement = decoded(encodedAt(encoded, 1))
    expect(replacement.type).toBe('sessionsChanged')
    expect(sessions(encodedAt(encoded, 1))).toEqual([first])
    expect(encoded[1]).not.toContain(revoked)
  })

  it('shadow-compares two scoped worlds through hidden-only changes and revocation', async () => {
    const registry = new SessionRegistry(undefined, undefined, {
      publicationShadowCompare: true,
    })
    registries.push(registry)
    const aliceSession = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/shadow-alice',
    }).sessionId
    const bobSession = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/shadow-bob-secret',
    }).sessionId
    registry.modules.sessions.flushBroadcasts()

    const attach = (
      principal: string,
      snapshot: () => {
        revision: number
        allowedSignature: string
        allowedSessionIds: string[]
      },
    ) => {
      const encoded: string[] = []
      const id = registry.modules.sessions.attachClient(() => {}, {
        sendPrepared: (bytes) => encoded.push(bytes),
        principal,
        scope: `principal:${principal}`,
        serverRole: 'standalone',
        protocolVersion: 1,
        global: false,
        snapshot,
      })
      registry.modules.sessions.onClientMessage(id, {
        type: 'hello',
        clientId: '',
        viewport: { cols: 80, rows: 24, dpr: 1 },
        caps: ['metadataDelta'],
      })
      return { id, encoded }
    }

    const alice = attach('alice', () => ({
      revision: 1,
      allowedSignature: aliceSession,
      allowedSessionIds: [aliceSession],
    }))
    let bobRevision = 1
    let bobAllowed = [bobSession]
    const bob = attach('bob', () => ({
      revision: bobRevision,
      allowedSignature: JSON.stringify(bobAllowed),
      allowedSessionIds: bobAllowed,
    }))
    await until(() => alice.encoded.length === 1 && bob.encoded.length === 1)

    registry.modules.sessions.renameSession({
      sessionId: bobSession,
      name: 'hidden-from-alice',
    })
    registry.modules.sessions.flushBroadcasts()
    await until(() => alice.encoded.length === 2 && bob.encoded.length === 2)
    expect(decoded(encodedAt(alice.encoded, 1))).toMatchObject({
      type: 'metadataDelta',
      changes: [],
    })
    expect(alice.encoded[1]).not.toContain(bobSession)
    expect(alice.encoded[1]).not.toContain('hidden-from-alice')
    expect(decoded(encodedAt(bob.encoded, 1))).toMatchObject({
      type: 'metadataDelta',
      changes: [{ entity: 'session', id: bobSession, op: 'upsert' }],
    })

    bobRevision += 1
    bobAllowed = []
    registry.modules.sessions.refreshClientPublication(bob.id)
    await until(() => bob.encoded.length === 4)
    expect(decoded(encodedAt(bob.encoded, 2))).toEqual({
      type: 'sessionViewDelta',
      removedSessionIds: [bobSession],
    })
    expect(decoded(encodedAt(bob.encoded, 3))).toEqual({
      type: 'sessionsChanged',
      sessions: [],
    })

    const metrics = registry.modules.sessions.publicationMetrics()
    expect(metrics).toMatchObject({
      shadowMismatches: 0,
      failures: 0,
      queueDepth: 0,
    })
    expect(metrics.shadowComparisons).toBeGreaterThanOrEqual(5)
  })

  it('does not multiply a 588-session projection across same-ViewKey clients', async () => {
    const registry = new SessionRegistry()
    registries.push(registry)
    const sessionIds: string[] = []
    for (let index = 0; index < 588; index += 1) {
      sessionIds.push(
        registry.modules.sessions.createSession({
          agentKind: 'shell',
          cwd: '/world-' + index,
        }).sessionId,
      )
    }
    registry.modules.sessions.flushBroadcasts()

    const listSessions = vi.spyOn(registry.modules.sessions, 'listSessions')
    const publications = Array.from({ length: 4 }, () => [] as string[])
    for (const encoded of publications) {
      registry.modules.sessions.attachClient(() => {}, {
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
    }
    await until(() => publications.every((encoded) => encoded.length === 1))
    expect(listSessions).not.toHaveBeenCalled()

    const completedBefore = registry.modules.sessions.publicationMetrics().completedJobs
    listSessions.mockClear()
    registry.modules.sessions.renameSession({
      sessionId: sessionIds[0] ?? '',
      name: 'one-projection',
    })
    registry.modules.sessions.flushBroadcasts()
    await until(() => publications.every((encoded) => encoded.length === 2))

    expect(listSessions).toHaveBeenCalledTimes(1)
    expect(registry.modules.sessions.publicationMetrics().completedJobs - completedBefore).toBe(1)
  })
})
