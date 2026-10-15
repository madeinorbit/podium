/**
 * One host sample runs a fixed number of statements, whatever the number of
 * live sessions on the machine [POD-6149, server-data rule 8].
 */
import { asMachineId, type SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import type { SessionStore } from './store'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'
import { expectConstantStatements, type StatementPin } from './test-support/statement-count'

interface Fixture {
  store: SessionStore
  reg: SessionRegistry
  ids: SessionId[]
}

/** `size` live shells, quiet for 61 minutes when `quiet`, against a 60-minute backstop. */
async function fixture(size: number, quiet: boolean): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  await attachHostDaemon(reg, () => {})
  await store.settings.setSettings({
    ...(await store.settings.getSettings()),
    hibernation: {
      enabled: true,
      memoryPct: 80,
      loadPerCore: null,
      maxIdleSessions: null,
      idleMinutes: 30,
      idleShellMinutes: null,
      backstopMinutes: 60,
    },
  })
  const ids: SessionId[] = []
  for (let i = 0; i < size; i++) {
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: `/w${i}`,
      machineId: store.hostMachineId,
    })
    await reg.gateway.routeDaemonFrame(asMachineId(store.hostMachineId), {
      type: 'bind',
      sessionId,
      cmd: 'sh',
      cwd: `/w${i}`,
      agentKind: 'shell',
      geometry: { cols: 80, rows: 24 },
    } as never)
    ids.push(sessionId)
  }
  const sessions = (
    reg.modules.sessions as unknown as {
      sessions: Map<SessionId, { lastActiveAt: string; terminal: Record<string, number> }>
    }
  ).sessions
  const stampMs = quiet ? Date.now() - 61 * 60_000 : Date.now()
  ids.forEach((id, index) => {
    const live = sessions.get(id)
    if (!live) throw new Error('live session missing from map')
    // Distinct ages so the backstop's oldest-first choice is deterministic.
    const at = stampMs - index * 1000
    live.lastActiveAt = new Date(at).toISOString()
    live.terminal.resumedAtMs_ = at
    live.terminal.inputAtMs_ = at
    live.terminal.outputAtMs_ = at
  })
  return { store, reg, ids }
}

const sample = () => ({
  hostname: 'test',
  sampledAt: new Date().toISOString(),
  memory: {
    totalBytes: 8_000_000_000,
    availableBytes: 4_000_000_000,
    swapTotalBytes: 0,
    swapFreeBytes: 0,
  },
  load: { one: 1.0, five: 1.0, fifteen: 1.0, cpuCount: 8 },
})

const pin = (
  name: string,
  quiet: boolean,
  check: (f: Fixture) => Promise<void>,
): StatementPin<Fixture> => ({
  name,
  setup: async (size) => await fixture(size, quiet),
  target: (f) => f.store,
  run: async (f) => await f.reg.modules.hosts.onHostMetrics(f.store.hostMachineId, sample()),
  check: async (_result, f) => await check(f),
  teardown: async (f) => {
    await f.reg.dispose()
    await f.store.close()
  },
})

describe('host sample: pinned statement counts at 5 and 200 live shells', () => {
  it('a sample with nothing to retire', async () => {
    await expectConstantStatements(
      pin('host sample (steady)', false, async (f) => {
        expect((await f.store.sessions.loadSessions()).map((s) => s.id).sort()).toEqual([...f.ids].sort())
      }),
      5,
    )
  })

  it('a sample at the backstop reads scheduled wakeups once, not once per quiet session', async () => {
    await expectConstantStatements(
      pin('host sample (backstop)', true, async (f) => {
        // The oldest quiet shell is retired, the rest are left for later samples.
        await expect
          .poll(async () => (await f.store.sessions.loadSessions()).some((s) => s.id === f.ids.at(-1)))
          .toBe(false)
      }),
      38,
    )
  })
})
