import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONNECT_REACHABILITY_PREFIX,
  connectProbeMessage,
  installationPublicKeyWire,
  readOrCreateInstallationIdentity,
  verifyWithWireKey,
} from '@podium/runtime/installation-identity'
import { Hono } from 'hono'
import { afterAll, describe, expect, it } from 'vitest'
import { registerWellKnownRoute } from './well-known-route'

const dir = mkdtempSync(join(tmpdir(), 'podium-well-known-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const identity = readOrCreateInstallationIdentity(dir)
const NOW = 1_800_000_000
const CHALLENGE = 'c2FtcGxlLWNoYWxsZW5nZS1ieXRlcw'

function cloudKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const wire = `ed25519:${publicKey.export({ format: 'jwk' }).x as string}`
  const signProbe = (installationId: string, challenge: string, ts: number) =>
    sign(
      null,
      Buffer.from(`podium-connect-probe-v1\n${connectProbeMessage(installationId, challenge, ts)}`),
      privateKey,
    ).toString('base64url')
  return { wire, signProbe }
}

const cloud = cloudKey()

function build(over: { identity?: () => typeof identity | undefined; trusted?: string[] } = {}) {
  const app = new Hono()
  registerWellKnownRoute(app, {
    identity: over.identity ?? (() => identity),
    trustedProbeKeys: () => over.trusted ?? [cloud.wire],
    now: () => NOW,
  })
  return app
}

const probe = (
  app: Hono,
  over: {
    challenge?: string
    key?: string
    ts?: number
    signature?: string
    headers?: boolean
  } = {},
) => {
  const challenge = over.challenge ?? CHALLENGE
  const ts = over.ts ?? NOW
  const headers: Record<string, string> =
    over.headers === false
      ? {}
      : {
          'podium-probe-key': over.key ?? cloud.wire,
          'podium-timestamp': String(ts),
          'podium-probe-signature':
            over.signature ?? cloud.signProbe(identity.installationId, challenge, ts),
        }
  return app.request(`/.well-known/podium?challenge=${challenge}`, { headers })
}

describe('GET /.well-known/podium', () => {
  it('answers a valid cloud probe with a signature the expected key verifies', async () => {
    const res = await probe(build())
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as { challenge: string; signature: string }
    expect(body.challenge).toBe(CHALLENGE)
    expect(Object.keys(body).sort()).toEqual(['challenge', 'signature'])
    expect(
      verifyWithWireKey(
        installationPublicKeyWire(identity),
        CONNECT_REACHABILITY_PREFIX,
        CHALLENGE,
        body.signature,
      ),
    ).toBe(true)
  })

  it('is indistinguishable from an unknown path for everything else', async () => {
    const app = build()
    const unknown = await app.request('/.well-known/nothing')
    const expectSameAs404 = async (res: Response) => {
      expect(res.status).toBe(404)
      expect(await res.text()).toBe(await unknown.clone().text())
    }
    await expectSameAs404(await probe(app, { headers: false }))
    await expectSameAs404(await probe(app, { signature: 'AAAA' }))
    await expectSameAs404(await probe(app, { ts: NOW - 301 }))
    await expectSameAs404(await probe(app, { ts: NOW + 301 }))
    await expectSameAs404(await probe(app, { challenge: 'short' }))
    await expectSameAs404(await probe(app, { challenge: 'not+base64url+at+all' }))
    await expectSameAs404(await app.request('/.well-known/podium'))
    // signed by a key the server does not trust
    const stranger = cloudKey()
    await expectSameAs404(
      await probe(app, {
        key: stranger.wire,
        signature: stranger.signProbe(identity.installationId, CHALLENGE, NOW),
      }),
    )
    // trusted key, but the signature names another installation
    await expectSameAs404(
      await probe(app, { signature: cloud.signProbe(`pdm_${'x'.repeat(43)}`, CHALLENGE, NOW) }),
    )
  })

  it('accepts a probe at the edge of the skew window', async () => {
    expect((await probe(build(), { ts: NOW - 300 })).status).toBe(200)
  })

  it('answers nothing on a box without an installation identity', async () => {
    expect((await probe(build({ identity: () => undefined }))).status).toBe(404)
  })

  it('answers operator-added keys too', async () => {
    const extra = cloudKey()
    const app = build({ trusted: [cloud.wire, extra.wire] })
    const res = await probe(app, {
      key: extra.wire,
      signature: extra.signProbe(identity.installationId, CHALLENGE, NOW),
    })
    expect(res.status).toBe(200)
  })
})
