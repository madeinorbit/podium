import type { MetadataChange, SessionMeta } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createViewKey, type PublicationView } from './publish-worker-actor.js'
import {
  PublicationSupersededError,
  PublishWorkerClient,
  type PublishWorkerLike,
} from './publish-worker-client.js'
import type { PublishWorkerCommand, PublishWorkerResult } from './publish-worker-protocol.js'

type Handler = (value: never) => void

function fakeWorker() {
  const handlers: Record<'message' | 'error' | 'exit', Handler[]> = {
    message: [],
    error: [],
    exit: [],
  }
  const worker: PublishWorkerLike & {
    sent: PublishWorkerCommand[]
    emit(event: 'message' | 'error' | 'exit', value: unknown): void
  } = {
    sent: [],
    postMessage(message) {
      this.sent.push(message as PublishWorkerCommand)
    },
    on(event, handler) {
      handlers[event].push(handler)
    },
    terminate() {},
    emit(event, value) {
      for (const handler of handlers[event]) {
        ;(handler as (payload: unknown) => void)(value)
      }
    },
  }
  return worker
}

function session(sessionId: string): SessionMeta {
  return {
    sessionId,
    agentKind: 'codex',
    cwd: `/work/${sessionId}`,
    title: sessionId,
    machineId: 'local',
    machineName: 'Local',
    status: 'live',
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    controllerId: null,
    createdAt: '2026-07-18T00:00:00.000Z',
    lastActiveAt: '2026-07-18T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
  }
}

function view(name: string, revision = 1): PublicationView {
  return {
    key: createViewKey({
      principal: name,
      scope: name,
      serverRole: 'standalone',
      protocolVersion: 1,
      capabilities: [],
    }),
    revision,
    allowedSessionIds: ['s1'],
  }
}

function prepareCommands(worker: ReturnType<typeof fakeWorker>) {
  return worker.sent.filter(
    (command): command is Extract<PublishWorkerCommand, { type: 'prepare' }> =>
      command.type === 'prepare',
  )
}

function prepareCommand(worker: ReturnType<typeof fakeWorker>, index: number) {
  const command = prepareCommands(worker)[index]
  if (!command) throw new Error(`missing prepare command ${index}`)
  return command
}

function spawnedWorker(workers: ReturnType<typeof fakeWorker>[], index: number) {
  const worker = workers[index]
  if (!worker) throw new Error(`missing spawned worker ${index}`)
  return worker
}

function reply(
  worker: ReturnType<typeof fakeWorker>,
  command: Extract<PublishWorkerCommand, { type: 'prepare' }>,
  overrides: Partial<Extract<PublishWorkerResult, { ok: true }>> = {},
) {
  worker.emit('message', {
    id: command.id,
    ok: true,
    durationMs: 2,
    publication: {
      viewKey: command.input.view.key,
      viewRevision: command.input.view.revision,
      generation: 1,
      ledgerCursor: 1,
      sourceRange: { fromExclusive: null, toInclusive: 1 },
      kind: 'snapshot',
      bytes: '{}',
    },
    ...overrides,
  } satisfies PublishWorkerResult)
}

