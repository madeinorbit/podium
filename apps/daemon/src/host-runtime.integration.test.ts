import type { AgentSessionHandle } from '@podium/agent-runtime'
import type { SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from './control/context'
import { reapServerSessionsOnClose } from './host-runtime'
import type { DaemonMachineRuntime } from './runtime/machine-runtime'
import type { ServerReapIo } from './runtime/server-reap'

const SESSION = 'full-reap-session' as SessionId

const SERVER_FAMILIES = [
  { driver: 'opencode-server', harness: 'opencode' },
  { driver: 'codex-app-server', harness: 'codex' },
  { driver: 'grok-acp', harness: 'grok' },
] as const

function reapIo(state: { alive: boolean }): ServerReapIo & { signals: string[] } {
  const signals: string[] = []
  return {
    signals,
    pidAlive: () => state.alive,
    signal: (_pid, signal) => {
      signals.push(signal)
      if (signal === 'SIGKILL') state.alive = false
    },
    pidInUnit: () => false,
    probeOpencode: async () => false,
    runSystemctl: async () => {},
    sleep: async () => {},
    canScope: () => false,
  }
}

describe('full-reap daemon close', () => {
  it.each(SERVER_FAMILIES)('$driver leaves no live child behind', async ({ driver, harness }) => {
    const state = { alive: true }
    const calls: string[] = []
    const handle = {
      binding: {
        sessionId: SESSION,
        driver,
        family: 'server',
        harness,
        workdir: '/tmp/full-reap',
        resume: null,
        process: { key: `full-reap:${SESSION}`, pid: 4321 },
        bindingVersion: 1,
      },
      async kill() {
        calls.push('kill')
      },
    } as unknown as AgentSessionHandle
    const sent: DaemonMessage[] = []
    const ctx = {
      agentRuntime: {
        serverHandleFor: (sessionId: SessionId) =>
          sessionId === SESSION ? handle : undefined,
        journalledServerProcess: () => undefined,
      },
      send: (message: DaemonMessage) => void sent.push(message),
    } as unknown as DaemonContext
    const runtime = {
      registeredBindings: () => [handle.binding],
    } as unknown as Pick<DaemonMachineRuntime, 'registeredBindings'>

    const io = reapIo(state)
    reapServerSessionsOnClose(ctx, runtime, io)
    await vi.waitFor(() =>
      expect(sent.some((message) => message.type === 'sessionKillResult')).toBe(true),
    )

    expect(state.alive).toBe(false)
    expect(io.signals).toEqual(['SIGKILL'])
    expect(calls).toEqual(['kill', 'kill'])
    expect(sent.find((message) => message.type === 'sessionKillResult')).toMatchObject({
      killed: true,
      sessionId: SESSION,
    })
  })
})
