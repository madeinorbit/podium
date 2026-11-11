import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  isOldFormSessionToken,
  readCachedSessionToken,
  readOldFormSessionToken,
  resolveSessionToken,
  saveCachedSessionToken,
  sessionTokenPath,
} from './session-mint'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-session-cache-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('caches a minted token readable only by its owner', () => {
  const minted = { token: 'signed.token=', expiresAt: '2999-01-01T00:00:00.000Z' }
  saveCachedSessionToken(minted, dir)

  expect(readCachedSessionToken(dir)).toBe(minted.token)
  expect(statSync(sessionTokenPath(dir)).mode & 0o077).toBe(0)
  expect(readFileSync(sessionTokenPath(dir), 'utf8')).toContain(minted.token)
})

it('ignores a cached token that has expired', () => {
  const past = '2020-01-01T00:00:00.000Z'
  saveCachedSessionToken({ token: 'stale', expiresAt: past }, dir)
  expect(readCachedSessionToken(dir)).toBeUndefined()
})

it('ignores an unreadable or malformed cache rather than throwing', () => {
  writeFileSync(sessionTokenPath(dir), 'not json')
  expect(readCachedSessionToken(dir)).toBeUndefined()
})

it('prefers an explicit PODIUM_SESSION_TOKEN over the cache', () => {
  saveCachedSessionToken({ token: 'cached', expiresAt: '2999-01-01T00:00:00.000Z' }, dir)
  expect(resolveSessionToken({ PODIUM_SESSION_TOKEN: 'from-env' }, dir)).toBe('from-env')
  expect(resolveSessionToken({}, dir)).toBe('cached')
})

it('resolves to undefined when there is no credential anywhere', () => {
  expect(resolveSessionToken({}, dir)).toBeUndefined()
})

it('leaves a pre-upgrade cache file alone for the carry-over', () => {
  const bytes = '{"token":"old-token","expiresAt":"2999-01-01T00:00:00.000Z"}'
  writeFileSync(sessionTokenPath(dir), bytes)
  expect(resolveSessionToken({}, dir)).toBeUndefined()
  expect(readFileSync(sessionTokenPath(dir), 'utf8')).toBe(bytes)
})

// The old-form cache, for the sign-in carry-over (POD-6751).
const OLD_TOKEN = 'Krhai8IVO7WU7uCc6cw94ZJckKFeeQ2iVNKGOm-di1U'

it('reads an old-form cache as old, never as a credential, and leaves the file alone', () => {
  const old = { token: OLD_TOKEN, expiresAt: '2999-01-01T00:00:00.000Z' }
  const text = `${JSON.stringify(old, null, 2)}\n`
  writeFileSync(sessionTokenPath(dir), text, { mode: 0o600 })
  // The ordinary reader does not hand an old token out as a credential.
  expect(readCachedSessionToken(dir)).toBeUndefined()
  expect(resolveSessionToken({}, dir)).toBeUndefined()
  expect(readOldFormSessionToken(dir)).toEqual(old)
  expect(readFileSync(sessionTokenPath(dir), 'utf8')).toBe(text)
})

it('does not take a new-form cache, an expired old one or a malformed one for an old-form cache', () => {
  saveCachedSessionToken({ token: 'signed.token=', expiresAt: '2999-01-01T00:00:00.000Z' }, dir)
  expect(readOldFormSessionToken(dir)).toBeUndefined()
  // A version-2 file whose token happens to look old is still the new form.
  saveCachedSessionToken({ token: OLD_TOKEN, expiresAt: '2999-01-01T00:00:00.000Z' }, dir)
  expect(readOldFormSessionToken(dir)).toBeUndefined()
  writeFileSync(
    sessionTokenPath(dir),
    JSON.stringify({ token: OLD_TOKEN, expiresAt: '2020-01-01T00:00:00.000Z' }),
  )
  expect(readOldFormSessionToken(dir)).toBeUndefined()
  writeFileSync(
    sessionTokenPath(dir),
    JSON.stringify({ token: 'signed.token=', expiresAt: '2999-01-01T00:00:00.000Z' }),
  )
  expect(readOldFormSessionToken(dir)).toBeUndefined()
  writeFileSync(sessionTokenPath(dir), 'not json')
  expect(readOldFormSessionToken(dir)).toBeUndefined()
  rmSync(sessionTokenPath(dir))
  expect(readOldFormSessionToken(dir)).toBeUndefined()
})

it('tells an old token from a signed one by its form', () => {
  expect(isOldFormSessionToken(OLD_TOKEN)).toBe(true)
  expect(isOldFormSessionToken(`${OLD_TOKEN}.c2lnbmF0dXJl`)).toBe(false)
  expect(isOldFormSessionToken('short')).toBe(false)
  expect(isOldFormSessionToken('')).toBe(false)
})
