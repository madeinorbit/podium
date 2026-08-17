/**
 * THE SERVER-FAMILY TEARDOWN REAP (POD-2249).
 *
 * The bug class these pin: `sessions.stop` parked the row while the driver
 * process ran on, and `sessions.kill` deleted the row and left a credentialed
 * child. Every server-sent teardown frame lands in `stopSessionProcess`, whose
 * server-family branch is this module — so what is pinned here is the branch's
 * whole contract: ownership detection, the verb per mode, SIGKILL escalation,
 * the post-restart journal arm with its per-driver CORROBORATION (a journalled
 * pid is never signalled on the pid's word alone — the review's recycled-pid
 * kill), and a `sessionKillResult` that is measured rather than assumed.
 *
 * PER DRIVER, DELIBERATELY. The first round of these tests populated only
 * `opencodeRuntime`, and the reviewer proved the gap by reverting the fix for
 * codex and grok outright with the whole suite staying green. Every ownership
 * assertion below runs once per registry slot, so dropping any driver from
 * either arm of the reap goes red — the epic's missing-caller lesson, pinned.
 */

import type { AgentSessionHandle } from '@podium/agent-runtime'
import type { SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from '../control/context'
import { sessionHandlers, stopSessionProcess } from '../control/session'
import { beginServerDriverReap, type ServerReapIo } from './server-reap'

const SESSION = 'sess-1' as SessionId

type RuntimeSlot = 'opencodeRuntime' | 'codexRuntime' | 'grokRuntime'

/** [driver, registry slot, whether its journal carries the opencode probe]. */
const DRIVERS: Array<{ driver: string; slot: RuntimeSlot }> = [
  { driver: 'opencode', slot: 'opencodeRuntime' },
  { driver: 'codex', slot: 'codexRuntime' },
  { driver: 'grok', slot: 'grokRuntime' },
]

interface FakeProcessState {
  /** The one liveness bit the fake io reads and the fake signals flip. */
  alive: boolean
  /** Which signal (if any) actually kills the fake process. */
  diesOn: 'SIGTERM' | 'SIGKILL' | 'never'
}

/** How the journal path may corroborate identity: is the pid genuinely in this
 *  session's cgroup, does the opencode probe answer? Both AND with `alive`, so
 *  a killed process stops corroborating — which is the measurement. */
interface Corroboration {
  cgroup?: boolean
  probe?: boolean
}

function fakeIo(
  state: FakeProcessState,
  corroboration: Corroboration = {},
): ServerReapIo & {
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
    pidInUnit: () => (corroboration.cgroup ?? false) && state.alive,
    probeOpencode: async () => (corroboration.probe ?? false) && state.alive,
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
        key: 'podium-x-sess-1',
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

/** A ctx whose ONE populated registry is `slot` — so these tests go red if that
 *  driver is dropped from either arm of the reap. */
function fakeCtx(
  slot: RuntimeSlot,
  input: {
    handle?: AgentSessionHandle
    journalEntry?: Record<string, unknown>
  },
): {
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
    opencodeRuntime: undefined,
    codexRuntime: undefined,
    grokRuntime: undefined,
    [slot]: runtime,
    send: (msg: DaemonMessage) => void sent.push(msg),
  } as unknown as DaemonContext
  return { ctx, sent, journalCleared }
}

/** A journal entry as each driver writes it — opencode's carries the probe
 *  material the reap's corroboration reads. */
function journalEntryFor(driver: string): Record<string, unknown> {
  return {
    sessionId: SESSION,
    process: { key: `podium-x-${SESSION}`, pid: 7777, scopeUnit: `podium-x-${SESSION}.scope` },
    ...(driver === 'opencode' ? { baseUrl: 'http://127.0.0.1:4242', secret: 's3cret' } : {}),
  }
}

const killResult = (sent: DaemonMessage[]) =>
  sent.find((m) => m.type === 'sessionKillResult') as
    | { killed: boolean; durableLabel: string; reason?: string }
    | undefined

describe('ownership', () => {
  it('leaves a session no server runtime holds untouched, so the PTY path is unchanged', () => {
    const { ctx, sent } = fakeCtx('opencodeRuntime', {})
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

describe('teardown through a live handle — once per driver registry', () => {
  it.each(DRIVERS)('$driver: a park reaches the driver stop and reports a MEASURED kill', async ({
    slot,
  }) => {
    const state: FakeProcessState = { alive: true, diesOn: 'SIGTERM' }
    const { handle, calls } = fakeHandle({
      pid: 4321,
      onStop: () => {
        state.alive = false
      },
    })
    const { ctx, sent } = fakeCtx(slot, { handle })
    const io = fakeIo(state)

    expect(beginServerDriverReap(ctx, SESSION, { retire: false }, io)).toBe(true)
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(calls).toEqual(['stop'])
    expect(killResult(sent)).toMatchObject({ killed: true, durableLabel: 'podium-x-sess-1' })
  })

  it.each(
    DRIVERS,
  )('$driver: a RETIRE goes straight to the driver kill — the journal must die with the row', async ({
    slot,
  }) => {
    const state: FakeProcessState = { alive: true, diesOn: 'SIGTERM' }
    const { handle, calls } = fakeHandle({
      pid: 4321,
      onKill: () => {
        state.alive = false
      },
    })
    const { ctx, sent } = fakeCtx(slot, { handle })

    beginServerDriverReap(ctx, SESSION, { retire: true }, fakeIo(state))
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(calls).toEqual(['kill'])
    expect(killResult(sent)).toMatchObject({ killed: true })
  })

  it('ESCALATES with the raw SIGKILL FIRST — the last resort must not sit behind a verb that can throw', async () => {
    // The driver's verbs run but the process ignores SIGTERM: only the raw
    // SIGKILL (the unscoped-opencode arm, whose child left the host map on the
    // first verb) actually lands — and it lands even though `kill()` rejects.
    const state: FakeProcessState = { alive: true, diesOn: 'SIGKILL' }
    const { ctx, sent } = fakeCtx('opencodeRuntime', {
      handle: {
        binding: { process: { key: 'podium-x-sess-1', pid: 4321 } },
        async stop() {},
        async kill() {
          throw new Error('endpoint unreachable')
        },
      } as unknown as AgentSessionHandle,
    })
    const io = fakeIo(state)

    beginServerDriverReap(ctx, SESSION, { retire: false }, io)
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(io.signals).toContainEqual({ pid: 4321, signal: 'SIGKILL' })
    // The raw SIGKILL landed before `kill()` threw, so the catch's measured
    // answer is still "dead" — with the verb's failure named.
    expect(killResult(sent)).toMatchObject({ killed: true, reason: 'endpoint unreachable' })
  })

  it('reports killed:false — never an assumed receipt — for a process nothing could end', async () => {
    const state: FakeProcessState = { alive: true, diesOn: 'never' }
    const { handle, calls } = fakeHandle({ pid: 4321 })
    const { ctx, sent } = fakeCtx('opencodeRuntime', { handle })
    const io = fakeIo(state)

    beginServerDriverReap(ctx, SESSION, { retire: false }, io)
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(calls).toEqual(['stop', 'kill'])
    expect(io.signals).toContainEqual({ pid: 4321, signal: 'SIGKILL' })
    expect(killResult(sent)).toMatchObject({ killed: false })
    expect(killResult(sent)?.reason).toMatch(/still running/)
  })

  it('a verb that THROWS still answers, with the pid probe as the verdict', async () => {
    const state: FakeProcessState = { alive: true, diesOn: 'never' }
    const handle = {
      binding: { process: { key: 'podium-x-sess-1', pid: 4321 } },
      async stop() {
        throw new Error('endpoint unreachable')
      },
    } as unknown as AgentSessionHandle
    const { ctx, sent } = fakeCtx('opencodeRuntime', { handle })

    beginServerDriverReap(ctx, SESSION, { retire: false }, fakeIo(state))
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(killResult(sent)).toMatchObject({ killed: false, reason: 'endpoint unreachable' })
  })

  it('with no recorded pid the verbs are trusted, not measured — and nothing touches the process table', async () => {
    const state: FakeProcessState = { alive: true, diesOn: 'never' }
    const { handle, calls } = fakeHandle({})
    const { ctx, sent } = fakeCtx('opencodeRuntime', { handle })
    const io = fakeIo(state)

    beginServerDriverReap(ctx, SESSION, { retire: false }, io)
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(calls).toEqual(['stop'])
    expect(io.signals).toHaveLength(0)
    expect(killResult(sent)).toMatchObject({ killed: true })
  })
})

describe('teardown from the journal alone — the post-daemon-restart arm, once per driver', () => {
  /** Each driver's corroboration, as the module records it: opencode by its
   *  credentialed probe, codex/grok by cgroup membership of the scope unit. */
  const corroborationFor = (driver: string): Corroboration =>
    driver === 'opencode' ? { probe: true } : { cgroup: true }

  it.each(
    DRIVERS,
  )('$driver: a corroborated survivor is signalled, its scope stopped, and the kill measured', async ({
    driver,
    slot,
  }) => {
    const state: FakeProcessState = { alive: true, diesOn: 'SIGTERM' }
    const { ctx, sent, journalCleared } = fakeCtx(slot, { journalEntry: journalEntryFor(driver) })
    const io = fakeIo(state, corroborationFor(driver))

    expect(beginServerDriverReap(ctx, SESSION, { retire: false }, io)).toBe(true)
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(io.signals).toContainEqual({ pid: 7777, signal: 'SIGTERM' })
    expect(io.systemctl.flat().join(' ')).toContain(`podium-x-${SESSION}.scope`)
    expect(killResult(sent)).toMatchObject({ killed: true })
    // A PARK keeps the journal: a dead process fails the adopt probe, so the
    // stale entry only costs a refused rebind.
    expect(journalCleared).toHaveLength(0)
  })

  it.each(
    DRIVERS,
  )("$driver: an UNCORROBORATED pid is NEVER signalled — a recycled pid is not this session's process", async ({
    driver,
    slot,
  }) => {
    // The review's scenario: park, reboot, delete. The journalled pid is
    // alive on the process table but belongs to someone else now — no cgroup
    // membership, no probe answer. The reap must not signal it, and must not
    // report killed:false (which would resurrect the long-dead session).
    const state: FakeProcessState = { alive: true, diesOn: 'never' }
    const { ctx, sent, journalCleared } = fakeCtx(slot, { journalEntry: journalEntryFor(driver) })
    const io = fakeIo(state, {})

    beginServerDriverReap(ctx, SESSION, { retire: true }, io)
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(io.signals).toHaveLength(0)
    expect(killResult(sent)).toMatchObject({ killed: true })
    // …but never SILENTLY (review residual): the pid is occupied and
    // uncorroborable, which for an unscoped wedged opencode could be this
    // session's credentialed server — the receipt names the ambiguity.
    expect(killResult(sent)?.reason).toMatch(/uncorroborable/)
    // The scope stop still ran — it is session-named and cannot hit a
    // bystander, and it clears any lingering cgroup the pid signal missed.
    expect(io.systemctl.length).toBeGreaterThan(0)
    // Retire still clears the journal: the row is gone, the credential's
    // address must go with it.
    expect(journalCleared).toEqual([SESSION])
  })

  it('a journalled reap of a DEAD pid stays a clean receipt — no ambiguity note', async () => {
    const state: FakeProcessState = { alive: false, diesOn: 'SIGTERM' }
    const { ctx, sent } = fakeCtx('codexRuntime', { journalEntry: journalEntryFor('codex') })
    const io = fakeIo(state, {})

    beginServerDriverReap(ctx, SESSION, { retire: false }, io)
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(io.signals).toHaveLength(0)
    expect(killResult(sent)).toMatchObject({ killed: true })
    expect(killResult(sent)?.reason).toBeUndefined()
  })

  it('escalates a corroborated SIGTERM survivor to SIGKILL', async () => {
    const state: FakeProcessState = { alive: true, diesOn: 'SIGKILL' }
    const { ctx, sent } = fakeCtx('codexRuntime', { journalEntry: journalEntryFor('codex') })
    const io = fakeIo(state, { cgroup: true })

    beginServerDriverReap(ctx, SESSION, { retire: false }, io)
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(io.signals.map((s) => s.signal)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(killResult(sent)).toMatchObject({ killed: true })
  })

  it('an opencode survivor is corroborated by the probe even where no scope exists', async () => {
    const state: FakeProcessState = { alive: true, diesOn: 'SIGTERM' }
    const entry = {
      sessionId: SESSION,
      process: { key: `podium-x-${SESSION}`, pid: 7777 },
      baseUrl: 'http://127.0.0.1:4242',
      secret: 's3cret',
    }
    const { ctx, sent } = fakeCtx('opencodeRuntime', { journalEntry: entry })
    const io = fakeIo(state, { probe: true })

    beginServerDriverReap(ctx, SESSION, { retire: false }, io)
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(io.signals).toContainEqual({ pid: 7777, signal: 'SIGTERM' })
    expect(killResult(sent)).toMatchObject({ killed: true })
  })
})

describe('the choke point: every teardown frame lands in stopSessionProcess', () => {
  /** Enough of a DaemonContext for `stopSessionProcess` to run end to end.
   *  `backend: 'none'` keeps the PTY durable reap out of the way, and a
   *  pid-less handle keeps the DEFAULT io off the real process table. */
  function wiringCtx(
    handle: AgentSessionHandle,
    sessionBinding?: { transition: () => Promise<unknown> },
  ): { ctx: DaemonContext; sent: DaemonMessage[] } {
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
      ...(sessionBinding ? { sessionBinding } : {}),
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

  it('the RETIRE FRAME carries retire through the handler — a delete must never soften to a park', async () => {
    const { handle, calls } = fakeHandle({})
    const { ctx, sent } = wiringCtx(handle, {
      transition: async () => ({ status: 'applied' }),
    })

    sessionHandlers.sessionBindingRetire(ctx, {
      type: 'sessionBindingRetire',
      sessionId: SESSION,
      transitionId: `retire:${SESSION}`,
      retiredAt: '2026-08-17T00:00:00.000Z',
    } as never)
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(calls).toEqual(['kill'])
  })

  it('…and carries it through the FAILURE arm too — the one that runs when the transition broke', async () => {
    const { handle, calls } = fakeHandle({})
    const { ctx, sent } = wiringCtx(handle, {
      transition: async () => {
        throw new Error('binding store unavailable')
      },
    })

    sessionHandlers.sessionBindingRetire(ctx, {
      type: 'sessionBindingRetire',
      sessionId: SESSION,
      transitionId: `retire:${SESSION}`,
      retiredAt: '2026-08-17T00:00:00.000Z',
    } as never)
    await vi.waitFor(() => expect(killResult(sent)).toBeDefined())

    expect(calls).toEqual(['kill'])
  })
})
