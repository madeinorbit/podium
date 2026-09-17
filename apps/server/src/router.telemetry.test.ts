/**
 * `telemetry.*` tRPC tests [spec:SP-f933].
 *
 * The property worth pinning: this router is the SAME switch as `podium
 * telemetry` operator overrides remain above the database settings row. UI
 * choices write the row without changing config.json and survives with no server running.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig } from '@podium/runtime/config'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolvePrincipal } from './command-principal'

import { SuperagentService } from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { OPERATOR } from './test-support/capabilities'

async function makeCaller(telemetry?: { emitter: { buildUsageReport: () => unknown } }) {
  const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = await SuperagentService.create(registry.modules, repos, registry.sessionStore)
  return appRouter.createCaller({
    registry,
    repos,
    superagent,
    capability: OPERATOR,
    principal: resolvePrincipal(OPERATOR, { parentSessionOf: () => undefined }),
    ...(telemetry ? { telemetry: telemetry as never } : {}),
  })
}

// Commands and reads in one test address one instance, not independent in-memory stores.
let harness: ReturnType<typeof makeCaller> | undefined
function caller(telemetry?: { emitter: { buildUsageReport: () => unknown } }) {
  return harness ??= makeCaller(telemetry)
}

let dir: string
beforeEach(() => {
  harness = undefined
  dir = mkdtempSync(join(tmpdir(), 'podium-telemetry-rtr-'))
  process.env.PODIUM_STATE_DIR = dir
  saveConfig({ mode: 'all-in-one' })
})
afterEach(() => {
  process.env.PODIUM_STATE_DIR = priorStateDir
  delete process.env.DO_NOT_TRACK
  rmSync(dir, { recursive: true, force: true })
})

const priorStateDir = process.env.PODIUM_STATE_DIR!

describe('telemetry.state', () => {
  it('reports absent tiers and no install id on a fresh box', async () => {
    expect(await (await caller()).telemetry.state()).toMatchObject({
      usage: 'absent',
      crash: 'absent',
      endpoint: 'https://pulse.podium.do/v1/u',
    })
  })

  it('surfaces the kill switch so the UI can explain a disabled toggle', async () => {
    process.env.DO_NOT_TRACK = '1'
    expect(await (await caller()).telemetry.state()).toMatchObject({ suppressedBy: 'DO_NOT_TRACK' })
  })
})

describe('telemetry.set', () => {
  it('writes the database and leaves config.json unchanged', async () => {
    await (await caller()).telemetry.set({ usage: 'on' })
    expect(loadConfig().telemetry?.usage).toBeUndefined()
    expect((await (await caller()).telemetry.state()).usage).toBe('on')
    expect((await (await caller()).telemetry.state()).installId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('persists immediately — one tier at a time, no Save button to lose', async () => {
    await (await caller()).telemetry.set({ usage: 'on' })
    await (await caller()).telemetry.set({ crash: 'on' })
    expect(await (await caller()).telemetry.state()).toMatchObject({ usage: 'on', crash: 'on' })
    await (await caller()).telemetry.set({ usage: 'off' })
    expect(await (await caller()).telemetry.state()).toMatchObject({ usage: 'off', crash: 'on' })
  })

  it('rejects an empty call rather than silently doing nothing', async () => {
    await expect((await caller()).telemetry.set({})).rejects.toThrow()
  })

  it('opting out never mints an id', async () => {
    await (await caller()).telemetry.set({ usage: 'off', crash: 'off' })
    expect((await (await caller()).telemetry.state()).installId).toBeUndefined()
  })
})

describe('telemetry.resetId', () => {
  it('mints a new id', async () => {
    await (await caller()).telemetry.set({ usage: 'on' })
    const before = (await (await caller()).telemetry.state()).installId
    const state = await (await caller()).telemetry.resetId()
    expect(state.installId).not.toBe(before)
    expect((await (await caller()).telemetry.state()).installId).toBe(state.installId)
  })
})

describe('telemetry.preview', () => {
  it('renders the REAL pending report when an emitter is wired', async () => {
    const report = { schema: 1, sessions: { codex: 2 } }
    expect(await (await caller({ emitter: { buildUsageReport: () => report } })).telemetry.preview()).toBe(
      report,
    )
  })

  it('is null with no emitter (nothing real to show yet)', async () => {
    expect(await (await caller()).telemetry.preview()).toBeNull()
  })
})
