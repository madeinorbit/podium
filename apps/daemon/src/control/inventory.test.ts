import type { DaemonMessage, Inventory } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The handler builds inventory via @podium/agent-bridge, which shells out to real
// CLIs. Mock it so the test exercises the daemon's report/cache/rebuild logic in
// isolation without spawning anything.
const buildInventory = vi.fn<() => Promise<Inventory>>()
vi.mock('@podium/agent-bridge', () => ({ buildInventory: () => buildInventory() }))

import type { DaemonContext } from './context'
import { inventoryHandlers, reportInventory, startInventoryRefresh } from './inventory'

const INV: Inventory = {
  os: 'linux',
  arch: 'x64',
  agents: [{ kind: 'claude-code', installed: true, login: { state: 'in' } }],
  tools: [{ name: 'gh', installed: false }],
}

const LOGGED_OUT_INV: Inventory = {
  ...INV,
  agents: [{ kind: 'claude-code', installed: true, login: { state: 'out' } }],
}

let seq = 0
/** A ctx that only wires what reportInventory touches, with a fresh homeDir per
 *  test so the module-global cache never bleeds across cases. */
function makeCtx(): { ctx: DaemonContext; sent: DaemonMessage[] } {
  const sent: DaemonMessage[] = []
  const ctx = {
    send: (m: DaemonMessage) => sent.push(m),
    machineId: 'm-test',
    homeDir: `/fake/home/${seq++}`,
  } as unknown as DaemonContext
  return { ctx, sent }
}

describe('daemon inventory reporting (#222)', () => {
  beforeEach(() => buildInventory.mockReset().mockResolvedValue(INV))
  afterEach(() => vi.restoreAllMocks())

  it('sends an inventoryReport frame carrying the built inventory', async () => {
    const { ctx, sent } = makeCtx()
    await reportInventory(ctx)
    expect(sent).toEqual([{ type: 'inventoryReport', machineId: 'm-test', inventory: INV }])
  })

  it('caches: a second report (reconnect) re-sends without rebuilding', async () => {
    const { ctx, sent } = makeCtx()
    await reportInventory(ctx)
    await reportInventory(ctx)
    expect(buildInventory).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(2)
  })

  it('inventoryRequest forces a rebuild', async () => {
    const { ctx } = makeCtx()
    await reportInventory(ctx) // seed the cache
    inventoryHandlers.inventoryRequest(ctx, { type: 'inventoryRequest' })
    await Promise.resolve() // let the void promise settle
    await vi.waitFor(() => expect(buildInventory).toHaveBeenCalledTimes(2))
  })

  it('periodically rebuilds inventory and stops cleanly', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, sent } = makeCtx()
      const stop = startInventoryRefresh(ctx, 100)
      await vi.advanceTimersByTimeAsync(100)
      expect(buildInventory).toHaveBeenCalledTimes(1)
      expect(sent).toEqual([{ type: 'inventoryReport', machineId: 'm-test', inventory: INV }])
      stop()
      await vi.advanceTimersByTimeAsync(200)
      expect(buildInventory).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not publish a pre-credential probe after its forced rebuild', async () => {
    const { ctx, sent } = makeCtx()
    let resolveStale!: (inventory: Inventory) => void
    let resolveFresh!: (inventory: Inventory) => void
    buildInventory
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveStale = resolve
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFresh = resolve
        }),
      )

    const stale = reportInventory(ctx)
    const fresh = reportInventory(ctx, { rebuild: true })
    resolveFresh(INV)
    await fresh
    resolveStale(LOGGED_OUT_INV)
    await stale

    expect(sent).toEqual([{ type: 'inventoryReport', machineId: 'm-test', inventory: INV }])
  })

  it('a failed build is never cached, never throws, and the next call retries', async () => {
    const { ctx, sent } = makeCtx()
    buildInventory.mockRejectedValueOnce(new Error('probe blew up'))
    await expect(reportInventory(ctx)).resolves.toBeUndefined() // swallowed
    expect(sent).toHaveLength(0)
    await reportInventory(ctx) // retries because the failure wasn't cached
    expect(buildInventory).toHaveBeenCalledTimes(2)
    expect(sent).toHaveLength(1)
  })
})
