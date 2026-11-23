/**
 * Issue and verify (POD-7311 acceptance 1): a grant round-trips with its scopes;
 * a tampered, expired, wrong-workspace or wrong-key grant is refused.
 */

import { sign } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  CLIENT_GRANT_LIFETIME_MS,
  DAEMON_GRANT_LIFETIME_MS,
  LiveGrantKeyRing,
  LiveGrantSigningUnavailable,
  mintLiveGrantKey,
  parseLiveGrantKeyRing,
  signClientGrant,
  signDaemonGrant,
  verifyLiveGrant,
} from './index'
import { decodePayload } from './wire'

const NOW = Date.parse('2026-11-23T12:00:00.000Z')
const WS = 'ws_alpha'
const ring = new LiveGrantKeyRing([mintLiveGrantKey('k1')])
const verifierRing = ring.publicOnly()

const CLAIMS = {
  workspace: WS,
  member: 'user:alice',
  role: 'member',
  sessions: {
    's-watch': ['view'],
    's-drive': ['view', 'use'],
    's-none': [],
  },
  machines: {
    'm-use': ['view', 'use'],
    'm-admin': ['view', 'manage'],
  },
  roots: { 'm-use': ['/repo', '/other'], 'm-admin': ['/admin-only'] },
  logins: ['m-use'],
} as const

const issue = (overrides: Partial<Parameters<typeof signClientGrant>[1]> = {}) =>
  signClientGrant(ring, { ...CLAIMS, ...overrides }, { now: NOW })

const verify = (token: string, now = NOW + 1_000, workspace = WS) =>
  verifyLiveGrant(token, { keys: verifierRing, workspace, now })

describe('client grant round trip', () => {
  it('verifies and answers every scope it was issued with', () => {
    const signed = issue()
    expect(signed.expiresAt - signed.issuedAt).toBe(CLIENT_GRANT_LIFETIME_MS)
    expect(signed.refreshAt).toBe(signed.issuedAt + CLIENT_GRANT_LIFETIME_MS / 2)
    expect(signed.keyId).toBe('k1')
    const result = verifyLiveGrant(signed.token, {
      keys: verifierRing,
      workspace: WS,
      kind: 'client',
      now: NOW + 1_000,
    })
    if (!result.ok) throw new Error(result.refusal)
    const grant = result.grant
    expect(grant.kind).toBe('client')
    expect(grant.member).toBe('user:alice')
    expect(grant.role).toBe('member')
    expect(grant.workspace).toBe(WS)
    expect(grant.expiresAt).toBe(signed.expiresAt)
    expect(grant.keyId).toBe('k1')
    expect([...grant.sessionActions('s-drive')].sort()).toEqual(['use', 'view'])
    expect(grant.allowsSession('s-watch', 'view')).toBe(true)
    expect(grant.allowsSession('s-watch', 'use')).toBe(false)
    // An id issued with no action is not in the grant at all.
    expect([...grant.sessionIds()].sort()).toEqual(['s-drive', 's-watch'])
    expect(grant.allowsSession('s-unknown', 'view')).toBe(false)
    // Machine actions are a set, not a ladder.
    expect(grant.allowsMachine('m-admin', 'manage')).toBe(true)
    expect(grant.allowsMachine('m-admin', 'use')).toBe(false)
    expect(grant.rootsOf('m-use')).toEqual(['/other', '/repo'])
    expect(grant.mayAskPath('m-use', '/repo/src/a.ts')).toBe(true)
    expect(grant.mayAskPath('m-use', '/repository')).toBe(false)
    // Roots on a machine without `use` admit no direct ask.
    expect(grant.mayAskPath('m-admin', '/admin-only/x')).toBe(false)
    expect(grant.maySeeLogins('m-use')).toBe(true)
    expect(grant.maySeeLogins('m-admin')).toBe(false)
    expect(grant.connectionKey).toBeUndefined()
    expect(grant.epoch).toBeUndefined()
    expect(grant.isLive(signed.expiresAt - 1)).toBe(true)
    expect(grant.isLive(signed.expiresAt)).toBe(false)
  })

  it('carries a connection key and a routing epoch when given', () => {
    const result = verify(issue({ connectionKey: 'thumb-1', epoch: 7 }).token)
    if (!result.ok) throw new Error(result.refusal)
    expect(result.grant.connectionKey).toBe('thumb-1')
    expect(result.grant.epoch).toBe(7)
  })
})

