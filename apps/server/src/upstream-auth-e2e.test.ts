import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { startServer } from './server'
import { SessionStore } from './store'
import { UpstreamSync } from './upstream'

// Token auth against a PASSWORD-PROTECTED hub (docs/spec/node-hub-sync.md §4):
// a bad token is a failed upgrade — clean retry with backoff, no crash loop —
// and the hub-minted token (an ordinary client_sessions row) gets through the
// same cookie gate a browser session does.
describe('upstream sync token auth e2e (password-gated hub)', () => {
  let hubStateDir: string
  let hub: Awaited<ReturnType<typeof startServer>>

  const until = async (pred: () => boolean, ms = 5000): Promise<void> => {
    const deadline = Date.now() + ms
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for condition')
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  beforeAll(async () => {
    hubStateDir = mkdtempSync(join(tmpdir(), 'podium-upstream-auth-'))
    process.env.PODIUM_STATE_DIR = hubStateDir
    // applyEnvPassword in startServer picks this up → /client + /trpc need the cookie.
    process.env.PODIUM_PASSWORD = 'hub-secret-pw'
    hub = await startServer({ port: 0 })
  })

  afterAll(async () => {
    await hub.close()
    rmSync(hubStateDir, { recursive: true, force: true })
    delete process.env.PODIUM_STATE_DIR
    delete process.env.PODIUM_PASSWORD
  })

  function makeNode(token: string) {
    const store = new SessionStore(':memory:')
    const registry = new SessionRegistry(store)
    const sync = new UpstreamSync({
      url: `http://127.0.0.1:${hub.port}`,
      token,
      mirror: registry,
      store: store.settings,
      backoff: { minMs: 25, maxMs: 100 },
    })
    return { store, registry, sync }
  }

  it('a bad token retries with backoff — logged, never a crash loop', async () => {
    const { registry, store, sync } = makeNode('not-a-real-token')
    sync.start()
    // Rejected upgrades keep retrying (backoff), and nothing ever syncs.
    await until(() => sync.connectAttempts >= 3)
    expect(sync.lastCatchUpKind).toBeNull()
    expect(registry.modules.sessions.listSessions().filter((s) => s.viaHub)).toHaveLength(0)
    sync.stop()
    registry.dispose()
    store.close()
  })

  it('a hub-minted token authenticates the WS upgrade AND the tRPC catch-up', async () => {
    hub.registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/hub/authed' })
    const token = hub.registry.mintUpstreamToken()
    const { registry, store, sync } = makeNode(token)
    sync.start()
    await until(() => registry.modules.sessions.listSessions().some((s) => s.viaHub && s.cwd === '/hub/authed'))
    expect(sync.lastCatchUpKind).toBe('snapshot')
    sync.stop()
    registry.dispose()
    store.close()
  })
})
