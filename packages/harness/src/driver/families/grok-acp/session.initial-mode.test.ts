/**
 * THE ENGINE'S INITIAL MODE COMES FROM ITS LAUNCH TERMS (POD-6858 §4.8).
 *
 * `grok agent stdio` takes no mode flag, so Grok's posture section leaves the
 * engine's argv alone and names the mode it wants (`requestedMode`). The
 * family sets it over ACP: `auto` is `_meta.autoMode` on `session/new`, every
 * other mode is `session/set_mode`. Before the terms existed every engine
 * session was forced to `default`.
 */
import type { SessionId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { manifestFor } from '../../../registry.js'
import {
  createMemoryAttachmentStager,
  createMemoryDriverSlots,
  serverFamilyLaunch,
  testEngineTerms,
  testHarnessContext,
} from '../../testing/index.js'
import { grokEngineFacts } from './engine-facts.js'
import type { GrokAcpRuntimeHost } from './runtime.js'
import { createGrokSessionRuntime, type DaemonGrokRuntime } from './session.js'
import { type FakeGrokAcpServer, startFakeGrokAcpServer } from './test-support/fake-acp-server.js'

const runtimes: DaemonGrokRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
})

/** Launch one engine session whose endpoint reports `requestedMode`. */
async function launchWith(requestedMode: string | null | undefined): Promise<FakeGrokAcpServer> {
  let server: FakeGrokAcpServer | undefined
  let seq = 0
  const entries = new Map<SessionId, never>()
  const host: GrokAcpRuntimeHost = {
    ...testEngineTerms(),
    harnessContextFor: async () => testHarnessContext({ kind: 'grok' }),
    stageAttachment: createMemoryAttachmentStager(),
    bindings: {
      recorded: (id) => entries.get(id),
      bound: (entry) => void entries.set(entry.sessionId, entry as never),
      released: (id) => void entries.delete(id),
    },
    now: () => Date.UTC(2026, 10, 13) + ++seq * 1000,
    mintSessionId: () => `gk-minted-${++seq}` as SessionId,
    readHistory: async () => ({ items: [], hasMore: false }),
    async launch(input) {
      server = startFakeGrokAcpServer(`grok-native-${input.sessionId}`)
      return {
        transport: server.transport,
        process: { key: `podium-gk-${input.sessionId}`, pid: 4100 },
        alive: () => server?.alive ?? false,
        stop: async () => server?.crash(),
        kill: async () => server?.crash(),
        resources: () => undefined,
        ...(requestedMode !== undefined ? { requestedMode } : {}),
      }
    },
  }
  const runtime = createGrokSessionRuntime({
    stageAttachment: createMemoryAttachmentStager(),
    driverSlots: createMemoryDriverSlots(),
    facts: grokEngineFacts(manifestFor('grok')!),
    engine: host,
    send: () => {},
    emitBind: () => {},
    sessionReady: () => {},
    traceRuntimeEvent: () => {},
    startMailContinuation: () => () => {},
  })
  runtimes.push(runtime)
  await runtime.launch(
    serverFamilyLaunch({
      harnessContext: testHarnessContext({ kind: 'grok' }),
      sessionId: 'grok-initial-mode' as SessionId,
      cwd: '/work',
    }),
  )
  if (!server) throw new Error('the engine was never launched')
  return server
}

describe('grok-acp initial mode', () => {
  it('auto: asks for auto mode on session/new and sets no other mode', async () => {
    const server = await launchWith('auto')
    expect(server.sessionNews[0]).toMatchObject({ _meta: { autoMode: true } })
    expect(server.setModes).toEqual([])
  })

  it('default: no autoMode, and session/set_mode default', async () => {
    const server = await launchWith('default')
    expect(server.sessionNews[0]?._meta).toBeUndefined()
    expect(server.setModes).toEqual([{ sessionId: server.sessionId, modeId: 'default' }])
  })

  it('a native pick: session/set_mode with that mode', async () => {
    const server = await launchWith('plan')
    expect(server.sessionNews[0]?._meta).toBeUndefined()
    expect(server.setModes).toEqual([{ sessionId: server.sessionId, modeId: 'plan' }])
  })

  it('no requested mode: default, as before the terms existed', async () => {
    for (const requested of [undefined, null]) {
      const server = await launchWith(requested)
      expect(server.sessionNews[0]?._meta).toBeUndefined()
      expect(server.setModes).toEqual([{ sessionId: server.sessionId, modeId: 'default' }])
    }
  })
})
