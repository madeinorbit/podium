import type { Inventory } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The handler builds inventory via @podium/harness, which shells out to real CLIs.
// Mock it so the test exercises the daemon's report/cache/rebuild logic in
// isolation without spawning anything. The mock returns the MACHINE-KEYED shape
// (POD-397): the probe hands back the machine its facts are about, and the handler
// must send THAT id rather than reaching for ctx.machineId a second time.
const buildInventory = vi.fn<() => Promise<Inventory>>()
// Same reasoning for the model probe (POD-1466): it shells out to grok/cursor/
// opencode/codex and calls the Anthropic models API. The mock records the OPTIONS
// it was handed, because "which home did it read the claude login from" is the
// part of the daemon's wiring worth pinning.
const probeModels = vi.fn<(opts: unknown) => Promise<Record<string, unknown[]>>>()
vi.mock('@podium/harness', () => ({
  buildMachineInventory: async (opts: { machineId: string }) => ({
    machineId: opts.machineId,
    inventory: await buildInventory(),
  }),
  probeAllModels: (opts: unknown) => probeModels(opts),
}))

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

describe('daemon model probe (POD-1466)', () => {
  const MODELS = { grok: [{ value: 'grok-4.5', label: 'grok-4.5' }] }

  beforeEach(() => probeModels.mockReset().mockResolvedValue(MODELS))
  afterEach(() => vi.restoreAllMocks())

  it('answers modelProbeRequest with the models of the host it runs on, by requestId', async () => {
    const { ctx, sent } = makeCtx()
    inventoryHandlers.modelProbeRequest(ctx, { type: 'modelProbeRequest', requestId: 'req-1' })
    await vi.waitFor(() =>
      expect(sent).toEqual([{ type: 'modelProbeResult', requestId: 'req-1', byAgent: MODELS }]),
    )
  })

  it('reads the claude login from the daemon own home, not the process home', async () => {
    const { ctx } = makeCtx()
    inventoryHandlers.modelProbeRequest(ctx, { type: 'modelProbeRequest', requestId: 'req-2' })
    await vi.waitFor(() => expect(probeModels).toHaveBeenCalled())
    expect(probeModels.mock.calls[0]?.[0]).toMatchObject({ claude: { homeDir: ctx.homeDir } })
  })

  // A silent daemon would only burn the server correlator's 20s timeout, and the
  // catalog would learn nothing either way — so a broken probe still ANSWERS.
  it('still answers, with an empty catalog, when the probe throws', async () => {
    const { ctx, sent } = makeCtx()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    probeModels.mockRejectedValueOnce(new Error('no cli'))
    inventoryHandlers.modelProbeRequest(ctx, { type: 'modelProbeRequest', requestId: 'req-3' })
    await vi.waitFor(() =>
      expect(sent).toEqual([{ type: 'modelProbeResult', requestId: 'req-3', byAgent: {} }]),
    )
  })
})
