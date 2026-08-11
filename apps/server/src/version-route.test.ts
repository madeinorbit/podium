import { MIN_SUPPORTED_VERSION, WIRE_VERSION } from '@podium/protocol'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerVersionRoute } from './server'

type VersionBody = {
  wireVersion: number
  appVersion: string
  instanceId: string
  minSupportedVersion: number
}

async function fetchVersion(
  instanceId = 'default',
  appVersion?: () => string,
): Promise<{ status: number; body: VersionBody }> {
  const app = new Hono()
  registerVersionRoute(app, { instanceId, ...(appVersion ? { appVersion } : {}) })
  const res = await app.request('/version')
  return { status: res.status, body: (await res.json()) as VersionBody }
}

describe('GET /version', () => {
  // Stripped-down route tests fall back to process.env.PODIUM_APP_VERSION; startServer
  // injects the source identity captured at boot. Save/restore the env around each test
  // so the global mutation cannot leak to sibling suites.
  let savedAppVersion: string | undefined
  let savedInstance: string | undefined
  beforeEach(() => {
    savedAppVersion = process.env.PODIUM_APP_VERSION
    savedInstance = process.env.PODIUM_INSTANCE
  })
  afterEach(() => {
    if (savedAppVersion === undefined) delete process.env.PODIUM_APP_VERSION
    else process.env.PODIUM_APP_VERSION = savedAppVersion
    if (savedInstance === undefined) delete process.env.PODIUM_INSTANCE
    else process.env.PODIUM_INSTANCE = savedInstance
  })

  it('reports the wire + app version as JSON', async () => {
    const { status, body } = await fetchVersion()
    expect(status).toBe(200)
    expect(body.wireVersion).toBe(WIRE_VERSION)
    expect(body.minSupportedVersion).toBe(MIN_SUPPORTED_VERSION)
    expect(typeof body.appVersion).toBe('string')
    expect(body.instanceId).toBe('default')
  })

  it('reports the baked PODIUM_APP_VERSION as appVersion', async () => {
    process.env.PODIUM_APP_VERSION = '9.9.9'
    const { status, body } = await fetchVersion()
    expect(status).toBe(200)
    expect(body.appVersion).toBe('9.9.9')
    // Full contract shape stays intact alongside the baked version.
    expect(body.wireVersion).toBe(WIRE_VERSION)
    expect(body.minSupportedVersion).toBe(MIN_SUPPORTED_VERSION)
  })

  it('reports the source identity captured by the server at boot', async () => {
    delete process.env.PODIUM_APP_VERSION
    const { body } = await fetchVersion('default', () => 'dev+abc1234')
    expect(body.appVersion).toBe('dev+abc1234')
  })

  it('reports the selected instance identity', async () => {
    process.env.PODIUM_INSTANCE = 'wrong-ambient-value'
    const { body } = await fetchVersion('blue')
    expect(body.instanceId).toBe('blue')
  })

  it("falls back to 'dev' when PODIUM_APP_VERSION is unset", async () => {
    delete process.env.PODIUM_APP_VERSION
    const { body } = await fetchVersion()
    expect(body.appVersion).toBe('dev')
  })
})
