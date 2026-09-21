import { describe, expect, it } from 'vitest'
import { parseCodexAuthContents, codexAccessTokenExpiryMs } from '../../codex-auth-identity.js'
import { credentialFileReader, declaredValue } from '../../manifest.js'
import { codexCredentials } from './credentials.js'

function jwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')
  return `h.${payload}.s`
}

const nowSec = () => Math.floor(Date.now() / 1000)

describe('codexCredentials section', () => {
  it('serves the codex bundle from the CODEX_HOME-aware auth file', () => {
    expect(codexCredentials.kinds).toEqual(['codex'])
    expect(codexCredentials.files).toHaveLength(1)
    expect(codexCredentials.files[0]).toMatchObject({
      kind: 'codex',
      dirName: '.codex',
      fileName: 'auth.json',
      homeEnvVar: 'CODEX_HOME',
      propagatable: true,
    })
    expect(declaredValue(codexCredentials.transfer)).toBeUndefined()
  })

  it('resolves identity from the declared file, nothing else', () => {
    const idToken = jwt(nowSec() + 3600)
    const contents = JSON.stringify({
      tokens: { access_token: 'a', refresh_token: 'r', id_token: idToken },
    })
    const identity = codexCredentials.identity(() => contents)
    expect(identity?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(codexCredentials.identity(() => undefined)).toBeUndefined()
  })

  it('reads through the shared file reader the login probe uses', () => {
    const read = credentialFileReader(codexCredentials, '/no/such/home', {})
    expect(read('.codex', 'auth.json')).toBeUndefined()
  })
})

describe('parseCodexAuthContents', () => {
  it('extracts the token pair and rejects half logins', () => {
    expect(
      parseCodexAuthContents(
        JSON.stringify({ tokens: { access_token: 'tok', account_id: 'acct' } }),
      ),
    ).toEqual({ accessToken: 'tok', accountId: 'acct' })
    expect(parseCodexAuthContents(JSON.stringify({ tokens: { access_token: 'tok' } }))).toBeUndefined()
    expect(parseCodexAuthContents('not-json')).toBeUndefined()
  })

  it('reads the JWT clock without verifying', () => {
    const expMs = codexAccessTokenExpiryMs(jwt(nowSec() + 60))
    expect(expMs).toBeGreaterThan(Date.now())
    expect(codexAccessTokenExpiryMs('not-a-jwt')).toBeUndefined()
  })
})
