/**
 * THE OPENCODE SESSION ADAPTER (moved from
 * apps/daemon/src/runtime/opencode-driver.test.ts in 1.5 with the code it
 * pins: turn-status translation at the session layer).
 */
import type { AgentSessionHandle } from '../../driver.js'
import type { OpencodeRuntime, OpencodeRuntimeHost } from './runtime.js'
import type { RuntimeEvent } from '../../events.js'
import type { AgentRuntimeState, SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createOpencodeRuntime: vi.fn(),
}))

/**
 * A TOTAL replacement of the runtime module, so every export this file's
 * subject reaches for has to appear here. `configureFieldsForDriver`
 * (POD-3087) stays REAL (it lives in ../../configure-catalog.js, untouched
 * by this mock): it is a pure lookup over the drivers' own capability
 * declarations with no IO, so faking it would only let this suite disagree
 * with what the bind actually carries.
 */
vi.mock('./runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime.js')>()
  return {
    ...actual,
    createOpencodeRuntime: mocks.createOpencodeRuntime,
    OPENCODE_SERVER_DRIVER_ID: 'opencode-server',
  }
})

import { createOpencodeSessionRuntime } from './session.js'
import { opencodeFlavor } from './engine-facts.js'
import { manifestFor } from '../../../registry.js'

function world() {
  const sessionId = 'opencode-status-test' as SessionId
  const sent: DaemonMessage[] = []
  let currentState: AgentRuntimeState = {
    phase: 'idle',
    since: '2026-08-26T00:00:00.000Z',
    nativeSubagentCount: 0,
  }
  let releaseTurnEvent!: () => void
  const turnEventReady = new Promise<void>((resolve) => {
    releaseTurnEvent = resolve
  })
  const turnStarted: RuntimeEvent = {
    t: 'turn',
    ev: { ev: 'started', turnEpoch: 1, origin: 'human' },
    at: '2026-08-26T00:00:01.000Z',
    provenance: 'live',
    cursor: { segmentId: 'opencode-test', components: { seq: 1 } },
    observerGeneration: 1,
    turnEpoch: 1,
  }
  const workingState: AgentRuntimeState = {
    phase: 'working',
    since: '2026-08-26T00:00:01.000Z',
    nativeSubagentCount: 0,
  }
  const handle = {
    binding: {
      sessionId,
      driver: 'opencode-server',
      family: 'server',
      harness: 'opencode',
      workdir: '/work',
      resume: { kind: 'opencode-session', value: 'opencode-session-test' },
      process: { key: 'opencode-process-test' },
      bindingVersion: 1,
    },
    state: async () => currentState,
    events: async function* () {
      await turnEventReady
      yield turnStarted
    },
    send: async () => {
      currentState = workingState
      releaseTurnEvent()
      return {} as never
    },
  } as unknown as AgentSessionHandle
  const runtime = {
    createWithId: vi.fn(async () => handle),
    handleFor: vi.fn((id: SessionId) => (id === sessionId ? handle : undefined)),
    journal: { read: () => undefined },
    driver: {},
  } as unknown as OpencodeRuntime

  mocks.createOpencodeRuntime.mockReset()
  mocks.createOpencodeRuntime.mockReturnValue(runtime)

  const daemon = createOpencodeSessionRuntime({
    flavor: opencodeFlavor(manifestFor('opencode')!),
    engine: {} as OpencodeRuntimeHost,
    send: (message) => sent.push(message),
    emitBind: (bind) => {
      sent.push({ type: 'bind', ...bind })
    },
    sessionReady: () => {},
    traceRuntimeEvent: () => {},
    startMailContinuation: () => () => {},
  })
  const phases = () =>
    sent.flatMap((message) => (message.type === 'agentState' ? [message.state.phase] : []))

  return { daemon, handle, phases, sent, sessionId }
}

describe('opencode daemon turn status', () => {
  it('publishes working from the accepted turn before provider status arrives', async () => {
    const w = world()

    await w.daemon.launch({ sessionId: w.sessionId, cwd: '/work' })
    expect(
      w.sent.find((message) => message.type === 'bind'),
    ).toMatchObject({ attachKinds: ['client'] })
    expect(w.phases()).toEqual(['idle'])

    // No session.status event is emitted by this fixture. The accepted prompt
    // is represented only by the runtime's immediate `turn started` event.
    await w.handle.send(
      { text: 'hello' },
      { origin: 'human', delivery: 'when-ready' },
    )

    await vi.waitFor(() => expect(w.phases()).toContain('working'))
    expect(w.phases()).toEqual(['idle', 'working'])
  })
})

describe('§4.8 failure ownership — unrecoverable adopt is reported, not swallowed', () => {
  it('a journalled session the driver cannot rebind rejects instead of vanishing', async () => {
    // The journal names a server, but the driver cannot rebind it (its
    // process is gone and nothing answers). That is unrecoverable, and the
    // session adapter reports it — the reattach path turns the cause into
    // an honest reattach failure with pending turns invalidated, rather
    // than a generic "could not be rebound".
    const sessionId = 'opencode-unrecoverable' as SessionId
    const entry = {
      sessionId,
      opencodeSessionId: 'ses_dead',
      baseUrl: 'http://127.0.0.1:41234',
      username: 'podium',
      secret: 'journalled-secret',
      workdir: '/tmp',
      process: { key: 'opencode-process-dead' },
      seq: 0,
      turnEpoch: 0,
      bindingVersion: 1,
    }
    mocks.createOpencodeRuntime.mockReset()
    mocks.createOpencodeRuntime.mockReturnValue({
      driver: {
        adopt: vi.fn(async () => {
          throw new Error('server went away mid-adopt')
        }),
      },
    })
    const daemon = createOpencodeSessionRuntime({
      flavor: opencodeFlavor(manifestFor('opencode')!),
      engine: {
        journal: { read: () => entry, write: () => {}, clear: () => {} },
      } as unknown as OpencodeRuntimeHost,
      send: () => {},
      emitBind: () => {},
      sessionReady: () => {},
      traceRuntimeEvent: () => {},
      startMailContinuation: () => () => {},
    })
    await expect(daemon.adoptFromJournal(sessionId)).rejects.toThrow(
      'server went away mid-adopt',
    )
  })

  it('still answers undefined for a session it never journalled', async () => {
    mocks.createOpencodeRuntime.mockReset()
    mocks.createOpencodeRuntime.mockReturnValue({
      driver: {
        adopt: vi.fn(async () => {
          throw new Error('must never be called without a journal entry')
        }),
      },
    })
    const daemon = createOpencodeSessionRuntime({
      flavor: opencodeFlavor(manifestFor('opencode')!),
      engine: { journal: { read: () => undefined } } as unknown as OpencodeRuntimeHost,
      send: () => {},
      emitBind: () => {},
      sessionReady: () => {},
      traceRuntimeEvent: () => {},
      startMailContinuation: () => () => {},
    })
    await expect(
      daemon.adoptFromJournal('never-seen' as SessionId),
    ).resolves.toBeUndefined()
  })
})
