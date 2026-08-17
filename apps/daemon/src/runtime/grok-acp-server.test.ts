import type {
  GrokAcpJournalEntry,
  GrokAcpRuntimeHost,
  GrokAcpTransport,
} from '@podium/agent-runtime'
import type { SessionId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { DaemonContext } from '../control/context'
import { serverDriverAdoptionCandidates } from '../control/session'
import { grokAcpProcessKey, grokAcpVersionProbe, resetGrokAcpVersionProbe } from './grok-acp-server'
import { createDaemonGrokRuntime } from './grok-driver'
import { availableDriverIds } from './registry'

afterEach(() => resetGrokAcpVersionProbe())

function adoptionWorld() {
  const entries = new Map<SessionId, GrokAcpJournalEntry>()
  const requests: Array<{ method?: string; params?: Record<string, unknown> }> = []
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
          const result =
            frame.method === 'initialize'
              ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
              : frame.method === 'session/load'
                ? { sessionId: frame.params?.sessionId }
                : {}
          handler?.line(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }))
        },
        onLine(next) {
          handler = next
        },
        close() {},
      }
      return {
        transport,
        process: { key: grokAcpProcessKey(input.sessionId), pid: 10_000 + launches },
        stop: async () => {},
        kill: async () => {},
        memoryBytes: () => undefined,
        alive: () => true,
      }
    },
  }
  const runtime = createDaemonGrokRuntime({ send: () => {}, host })
  return { entries, requests, runtime, launches: () => launches }
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
})

describe('Grok ACP daemon gate', () => {
  it('admits a supported binary into driver selection', () => {
    expect(grokAcpVersionProbe(() => ({ ok: true, output: 'grok 1.0.3' }))).toEqual({
      drivable: true,
    })
    expect(availableDriverIds({ opencodeDrivable: false, grokDrivable: true })).toContain(
      'grok-acp',
    )
  })

  it('does not memoize an unprobeable result', () => {
    let calls = 0
    const first = grokAcpVersionProbe(() => {
      calls += 1
      return { ok: false, output: 'timed out' }
    })
    const second = grokAcpVersionProbe(() => {
      calls += 1
      return { ok: true, output: 'grok 0.2.118' }
    })
    expect(first).toMatchObject({ drivable: false, reason: 'unprobeable' })
    expect(second).toEqual({ drivable: true })
    expect(calls).toBe(2)
  })

  it('memoizes a definitive unsupported version', () => {
    let calls = 0
    const probe = () => {
      calls += 1
      return { ok: true, output: 'grok 0.2.22' }
    }
    expect(grokAcpVersionProbe(probe)).toMatchObject({
      drivable: false,
      reason: 'unsupported',
    })
    expect(grokAcpVersionProbe(probe)).toMatchObject({ reason: 'unsupported' })
    expect(calls).toBe(1)
  })
})

describe('server restart adoption registry', () => {
  it('pins every shipped server runtime, including Grok ACP', () => {
    const opencodeRuntime = { marker: 'opencode' }
    const codexRuntime = { marker: 'codex' }
    const grokRuntime = { marker: 'grok' }
    const ctx = {
      opencodeRuntime,
      codexRuntime,
      grokRuntime,
    } as unknown as DaemonContext
    expect(
      serverDriverAdoptionCandidates(ctx).map(({ runtime, what }) => ({
        marker: (runtime as unknown as { marker: string }).marker,
        what,
      })),
    ).toEqual([
      { marker: 'opencode', what: 'opencode serve' },
      { marker: 'codex', what: 'codex app-server' },
      { marker: 'grok', what: 'grok agent stdio' },
    ])
  })
})
