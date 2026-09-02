import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer } from './server'

/**
 * THE CLAIM THIS CHANGE MAKES, END TO END (PDM-26).
 *
 * An empty state directory plus the cloud boot profile is a SERVING instance:
 * no interactive setup, no pre-seeded `config.json`, and nothing for a human to
 * click. Every piece of that is testable on its own — the accessors, readiness,
 * the setup route — and none of those tests can fail the way this deployment
 * actually fails, which is by one of them not being wired to the next.
 *
 * A REAL BOOTED SERVER for that reason: readiness is derived in `server.ts` from
 * an env mode this file resolves, the setup route reports a layer the accessor
 * decides, and the whole point is that those three agree.
 *
 * In the ORDINARY lane, not `*.integration.*`, which in this repo means the
 * heavyweight suite behind a build and the whole-host lease. This boots the same
 * way `server.activation-lockout.test.ts` does — a listener on port 0 and a temp
 * state dir — and belongs where that one is.
 */
const priorEnv = {
  stateDir: process.env.PODIUM_STATE_DIR,
  mode: process.env.PODIUM_MODE,
  publicUrl: process.env.PODIUM_PUBLIC_URL,
  appUrl: process.env.PODIUM_APP_URL,
  allowedOrigins: process.env.PODIUM_ALLOWED_ORIGINS,
  updateScope: process.env.PODIUM_UPDATE_SCOPE,
  transcriptLake: process.env.PODIUM_TRANSCRIPT_LAKE,
}

describe('a headless boot from the environment alone', () => {
  let stateDir: string
  let handle: Awaited<ReturnType<typeof startServer>>
  const url = (path: string): string => `http://127.0.0.1:${handle.port}${path}`

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-headless-boot-'))
    // The cloud boot profile, minus the parts a test cannot have (a real
    // hostname, a first-admin secret). NOTHING is written into the state dir.
    process.env.PODIUM_STATE_DIR = stateDir
    process.env.PODIUM_MODE = 'server'
    process.env.PODIUM_PUBLIC_URL = 'https://api.meetpodium.com'
    process.env.PODIUM_APP_URL = 'https://app.meetpodium.com'
    process.env.PODIUM_ALLOWED_ORIGINS = 'https://app.meetpodium.com'
    process.env.PODIUM_UPDATE_SCOPE = 'fleet-only'
    process.env.PODIUM_TRANSCRIPT_LAKE = 'off'
    handle = await startServer({ port: 0 })
  })

  afterAll(async () => {
    await handle.close()
    for (const [key, value] of [
      ['PODIUM_STATE_DIR', priorEnv.stateDir],
      ['PODIUM_MODE', priorEnv.mode],
      ['PODIUM_PUBLIC_URL', priorEnv.publicUrl],
      ['PODIUM_APP_URL', priorEnv.appUrl],
      ['PODIUM_ALLOWED_ORIGINS', priorEnv.allowedOrigins],
      ['PODIUM_UPDATE_SCOPE', priorEnv.updateScope],
      ['PODIUM_TRANSCRIPT_LAKE', priorEnv.transcriptLake],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('serves: the data plane is available and /readiness answers 200', async () => {
    const response = await fetch(url('/readiness'))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ dataPlane: 'available' })
  })

  it('asks nobody to finish setup, and says which layer decided the mode', async () => {
    const setup = (await (await fetch(url('/setup/config'))).json()) as Record<string, unknown>
    expect(setup).toMatchObject({ needsSetup: false, mode: 'server', modeSource: 'env' })
  })

  it('writes no config.json — the deployment speaks to this instance only through env', () => {
    expect(existsSync(join(stateDir, 'config.json'))).toBe(false)
  })

  it('does not mirror transcripts, so nothing is written to a disk that may not persist', () => {
    expect(existsSync(join(stateDir, 'transcripts'))).toBe(false)
  })
})
