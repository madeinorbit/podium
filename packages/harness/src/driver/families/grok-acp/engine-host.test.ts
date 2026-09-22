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
import type { GrokAcpJournalEntry } from './runtime.js'

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
