import { parseServerVersion, type UpdateTarget } from '@podium/protocol'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { registerVersionRoute } from './server'

async function getVersion(updateTarget?: () => UpdateTarget | undefined) {
  const app = new Hono()
  registerVersionRoute(app, { instanceId: 'inst-1', updateTarget })
  const res = await app.request('/version')
  return { status: res.status, body: (await res.json()) as unknown }
}

describe('GET /version target descriptor', () => {
  it('still returns the existing fields when no target is configured', async () => {
    const { status, body } = await getVersion()
    expect(status).toBe(200)
    const v = parseServerVersion(body)
    expect(v.wireVersion).toBeTypeOf('number')
    expect(v.minSupportedVersion).toBeTypeOf('number')
    expect(v.wireSchemaDigest).toBeTypeOf('string')
    expect(v.appVersion).toBeTypeOf('string')
    expect(v.instanceId).toBe('inst-1')
    expect(v.target).toBeUndefined()
  })

  it('publishes the target descriptor when one is configured', async () => {
    const { body } = await getVersion(() => ({
      version: '0.4.2',
      critical: false,
      artifacts: {
        headless: {
          delivery: 'feed',
          platforms: {
            'linux-x86_64': { url: 'https://x.test/a.tgz', digest: 'd', signature: 's' },
          },
        },
      },
    }))
    const v = parseServerVersion(body)
    expect(v.target?.version).toBe('0.4.2')
    expect(v.target?.artifacts.headless?.delivery).toBe('feed')
  })

  it('reports a development identity as the target version', async () => {
    const { body } = await getVersion(() => ({
      version: 'dev+9f3a1c2',
      critical: false,
      artifacts: {},
    }))
    expect(parseServerVersion(body).target?.version).toBe('dev+9f3a1c2')
  })

  it('serves the version fields even when building the target throws', async () => {
    const { status, body } = await getVersion(() => {
      throw new Error('bundle build failed')
    })
    expect(status).toBe(200)
    const v = parseServerVersion(body)
    expect(v.wireVersion).toBeTypeOf('number')
    expect(v.target).toBeUndefined()
  })
})
