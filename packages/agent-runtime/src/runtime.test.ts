import { unsupported } from '@podium/harness'
import type { Inventory } from '@podium/model'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionHandle, RuntimeDriver } from './driver.js'
import { createAgentRuntime, type AgentRuntimeDriverSource } from './runtime.js'
import type { SessionSpec } from './session-spec.js'
import { createFakeDriver, resetFakeRuntime } from './testing/fake-driver.js'

const INVENTORY: Inventory = {
  os: 'linux',
  arch: 'x64',
  podiumVersion: 'test',
  agents: [],
  tools: [],
}

const PRIMITIVE_SUPPORT = {
  import: { supported: true, value: true },
  list: { scope: 'process-table' },
} as const

function spec(): SessionSpec {
  return {
    harness: 'codex',
    selection: {
      auth: 'subscription',
      platform: 'linux',
      available: ['codex-app-server'],
      preference: 'codex-app-server',
    },
    workdir: '/tmp/runtime-composition',
    model: {},
    instructions: unsupported('fixture'),
    mcpServers: unsupported('fixture'),
  }
}

function source(
  driver: RuntimeDriver,
  initial: readonly AgentSessionHandle[] = [],
): AgentRuntimeDriverSource {
  const indexed = [...initial]
  const remember = (handle: AgentSessionHandle) => {
    indexed.push(handle)
    return handle
  }
  const owned: RuntimeDriver = {
    ...driver,
    create: async (sessionSpec) => remember(await driver.create(sessionSpec)),
    resume: async (ref, sessionSpec) => remember(await driver.resume(ref, sessionSpec)),
    adopt: async (binding) => remember(await driver.adopt(binding)),
  }
  return {
    driverFor: (harness, driverId) =>
      owned.harness === harness && owned.id === driverId ? owned : undefined,
    handleFor: (sessionId) => indexed.find((handle) => handle.binding.sessionId === sessionId),
    bindings: () => indexed.map((handle) => handle.binding),
  }
}

describe('createAgentRuntime', () => {
  beforeEach(() => resetFakeRuntime())

  it('owns selection, capabilities, inventory, and authoritative process listing', async () => {
    const driver = createFakeDriver({ harness: 'codex', id: 'codex-app-server' })
    const inventory = vi.fn(async () => INVENTORY)
    const driverSource = source(driver)
    const list = vi.fn(async () => [])
    const runtime = createAgentRuntime({
      sources: () => [driverSource],
      primitiveSupport: PRIMITIVE_SUPPORT,
      landArchive: async (archive) => archive.resume,
      list,
      inventory,
    })

    const handle = await runtime.create(spec())

    expect(runtime.handleFor(handle.binding.sessionId)).toBe(handle)
    expect(runtime.has(handle.binding.sessionId)).toBe(true)
    expect(runtime.capabilities('codex', 'codex-app-server')).toEqual(driver.capabilities())
    await expect(runtime.inventory()).resolves.toBe(INVENTORY)
    await expect(runtime.list()).resolves.toEqual([])
    expect(inventory).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledOnce()
  })

  it('lands an archive before resuming it through the selected driver', async () => {
    const driver = createFakeDriver({ harness: 'codex', id: 'codex-app-server' })
    const driverSource = source(driver)
    const original = await driver.create(spec())
    const archive = await original.export()
    const landArchive = vi.fn(async () => archive.resume)
    const runtime = createAgentRuntime({
      sources: () => [driverSource],
      primitiveSupport: PRIMITIVE_SUPPORT,
      landArchive,
      list: async () => [],
      inventory: async () => INVENTORY,
    })

    const imported = await runtime.import(archive, spec())

    expect(landArchive).toHaveBeenCalledWith(archive, spec())
    expect(imported.binding.resume).toEqual(archive.resume)
    await expect(runtime.import({ ...archive, harness: 'opencode' }, spec())).rejects.toThrow(
      "archive harness 'opencode' cannot be imported as 'codex'",
    )
  })

  it('adopts by exact harness and driver and detects duplicate registry ownership', async () => {
    const driver = createFakeDriver({ harness: 'codex', id: 'codex-app-server' })
    const live = await driver.create(spec())
    const driverSource = source(driver)
    const binding = live.binding
    driver.control.restartSupervisor()

    const runtime = createAgentRuntime({
      sources: () => [driverSource],
      primitiveSupport: PRIMITIVE_SUPPORT,
      landArchive: async (archive) => archive.resume,
      list: async () => [binding],
      inventory: async () => INVENTORY,
    })
    const adopted = await runtime.adopt(binding)
    expect(runtime.handleFor(binding.sessionId)).toBe(adopted)

    const duplicate = {
      ...adopted,
      binding: { ...adopted.binding, driver: 'generic-pty' as const },
    }
    const conflicted = createAgentRuntime({
      sources: () => [source(driver, [adopted]), source(driver, [duplicate])],
      primitiveSupport: PRIMITIVE_SUPPORT,
      landArchive: async (archive) => archive.resume,
      list: async () => [],
      inventory: async () => INVENTORY,
    })

    expect(() => conflicted.registeredBindings()).toThrow(
      "session '" + binding.sessionId + "' is indexed by more than one runtime driver",
    )
  })
})
