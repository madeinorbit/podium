import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  readCachedSessionToken,
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
