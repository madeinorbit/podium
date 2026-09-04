import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InstallationIdentity } from '@podium/runtime/installation-identity'
import { describe, expect, it } from 'vitest'
import { connectClient } from './client'

const vectors = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../../../../../packages/runtime/src/fixtures/connect-vectors.json'),
    'utf8',
  ),
) as {
  installationId: string
  publicKeyWire: string
  privateKeyPkcs8: string
  path: string
  body: string
  timestamp: number
  signature: string
}

const identity: InstallationIdentity = {
  version: 1,
  installationId: vectors.installationId,
  privateKey: vectors.privateKeyPkcs8,
  publicKey: createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: vectors.publicKeyWire.slice('ed25519:'.length) },
    format: 'jwk',
  })
    .export({ format: 'der', type: 'spki' })
    .toString('base64'),
  generation: 1,
  createdAt: '2026-09-04T00:00:00.000Z',
}

type Seen = { url: string; init: RequestInit }
function client(respond: (seen: Seen) => Response | Promise<Response>, now = vectors.timestamp) {
  const seen: Seen[] = []
  const c = connectClient({
    baseUrl: 'https://connect.test/',
    identity: () => identity,
    now: () => now,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const s = { url: String(url), init: init ?? {} }
      seen.push(s)
      return respond(s)
    }) as unknown as typeof fetch,
  })
  return { c, seen }
}
const header = (s: Seen, name: string) => new Headers(s.init.headers).get(name)

describe('connectClient', () => {
  it('registers with the wire public key and no signature', async () => {
    const { c, seen } = client(() => new Response('{}', { status: 201 }))
    expect(await c.register()).toEqual({ ok: true })
    const s = seen[0] as Seen
    expect(s.url).toBe('https://connect.test/v1/installations')
    expect(s.init.method).toBe('POST')
    expect(JSON.parse(s.init.body as string)).toEqual({
      installationId: vectors.installationId,
      publicKey: vectors.publicKeyWire,
    })
    expect(header(s, 'podium-signature')).toBeNull()
  })

  it('publishes with exactly the signature Connect expects (shared vector)', async () => {
    const { c, seen } = client(() => new Response(vectors.body, { status: 200 }))
    expect(await c.publish(JSON.parse(vectors.body))).toEqual({ ok: true })
    const s = seen[0] as Seen
    expect(s.url).toBe(`https://connect.test${vectors.path}`)
    expect(s.init.method).toBe('PUT')
    expect(s.init.body).toBe(vectors.body)
    expect(header(s, 'podium-installation')).toBe(vectors.installationId)
    expect(header(s, 'podium-timestamp')).toBe(String(vectors.timestamp))
    expect(header(s, 'podium-signature')).toBe(vectors.signature)
  })

  it('signs DELETE over the empty body', async () => {
    const { c, seen } = client(() => new Response(null, { status: 204 }))
    expect(await c.clear()).toEqual({ ok: true })
    const s = seen[0] as Seen
    expect(s.init.method).toBe('DELETE')
    expect(s.init.body).toBeUndefined()
    const hash = createHash('sha256').update('').digest('hex')
    const message = `DELETE\n${vectors.path}\n${vectors.timestamp}\n${hash}`
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: vectors.publicKeyWire.slice(8) },
      format: 'jwk',
    })
    expect(
      verify(
        null,
        Buffer.from(`podium-connect-request-v1\n${message}`),
        key,
        Buffer.from(header(s, 'podium-signature') ?? '', 'base64url'),
      ),
    ).toBe(true)
  })

  it('maps an error body to an http failure and a thrown fetch to a network one', async () => {
    const { c } = client(
      () =>
        new Response(JSON.stringify({ error: 'GENERATION_BEHIND', message: 'moved' }), {
          status: 409,
        }),
    )
    expect(await c.publish(JSON.parse(vectors.body))).toEqual({
      ok: false,
      failure: { kind: 'http', status: 409, code: 'GENERATION_BEHIND', message: 'moved' },
    })
    const down = client(() => {
      throw new TypeError('fetch failed')
    })
    expect(await down.c.register()).toEqual({
      ok: false,
      failure: { kind: 'network', message: 'fetch failed' },
    })
  })

  it('returns the check result verbatim and CONNECT_UNAVAILABLE when Connect fails', async () => {
    const result = { ok: false, error: 'DNS_FAILED', detail: 'no address' }
    const { c, seen } = client(() => Response.json(result))
    expect(await c.check('https://my.example')).toEqual(result)
    const s = seen[0] as Seen
    expect(s.url).toBe(`https://connect.test/v1/installations/${vectors.installationId}/check`)
    expect(JSON.parse(s.init.body as string)).toEqual({ url: 'https://my.example' })
    expect(header(s, 'podium-signature')).toBeTruthy()

    const limited = client(
      () =>
        new Response(JSON.stringify({ error: 'RATE_LIMITED', message: 'slow down' }), {
          status: 429,
        }),
    )
    expect(await limited.c.check('https://my.example')).toEqual({
      ok: false,
      error: 'CONNECT_UNAVAILABLE',
      detail: 'RATE_LIMITED',
    })
  })
})
