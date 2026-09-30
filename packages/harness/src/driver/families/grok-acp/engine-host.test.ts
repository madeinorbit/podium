/**
 * THE GROK ENGINE HOST (moved from apps/daemon/src/runtime/grok-acp-server.test.ts
 * in 1.5 with the code it pins).
 *
 * The family is handed its engine through injected supervision ports and never
 * spawns, journals or kills: the fakes below stand in for the supervisor's
 * durable process, and every harness-shaped value (argv stems, scope tokens,
 * strip lists) is read off the adapter's sections through the facts.
 */

import { asSessionId } from '@podium/model'
import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { grokEngineFacts } from './engine-facts.js'
import { manifestFor } from '../../../registry.js'
import {
  type GrokEngineHostDeps,
  createGrokEngineHost,
  evaluateGrokAcpVersionProbe,
  GrokEngineLeaseRefused,
  grokAcpProcessKey,
} from './engine-host.js'
import type {
  EngineAttachment,
  EngineProcessOwner,
  EngineSupervisor,
  SessionEngineOwner,
} from '../engine-supervision.js'
import { createTestEngineOwner } from '../../testing/binding-records.js'
import { createMemoryDriverSlots } from '../../testing/index.js'
import { isDriverRefusal } from '../../errors.js'
import type { GrokAcpJournalEntry, GrokAcpRuntimeHost } from './runtime.js'
import { createGrokAcpRuntime } from './runtime.js'
import { startFakeGrokAcpServer } from './test-support/fake-acp-server.js'
import type { SessionId } from '@podium/model'

const FACTS = grokEngineFacts(manifestFor('grok')!)

function engineHost(extra: Partial<GrokEngineHostDeps> = {}) {
  return createGrokEngineHost({
    facts: FACTS,
    resources: () => undefined,
    buildEnv: () => ({}),
    gracefulExitMs: 1,
    checkVersion: async () => ({ drivable: true as const }),
    ...extra,
  })
}

describe('the version gate', () => {
  it('admits a supported binary', () => {
    expect(evaluateGrokAcpVersionProbe('grok 0.2.118', true)).toEqual({
      drivable: true,
    })
  })

  it('REFUSES an out-of-range grok with a machine-readable diagnostic', () => {
    const verdict = evaluateGrokAcpVersionProbe('grok 0.2.22', true)
    expect(verdict.drivable).toBe(false)
    if (verdict.drivable) return
    expect(verdict.reason).toBe('unsupported')
    expect(verdict.diagnostic.code).toBe('grok-version-too-old')
    expect(verdict.diagnostic.observedVersion).toBe('grok 0.2.22')
  })

  it('admits failed probes and retains a retryable notice', () => {
    const verdict = evaluateGrokAcpVersionProbe('timed out', false)
    expect(verdict).toMatchObject({ drivable: true, reason: 'unprobeable' })
    expect(verdict.diagnostic?.body).toContain('probe may have timed out')
  })
})

