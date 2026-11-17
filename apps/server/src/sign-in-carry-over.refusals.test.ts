/**
 * THE SIGN-IN CARRY-OVER: WHAT GAINS NOTHING (POD-6751;
 * docs/design/sign-in-carry-over.md, sections 10.5 and 10.6).
 *
 * A made-up old-style cookie gets the answer of the same request without it,
 * byte for byte, and causes no write. An old cookie is carried by
 * `GET /auth/status` and by nothing else, over HTTPS or on the same machine,
 * and never for a request that already has a device sign-in.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { WorkspaceIdentity } from '@podium/identity'
import { CLIENT_WIRE_VERSION, SECURE_DEVICE_SIGN_IN_COOKIE } from '@podium/protocol'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { countStatements } from './test-support/statement-count'
import {
  ALICE,
  type Answer,
  BOB,
  https,
  OLD_TOKENS,
  oldCookie,
  remoteHttp,
  startUpgradedInstance,
  type UpgradedInstance,
  useUpgradeDayClock,
} from './test-support/upgraded-customer-instance'

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')
const oldRows = (i: UpgradedInstance) => i.rows('SELECT * FROM client_sessions ORDER BY token_hash')
const issued = (i: UpgradedInstance) => ({
  deviceSignIns: i.rows('SELECT id FROM identity_session ORDER BY id'),
  carryRecords: i.rows('SELECT old_token_hash FROM carried_sign_ins'),
  audits: i.rows("SELECT id FROM settings_audit_events WHERE command = 'members.signInCarried'"),
})
const WRITES = /^\s*(insert|update|delete|replace)\b/i

/** One request, with every statement it ran on the server's connection. */
async function observed(i: UpgradedInstance, ask: () => Promise<Answer>) {
  const tally = await countStatements(i.handle.registry.sessionStore, ask)
  const queries = [...tally.byQuery.keys()]
  return { answer: tally.result, queries, writes: queries.filter((sql) => WRITES.test(sql)) }
}

const socketOutcome = async (i: UpgradedInstance, cookie: string): Promise<'open' | number> => {
  const url = `ws://127.0.0.1:${i.handle.port}/client?v=${CLIENT_WIRE_VERSION}&cap=sync.http.v1`
  return await new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { cookie } })
    ws.on('open', () => {
      resolve('open')
      ws.close()
    })
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0)
      ws.terminate()
    })
    ws.on('error', () => resolve(0))
  })
}

