import type {
  GrokAcpJournalEntry,
  GrokAcpRuntimeHost,
  GrokAcpTransport,
} from '@podium/harness/driver/host'
import type { SessionId } from '@podium/model'
import type {
  DurableAdapter,
  DurableProcess,
  HeadlessAttachOptions,
  HeadlessSpawnOptions,
  HostAgentSession,
} from '@podium/process/durable'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { asSessionId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createGrokAcpHost,
  GrokEngineLeaseRefused,
  grokAcpProcessKey,
  grokAcpVersionProbe,
  resetGrokAcpVersionProbe,
} from './grok-acp-server'
import { createDaemonGrokRuntime } from './grok-driver'
import { availableDriverIds } from './registry'

afterEach(() => resetGrokAcpVersionProbe())

function adoptionWorld(options: { deferStop?: boolean; deferLoad?: boolean } = {}) {
  const entries = new Map<SessionId, GrokAcpJournalEntry>()
  const requests: Array<{ method?: string; params?: Record<string, unknown> }> = []
  const stopWaiters: Array<() => void> = []
  const loadReplies: Array<{ respond(payload: Record<string, unknown>): void }> = []
  const childCloses: Array<() => void> = []
  const sent: DaemonMessage[] = []
  let deferLoad = options.deferLoad ?? false
  let launches = 0

  const host: GrokAcpRuntimeHost = {
    journal: {
      read: (sessionId) => entries.get(sessionId),
      write: (entry) => void entries.set(entry.sessionId, entry),
      clear: (sessionId) => void entries.delete(sessionId),
    },
    now: () => 1_786_700_000_000,
    mintSessionId: () => 'grok-minted' as SessionId,
    async launch(input) {
      launches += 1
      let handler: { line(line: string): void; closed(): void } | undefined
      const transport: GrokAcpTransport = {
        write(line) {
          const frame = JSON.parse(line) as {
            id?: string | number
            method?: string
            params?: Record<string, unknown>
          }
          requests.push(frame)
          if (frame.id === undefined || !frame.method) return
          const respond = (payload: Record<string, unknown>) =>
            handler?.line(JSON.stringify({ jsonrpc: '2.0', id: frame.id, ...payload }))
          if (frame.method === 'session/load' && deferLoad) {
            loadReplies.push({ respond })
            return
          }
          const result =
            frame.method === 'initialize'
              ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
              : frame.method === 'session/load'
                ? { sessionId: frame.params?.sessionId }
                : {}
          respond({ result })
        },
        onLine(next) {
          handler = next
        },
        close() {},
      }
      childCloses.push(() => handler?.closed())
      return {
        transport,
        process: { key: grokAcpProcessKey(input.sessionId), pid: 10_000 + launches },
        stop: options.deferStop
          ? () => new Promise<void>((resolve) => void stopWaiters.push(resolve))
          : async () => {},
        kill: async () => {},
        resources: () => undefined,
        alive: () => true,
      }
    },
  }
  const runtime = createDaemonGrokRuntime({ send: (message) => sent.push(message), host })
  return {
    entries,
    requests,
    runtime,
    sent,
    launches: () => launches,
    crashLatest: () => childCloses.at(-1)?.(),
    releaseStops: () => stopWaiters.splice(0).forEach((resolve) => resolve()),
    setLoadDeferred: (deferred: boolean) => {
      deferLoad = deferred
    },
    resolveLoads: () =>
      loadReplies
        .splice(0)
        .forEach(({ respond }) => respond({ result: { sessionId: 'native-grok-resurrecting' } })),
    rejectLoads: () =>
      loadReplies
        .splice(0)
        .forEach(({ respond }) =>
          respond({ error: { code: -32_000, message: 'session/load timed out' } }),
        ),
  }
}

function journalEntry(
  sessionId: SessionId,
  processKey = grokAcpProcessKey(sessionId),
): GrokAcpJournalEntry {
  return {
    sessionId,
    grokSessionId: `native-${sessionId}`,
    workdir: '/work/grok',
    process: { key: processKey },
    providerEventSeq: 42,
    seq: 51,
    turnEpoch: 3,
    bindingVersion: 1,
  }
}