describe('daemon grant round trip', () => {
  it('verifies as the machine it names, for an hour', () => {
    const signed = signDaemonGrant(ring, { workspace: WS, machine: 'm-1', epoch: 3 }, { now: NOW })
    expect(signed.expiresAt - signed.issuedAt).toBe(DAEMON_GRANT_LIFETIME_MS)
    const result = verifyLiveGrant(signed.token, {
      keys: verifierRing,
      workspace: WS,
      kind: 'daemon',
      now: NOW + DAEMON_GRANT_LIFETIME_MS - 1,
    })
    if (!result.ok) throw new Error(result.refusal)
    expect(result.grant.machine).toBe('m-1')
    expect(result.grant.epoch).toBe(3)
  })

  it('is refused where a client grant is expected, and the other way round', () => {
    const daemon = signDaemonGrant(ring, { workspace: WS, machine: 'm-1' }, { now: NOW })
    expect(
      verifyLiveGrant(daemon.token, {
        keys: verifierRing,
        workspace: WS,
        kind: 'client',
        now: NOW,
      }),
    ).toEqual({ ok: false, refusal: 'wrong-kind' })
    expect(
      verifyLiveGrant(issue().token, {
        keys: verifierRing,
        workspace: WS,
        kind: 'daemon',
        now: NOW,
      }),
    ).toEqual({ ok: false, refusal: 'wrong-kind' })
  })
})

