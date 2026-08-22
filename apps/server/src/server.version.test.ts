import { parseServerVersion, type UpdateTarget } from '@podium/protocol'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { resolveDevelopmentRuntime } from './modules/updates/development-runtime'
import { registerVersionRoute } from './server'

async function getVersion(
  updateTarget?: () => UpdateTarget | undefined,
  sourceDigest?: () => string | undefined,
  installKind?: () => 'installed' | 'source',
) {
  const app = new Hono()
  registerVersionRoute(app, { instanceId: 'inst-1', updateTarget, sourceDigest, installKind })
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

  it('reports server source identity separately from its display version', async () => {
    const { body } = await getVersion(undefined, () => '47a01e3')
    expect(parseServerVersion(body).sourceDigest).toBe('47a01e3')
  })
  it('reports whether the coordinator is a source checkout', async () => {
    const { body } = await getVersion(undefined, undefined, () => 'source')
    expect(parseServerVersion(body).installKind).toBe('source')
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

describe('development runtime', () => {
  it('keeps a source process on source restart mechanics and gives it its checkout', () => {
    expect(
      resolveDevelopmentRuntime({
        env: {},
        packagedVersion: undefined,
        sourceRunRoot: '/repo/podium',
      }),
    ).toEqual({
      runningFromSource: true,
      publisherSourceRoot: '/repo/podium',
    })
  })

  it('keeps an ordinary packaged install out of the publisher', () => {
    expect(
      resolveDevelopmentRuntime({
        env: {},
        packagedVersion: '0.2.0',
        sourceRunRoot: '/bundled/source/is/not/a/checkout',
      }),
    ).toEqual({ runningFromSource: false, publisherSourceRoot: undefined })
  })

  it('lets an explicitly configured packaged install publish without becoming a source run', () => {
    expect(
      resolveDevelopmentRuntime({
        env: {
          PODIUM_DEV_SOURCE_ROOT: '/repo/podium',
        },
        packagedVersion: '0.2.0-dev.4+47a01e3',
        sourceRunRoot: '/bundled/source/is/not/a/checkout',
      }),
    ).toEqual({ runningFromSource: false, publisherSourceRoot: '/repo/podium' })
  })

  it('refuses a relative publisher checkout', () => {
    expect(() =>
      resolveDevelopmentRuntime({
        env: { PODIUM_DEV_SOURCE_ROOT: '../podium' },
        packagedVersion: '0.2.0',
        sourceRunRoot: '/repo/podium',
      }),
    ).toThrow(/absolute checkout path/)
  })
})
