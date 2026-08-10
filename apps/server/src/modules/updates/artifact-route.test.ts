import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { registerDevArtifactRoute } from './artifact-route'
import type { BuiltDevBundle } from './dev-bundle'
import {
  developmentArtifactUrl,
  selectDevelopmentArtifactOrigin,
  wireDevBundlePublisher,
} from './dev-publisher-wiring'

const bytes = new Uint8Array([9, 8, 7, 6])
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const signature = sign(null, bytes, privateKey)
const built: BuiltDevBundle = {
  version: 'dev+abc1234',
  path: '/stage/dev.tar.gz',
  digest: 'sha256-fixture',
  signature: signature.toString('base64'),
}

function appFor(authenticated = true) {
  const app = new Hono()
  registerDevArtifactRoute(app, {
    current: () => built,
    authenticate: (request) =>
      authenticated && request.headers.get('authorization') === 'Bearer machine-token',
    readFile: async (path) => {
      if (path !== built.path) throw new Error('unexpected path')
      return bytes
    },
  })
  return app
}

describe('development artifact route', () => {
  it('builds an origin-relative route with encoded version and authentication token', () => {
    const url = new URL(
      developmentArtifactUrl('https://podium.example.test:55555', 'dev+abc/123', 'random token/?'),
    )
    expect(url.origin).toBe('https://podium.example.test:55555')
    expect(url.pathname).toBe('/updates/dev-bundle/dev%2Babc%2F123')
    expect(url.searchParams.get('token')).toBe('random token/?')
  })
  it('keeps a source publisher enabled for same-host fallback', () => {
    const base: Parameters<typeof wireDevBundlePublisher>[0] = {
      sourceRoot: '/repo/podium',
      artifactOrigin: 'https://podium.example.test',
      localArtifactOrigin: () => 'http://127.0.0.1:18787',
      hasRemoteManagedMachines: () => false,
      artifactToken: 'random-token',
      signingKey: 'unused-until-build',
      setTarget: () => {},
      locks: {
        acquire: () => ({ granted: true, alreadyHeld: false, lock: {} as never }),
        cancel: () => {},
        renew: () => {},
        release: () => {},
      },
    }
    expect(wireDevBundlePublisher(base).enabled).toBe(true)
    expect(
      wireDevBundlePublisher({
        ...base,
        artifactOrigin: undefined,
      }).enabled,
    ).toBe(true)
    expect(wireDevBundlePublisher({ ...base, sourceRoot: undefined }).enabled).toBe(false)
  })

  it('uses loopback only for a same-host managed fleet', () => {
    const localOrigin = 'http://127.0.0.1:18787'
    expect(
      selectDevelopmentArtifactOrigin({
        externalOrigin: 'https://podium.example.test',
        localOrigin,
        hasRemoteManagedMachines: true,
      }),
    ).toBe('https://podium.example.test')
    expect(
      selectDevelopmentArtifactOrigin({
        externalOrigin: undefined,
        localOrigin,
        hasRemoteManagedMachines: false,
      }),
    ).toBe(localOrigin)
    expect(() =>
      selectDevelopmentArtifactOrigin({
        externalOrigin: undefined,
        localOrigin,
        hasRemoteManagedMachines: true,
      }),
    ).toThrow(/requires PODIUM_DEV_ARTIFACT_BASE_URL/)
  })

  it('serves the exact signed bytes to an authenticated machine', async () => {
    const app = appFor()
    const response = await app.request('/updates/dev-bundle/dev%2Babc1234', {
      headers: { authorization: 'Bearer machine-token' },
    })
    const served = new Uint8Array(await response.arrayBuffer())
    expect(response.status).toBe(200)
    expect(Array.from(served)).toEqual(Array.from(bytes))
    expect(verify(null, served, publicKey, Buffer.from(built.signature, 'base64'))).toBe(true)
  })

  it('refuses an unauthenticated request', async () => {
    const response = await appFor().request('/updates/dev-bundle/dev%2Babc1234')
    expect(response.status).toBe(401)
  })

  it('refuses a version that is not the current build', async () => {
    const response = await appFor().request('/updates/dev-bundle/dev%2Bold', {
      headers: { authorization: 'Bearer machine-token' },
    })
    expect(response.status).toBe(404)
  })

  it('does not expose a stale path after the current build changes', async () => {
    let current: BuiltDevBundle | null = built
    const app = new Hono()
    registerDevArtifactRoute(app, {
      current: () => current,
      authenticate: () => true,
      readFile: async () => bytes,
    })

    current = { ...built, version: 'dev+new1234', path: '/stage/new.tar.gz' }
    const stale = await app.request('/updates/dev-bundle/dev%2Babc1234')
    const fresh = await app.request('/updates/dev-bundle/dev%2Bnew1234')
    expect(stale.status).toBe(404)
    expect(fresh.status).toBe(200)
  })
})