describe('refusals', () => {
  const token = issue().token
  const [prefix, kid, payload, signature] = token.split('.') as [string, string, string, string]

  it('refuses a tampered payload', () => {
    // A different, validly encoded payload under the original signature.
    const other = issue({ member: 'user:mallory' }).token.split('.')[2]!
    expect(verify([prefix, kid, other, signature].join('.'))).toEqual({
      ok: false,
      refusal: 'bad-signature',
    })
  })

  it('refuses a flipped signature bit', () => {
    const bytes = Buffer.from(signature, 'base64url')
    bytes[10] = bytes[10]! ^ 1
    expect(verify([prefix, kid, payload, bytes.toString('base64url')].join('.'))).toEqual({
      ok: false,
      refusal: 'bad-signature',
    })
  })

  it('refuses a renamed key id: the key id is signed too', () => {
    const both = new LiveGrantKeyRing([
      ...verifierRing.keys,
      { kid: 'k2', publicKey: ring.signingKey()!.publicKey },
    ])
    expect(
      verifyLiveGrant([prefix, 'k2', payload, signature].join('.'), {
        keys: both,
        workspace: WS,
        now: NOW,
      }),
    ).toEqual({ ok: false, refusal: 'bad-signature' })
  })

  it('refuses an expired grant, and one issued too far in the future', () => {
    expect(verify(token, NOW + CLIENT_GRANT_LIFETIME_MS)).toEqual({ ok: false, refusal: 'expired' })
    expect(verify(token, NOW - 61_000)).toEqual({ ok: false, refusal: 'not-yet-valid' })
    expect(verify(token, NOW - 59_000).ok).toBe(true)
  })

  it('refuses a grant for another workspace', () => {
    expect(verify(token, NOW, 'ws_beta')).toEqual({ ok: false, refusal: 'wrong-workspace' })
  })

  it('refuses a grant signed with a key the verifier does not have', () => {
    const stranger = new LiveGrantKeyRing([mintLiveGrantKey('k1')])
    const forged = signClientGrant(stranger, CLAIMS, { now: NOW }).token
    // The same key id, another key: the signature does not verify.
    expect(verify(forged)).toEqual({ ok: false, refusal: 'bad-signature' })
    const unknown = signClientGrant(new LiveGrantKeyRing([mintLiveGrantKey('k9')]), CLAIMS, {
      now: NOW,
    }).token
    expect(verify(unknown)).toEqual({ ok: false, refusal: 'unknown-key' })
  })

  it('refuses what is not a token', () => {
    for (const bad of [
      '',
      'nope',
      42,
      undefined,
      `${prefix}.${kid}.${payload}`,
      `plg2.${kid}.${payload}.${signature}`,
      `${prefix}.${kid}.${payload}.${signature}.x`,
      `${prefix}.${kid}.${payload}.${signature.slice(0, 20)}`,
      `${prefix}.${kid}.${payload}.${'A'.repeat(600_000)}`,
    ]) {
      expect(verify(bad as string)).toEqual({ ok: false, refusal: 'malformed' })
    }
  })

  it('refuses a validly signed payload that is not a grant', () => {
    // Signed with the real key, so only the content check can refuse it.
    const key = ring.signingKey()!
    const signedOver = (json: string) => {
      const body = deflateRawSync(Buffer.from(json)).toString('base64url')
      const part = `plg1.${key.kid}.${body}`
      return `${part}.${sign(null, Buffer.from(part), key.privateKey).toString('base64url')}`
    }
    const base = {
      v: 1,
      k: 'c',
      ws: WS,
      iat: NOW,
      exp: NOW + 60_000,
      m: 'u',
      ro: 'member',
      r: {},
      l: [],
    }
    for (const json of [
      '{',
      JSON.stringify({ ...base, v: 2, s: [], h: [] }),
      JSON.stringify({ ...base, s: [[8, ['a']]], h: [] }),
      JSON.stringify({
        ...base,
        s: [
          [1, ['a']],
          [3, ['a']],
        ],
        h: [],
      }),
      JSON.stringify({ ...base, s: [], h: [], exp: NOW }),
      JSON.stringify({ ...base, s: [], h: [], m: '' }),
      JSON.stringify({ ...base, k: 'x', s: [], h: [] }),
    ]) {
      expect(verify(signedOver(json))).toEqual({ ok: false, refusal: 'malformed' })
    }
    expect(verify(signedOver(JSON.stringify({ ...base, s: [], h: [] }))).ok).toBe(true)
  })
})

describe('keys', () => {
  it('a verifier ring cannot sign', () => {
    expect(() => signClientGrant(verifierRing, CLAIMS)).toThrow(LiveGrantSigningUnavailable)
  })

  it('a key file round-trips, and its public form verifies what the private form signed', () => {
    const file = parseLiveGrantKeyRing(ring.toJson({ includePrivate: true }))
    const publicFile = parseLiveGrantKeyRing(ring.toJson({ includePrivate: false }))
    expect(publicFile.signingKey()).toBeUndefined()
    const signed = signClientGrant(file, CLAIMS, { now: NOW })
    expect(verifyLiveGrant(signed.token, { keys: publicFile, workspace: WS, now: NOW }).ok).toBe(
      true,
    )
  })

  it('refuses a damaged key file whole', () => {
    expect(() => parseLiveGrantKeyRing('{"keys":[]}')).toThrow()
    expect(() => parseLiveGrantKeyRing('{"keys":[{"kid":"a","publicKey":"AAAA"}]}')).toThrow()
    const good = JSON.parse(ring.toJson({ includePrivate: false })).keys[0]
    expect(() => parseLiveGrantKeyRing(JSON.stringify({ keys: [good, good] }))).toThrow(/twice/)
  })

  it('signs only what it can verify: an id too long is refused at issue', () => {
    expect(() => issue({ member: 'x'.repeat(300) })).toThrow()
    expect(decodePayload(issue().token.split('.')[2]!).kind).toBe('client')
  })
})