describe('on the upgraded two-member fixture, nothing below is ever carried', () => {
  // These tests leave the old rows and the sign-in tables as they found them
  // (each asserts it), so they share one server.
  let i: UpgradedInstance
  let none: Answer
  let noneHttps: Answer
  beforeAll(async () => {
    useUpgradeDayClock()
    i = await startUpgradedInstance('two-members')
    // The upgrade deleted the `upstream` and `server-transfer-claim` rows. They
    // are put back, so that the carry-over's own label rule is what refuses
    // them, not the upgrade having run first (R8).
    for (const [token, label] of [
      [OLD_TOKENS.upstream, 'upstream'],
      [OLD_TOKENS.serverTransferClaim, 'server-transfer-claim'],
    ] as const) {
      expect(i.rows('SELECT 1 FROM client_sessions WHERE token_hash = ?', hashOf(token))).toEqual(
        [],
      )
      i.write(
        "INSERT INTO client_sessions (token_hash, user_id, created_at, expires_at, label) VALUES (?, ?, '2026-11-01T09:00:00.000Z', '2036-08-01T00:00:00.000Z', ?)",
        hashOf(token),
        ALICE,
        label,
      )
    }
    none = await i.status()
    noneHttps = await i.status(undefined, https)
    expect(none.body).toMatchObject({ authed: false })
  }, 120_000)
  afterAll(async () => {
    await i?.close()
    vi.useRealTimers()
  })

  let rowsBefore: unknown[]
  let issuedBefore: ReturnType<typeof issued>
  beforeEach(() => {
    rowsBefore = oldRows(i)
    issuedBefore = issued(i)
  })
  afterEach(() => {
    // Whatever a test presented, no old row changed and nothing was issued.
    expect(oldRows(i)).toEqual(rowsBefore)
    expect(issued(i)).toEqual(issuedBefore)
  })

  /** The answer equals the one without any cookie, sets no cookie, and nothing was written. */
  const gainsNothing = async (cookie: string, headers: Record<string, string> = {}) => {
    const expected = 'x-forwarded-proto' in headers ? noneHttps : none
    const { answer, writes } = await observed(i, () =>
      i.request('/auth/status', { headers: { cookie, ...headers } }),
    )
    expect(answer.status).toBe(expected.status)
    expect(answer.text).toBe(expected.text)
    expect(answer.setCookies).toEqual([])
    expect(answer.headers.get('cache-control')).toBe(expected.headers.get('cache-control'))
    expect(answer.headers.get('content-type')).toBe(expected.headers.get('content-type'))
    expect(writes).toEqual([])
  }

  it('test 19: a random value, an empty one, an overlong one, one outside the alphabet', async () => {
    await gainsNothing(oldCookie(randomBytes(32).toString('base64url')))
    await gainsNothing(oldCookie(''))
    await gainsNothing(oldCookie('a'.repeat(600)))
    await gainsNothing(oldCookie(`${OLD_TOKENS.aliceBrowser.slice(0, 20)}%2F+/==`))
    await gainsNothing(oldCookie('short'))
  })

  it('test 20: Alice’s stored hash and the public id of her sign-in are not tokens', async () => {
    const [row] = i.rows<{ token_hash: string; session_id: string | null }>(
      'SELECT token_hash, session_id FROM client_sessions WHERE token_hash = ?',
      hashOf(OLD_TOKENS.aliceBrowser),
    )
    expect(row?.token_hash).toBe(hashOf(OLD_TOKENS.aliceBrowser))
    await gainsNothing(oldCookie(row?.token_hash ?? ''))
    // The upgrade gave every old sign-in a public id; an admin sees it in Access.
    expect(row?.session_id).toMatch(/^[A-Za-z0-9_-]{20,}$/)
    await gainsNothing(oldCookie(row?.session_id ?? ''))
    await gainsNothing(oldCookie(ALICE))
  })

  it('test 21: the real tokens of labels that are not a person’s sign-in', async () => {
    for (const token of [
      OLD_TOKENS.upstream,
      OLD_TOKENS.serverTransferClaim,
      OLD_TOKENS.unknownLabel,
    ]) {
      // The row exists and is unexpired: only its label keeps it from being honoured.
      expect(
        i.rows(
          'SELECT 1 FROM client_sessions WHERE token_hash = ? AND expires_at > ?',
          hashOf(token),
          new Date().toISOString(),
        ),
      ).toHaveLength(1)
      await gainsNothing(oldCookie(token))
    }
  })

  it('test 22: Alice’s real old token as a bearer, or under the new cookie name', async () => {
    const token = OLD_TOKENS.aliceBrowser
    // As a bearer over HTTPS.
    const bearer = await observed(i, () =>
      i.request('/auth/status', { headers: { authorization: `Bearer ${token}`, ...https } }),
    )
    expect(bearer.answer.text).toBe(noneHttps.text)
    expect(bearer.answer.setCookies).toEqual([])
    expect(bearer.writes).toEqual([])
    // Under the new cookie name without a signature, and signed with another secret.
    await gainsNothing(`${SECURE_DEVICE_SIGN_IN_COOKIE}=${token}`, https)
    const forged = `${token}.${createHmac('sha256', 'not the server’s secret').update(token).digest('base64')}`
    await gainsNothing(`${SECURE_DEVICE_SIGN_IN_COOKIE}=${encodeURIComponent(forged)}`, https)
    await gainsNothing(`podium.session_token=${encodeURIComponent(forged)}`)
  })

  it('test 23: only an old cookie on /trpc, /files, /sync and the socket is refused like no cookie', async () => {
    const cookie = oldCookie(OLD_TOKENS.aliceBrowser)
    const asset = `/files/asset?${new URLSearchParams({ sessionId: 'session-alice-history', path: 'probe.txt' })}`
    for (const path of ['/trpc/auth.profile', asset, '/sync/bootstrap', '/sync/delta']) {
      const without = await i.request(path)
      const { answer, writes } = await observed(i, () => i.request(path, { cookie }))
      expect({ path, status: answer.status }).toEqual({ path, status: 401 })
      expect(answer.text).toBe(without.text)
      expect(answer.setCookies).toEqual([])
      expect(writes).toEqual([])
    }
    expect(await socketOutcome(i, cookie)).toBe(401)
    // Other routes that act for a member: the device list and sign-out-everywhere.
    expect((await i.request('/auth/client-sessions', { cookie })).status).toBe(401)
    expect(
      (await i.request('/auth/members/sign-out-everywhere', { method: 'POST', cookie, body: {} }))
        .status,
    ).toBe(401)
  })

  it('test 25, first half: plain HTTP from another machine is https_required and carries nothing', async () => {
    const cookie = oldCookie(OLD_TOKENS.aliceBrowser)
    const without = await i.status(undefined, remoteHttp)
    const { answer, writes } = await observed(i, () => i.status(cookie, remoteHttp))
    expect(answer.text).toBe(without.text)
    expect(answer.body).toMatchObject({
      error: 'https_required',
      message: expect.stringContaining('HTTPS for sign-in from other computers'),
    })
    expect(answer.setCookies).toEqual([])
    expect(writes).toEqual([])
    const guarded = await i.request('/trpc/auth.profile', { cookie, headers: remoteHttp })
    expect(guarded.status).toBe(400)
    expect(guarded.body).toMatchObject({
      error: 'https_required',
      message: expect.stringContaining('HTTPS for sign-in from other computers'),
    })
  })

  it('test 26: a foreign Origin on the status request', async () => {
    const cookie = oldCookie(OLD_TOKENS.aliceBrowser)
    // Over HTTPS, so that the Origin is the only thing that stands in the way.
    // (On plain HTTP a foreign Origin already makes the request "not this
    // machine", which is refused as https_required.)
    for (const headers of [
      { ...https, origin: 'https://evil.example' },
      { origin: 'https://evil.example' },
    ]) {
      const without = await i.request('/auth/status', { headers })
      const { answer, writes } = await observed(i, () =>
        i.request('/auth/status', { cookie, headers }),
      )
      expect(answer.status).toBe(without.status)
      expect(answer.text).toBe(without.text)
      expect(answer.body).toMatchObject(
        'x-forwarded-proto' in headers ? { authed: false } : { error: 'https_required' },
      )
      expect(answer.setCookies).toEqual([])
      expect(writes).toEqual([])
    }
  })
})