describe('headless engine lifecycle (POD-4433)', () => {
  const SESSION = asSessionId('22222222-2222-4222-8222-222222222222')

  /** A supervision attachment the test drives by hand. */
  function fakeEngineSession(input: { childPid?: number; lease?: boolean } = {}): {
    session: EngineAttachment
    written: string[]
    dataListeners: Array<(seq: bigint, data: Buffer) => void>
    exits: Array<(code: number, signal: number) => void>
  } {
    const written: string[] = []
    const dataListeners: Array<(seq: bigint, data: Buffer) => void> = []
    const exits: Array<(code: number, signal: number) => void> = []
    const session: EngineAttachment = {
      ready: Promise.resolve({
        lease: input.lease ?? true,
        childPid: input.childPid ?? 4242,
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
    }
    return { session, written, dataListeners, exits }
  }

  /**
   * Both ports the family consumes, built from one set of hooks: the
   * session-owned process verbs (`engines`) carry the behavior under test,
   * while the scope port (`supervision`) answers nothing on this platform.
   * Spread at the call site: `...fakePorts({ startEngine: ... })`.
   */
  function fakePorts(hooks: {
    startEngine?: (opts: {
      label: string
      cmd: string
      args: string[]
      cwd: string
      env: Record<string, string>
      stripEnv: readonly string[]
    }) => Promise<EngineAttachment>
  }): {
    supervision: Pick<EngineSupervisor, 'scopeUnitFor'>
    engines: SessionEngineOwner<GrokAcpJournalEntry>
  } {
    return {
      supervision: { scopeUnitFor: () => undefined },
      engines: createTestEngineOwner<GrokAcpJournalEntry>(
        hooks.startEngine ? { startEngine: hooks.startEngine } : {},
      ),
    }
  }

  it('spawns grok stdio headless under the session label, without argv secrets', async () => {
    const launched: Array<Parameters<EngineProcessOwner['startEngine']>[0]> = []
    const { session } = fakeEngineSession()
    const host = engineHost({
      ...fakePorts({
        startEngine: async (opts) => {
          launched.push(opts)
          return session
        },
      }),
    })
    const endpoint = await host.launch({ sessionId: SESSION, workdir: '/tmp' })
    expect(launched).toHaveLength(1)
    expect(launched[0]).toMatchObject({
      label: grokAcpProcessKey(FACTS, SESSION),
      cmd: 'grok',
      args: ['agent', 'stdio'],
      cwd: '/tmp',
    })
    expect(launched[0]?.stripEnv).toContain('XAI_API_KEY')
    expect(launched[0]?.stripEnv).toEqual(expect.arrayContaining([...FACTS.stripEnv]))
    expect(endpoint.process.key).toBe(grokAcpProcessKey(FACTS, SESSION))
    expect(endpoint.alive()).toBe(true)
  })

  it('carries ACP stdio over the host attachment: writes reach stdin, stdout lines reach the driver', async () => {
    const rig = fakeEngineSession()
    const host = engineHost({
      ...fakePorts({ startEngine: async () => rig.session }),
    })
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
    const { session } = fakeEngineSession({ lease: false })
    const host = engineHost({
      ...fakePorts({ startEngine: async () => session }),
    })
    await expect(host.launch({ sessionId: SESSION, workdir: '/tmp' })).rejects.toBeInstanceOf(
      GrokEngineLeaseRefused,
    )
  })

  it('closing the transport drops the channel without ending the engine', async () => {
    const rig = fakeEngineSession()
    const host = engineHost({
      ...fakePorts({ startEngine: async () => rig.session }),
    })
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

describe('readHistory — the Store read over updates.jsonl', () => {
  const GROK_SESSION = '019ffd6d-f4c8-7c23-90bd-96cd86e783e9'
  const SESSION = asSessionId('55555555-5555-4555-8555-555555555555')
  const CWD = '/tmp/grok-history-probe'

  /** One user turn and its assistant reply, in the real `updates.jsonl` record
   *  format: Grok's history is read from the file it only appends to (POD-4875). */
  const writeUpdates = (path: string): void => {
    const update = (sessionUpdate: string, text: string, ms: number) => ({
      timestamp: Math.floor(ms / 1000),
      method: 'session/update',
      params: {
        sessionId: GROK_SESSION,
        update: { sessionUpdate, content: { type: 'text', text } },
        _meta: { agentTimestampMs: ms },
      },
    })
    const lines = [
      update('user_message_chunk', 'hello from disk', Date.UTC(2026, 8, 28, 10, 0, 1)),
      update('agent_message_chunk', 'reply from disk', Date.UTC(2026, 8, 28, 10, 0, 5)),
    ]
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  }

  const updatesPathFor = async (home: string): Promise<string> => {
    const { grokSessionPaths } = await import('../../../adapters/grok/instrumentation.js')
    return grokSessionPaths({ cwd: CWD, sessionId: GROK_SESSION, homeDir: home }).updatesPath
  }

  const sessionFor = () => ({
    sessionId: SESSION,
    agentKind: 'grok' as const,
    cwd: CWD,
    resume: { kind: 'grok-session' as const, value: GROK_SESSION },
  })

  it('reads the user turn and assistant reply from disk', async () => {
    // THE PRODUCTION READER, against a real file: the driver's history
    // delegates here, so this is the half the conformance suite cannot see
    // (that suite supplies its own readHistory over the fake's frames).
    const home = mkdtempSync(join(tmpdir(), 'pod-4782-gk-hist-'))
    try {
      writeUpdates(await updatesPathFor(home))
      const host = engineHost({ homeDir: home })
      const page = await host.readHistory(sessionFor(), { limit: 50 })
      expect(page.items.map((item) => [item.role, item.text])).toEqual([
        ['user', 'hello from disk'],
        ['assistant', 'reply from disk'],
      ])
      expect(page.hasMore).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("pages older items through the returned cursor ('before' limit 1, then head)", async () => {
    const home = mkdtempSync(join(tmpdir(), 'pod-4782-gk-page-'))
    try {
      writeUpdates(await updatesPathFor(home))
      const host = engineHost({ homeDir: home })
      const newest = await host.readHistory(sessionFor(), { limit: 1 })
      expect(newest.items.map((item) => item.text)).toEqual(['reply from disk'])
      expect(newest.hasMore).toBe(true)
      expect(newest.head).toBeDefined()
      const earlier = await host.readHistory(sessionFor(), {
        from: newest.head,
        limit: 10,
      })
      expect(earlier.items.map((item) => item.text)).toEqual(['hello from disk'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('a session with no chat history file yet reads as an empty page, not an error', async () => {
    // Grok creates `updates.jsonl` on its first turn. History before
    // that is empty — the slice layer returns empty for a missing chain or
    // file, so no existence check is needed here beyond what the Store
    // already does.
    const home = mkdtempSync(join(tmpdir(), 'pod-4782-gk-empty-'))
    try {
      const host = engineHost({ homeDir: home })
      const page = await host.readHistory(sessionFor(), { limit: 50 })
      expect(page).toEqual({ items: [], hasMore: false })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('refuses a foreign history cursor instead of reading another session', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pod-4782-gk-cursor-'))
    try {
      writeUpdates(await updatesPathFor(home))
      const host = engineHost({ homeDir: home })
      const session = sessionFor()
      await expect(
        host.readHistory(session, {
          from: { segmentId: 'history:someone-else:other', pathHint: 'x', components: {} },
          limit: 10,
        }),
      ).rejects.toSatisfy((err: unknown) => isDriverRefusal(err) && err.refusal.reason === 'invalid_value')
      // Same segment but no anchor is equally foreign: cursors are opaque.
      const own = await host.readHistory(session, { limit: 50 })
      expect(own.head).toBeDefined()
      await expect(
        host.readHistory(session, {
          from: { segmentId: own.head!.segmentId, components: {} },
          limit: 10,
        }),
      ).rejects.toSatisfy((err: unknown) => isDriverRefusal(err) && err.refusal.reason === 'invalid_value')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('history after a simulated daemon restart (fresh host, same files) equals history before it', async () => {
    // THE DAEMON-RESTART PROMISE: the driver's in-memory copy dies with the
    // process, the file does not. A fresh host over the same HOME must read
    // back exactly what the pre-restart host read.
    const home = mkdtempSync(join(tmpdir(), 'pod-4782-gk-restart-'))
    try {
      writeUpdates(await updatesPathFor(home))
      const before = await engineHost({ homeDir: home }).readHistory(sessionFor(), { limit: 50 })
      expect(before.items).toHaveLength(2)
      // Fresh driver generation: new host object, same files on disk.
      const after = await engineHost({ homeDir: home }).readHistory(sessionFor(), { limit: 50 })
      expect(after.items).toEqual(before.items)
      expect(after.items.map((item) => [item.role, item.text])).toEqual([
        ['user', 'hello from disk'],
        ['assistant', 'reply from disk'],
      ])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('driver history after a simulated daemon restart (fresh driver, same files) equals history before it', async () => {
    // THROUGH THE DRIVER, not just the host: both generations delegate to
    // the Store port over the same `updates.jsonl`, so neither reads
    // the live process (whose fake holds no conversation at all). A driver
    // regressed to its in-memory copy would read empty here and go red.
    const home = mkdtempSync(join(tmpdir(), 'pod-4782-gk-drv-restart-'))
    try {
      writeUpdates(await updatesPathFor(home))
      const makeDriverHost = (
        prod: ReturnType<typeof engineHost>,
        entries: Map<SessionId, GrokAcpJournalEntry>,
        seq: { n: number },
      ): GrokAcpRuntimeHost => ({
        bindings: {
          recorded: (id) => entries.get(id),
          bound: (entry) => void entries.set(entry.sessionId, entry),
          released: (id) => void entries.delete(id),
        },
        now: () => Date.UTC(2026, 8, 28) + ++seq.n * 1000,
        mintSessionId: () => `gk-restart-${++seq.n}` as SessionId,
        readHistory: (session, range) => prod.readHistory(session, range),
        async launch(input) {
          const server = startFakeGrokAcpServer(GROK_SESSION)
          return {
            transport: server.transport,
            process: { key: `podium-gk-${input.sessionId}` },
            stop: async () => server.crash(),
            kill: async () => server.crash(),
            resources: () => undefined,
            alive: () => server.alive,
          }
        },
      })
      const spec = () => ({
        harness: 'grok' as const,
        selection: {
          auth: 'subscription' as const,
          platform: 'linux' as const,
          available: ['grok-acp' as const],
          preference: 'grok-acp' as const,
        },
        workdir: CWD,
        model: {},
        instructions: { supported: false as const, reason: 'fixture' },
        mcpServers: { supported: false as const, reason: 'fixture' },
      })
      const seq1 = { n: 0 }
      const entries1 = new Map<SessionId, GrokAcpJournalEntry>()
      const prod1 = engineHost({ homeDir: home })
      const runtime1 = createGrokAcpRuntime(makeDriverHost(prod1, entries1, seq1), createMemoryDriverSlots())
      const handle1 = await runtime1.driver.create(spec())
      try {
        const before = await handle1.transcript.history({ limit: 50 })
        expect(before.items.map((item) => [item.role, item.text])).toEqual([
          ['user', 'hello from disk'],
          ['assistant', 'reply from disk'],
        ])
        // Simulate the daemon restart: drop the whole runtime, keep the files.
        runtime1.dispose()
        const seq2 = { n: 100 }
        const entries2 = new Map<SessionId, GrokAcpJournalEntry>()
        const prod2 = engineHost({ homeDir: home })
        const runtime2 = createGrokAcpRuntime(makeDriverHost(prod2, entries2, seq2), createMemoryDriverSlots())
        try {
          const handle2 = await runtime2.driver.create(spec())
          const after = await handle2.transcript.history({ limit: 50 })
          expect(after.items).toEqual(before.items)
        } finally {
          runtime2.dispose()
        }
      } finally {
        // runtime1 already disposed above; disposing twice is safe.
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