describe('Grok ACP daemon restart adoption', () => {
  it('refuses a persisted journal entry naming another incarnation', async () => {
    const world = adoptionWorld()
    const sessionId = 'grok-mismatch' as SessionId
    world.entries.set(sessionId, journalEntry(sessionId, grokAcpProcessKey('other' as SessionId)))

    expect(await world.runtime.adoptFromJournal(sessionId)).toBeUndefined()
    expect(world.launches()).toBe(0)
    expect(world.requests).toEqual([])
    world.runtime.dispose()
  })

  it('launches a fresh child and resumes the exact native session with session/load', async () => {
    const world = adoptionWorld()
    const sessionId = 'grok-restarted' as SessionId
    world.entries.set(sessionId, journalEntry(sessionId))

    const handle = await world.runtime.adoptFromJournal(sessionId)
    expect(handle).toBeDefined()
    expect(world.launches()).toBe(1)
    expect(world.requests).toContainEqual(
      expect.objectContaining({
        method: 'session/load',
        params: expect.objectContaining({
          sessionId: `native-${sessionId}`,
          cwd: '/work/grok',
          mcpServers: [],
        }),
      }),
    )
    expect(handle?.binding).toMatchObject({
      sessionId,
      resume: { kind: 'grok-session', value: `native-${sessionId}` },
      bindingVersion: 2,
      process: { key: grokAcpProcessKey(sessionId) },
    })
    expect(world.runtime.has(sessionId)).toBe(true)
    world.runtime.dispose()
  })

  it('carries the dead Grok handle generation on agentExit', async () => {
    const world = adoptionWorld()
    const sessionId = 'grok-exit-generation' as SessionId
    world.entries.set(sessionId, journalEntry(sessionId))

    const handle = await world.runtime.adoptFromJournal(sessionId)
    expect(handle).toBeDefined()
    const generation = (await handle?.snapshot())?.observerGeneration
    expect(generation).toEqual(expect.any(Number))
    if (generation === undefined) throw new Error('Grok handle was not generation-fenced')

    world.crashLatest()

    await vi.waitFor(() =>
      expect(world.sent).toContainEqual({
        type: 'agentExit',
        sessionId,
        code: 0,
        observerGeneration: generation,
      }),
    )
    world.runtime.dispose()
  })

  it('`has` follows the handle map, so a lifecycle kill drops the bind fact (POD-2249)', async () => {
    // Pins the removal of the parallel `live` Set, which survived the lifecycle
    // verbs and kept reporting a parked session as behind the contract.
    const world = adoptionWorld()
    const sessionId = 'grok-parked' as SessionId
    world.entries.set(sessionId, journalEntry(sessionId))

    const handle = await world.runtime.adoptFromJournal(sessionId)
    expect(handle).toBeDefined()
    expect(world.runtime.has(sessionId)).toBe(true)

    await handle?.kill()
    expect(world.runtime.has(sessionId)).toBe(false)
    expect(world.runtime.handleFor(sessionId)).toBeUndefined()
    world.runtime.dispose()
  })

  it('a resurrection binds only after its journalled conversation is ready while the parked child stops', async () => {
    const world = adoptionWorld({ deferStop: true })
    const sessionId = 'grok-resurrecting' as SessionId
    world.entries.set(sessionId, journalEntry(sessionId))

    const parked = await world.runtime.adoptFromJournal(sessionId)
    expect(parked).toBeDefined()

    // The server parks its row before daemon teardown settles. The replacement
    // spawn can arrive in this exact window, so the disposed handle must already
    // be absent from the runtime's live ownership index.
    const stopping = parked?.stop()
    expect(world.runtime.has(sessionId)).toBe(false)

    // `session/load` is the provider readiness boundary. Until it answers the
    // daemon's adoption promise remains pending, so its caller cannot emit the
    // `bind` frame that durably promotes the server row to live.
    world.setLoadDeferred(true)
    let ready = false
    const resurrection = world.runtime.adoptFromJournal(sessionId).then((handle) => {
      ready = true
      return handle
    })
    await vi.waitFor(() =>
      expect(world.requests.filter((request) => request.method === 'session/load')).toHaveLength(2),
    )
    expect(ready).toBe(false)

    world.resolveLoads()
    const resurrected = await resurrection
    expect(resurrected).toBeDefined()
    expect(resurrected?.binding).toMatchObject({
      sessionId,
      resume: { kind: 'grok-session', value: `native-${sessionId}` },
      bindingVersion: 3,
    })

    // Finishing the old stop must not delete the replacement registered under
    // the same Podium session id.
    world.releaseStops()
    await stopping
    expect(world.runtime.handleFor(sessionId)).toBe(resurrected)
    expect(world.runtime.has(sessionId)).toBe(true)
    expect(
      world.requests.filter(
        (request) =>
          request.method === 'session/load' && request.params?.sessionId === `native-${sessionId}`,
      ),
    ).toHaveLength(2)
    world.runtime.dispose()
  })

  it('a failed or timed-out journal load releases its provisional handle and remains retryable', async () => {
    const world = adoptionWorld({ deferLoad: true })
    const sessionId = 'grok-load-failure' as SessionId
    world.entries.set(sessionId, journalEntry(sessionId))

    const failed = world.runtime.adoptFromJournal(sessionId)
    await vi.waitFor(() =>
      expect(world.requests.some((request) => request.method === 'session/load')).toBe(true),
    )
    world.rejectLoads()

    await expect(failed).resolves.toBeUndefined()
    expect(world.runtime.has(sessionId)).toBe(false)
    expect(world.runtime.handleFor(sessionId)).toBeUndefined()
    expect(world.entries.get(sessionId)?.grokSessionId).toBe(`native-${sessionId}`)

    world.setLoadDeferred(false)
    const retried = await world.runtime.adoptFromJournal(sessionId)
    expect(retried?.binding).toMatchObject({
      sessionId,
      resume: { kind: 'grok-session', value: `native-${sessionId}` },
      // The failed attempt consumed version 2 before provider readiness. A
      // retry must advance past that stale generation rather than reuse it.
      bindingVersion: 3,
    })
    world.runtime.dispose()
  })
})

