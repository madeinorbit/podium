import type {
  AgentSessionHandle,
  OpencodeRuntime,
  OpencodeRuntimeHost,
  RuntimeEvent,
} from '@podium/agent-runtime'
import type { AgentRuntimeState, SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createOpencodeRuntime: vi.fn(),
}))

vi.mock('@podium/agent-runtime', () => ({
  createOpencodeRuntime: mocks.createOpencodeRuntime,
  OPENCODE_SERVER_DRIVER_ID: 'opencode-server',
}))

import { createDaemonOpencodeRuntime } from './opencode-driver'

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

  const daemon = createDaemonOpencodeRuntime({
    send: (message) => sent.push(message),
    host: {} as OpencodeRuntimeHost,
  })
  const phases = () =>
    sent.flatMap((message) => (message.type === 'agentState' ? [message.state.phase] : []))

  return { daemon, handle, phases, sessionId }
}

describe('opencode daemon turn status', () => {
  it('publishes working from the accepted turn before provider status arrives', async () => {
    const w = world()

    await w.daemon.launch({ sessionId: w.sessionId, cwd: '/work' })
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
