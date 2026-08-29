import type { Inventory } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The machine runtime owns the real CLI probe. This fake keeps the test on the
// report/cache/rebuild behavior and proves the handler enters through that root.
const buildInventory = vi.fn<() => Promise<Inventory>>()
// Same reasoning for the model probe (POD-1466): it shells out to grok/cursor/
// opencode/codex and calls the Anthropic models API. The mock records the OPTIONS
// it was handed, because "which home did it read the claude login from" is the
// part of the daemon's wiring worth pinning.
const probeModels = vi.fn<(opts: unknown) => Promise<Record<string, unknown[]>>>()
vi.mock('@podium/harness', () => ({
  probeAllModels: (opts: unknown) => probeModels(opts),
}))
vi.mock('../runtime/codex-app-server', () => ({
  codexAppServerVersionProbe: vi.fn(async () => ({ drivable: false })),
}))
vi.mock('../runtime/grok-acp-server', () => ({
  grokAcpVersionProbe: vi.fn(async () => ({ drivable: false })),
}))
vi.mock('../runtime/opencode-server', () => ({
  opencodeVersionProbe: vi.fn(async () => ({ drivable: false })),
}))
vi.mock('../runtime/registry', () => ({ claudeSdkTosAcceptedByEnv: () => false }))

import type { DaemonContext } from './context'
import {
  inventoryHandlers,
  reportInventory,
  startInventoryRefresh,
  terminalRuntimeDriverInventory,
} from './inventory'

const INV: Inventory = {
  os: 'linux',
  arch: 'x64',
  agents: [{ kind: 'claude-code', installed: true, login: { state: 'in' } }],
  tools: [{ name: 'gh', installed: false }],
}
const withTerminalDrivers = (inventory: Inventory): Inventory => ({
  ...inventory,
  runtimeDrivers: terminalRuntimeDriverInventory(),
})
const LOGGED_OUT_INV: Inventory = {
  ...INV,
  agents: [{ kind: 'claude-code', installed: true, login: { state: 'out' } }],
}

const TIMED_OUT_INV: Inventory = {
  ...INV,
  agents: [
    {
      kind: 'claude-code',
      installed: null,
      probeError: { reason: 'timed-out', timeoutMs: 60_000 },
      login: { state: 'in' },
    },
  ],
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
    agentRuntime: { inventory: () => buildInventory() },
  } as unknown as DaemonContext
  return { ctx, sent }
}

function makeRuntimeCtx(): {
  ctx: DaemonContext
  sent: DaemonMessage[]
  current: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
  reprobe: ReturnType<typeof vi.fn>
} {
  const sent: DaemonMessage[] = []
  const snapshot = { inventory: withTerminalDrivers(INV) }
  const current = vi.fn(async () => snapshot)
  const refresh = vi.fn(async () => snapshot)
  const reprobe = vi.fn(async () => snapshot)
  const ctx = {
    send: (message: DaemonMessage) => sent.push(message),
    machineId: 'm-runtime',
    agentRuntime: { inventory: async () => INV },
    harnessRuntime: {
      current,
      refresh,
      reprobe,
      isCurrent: (candidate: unknown) => candidate === snapshot,
    },
  } as unknown as DaemonContext
  return { ctx, sent, current, refresh, reprobe }
}

