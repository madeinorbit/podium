import { parseServerVersion, type ServedWebIdentity, type UpdateTarget } from '@podium/protocol'
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

/**
 * THE SERVED WEBSITE'S OWN IDENTITY (POD-2721).
 *
 * A page cannot read the stamp of the dist it was served from and trust the
 * answer: fetching `/podium-build.json` returns whatever is on disk NOW, which
 * after a swap is the build that replaced it. Only the server can say which
 * bytes it is currently handing out, so it says so here — freshly, per request,
 * because a value captured at boot would keep naming a dist this process has
 * already stopped serving.
 */
describe('GET /version served website identity', () => {
  const servedVersion = async (web?: () => ServedWebIdentity) => {
    const app = new Hono()
    registerVersionRoute(app, { instanceId: 'inst-1', ...(web ? { web } : {}) })
    return parseServerVersion(await (await app.request('/version')).json())
  }

  it('names the entry bundle it is serving, not only the checkout', async () => {
    const v = await servedVersion(() => ({
      present: true,
      appVersion: '0.1.1-dev.1+a55ec3d',
      digest: 'a55ec3d',
      bundle: 'bundle+CFyX4Q_p',
    }))
    expect(v.web?.present).toBe(true)
    expect(v.web?.bundle).toBe('bundle+CFyX4Q_p')
    // The checkout alone could not have told the two POD-2721 builds apart.
    expect(v.web?.digest).toBe('a55ec3d')
  })

  it('re-reads on every request, so a swap under a running server is visible', async () => {
    let bundle = 'bundle+Bw5YMffE'
    const app = new Hono()
    registerVersionRoute(app, {
      instanceId: 'inst-1',
      web: () => ({ present: true, bundle }),
    })
    const read = async () =>
      parseServerVersion(await (await app.request('/version')).json()).web?.bundle
    expect(await read()).toBe('bundle+Bw5YMffE')
    bundle = 'bundle+CFyX4Q_p'
    expect(await read()).toBe('bundle+CFyX4Q_p')
  })

  it('says so plainly when this origin serves no website', async () => {
    expect((await servedVersion(() => ({ present: false }))).web?.present).toBe(false)
  })

  it('omits the field entirely when the server was assembled without a website reader', async () => {
    expect((await servedVersion()).web).toBeUndefined()
  })

  it('keeps serving the version fields when reading the served dist throws', async () => {
    const v = await servedVersion(() => {
      throw new Error('web dir vanished mid-swap')
    })
    expect(v.web).toBeUndefined()
    expect(v.wireVersion).toBeTypeOf('number')
  })
})