describe('Grok ACP daemon gate', () => {
  it('admits a supported binary into driver selection', async () => {
    await expect(
      grokAcpVersionProbe(() => ({ ok: true, output: 'grok 0.2.118' })),
    ).resolves.toEqual({
      drivable: true,
    })
    expect(availableDriverIds({ opencodeDrivable: false, grokDrivable: true })).toContain(
      'grok-acp',
    )
  })

  it('temporarily memoizes an unprobeable result', async () => {
    let calls = 0
    const first = await grokAcpVersionProbe(() => {
      calls += 1
      return { ok: false, output: 'timed out' }
    })
    const second = await grokAcpVersionProbe(() => {
      calls += 1
      return { ok: true, output: 'grok 0.2.118' }
    })
    expect(first).toMatchObject({ drivable: true, reason: 'unprobeable' })
    expect(second).toMatchObject({ drivable: true, reason: 'unprobeable' })
    expect(calls).toBe(1)
  })

  it('memoizes a definitive unsupported version', async () => {
    let calls = 0
    const probe = () => {
      calls += 1
      return { ok: true, output: 'grok 0.2.22' }
    }
    await expect(grokAcpVersionProbe(probe)).resolves.toMatchObject({
      drivable: false,
      reason: 'unsupported',
    })
    await expect(grokAcpVersionProbe(probe)).resolves.toMatchObject({ reason: 'unsupported' })
    expect(calls).toBe(1)
  })
})

