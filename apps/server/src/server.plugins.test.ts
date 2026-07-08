import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PodiumPluginHooks } from './plugins'
import { startServer } from './server'

// The cloud plugin seam (docs/offline-sync-architecture.md §4 rule 2, issue
// #157): a private module composes in at build time via startServer plugins —
// the OSS tree ships none and never references cloud code by path. This test
// plugin exercises exactly what the seam promises: route registration on the
// live Hono app, and typed access to the composed modules/bus/config/role.
describe('startServer plugin seam', () => {
  let stateDir: string
  let handle: Awaited<ReturnType<typeof startServer>>
  let seen: PodiumPluginHooks | undefined
  const registered: string[] = []

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-plugin-'))
    process.env.PODIUM_STATE_DIR = stateDir
    handle = await startServer({
      port: 0,
      plugins: [
        {
          name: 'test-cloud',
          // Async on purpose: startServer must AWAIT registration before it listens.
          register: async (hooks) => {
            seen = hooks
            registered.push('test-cloud')
            hooks.hono.get('/cloud/ping', (c) =>
              c.json({ pong: true, sessions: hooks.modules.sessions.listSessions().length }),
            )
          },
        },
        // Plugins run in order — the seam is a list, not a set.
        { name: 'second', register: () => void registered.push('second') },
      ],
    })
  })

  afterAll(async () => {
    await handle.close()
    delete process.env.PODIUM_STATE_DIR
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('a plugin-registered route is served by the running server', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/cloud/ping`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pong: true, sessions: 0 })
  })

  it('hooks hand the plugin the LIVE composition, not copies', () => {
    expect(seen?.modules).toBe(handle.registry.modules)
    expect(seen?.bus).toBe(handle.registry.bus)
    expect(seen?.role).toEqual({ hub: true })
    expect(seen?.config).toBeTypeOf('object')
  })

  it('plugins register in list order, awaited', () => {
    expect(registered).toEqual(['test-cloud', 'second'])
  })

  it('core surfaces are untouched by plugin registration', async () => {
    const health = await fetch(`http://127.0.0.1:${handle.port}/health`)
    expect(await health.text()).toBe('ok')
  })
})
