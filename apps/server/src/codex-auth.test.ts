import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveCodexAuth } from './codex-auth'
import { LlmConfigError } from './llm'

/** Build a (signature-less) JWT whose `exp` claim is `expSeconds`. */
function jwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')
  return `h.${payload}.s`
}

const nowSec = () => Math.floor(Date.now() / 1000)

function writeAuth(home: string, accessToken: string, accountId = 'acct-1'): void {
  writeFileSync(
    join(home, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: accessToken,
        refresh_token: 'refresh-single-use-xyz',
        account_id: accountId,
      },
      last_refresh: '2026-06-11T00:00:00Z',
    }),
  )
}

/** A fetch that fails the test if called — proves codex-auth never hits the network. */
const FETCH_FORBIDDEN = (() => {
  throw new Error('fetch must not be called: codex-auth is read-only and never rotates the token')
}) as unknown as typeof fetch

describe('resolveCodexAuth — read-only, self-healing', () => {
  let home: string
  let prev: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codex-auth-'))
    prev = process.env.CODEX_HOME
    process.env.CODEX_HOME = home
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prev
  })

  it('returns the access token and account id for a valid token without touching the file', async () => {
    const token = jwt(nowSec() + 3600)
    writeAuth(home, token, 'acct-9')
    const before = readFileSync(join(home, 'auth.json'), 'utf8')

    const auth = await resolveCodexAuth(FETCH_FORBIDDEN)

    expect(auth).toEqual({ accessToken: token, accountId: 'acct-9' })
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe(before)
  })

  it('throws an actionable error instead of refreshing when the token is expired', async () => {
    writeAuth(home, jwt(nowSec() - 60))
    const before = readFileSync(join(home, 'auth.json'), 'utf8')

    await expect(resolveCodexAuth(FETCH_FORBIDDEN)).rejects.toBeInstanceOf(LlmConfigError)
    await expect(resolveCodexAuth(FETCH_FORBIDDEN)).rejects.toThrow(/codex login/)
    // Never rewrites the shared single-use credential.
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe(before)
  })

  it('self-heals: returns a token a concurrent codex session rotated in, not the rejected one', async () => {
    // 401-retry shape: our previous token was rejected; the file now holds a fresh one
    // (a live codex CLI session rotated it). We must pick up the new token.
    const fresh = jwt(nowSec() + 3600)
    writeAuth(home, fresh)

    const auth = await resolveCodexAuth(FETCH_FORBIDDEN, {
      rejectedAccessToken: 'previous-token-the-backend-401d',
    })

    expect(auth.accessToken).toBe(fresh)
  })

  it('does not loop on a token the backend already rejected when the file still holds it', async () => {
    const token = jwt(nowSec() + 3600) // structurally valid, but the backend 401'd it
    writeAuth(home, token)

    await expect(
      resolveCodexAuth(FETCH_FORBIDDEN, { rejectedAccessToken: token }),
    ).rejects.toBeInstanceOf(LlmConfigError)
  })
})
