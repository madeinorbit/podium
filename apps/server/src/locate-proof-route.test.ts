import { LOCATE_PROOF_PATH } from '@podium/protocol/server-locate'
import vectors from '@podium/protocol/server-locate-vectors'
import type { InstallationIdentity } from '@podium/runtime/installation-identity'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { registerLocateProofRoute } from './locate-proof-route'

const identity: InstallationIdentity = {
  version: 1,
  installationId: vectors.server.installationId,
  privateKey: vectors.server.privateKeyPkcs8,
  publicKey: vectors.server.publicKeySpki,
  generation: 1,
  createdAt: '2026-10-10T00:00:00.000Z',
}

function build(
  over: {
    identity?: InstallationIdentity | undefined
    publicUrl?: string | undefined
    address?: string
    ratePerMinute?: number
    now?: () => number
  } = {},
) {
  const app = new Hono()
  registerLocateProofRoute(app, {
    identity: () => ('identity' in over ? over.identity : identity),
    publicUrl: () => ('publicUrl' in over ? over.publicUrl : 'https://words-one.trycloudflare.com'),
    clientAddress: () => over.address ?? '203.0.113.7',
    ...(over.ratePerMinute ? { ratePerMinute: over.ratePerMinute } : {}),
    ...(over.now ? { now: over.now } : {}),
  })
  return app
}

const post = (app: Hono, body: string, headers: Record<string, string> = {}) =>
  app.request(LOCATE_PROOF_PATH, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8', ...headers },
    body,
  })

describe('POST /.well-known/podium/locate (POD-5921)', () => {
  for (const vector of vectors.cases.filter((v) => v.serverProduces)) {
    it(`signs the shared vector "${vector.name}" byte for byte`, async () => {
      const app = build({ publicUrl: vector.configuredPublicUrl })
      const res = await post(app, JSON.stringify({ nonce: vector.nonce }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(vector.response)
    })
  }

  it('accepts application/json as well as text/plain', async () => {
    const res = await post(app(), JSON.stringify({ nonce: vectors.cases[0]!.nonce }), {
      'content-type': 'application/json',
    })
    expect(res.status).toBe(200)
  })

  it('is public: wildcard CORS, no-store, and no cookie read or set', async () => {
    const res = await post(app(), JSON.stringify({ nonce: vectors.cases[0]!.nonce }), {
      cookie: 'podium_session=secret',
      origin: 'https://elsewhere.example',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('answers the preflight', async () => {
    const res = await app().request(LOCATE_PROOF_PATH, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-methods')).toBe('POST')
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type')
  })

  it('is 404 without an installation identity or a public URL', async () => {
    const body = JSON.stringify({ nonce: vectors.cases[0]!.nonce })
    expect((await post(build({ identity: undefined }), body)).status).toBe(404)
    expect((await post(build({ publicUrl: undefined }), body)).status).toBe(404)
  })

  it('is 400 on a malformed body', async () => {
    for (const body of [
      'not json',
      '{}',
      JSON.stringify({ nonce: 'short' }),
      JSON.stringify({ nonce: `${vectors.cases[0]!.nonce}AAAA` }),
      JSON.stringify({ nonce: vectors.cases[0]!.nonce, pad: 'x'.repeat(2000) }),
    ]) {
      const res = await post(app(), body)
      expect(res.status, body.slice(0, 40)).toBe(400)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
    }
  })

  it('is 429 above the per-address rate, per address, and recovers after a minute', async () => {
    let at = 1_000_000
    const shared = new Hono()
    let address = '198.51.100.1'
    registerLocateProofRoute(shared, {
      identity: () => identity,
      publicUrl: () => 'https://words-one.trycloudflare.com',
      clientAddress: () => address,
      ratePerMinute: 3,
      now: () => at,
    })
    const body = JSON.stringify({ nonce: vectors.cases[0]!.nonce })
    const statuses: number[] = []
    for (let i = 0; i < 4; i += 1) statuses.push((await post(shared, body)).status)
    expect(statuses).toEqual([200, 200, 200, 429])
    address = '198.51.100.2'
    expect((await post(shared, body)).status).toBe(200)
    address = '198.51.100.1'
    at += 60_000
    expect((await post(shared, body)).status).toBe(200)
  })
})

function app() {
  return build()
}