describe('PublishWorkerClient', () => {
  it('coalesces reentrant N+1-before-N callbacks into ledger order before prepare', () => {
    const worker = fakeWorker()
    const client = new PublishWorkerClient({ spawn: () => worker })
    client.replaceProjection({
      generation: 1,
      ledgerCursor: 2,
      sessions: [session('outer'), session('inner')],
    })
    const stale = client.request({ view: view('target'), sinceCursor: null })
    stale.catch(() => {})
    // Ledger onAppended can re-enter: the inner commit's service callback (seq 4)
    // returns before the outer commit reaches its own callback (seq 3).
    client.applyProjection({
      generation: 2,
      ledgerCursor: 4,
      changes: [{ seq: 4, entity: 'session', id: 'inner', op: 'remove' }],
    })
    client.applyProjection({
      generation: 3,
      ledgerCursor: 3,
      changes: [{ seq: 3, entity: 'session', id: 'outer', op: 'remove' }],
    })
    void client.request({ view: view('target'), sinceCursor: null })

    const patch = worker.sent.find(
      (command): command is Extract<PublishWorkerCommand, { type: 'patch' }> =>
        command.type === 'patch',
    )
    expect(patch?.event).toMatchObject({
      generation: 3,
      ledgerCursor: 4,
      changes: [{ seq: 3 }, { seq: 4 }],
    })
    client.stop()
  })

  it('runs the focused ViewKey before queued background views', async () => {
    const worker = fakeWorker()
    const client = new PublishWorkerClient({ spawn: () => worker })
    client.replaceProjection({ generation: 1, ledgerCursor: 1, sessions: [session('s1')] })

    const first = client.request({ view: view('first'), sinceCursor: null }, { focused: false })
    const background = client.request(
      { view: view('background'), sinceCursor: null },
      { focused: false },
    )
    const focused = client.request({ view: view('focused'), sinceCursor: null }, { focused: true })

    expect(prepareCommands(worker).map((command) => command.input.view.key)).toEqual([
      view('first').key,
    ])
    reply(worker, prepareCommand(worker, 0))
    await first
    expect(prepareCommands(worker).map((command) => command.input.view.key)).toEqual([
      view('first').key,
      view('focused').key,
    ])
    reply(worker, prepareCommand(worker, 1))
    await focused
    expect(prepareCommands(worker).map((command) => command.input.view.key)).toEqual([
      view('first').key,
      view('focused').key,
      view('background').key,
    ])
    reply(worker, prepareCommand(worker, 2))
    await background
    client.stop()
  })

  it('drops a queued same-ViewKey job when a newer view revision supersedes it', async () => {
    const worker = fakeWorker()
    const client = new PublishWorkerClient({ spawn: () => worker })
    client.replaceProjection({ generation: 1, ledgerCursor: 1, sessions: [session('s1')] })

    const blocker = client.request({ view: view('blocker'), sinceCursor: null })
    const stale = client.request({ view: view('target', 1), sinceCursor: null })
    const current = client.request({ view: view('target', 2), sinceCursor: null })
    await expect(stale).rejects.toBeInstanceOf(PublicationSupersededError)

    reply(worker, prepareCommand(worker, 0))
    await blocker
    expect(prepareCommands(worker)[1]?.input.view.revision).toBe(2)
    reply(worker, prepareCommand(worker, 1))
    await current
    expect(client.metrics().coalescedJobs).toBe(1)
    expect(client.metrics().supersededJobs).toBe(1)
    client.stop()
  })

  it('discards an in-flight result after that ViewKey changes and builds the replacement', async () => {
    const worker = fakeWorker()
    const client = new PublishWorkerClient({ spawn: () => worker })
    client.replaceProjection({ generation: 1, ledgerCursor: 1, sessions: [session('s1')] })

    const stale = client.request({ view: view('target', 1), sinceCursor: null })
    const staleCommand = prepareCommand(worker, 0)
    const current = client.request({ view: view('target', 2), sinceCursor: null })
    await expect(stale).rejects.toBeInstanceOf(PublicationSupersededError)

    reply(worker, staleCommand)
    expect(prepareCommands(worker)[1]?.input.view.revision).toBe(2)
    reply(worker, prepareCommand(worker, 1))
    await expect(current).resolves.toMatchObject({ viewRevision: 2 })
    client.stop()
  })

  it('restarts after a crash and resets the new worker from main-owned projection state', async () => {
    const workers = [fakeWorker(), fakeWorker()]
    let spawnIndex = 0
    const client = new PublishWorkerClient({
      spawn: () => spawnedWorker(workers, spawnIndex++),
    })
    const changes: MetadataChange[] = [
      { seq: 1, entity: 'session', id: 's1', op: 'upsert', value: session('s1') },
    ]
    client.applyProjection({ generation: 1, ledgerCursor: 1, changes })

    const crashed = client.request({ view: view('target'), sinceCursor: null })
    spawnedWorker(workers, 0).emit('exit', 1)
    await expect(crashed).rejects.toThrow(/exited 1/)

    const recovered = client.request({ view: view('target'), sinceCursor: null })
    expect(spawnedWorker(workers, 1).sent[0]).toMatchObject({
      type: 'reset',
      state: { generation: 1, ledgerCursor: 1, sessions: [{ sessionId: 's1' }] },
    })
    const recoveredWorker = spawnedWorker(workers, 1)
    reply(recoveredWorker, prepareCommand(recoveredWorker, 0))
    await recovered
    expect(client.metrics().failures).toBe(1)
    client.stop()
  })

  it('times out a stuck job, rejects it, and respawns for later work', async () => {
    vi.useFakeTimers()
    try {
      const workers = [fakeWorker(), fakeWorker()]
      let spawnIndex = 0
      const client = new PublishWorkerClient({
        spawn: () => spawnedWorker(workers, spawnIndex++),
        timeoutMs: 25,
      })
      client.replaceProjection({ generation: 1, ledgerCursor: 1, sessions: [session('s1')] })
      const stuck = client.request({ view: view('stuck'), sinceCursor: null })
      await vi.advanceTimersByTimeAsync(25)
      await expect(stuck).rejects.toThrow(/timed out/)

      const next = client.request({ view: view('next'), sinceCursor: null })
      expect(spawnIndex).toBe(2)
      const respawned = spawnedWorker(workers, 1)
      reply(respawned, prepareCommand(respawned, 0))
      await next
      client.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