describe('daemon inventory reporting (#222)', () => {
  beforeEach(() => buildInventory.mockReset().mockResolvedValue(INV))
  afterEach(() => vi.restoreAllMocks())

  it('sends an inventoryReport frame carrying the built inventory', async () => {
    const { ctx, sent } = makeCtx()
    await reportInventory(ctx)
    expect(sent).toEqual([{ type: 'inventoryReport', machineId: 'm-test', inventory: withTerminalDrivers(INV) }])
  })

  it('re-probes the production runtime on reconnect instead of replaying its snapshot', async () => {
    const { ctx, sent, current, reprobe } = makeRuntimeCtx()
    await reportInventory(ctx)
    expect(reprobe).toHaveBeenCalledTimes(1)
    expect(current).not.toHaveBeenCalled()
    expect(sent).toEqual([{ type: 'inventoryReport', machineId: 'm-runtime', inventory: withTerminalDrivers(INV) }])
  })

  it('publishes ordinary inventory before a delayed headless-driver probe settles', async () => {
    const { ctx, sent } = makeRuntimeCtx()
    let resolveDrivers!: (drivers: NonNullable<Inventory['runtimeDrivers']>) => void
    const drivers = new Promise<NonNullable<Inventory['runtimeDrivers']>>((resolve) => {
      resolveDrivers = resolve
    })

    await reportInventory(ctx, { runtimeDrivers: () => drivers })

    expect(sent).toEqual([
      { type: 'inventoryReport', machineId: 'm-runtime', inventory: withTerminalDrivers(INV) },
    ])
    resolveDrivers([
      ...terminalRuntimeDriverInventory(),
      { harness: 'codex', id: 'codex-app-server', family: 'server' },
    ])
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]).toEqual({
      type: 'inventoryReport',
      machineId: 'm-runtime',
      inventory: {
        ...INV,
        runtimeDrivers: [
          ...terminalRuntimeDriverInventory(),
          { harness: 'codex', id: 'codex-app-server', family: 'server' },
        ],
      },
    })
  })

  it('routes inventoryRequest through the single-flight re-probe', async () => {
    const { ctx, refresh, reprobe } = makeRuntimeCtx()
    inventoryHandlers.inventoryRequest(ctx, { type: 'inventoryRequest' })
    await vi.waitFor(() => expect(reprobe).toHaveBeenCalledTimes(1))
    expect(refresh).not.toHaveBeenCalled()
  })

  it('caches: a second report (reconnect) re-sends without rebuilding', async () => {
    const { ctx, sent } = makeCtx()
    await reportInventory(ctx)
    await reportInventory(ctx)
    expect(buildInventory).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(2)
  })

  it('does not cache a timeout, so a quieter reconnect can succeed', async () => {
    const { ctx, sent } = makeCtx()
    buildInventory.mockResolvedValueOnce(TIMED_OUT_INV).mockResolvedValueOnce(INV)

    await reportInventory(ctx)
    await reportInventory(ctx)

    expect(buildInventory).toHaveBeenCalledTimes(2)
    expect(sent).toEqual([
      { type: 'inventoryReport', machineId: 'm-test', inventory: withTerminalDrivers(TIMED_OUT_INV) },
      { type: 'inventoryReport', machineId: 'm-test', inventory: withTerminalDrivers(INV) },
    ])
  })

  it('inventoryRequest forces a rebuild', async () => {
    const { ctx } = makeCtx()
    await reportInventory(ctx) // seed the cache
    inventoryHandlers.inventoryRequest(ctx, { type: 'inventoryRequest' })
    await Promise.resolve() // let the void promise settle
    await vi.waitFor(() => expect(buildInventory).toHaveBeenCalledTimes(2))
  })

  it('an explicit reprobe refreshes the cached fallback inventory', async () => {
    const { ctx } = makeCtx()
    await reportInventory(ctx)
    await reportInventory(ctx, { reprobe: true })
    expect(buildInventory).toHaveBeenCalledTimes(2)
  })

  it('periodically rebuilds inventory and stops cleanly', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, sent } = makeCtx()
      const stop = startInventoryRefresh(ctx, 100)
      await vi.advanceTimersByTimeAsync(100)
      expect(buildInventory).toHaveBeenCalledTimes(1)
      expect(sent).toEqual([{ type: 'inventoryReport', machineId: 'm-test', inventory: withTerminalDrivers(INV) }])
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
    expect(buildInventory).toHaveBeenCalledTimes(1)
    resolveStale(LOGGED_OUT_INV)
    await vi.waitFor(() => expect(buildInventory).toHaveBeenCalledTimes(2))
    resolveFresh(INV)
    await Promise.all([stale, fresh])

    expect(sent).toEqual([{ type: 'inventoryReport', machineId: 'm-test', inventory: withTerminalDrivers(INV) }])
  })

  it('coalesces forced rebuilds behind an in-flight probe wave', async () => {
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

    const initial = reportInventory(ctx)
    const firstForced = reportInventory(ctx, { rebuild: true })
    const secondForced = reportInventory(ctx, { rebuild: true })
    expect(buildInventory).toHaveBeenCalledTimes(1)

    resolveStale(LOGGED_OUT_INV)
    await vi.waitFor(() => expect(buildInventory).toHaveBeenCalledTimes(2))
    resolveFresh(INV)
    await Promise.all([initial, firstForced, secondForced])

    expect(buildInventory).toHaveBeenCalledTimes(2)
    expect(sent).toEqual([{ type: 'inventoryReport', machineId: 'm-test', inventory: withTerminalDrivers(INV) }])
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