describe('boundaries that do carry, next to the ones that do not', () => {
  let f: UpgradedInstance | undefined
  beforeEach(() => useUpgradeDayClock())
  afterEach(async () => {
    await f?.close()
    f = undefined
    vi.useRealTimers()
  })

  it('test 25, second half: the same cookie over HTTPS afterwards is carried', async () => {
    f = await startUpgradedInstance('two-members')
    const i = f
    const cookie = oldCookie(OLD_TOKENS.aliceBrowser)
    expect((await i.status(cookie, remoteHttp)).body).toMatchObject({ error: 'https_required' })
    const carried = await i.status(cookie, https)
    expect(carried.body).toMatchObject({ authed: true, memberId: ALICE })
    expect(carried.cookie).toMatch(/^__Secure-podium\.session_token=/)
    // The new cookie is refused over plain HTTP from elsewhere, as any sign-in is.
    expect(
      (await i.request('/trpc/auth.profile', { cookie: carried.cookie, headers: remoteHttp }))
        .status,
    ).toBe(400)
    expect(
      (await i.request('/trpc/auth.profile', { cookie: carried.cookie, headers: https })).status,
    ).toBe(200)
  }, 120_000)

  it('test 26, control: with the server’s own origin, or none, the same request is carried', async () => {
    f = await startUpgradedInstance('two-members')
    const i = f
    const refused = await i.request('/auth/status', {
      cookie: oldCookie(OLD_TOKENS.aliceBrowser),
      headers: { ...https, origin: 'https://evil.example' },
    })
    expect(refused.body).toMatchObject({ authed: false })
    expect(refused.setCookies).toEqual([])
    // The same request from the page this server serves (TLS ends at the proxy
    // in front of it, so the scheme of the origin differs and the host does not).
    const carried = await i.request('/auth/status', {
      cookie: oldCookie(OLD_TOKENS.aliceBrowser),
      headers: { ...https, origin: `https://127.0.0.1:${i.handle.port}` },
    })
    expect(carried.body).toMatchObject({ authed: true, memberId: ALICE })
    expect(carried.cookie).toMatch(/^__Secure-podium\.session_token=/)
  }, 120_000)

  it('R9 at the module: an unauthenticated request over plain HTTP from elsewhere is not carried', async () => {
    f = await startUpgradedInstance('two-members')
    const i = f
    const before = oldRows(i)
    // The status route never gets here: its resolution is https_required. The
    // module refuses by itself too, whatever resolution it is handed.
    const request = new Request(`${i.origin}/auth/status`, {
      headers: { cookie: oldCookie(OLD_TOKENS.aliceBrowser) },
    })
    const carried = await i.handle.signInCarryOver?.carry(
      request,
      { scheme: 'http', sameMachine: false, clientAddress: '203.0.113.7' },
      { kind: 'unauthenticated' },
    )
    expect(carried).toBeUndefined()
    expect(oldRows(i)).toEqual(before)
    expect(issued(i).deviceSignIns).toEqual([])
    // And it never carries for a resolution that is not "no device sign-in".
    for (const resolution of [
      { kind: 'https_required' },
      { kind: 'not-a-member', accountId: 'someone' },
    ] as const) {
      expect(
        await i.handle.signInCarryOver?.carry(
          request,
          { scheme: 'https', sameMachine: false, clientAddress: '203.0.113.7' },
          resolution,
        ),
      ).toBeUndefined()
    }
    expect(oldRows(i)).toEqual(before)
  }, 120_000)

  it('test 27: Bob’s valid sign-in with Alice’s old cookie stays Bob, and costs no statement more', async () => {
    f = await startUpgradedInstance('two-members')
    const i = f
    const bob = await i.status(oldCookie(OLD_TOKENS.bobBrowser))
    expect(bob.body).toMatchObject({ authed: true, memberId: BOB })
    const rowsBefore = oldRows(i)
    const issuedBefore = issued(i)

    // Once without the probe, so the hourly "last seen" touch does not differ between the two.
    await i.status(bob.cookie)
    const alone = await observed(i, () => i.status(bob.cookie))
    const both = await observed(i, () =>
      i.status(`${bob.cookie}; ${oldCookie(OLD_TOKENS.aliceBrowser)}`),
    )
    expect(both.answer.body).toMatchObject({ authed: true, memberId: BOB, userId: BOB })
    expect(both.answer.text).toBe(alone.answer.text)
    expect(both.answer.setCookies).toEqual([])
    expect(both.queries.sort()).toEqual(alone.queries.sort())
    expect(both.queries.some((sql) => /client_sessions|carried_sign_ins/.test(sql))).toBe(false)
    expect(oldRows(i)).toEqual(rowsBefore)
    expect(issued(i)).toEqual(issuedBefore)

    // And a request with no old cookie at all runs nothing of the carry-over.
    const plain = await observed(i, () => i.status())
    expect(plain.queries.some((sql) => /client_sessions|carried_sign_ins/.test(sql))).toBe(false)
    // Alice's old sign-in is still hers to carry, in her own browser.
    expect((await i.status(oldCookie(OLD_TOKENS.aliceBrowser))).body).toMatchObject({
      authed: true,
      memberId: ALICE,
    })
  }, 120_000)

  it('test 28: hosted requests use no retired credential, invitation or session repository', async () => {
    // Only what the status route and the boot call is stood in: a hosted
    // workspace where nobody is signed in.
    const hosted = {
      workspaceId: 'ws_hosted',
      core: {
        accounts: {},
        capabilities: () => ({ adminEndDeviceSignIn: false }),
        signIn: {
          prompt: async () => 'email-password',
          signOut: async () => ({ deviceSignInId: null, headers: new Headers() }),
        },
        sweep: async () => {},
      },
      resolve: async () => ({ kind: 'unauthenticated' }),
      signInRequired: async () => true,
      catchUp: async () => ({ applied: 0 }),
    } as unknown as WorkspaceIdentity
    f = await startUpgradedInstance('two-members', { identity: () => hosted })
    const i = f
    expect(i.handle.signInCarryOver).toBeUndefined()
    expect(i.handle.registry.sessionStore).not.toHaveProperty('auth')
    const rowsBefore = oldRows(i)
    const importSources = () => ({
      credentials: i.rows('SELECT * FROM user_credentials ORDER BY user_id'),
      invitations: i.rows('SELECT * FROM member_invites ORDER BY id'),
    })
    const sourcesBefore = importSources()
    expect(sourcesBefore.credentials).toHaveLength(2)
    expect(sourcesBefore.invitations).toEqual([])
    const sourceOrSession = /user_credentials|member_invites|client_sessions|carried_sign_ins/
    expect(rowsBefore.length).toBeGreaterThan(0)
    expect(i.rows('SELECT 1 FROM workspace_meta WHERE key = ?', 'signInCarryOver.endsAt')).toEqual(
      [],
    )

    const none = await i.status(undefined, https)
    for (const headers of [https, {}]) {
      const { answer, queries } = await observed(i, () =>
        i.status(oldCookie(OLD_TOKENS.aliceBrowser), headers),
      )
      expect(answer.body).toMatchObject({ authed: false })
      expect(answer.setCookies).toEqual([])
      expect(queries.filter((sql) => sourceOrSession.test(sql))).toEqual([])
      if (headers === https) expect(answer.text).toBe(none.text)
    }
    // Sign-out does not look at it either.
    const out = await observed(i, () =>
      i.request('/auth/logout', { method: 'POST', cookie: oldCookie(OLD_TOKENS.aliceBrowser) }),
    )
    expect(out.answer.status).toBe(200)
    expect(out.answer.setCookies).toEqual([])
    expect(out.queries.filter((sql) => sourceOrSession.test(sql))).toEqual([])
    expect(oldRows(i)).toEqual(rowsBefore)
    expect(importSources()).toEqual(sourcesBefore)
  }, 120_000)
})
