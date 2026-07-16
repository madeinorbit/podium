/**
 * `telemetry.*` tRPC tests [spec:SP-f933].
 *
 * The property worth pinning: this router is the SAME switch as `podium
 * telemetry` — it reads and writes config.json (D8), not the settings blob, so
 * the web toggle works with the CLI and survives with no server running.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig } from '@podium/runtime/config'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OPERATOR } from './issue-authz'
import { SuperagentService } from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'

function caller(telemetry?: { emitter: { buildUsageReport: () => unknown } }) {
  const registry = new SessionRegistry()
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = new SuperagentService(registry.modules, repos, registry.sessionStore)
  return appRouter.createCaller({
    registry,
    repos,
    superagent,
    capability: OPERATOR,
    ...(telemetry ? { telemetry: telemetry as never } : {}),
  })
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-telemetry-rtr-'))
  process.env.PODIUM_STATE_DIR = dir
  saveConfig({ mode: 'all-in-one' })
})
afterEach(() => {
  delete process.env.PODIUM_STATE_DIR
  delete process.env.DO_NOT_TRACK
  rmSync(dir, { recursive: true, force: true })
})

describe('telemetry.state', () => {
  it('reports absent tiers and no install id on a fresh box', async () => {
    expect(await caller().telemetry.state()).toMatchObject({
      usage: 'absent',
      crash: 'absent',
      endpoint: 'https://telemetry.podium.dev',
    })
  })

  it('surfaces the kill switch so the UI can explain a disabled toggle', async () => {
    process.env.DO_NOT_TRACK = '1'
    expect(await caller().telemetry.state()).toMatchObject({ suppressedBy: 'DO_NOT_TRACK' })
  })
})

describe('telemetry.set', () => {
  it('writes config.json — the same switch as `podium telemetry`, not the settings blob', async () => {
    await caller().telemetry.set({ usage: 'on' })
    expect(loadConfig().telemetry?.usage).toBe('on')
    expect(loadConfig().telemetry?.installId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('persists immediately — one tier at a time, no Save button to lose', async () => {
    await caller().telemetry.set({ usage: 'on' })
    await caller().telemetry.set({ crash: 'on' })
    expect(loadConfig().telemetry).toMatchObject({ usage: 'on', crash: 'on' })
    await caller().telemetry.set({ usage: 'off' })
    expect(loadConfig().telemetry).toMatchObject({ usage: 'off', crash: 'on' })
  })

  it('rejects an empty call rather than silently doing nothing', async () => {
    await expect(caller().telemetry.set({})).rejects.toThrow()
  })

  it('opting out never mints an id', async () => {
    await caller().telemetry.set({ usage: 'off', crash: 'off' })
    expect(loadConfig().telemetry?.installId).toBeUndefined()
  })
})

describe('telemetry.resetId', () => {
  it('mints a new id', async () => {
    await caller().telemetry.set({ usage: 'on' })
    const before = loadConfig().telemetry?.installId
    const state = await caller().telemetry.resetId()
    expect(state.installId).not.toBe(before)
    expect(loadConfig().telemetry?.installId).toBe(state.installId)
  })
})

describe('telemetry.preview', () => {
  it('renders the REAL pending report when an emitter is wired', async () => {
    const report = { schema: 1, sessions: { codex: 2 } }
    expect(await caller({ emitter: { buildUsageReport: () => report } }).telemetry.preview()).toBe(
      report,
    )
  })

  it('is null with no emitter (nothing real to show yet)', async () => {
    expect(await caller().telemetry.preview()).toBeNull()
  })
})
