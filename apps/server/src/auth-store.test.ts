import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  applyEnvPassword,
  clearPassword,
  hasPassword,
  setPassword,
  verifyPassword,
} from './auth-store'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-auth-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('auth-store', () => {
  test('no password is set on a fresh state dir', () => {
    expect(hasPassword(dir)).toBe(false)
  })

  test('setPassword then verifyPassword succeeds for the right password', async () => {
    await setPassword('correct horse battery staple', dir)
    expect(hasPassword(dir)).toBe(true)
    expect(await verifyPassword('correct horse battery staple', dir)).toBe(true)
  })

  test('verifyPassword fails for the wrong password', async () => {
    await setPassword('hunter2', dir)
    expect(await verifyPassword('hunter3', dir)).toBe(false)
  })

  test('verifyPassword is false when no password is set', async () => {
    expect(await verifyPassword('anything', dir)).toBe(false)
  })

  test('the stored file never contains the plaintext password and is owner-only', async () => {
    await setPassword('s3cr3t-plaintext', dir)
    const path = join(dir, 'auth.json')
    const raw = readFileSync(path, 'utf8')
    expect(raw).not.toContain('s3cr3t-plaintext')
    // mode 0600 (owner read/write only)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('clearPassword removes the credential (opt-out)', async () => {
    await setPassword('hunter2', dir)
    clearPassword(dir)
    expect(hasPassword(dir)).toBe(false)
    expect(await verifyPassword('hunter2', dir)).toBe(false)
  })

  test('setPassword rejects an empty password', async () => {
    await expect(setPassword('', dir)).rejects.toThrow()
    await expect(setPassword('   ', dir)).rejects.toThrow()
    expect(hasPassword(dir)).toBe(false)
  })

  test('a changed password invalidates the old one', async () => {
    await setPassword('old-pw', dir)
    await setPassword('new-pw', dir)
    expect(await verifyPassword('old-pw', dir)).toBe(false)
    expect(await verifyPassword('new-pw', dir)).toBe(true)
  })

  test('the credential persists across reads (disk-backed, not in-memory)', async () => {
    await setPassword('durable-pw', dir)
    // A fresh call with no shared state must still verify — proves it reads from disk.
    expect(await verifyPassword('durable-pw', dir)).toBe(true)
  })
})

describe('applyEnvPassword (headless seam)', () => {
  test('sets the password from PODIUM_PASSWORD when none is configured', async () => {
    await applyEnvPassword({ PODIUM_PASSWORD: 'from-env' }, dir)
    expect(hasPassword(dir)).toBe(true)
    expect(await verifyPassword('from-env', dir)).toBe(true)
  })

  test('does NOT overwrite an already-configured password (idempotent across restarts)', async () => {
    await setPassword('user-chosen', dir)
    await applyEnvPassword({ PODIUM_PASSWORD: 'from-env' }, dir)
    expect(await verifyPassword('user-chosen', dir)).toBe(true)
    expect(await verifyPassword('from-env', dir)).toBe(false)
  })

  test('is a no-op when PODIUM_PASSWORD is unset or blank', async () => {
    await applyEnvPassword({}, dir)
    expect(hasPassword(dir)).toBe(false)
    await applyEnvPassword({ PODIUM_PASSWORD: '   ' }, dir)
    expect(hasPassword(dir)).toBe(false)
  })
})
