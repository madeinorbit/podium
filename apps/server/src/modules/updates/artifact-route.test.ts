import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { registerDevArtifactRoute } from './artifact-route'
import type { BuiltDevBundle } from './dev-bundle'

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
