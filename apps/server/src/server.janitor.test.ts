import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JanitorHost, StartJanitorWorkerFn } from './janitor-host'
import { startServer } from './server'

/**
 * The server OWNS the janitor thread (PDM-27).
 *
 * Before this, hosting was an option the composition root passed — so whether a
 * server had a janitor was a property of who constructed it, and a root that
 * forgot ran janitor-free forever. `startServer` now starts one itself; the only
 * remaining seam is this test one, which exists so unit tests do not spawn real
 * worker threads, NOT so a caller can opt out.
 *
 * What is asserted here is the wiring: started exactly once, after listen, off
 * the listen path; projected on `/version`; a start failure degraded rather than
 * fatal; closed in ordered shutdown. That a REAL worker then does real
 * maintenance is scripts/server-owned-janitor.integration.test.ts's job.
 */
const priorStateDir = process.env.PODIUM_STATE_DIR

function fakeWorker(overrides: Partial<JanitorHost> = {}): JanitorHost {
  return {
    progressVersion: () => 7,
    state: () => 'running',
    reason: () => undefined,
    close: () => {},
    ...overrides,
  }
}

describe('startServer hosts the janitor itself', () => {
  let stateDir: string
  let handle: Awaited<ReturnType<typeof startServer>> | undefined

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-server-janitor-'))
    process.env.PODIUM_STATE_DIR = stateDir
  })

  afterEach(async () => {
    await handle?.close()
    handle = undefined
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(stateDir, { recursive: true, force: true })
  })

  async function janitorOnVersion(port: number): Promise<{
    state?: string
    progressVersion?: number
    reason?: string
  }> {
    const response = await fetch(`http://127.0.0.1:${port}/version`)
    const body = (await response.json()) as {
      components?: { janitor?: { state?: string; progressVersion?: number; reason?: string } }
    }
    return body.components?.janitor ?? {}
  }

  async function until(ok: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      if (ok()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  it('starts exactly one worker, dialing its own bound port with its own credential', async () => {
    const calls: Array<{ serverUrl: string; token: string }> = []
    const start: StartJanitorWorkerFn = async (options) => {
      calls.push(options)
      return fakeWorker()
    }
    handle = await startServer({ port: 0, janitorWorkerForTests: start })
    await until(() => calls.length === 1, 'the janitor worker to start')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.serverUrl).toContain(`:${handle.port}`)
    expect(calls[0]?.token).toBeTruthy()

    const janitor = await janitorOnVersion(handle.port)
    expect(janitor.state).toBe('running')
    expect(janitor.progressVersion).toBe(7)
  })

  it('serves requests while the janitor is still starting, and never blocks on it', async () => {
    let release = (): void => {}
    const started = new Promise<void>((resolve) => {
      release = resolve
    })
    handle = await startServer({
      port: 0,
      janitorWorkerForTests: async () => {
        await started
        return fakeWorker()
      },
    })
    // `startServer` resolved with the janitor deliberately unfinished: the health
    // endpoint answers, and /version simply carries no janitor component yet.
    const health = await fetch(`http://127.0.0.1:${handle.port}/health`)
    expect(health.status).toBe(200)
    expect((await janitorOnVersion(handle.port)).state).toBeUndefined()
    release()
  })

  it('reports a worker that fails to start as degraded instead of failing the boot', async () => {
    handle = await startServer({
      port: 0,
      janitorWorkerForTests: async () => {
        throw new Error('worker module missing')
      },
    })
    const deadline = Date.now() + 5_000
    let janitor = await janitorOnVersion(handle.port)
    while (janitor.state === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      janitor = await janitorOnVersion(handle.port)
    }
    expect(janitor.state).toBe('degraded')
    expect(janitor.reason).toMatch(/worker module missing/)
  })

  it('closes the janitor in ordered shutdown', async () => {
    let closed = 0
    let hosted = false
    handle = await startServer({
      port: 0,
      janitorWorkerForTests: async () => {
        hosted = true
        return fakeWorker({ close: () => (closed += 1) })
      },
    })
    await until(() => hosted, 'the janitor worker to start')
    const started = handle
    handle = undefined
    await started.close()
    expect(closed).toBe(1)
  })
})
