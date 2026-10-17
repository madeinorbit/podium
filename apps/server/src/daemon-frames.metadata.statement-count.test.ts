/**
 * The daemon frames `daemon-frames.statement-count.test.ts` left out run a
 * fixed number of statements too, whatever the number of sessions on the
 * server, of machines in the fleet, or of items in the frame [POD-6227,
 * server-data rule 8]: terminal output in a batch, a terminal title, a host
 * sample as the daemon sends it (with its readiness), and an inventory report.
 * Each pin is proven armed: a read per row planted on the frame's own path
 * fails it.
 */
import { asMachineId, firstAdminMemberId, type SessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import type { SessionStore } from './store'
import { fixtureInventory } from './test-support/daemon-inventory'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'
import {
  expectArmed,
  expectConstantStatements,
  quietShipping,
  type StatementPin,
} from './test-support/statement-count'

interface Fixture {
  store: SessionStore
  reg: SessionRegistry
  ids: SessionId[]
}

/** `size` bound Claude Code sessions, and `size` other machines in the fleet. */
async function fixture(size: number): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  await attachHostDaemon(reg, () => {})
  await quietShipping(reg)
  const owner = await firstAdminMemberId(store)
  for (let i = 0; i < size; i++) {
    await store.machines.upsertMachine({
      id: asMachineId(`mach_other_${i}`),
      name: `Other ${i}`,
      hostname: `other-${i}`,
      tokenHash: `token-${i}`,
      ownerUserId: owner,
      assignment: { server: false, agentExecution: true },
    })
  }
  const ids: SessionId[] = []
  for (let i = 0; i < size; i++) {
    const { sessionId } = await reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: `/w${i}` })
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'claude',
      cwd: `/w${i}`,
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    } as never)
    ids.push(sessionId)
  }
  await settle(reg)
  return { store, reg, ids }
}

/** Let unawaited bus reactions and the coalesced broadcast finish (as in daemon-frames). */
async function settle(reg: SessionRegistry): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  await reg.modules.sessions.flushBroadcasts()
  await new Promise((resolve) => setTimeout(resolve, 20))
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
}

const route = async (f: Fixture, frame: unknown) => {
  await f.reg.gateway.routeDaemonFrame(f.reg.sessionStore.hostMachineId, frame as never)
  await settle(f.reg)
}

const pin = (
  name: string,
  run: (f: Fixture, size: number) => Promise<unknown>,
  check?: (f: Fixture, size: number) => Promise<void>,
): StatementPin<Fixture> => ({
  name,
  setup: fixture,
  target: (f) => f.store,
  run,
  ...(check ? { check: async (_result: unknown, f: Fixture, size: number) => await check(f, size) } : {}),
  teardown: async (f) => {
    await f.reg.dispose()
    await f.store.close()
  },
})

/**
 * Plant a read per session of the fixture in front of `method` of the object
 * `owner` picks (the gateway's frame router by default), so the planted loop
 * runs on the frame's path, inside the counted window.
 */
const plantPerSession = (
  method: string,
  owner: (f: Fixture) => object = (f) => f.reg.gateway,
) =>
  (f: Fixture): (() => void) => {
    const target = owner(f) as Record<string, (...args: unknown[]) => unknown>
    const original = target[method]!.bind(target)
    const spy = vi.spyOn(target, method).mockImplementation(async (...args: unknown[]) => {
      for (const id of f.ids) await f.store.sessions.getSession(id)
      return await original(...args)
    })
    return () => spy.mockRestore()
  }

const hostSample = () => ({
  type: 'hostMetrics',
  hostname: 'test',
  sampledAt: new Date().toISOString(),
  memory: { totalBytes: 8_000_000_000, availableBytes: 6_000_000_000, swapTotalBytes: 0, swapFreeBytes: 0 },
  load: { one: 0.1, five: 0.1, fifteen: 0.1, cpuCount: 8 },
  daemonReadiness: { state: 'ready', reason: 'test', quarantinedBindings: 0 },
})

/** A provisioned machine's report, with as many tools as the size so its own length is a dimension too. */
const inventory = (size: number, version: string) =>
  fixtureInventory({
    tools: Array.from({ length: size }, (_, i) => ({ name: `tool-${i}`, installed: true, version })),
  })

describe('daemon frames, the rest: pinned statement counts at 5 and 200', () => {
  // Output is counted in memory and written by the activity flush, which
  // daemon-frames.statement-count.test.ts pins.
  const batch = pin('agentFrameBatch', async (f, size) =>
    await route(f, {
      type: 'agentFrameBatch',
      sessionId: f.ids[0],
      frames: Array.from({ length: size }, () => 'QQ=='),
    }))

  it('agentFrameBatch with as many frames as the size touches no table', async () => {
    await expectConstantStatements(batch, 0)
  })

  it('agentFrameBatch pin is armed', async () => {
    await expectArmed(batch, 0, plantPerSession('routeDaemonFrame'))
  })

  const title = pin(
    'title',
    async (f) => await route(f, { type: 'title', sessionId: f.ids[0], title: 'Fixing the parser', source: 'osc' }),
    async (f) => expect((await f.store.sessions.getSession(f.ids[0]!))?.title).toBe('Fixing the parser'),
  )

  // The write of the session row and its projection pass and publication.
  it('title of one session among many', async () => {
    await expectConstantStatements(title, 10)
  })

  it('title pin is armed', async () => {
    await expectArmed(title, 10, plantPerSession('routeDaemonFrame'))
  })

  const metrics = pin('hostMetrics', async (f) => await route(f, hostSample()))

  // The sample's own reads are pinned in relay.host-sample.statement-count.test.ts;
  // the readiness is held in memory and announced with the machines.
  it('hostMetrics as the daemon sends it, with its readiness', async () => {
    await expectConstantStatements(metrics, 2)
  })

  it('hostMetrics pin is armed', async () => {
    await expectArmed(metrics, 2, plantPerSession('routeDaemonFrame'))
  })

  const report = (version: string) =>
    pin(
      `inventoryReport (${version})`,
      async (f, size) => await route(f, { type: 'inventoryReport', inventory: inventory(size, version) }),
      async (f, size) => {
        expect((await f.store.machines.getMachine(f.store.hostMachineId))?.inventory?.tools).toHaveLength(size)
      },
    )

  // The row's write, the machine projection's publication and the machine
  // broadcast, which reads the fleet once whatever its size.
  it('inventoryReport that changes the machine', async () => {
    await expectConstantStatements(report('1.0.0'), 19)
  })

  it('inventoryReport that repeats the last one', async () => {
    await expectConstantStatements(
      {
        ...report('1.0.0'),
        name: 'inventoryReport (repeat)',
        setup: async (size) => {
          const f = await fixture(size)
          await route(f, { type: 'inventoryReport', inventory: inventory(size, '1.0.0') })
          return f
        },
      },
      6,
    )
  })

  it('inventoryReport pin is armed', async () => {
    await expectArmed(report('1.0.0'), 19, plantPerSession('setMachineInventory', (f) => f.store.machines))
  })
})