describe('Grok ACP headless engine (POD-4433)', () => {
  const SESSION = asSessionId('22222222-2222-4222-8222-222222222222')

  /** A host attachment the test drives by hand. */
  function fakeEngineSession(input: { childPid?: number; lease?: boolean } = {}): {
    session: HostAgentSession
    written: string[]
    dataListeners: Array<(seq: bigint, data: Buffer) => void>
    exits: Array<(code: number, signal: number) => void>
  } {
    const written: string[] = []
    const dataListeners: Array<(seq: bigint, data: Buffer) => void> = []
    const exits: Array<(code: number, signal: number) => void> = []
    const session = {
      ready: Promise.resolve({
        version: 1,
        hostPid: 111,
        childPid: input.childPid ?? 4242,
        hasPty: false,
        cols: 0,
        rows: 0,
        seqLow: 0n,
        seqHigh: 0n,
        lease: input.lease ?? true,
      }),
      connection: {
        onData: (cb: (seq: bigint, data: Buffer) => void) => {
          dataListeners.push(cb)
          return () => {}
        },
        onExit: (cb: (code: number, signal: number) => void) => {
          exits.push(cb)
          return () => {}
        },
        write: async (data: Uint8Array) => {
          written.push(Buffer.from(data).toString('utf8'))
          return data.byteLength
        },
        signal: () => {},
      },
      dispose: () => {},
    } as unknown as HostAgentSession
    return { session, written, dataListeners, exits }
  }

  function fakeEngineDurable(hooks: {
    spawnHeadless?: (opts: HeadlessSpawnOptions) => Promise<HostAgentSession>
  }): DurableProcess {
    const adapter: DurableAdapter = {
      kind: 'host',
      spawn: () => Promise.reject(new Error('terminal spawn is not under test')),
      spawnHeadless:
        hooks.spawnHeadless ?? (() => Promise.reject(new Error('unexpected spawnHeadless'))),
      attachHeadless: () => Promise.reject(new Error('no engine host answers')),
      attach: () => Promise.reject(new Error('terminal attach is not under test')),
      has: async () => false,
      kill: async () => {},
      list: async () => [],
      socketPath: async () => undefined,
      waitForSocket: () => Promise.reject(new Error('unused')),
      hasMasterSync: () => false,
      attachCommand: (target: string) => target,
    }
    return {
      backend: 'host',
      primary: adapter,
      all: [adapter],
      spawn: (opts) => adapter.spawn(opts),
      spawnHeadless: (opts) => adapter.spawnHeadless(opts),
      attachHeadless: (opts: HeadlessAttachOptions) => adapter.attachHeadless(opts),
      locate: async () => undefined,
      has: (label) => adapter.has(label),
      kill: (label) => adapter.kill(label),
      list: () => adapter.list(),
      hasMasterSync: (label, env) => adapter.hasMasterSync(label, env),
    }
  }

  function launchHost(hooks: {
    spawnHeadless?: (opts: HeadlessSpawnOptions) => Promise<HostAgentSession>
  }) {
    return createGrokAcpHost({
      resources: () => undefined,
      durable: fakeEngineDurable(hooks),
    })
  }

  async function primeProbe(): Promise<void> {
    resetGrokAcpVersionProbe()
    await expect(
      grokAcpVersionProbe(() => ({ ok: true, output: 'grok 0.2.23' })),
    ).resolves.toMatchObject({ drivable: true })
  }

  it('spawns grok stdio headless under the session label, without argv secrets', async () => {
    await primeProbe()
    const launched: HeadlessSpawnOptions[] = []
    const { session } = fakeEngineSession()
    const host = launchHost({
      spawnHeadless: async (opts) => {
        launched.push(opts)
        return session
      },
    })
    const endpoint = await host.launch({ sessionId: SESSION, workdir: '/tmp' })
    expect(launched).toHaveLength(1)
    expect(launched[0]).toMatchObject({
      label: grokAcpProcessKey(SESSION),
      cmd: 'grok',
      args: ['agent', 'stdio'],
      cwd: '/tmp',
    })
    expect(launched[0]?.stripEnv).toContain('XAI_API_KEY')
    expect(endpoint.process.key).toBe(grokAcpProcessKey(SESSION))
    expect(endpoint.alive()).toBe(true)
  })

  it('carries ACP stdio over the host attachment: writes reach stdin, stdout lines reach the driver', async () => {
    await primeProbe()
    const rig = fakeEngineSession()
    const host = launchHost({ spawnHeadless: async () => rig.session })
    const endpoint = await host.launch({ sessionId: SESSION, workdir: '/tmp' })
    const lines: string[] = []
    let closed = 0
    endpoint.transport.onLine({ line: (line) => void lines.push(line), closed: () => void closed++ })
    endpoint.transport.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n')
    expect(rig.written).toEqual(['{"jsonrpc":"2.0","id":1,"method":"initialize"}\n'])
    for (const listener of rig.dataListeners) {
      listener(0n, Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","method":"m"}\n'))
    }
    expect(lines).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}', '{"jsonrpc":"2.0","method":"m"}'])
    expect(closed).toBe(0)
    // The engine's end arrives through the host's EXITED frame.
    for (const fire of rig.exits) fire(1, 0)
    expect(closed).toBe(1)
    expect(endpoint.alive()).toBe(false)
    expect(endpoint.engineExit?.()).toEqual({ code: 1, signal: 0 })
  })

  it('a writer lease held elsewhere refuses loudly', async () => {
    await primeProbe()
    const { session } = fakeEngineSession({ lease: false })
    const host = launchHost({ spawnHeadless: async () => session })
    await expect(host.launch({ sessionId: SESSION, workdir: '/tmp' })).rejects.toBeInstanceOf(
      GrokEngineLeaseRefused,
    )
  })

  it('closing the transport drops the channel without ending the engine', async () => {
    await primeProbe()
    const rig = fakeEngineSession()
    const host = launchHost({ spawnHeadless: async () => rig.session })
    const endpoint = await host.launch({ sessionId: SESSION, workdir: '/tmp' })
    let closed = 0
    endpoint.transport.onLine({ line: () => {}, closed: () => void closed++ })
    endpoint.transport.close()
    // Late writes are gated, the engine is untouched: stop/kill still own it.
    endpoint.transport.write('{"late":true}\n')
    expect(rig.written).toEqual([])
    expect(closed).toBe(0)
    expect(endpoint.alive()).toBe(true)
    expect(endpoint.engineExit?.()).toBeUndefined()
  })
})
