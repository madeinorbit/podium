/**
 * THE SERVER-FAMILY TEARDOWN REAP (POD-2249).
 *
 * The bug class these pin: `sessions.stop` parked the row while the driver
 * process ran on, and `sessions.kill` deleted the row and left a credentialed
 * child. Every server-sent teardown frame lands in `stopSessionProcess`, whose
 * server-family branch is this module — so what is pinned here is the branch's
 * whole contract: ownership detection, the verb per mode, SIGKILL escalation,
 * the post-restart journal arm, and a `sessionKillResult` that is measured
 * rather than assumed.
 */

import type { AgentSessionHandle } from '@podium/agent-runtime'
import type { SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from '../control/context'
import { sessionHandlers, stopSessionProcess } from '../control/session'
import { beginServerDriverReap, type ServerReapIo } from './server-reap'

const SESSION = 'sess-1' as SessionId

interface FakeProcessState {
  /** The one liveness bit the fake io reads and the fake signals flip. */
  alive: boolean
  /** Which signal (if any) actually kills the fake process. */
  diesOn: 'SIGTERM' | 'SIGKILL' | 'never'
}

function fakeIo(state: FakeProcessState): ServerReapIo & {
  signals: Array<{ pid: number; signal: string }>
  systemctl: string[][]
} {
  const signals: Array<{ pid: number; signal: string }> = []
  const systemctl: string[][] = []
  return {
    signals,
    systemctl,
    pidAlive: () => state.alive,
    signal(pid, signal) {
      signals.push({ pid, signal })
      if (state.diesOn !== 'never' && (signal === 'SIGKILL' || signal === state.diesOn)) {
        state.alive = false
      }
    },
    runSystemctl: async (args) => {
      systemctl.push([...args])
    },
    sleep: async () => {},
    canScope: () => true,
  }
}

function fakeHandle(input: {
  pid?: number
  scopeUnit?: string
  /** What the verbs do to the fake process. Defaults kill it. */
  onStop?: () => void | Promise<void>
  onKill?: () => void | Promise<void>
}): {
  handle: AgentSessionHandle
  calls: string[]
} {
  const calls: string[] = []
  const handle = {
    binding: {
      process: {
        key: 'podium-oc-sess-1',
        ...(input.pid !== undefined ? { pid: input.pid } : {}),
        ...(input.scopeUnit ? { scopeUnit: input.scopeUnit } : {}),
      },
    },
    async stop() {
      calls.push('stop')
      await input.onStop?.()
    },
    async kill() {
      calls.push('kill')
      await input.onKill?.()
    },
  } as unknown as AgentSessionHandle
  return { handle, calls }
}

function fakeCtx(input: {
  handle?: AgentSessionHandle
  journalEntry?: { sessionId: SessionId; process: Record<string, unknown> }
}): {
  ctx: DaemonContext
  sent: DaemonMessage[]
  journalCleared: SessionId[]
} {
  const sent: DaemonMessage[] = []
  const journalCleared: SessionId[] = []
  const runtime = {
    handleFor: (sessionId: SessionId) => (sessionId === SESSION ? input.handle : undefined),
    journal: {
      read: (sessionId: SessionId) => (sessionId === SESSION ? input.journalEntry : undefined),
      clear: (sessionId: SessionId) => void journalCleared.push(sessionId),
    },
  }
  const ctx = {
    opencodeRuntime: runtime,
    codexRuntime: undefined,
    grokRuntime: undefined,
    send: (msg: DaemonMessage) => void sent.push(msg),
  } as unknown as DaemonContext
  return { ctx, sent, journalCleared }
}

const killResult = (sent: DaemonMessage[]) =>
  sent.find((m) => m.type === 'sessionKillResult') as
    | { killed: boolean; durableLabel: string; reason?: string }
    | undefined

describe('ownership', () => {
  it('leaves a session no server runtime holds untouched, so the PTY path is unchanged', () => {
    const { ctx, sent } = fakeCtx({})
    expect(
      beginServerDriverReap(
        ctx,
        SESSION,
        { retire: false },
        fakeIo({ alive: false, diesOn: 'SIGTERM' }),
      ),
    ).toBe(false)
    expect(sent).toHaveLength(0)
  })
})

describe('teardown through a live handle', () => {
  it('a park reaches the driver stop and reports a MEASURED kill', async () => {
    const state: FakeProcessState = { alive: true, diesOn: 'SIGTERM' }
    const { handle, calls } = fakeHandle({
      pid: 4321,
      onStop: () => {
        state.alive = false
      },
    })
    const { ctx, sent } = fakeCtx({ handle })
    const io = fakeIo(state)

    expect(beginServerDriverReap(ctx, SESSION, { retire: false }, io)).toBe(true)
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(calls).toEqual(['stop'])
    expect(killResult(sent)).toMatchObject({ killed: true, durableLabel: 'podium-oc-sess-1' })
  })

  it('ESCALATES to SIGKILL when the process survives its stop, and still measures', async () => {
    // The driver's verbs run but the process ignores SIGTERM: only the raw
    // SIGKILL (the unscoped-opencode arm, whose child left the host map on the
    // first verb) actually lands.
    const state: FakeProcessState = { alive: true, diesOn: 'SIGKILL' }
    const { handle, calls } = fakeHandle({ pid: 4321 })
    const { ctx, sent } = fakeCtx({ handle })
    const io = fakeIo(state)

    beginServerDriverReap(ctx, SESSION, { retire: false }, io)
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(calls).toEqual(['stop', 'kill'])
    expect(io.signals).toContainEqual({ pid: 4321, signal: 'SIGKILL' })
    expect(killResult(sent)).toMatchObject({ killed: true })
  })

  it('reports killed:false — never an assumed receipt — for a process nothing could end', async () => {
    const state: FakeProcessState = { alive: true, diesOn: 'never' }
    const { handle } = fakeHandle({ pid: 4321 })
    const { ctx, sent } = fakeCtx({ handle })

    beginServerDriverReap(ctx, SESSION, { retire: false }, fakeIo(state))
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(killResult(sent)).toMatchObject({ killed: false })
    expect(killResult(sent)?.reason).toMatch(/still running/)
  })

  it('a RETIRE goes straight to the driver kill — the journal must die with the row', async () => {
    const state: FakeProcessState = { alive: true, diesOn: 'SIGTERM' }
    const { handle, calls } = fakeHandle({
      pid: 4321,
      onKill: () => {
        state.alive = false
      },
    })
    const { ctx, sent } = fakeCtx({ handle })

    beginServerDriverReap(ctx, SESSION, { retire: true }, fakeIo(state))
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(calls).toEqual(['kill'])
    expect(killResult(sent)).toMatchObject({ killed: true })
  })

  it('a verb that THROWS still answers, with the pid probe as the verdict', async () => {
    const state: FakeProcessState = { alive: true, diesOn: 'never' }
    const handle = {
      binding: { process: { key: 'podium-oc-sess-1', pid: 4321 } },
      async stop() {
        throw new Error('endpoint unreachable')
      },
    } as unknown as AgentSessionHandle
    const { ctx, sent } = fakeCtx({ handle })

    beginServerDriverReap(ctx, SESSION, { retire: false }, fakeIo(state))
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(killResult(sent)).toMatchObject({ killed: false, reason: 'endpoint unreachable' })
  })

  it('with no recorded pid the verbs are trusted, not measured — and nothing touches the process table', async () => {
    const state: FakeProcessState = { alive: true, diesOn: 'never' }
    const { handle, calls } = fakeHandle({})
    const { ctx, sent } = fakeCtx({ handle })
    const io = fakeIo(state)

    beginServerDriverReap(ctx, SESSION, { retire: false }, io)
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(calls).toEqual(['stop'])
    expect(io.signals).toHaveLength(0)
    expect(killResult(sent)).toMatchObject({ killed: true })
  })
})

describe('teardown from the journal alone — the post-daemon-restart arm', () => {
  const entry = {
    sessionId: SESSION,
    process: { key: 'podium-oc-sess-1', pid: 7777, scopeUnit: 'podium-oc-sess-1.scope' },
  }

  it('signals the recorded pid, stops the recorded scope, and NEVER adopts', async () => {
    const state: FakeProcessState = { alive: true, diesOn: 'SIGTERM' }
    const { ctx, sent, journalCleared } = fakeCtx({ journalEntry: entry })
    const io = fakeIo(state)

    expect(beginServerDriverReap(ctx, SESSION, { retire: false }, io)).toBe(true)
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(io.signals).toContainEqual({ pid: 7777, signal: 'SIGTERM' })
    expect(io.systemctl.length).toBeGreaterThan(0)
    expect(io.systemctl.flat().join(' ')).toContain('podium-oc-sess-1.scope')
    expect(killResult(sent)).toMatchObject({ killed: true })
    // A PARK keeps the journal: a dead process fails the adopt probe, so the
    // stale entry costs a refused rebind and nothing else.
    expect(journalCleared).toHaveLength(0)
  })

  it('escalates a SIGTERM survivor to SIGKILL', async () => {
    const state: FakeProcessState = { alive: true, diesOn: 'SIGKILL' }
    const { ctx, sent } = fakeCtx({ journalEntry: entry })
    const io = fakeIo(state)

    beginServerDriverReap(ctx, SESSION, { retire: false }, io)
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(io.signals.map((s) => s.signal)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(killResult(sent)).toMatchObject({ killed: true })
  })

  it('a RETIRE clears the journal — a deleted session must not stay on the adoption map', async () => {
    const state: FakeProcessState = { alive: true, diesOn: 'SIGTERM' }
    const { ctx, sent, journalCleared } = fakeCtx({ journalEntry: entry })

    beginServerDriverReap(ctx, SESSION, { retire: true }, fakeIo(state))
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(journalCleared).toEqual([SESSION])
  })

  it('an already-dead journalled process gets no signal and an honest receipt', async () => {
    const state: FakeProcessState = { alive: false, diesOn: 'SIGTERM' }
    const { ctx, sent } = fakeCtx({ journalEntry: entry })
    const io = fakeIo(state)

    beginServerDriverReap(ctx, SESSION, { retire: false }, io)
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(io.signals).toHaveLength(0)
    expect(killResult(sent)).toMatchObject({ killed: true })
  })
})

describe('the choke point: every teardown frame lands in stopSessionProcess', () => {
  /** Enough of a DaemonContext for `stopSessionProcess` to run end to end.
   *  `backend: 'none'` keeps the PTY durable reap out of the way, and a
   *  pid-less handle keeps the DEFAULT io off the real process table. */
  function wiringCtx(handle: AgentSessionHandle): { ctx: DaemonContext; sent: DaemonMessage[] } {
    const sent: DaemonMessage[] = []
    const runtime = {
      handleFor: (sessionId: SessionId) => (sessionId === SESSION ? handle : undefined),
      journal: { read: () => undefined, clear: () => {} },
    }
    const ctx = {
      backend: 'none',
      settingsDir: '/nonexistent/podium-test-settings',
      bridges: new Map(),
      pendingResizes: new Map(),
      durableLabels: new Map(),
      durableLabelFor: (sessionId: SessionId) => `podium-${sessionId}`,
      observers: { clearSession: () => {} },
      outputScheduler: { remove: () => {} },
      portableStateFence: { runSync: (fn: () => void) => fn() },
      runtime: undefined,
      opencodeRuntime: runtime,
      codexRuntime: undefined,
      grokRuntime: undefined,
      send: (msg: DaemonMessage) => void sent.push(msg),
    } as unknown as DaemonContext
    return { ctx, sent }
  }

  it('the generic kill frame — hibernate, stop, every park — reaches the driver stop', async () => {
    const { handle, calls } = fakeHandle({})
    const { ctx, sent } = wiringCtx(handle)

    sessionHandlers.kill(ctx, { type: 'kill', sessionId: SESSION } as never)
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(calls).toEqual(['stop'])
  })

  it('a binding retirement reaches the driver kill', async () => {
    const { handle, calls } = fakeHandle({})
    const { ctx, sent } = wiringCtx(handle)

    stopSessionProcess(ctx, { sessionId: SESSION }, { retire: true })
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(calls).toEqual(['kill'])
  })
})
