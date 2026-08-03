import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deleteLegacyInstancePasswordFile,
  hashPassword,
  readLegacyInstancePasswordHash,
  stagePasswordForFirstBoot,
  verifyPasswordHash,
} from '@podium/runtime/auth-store'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-auth-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * What is left of this module after POD-1554 is the KDF every per-account credential is
 * stored in, plus the `auth.json` handoff. The instance password itself — `hasPassword` /
 * `setPassword` / `clearPassword` / `verifyPassword` / `applyEnvPassword` — is gone, and
 * its behaviour is now covered per-account in `instance-password-migration.test.ts` and
 * `router.auth.test.ts`.
 */
describe('auth-store (the credential format)', () => {
  test('verifyPasswordHash succeeds for the right password', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(await verifyPasswordHash('correct horse battery staple', hash)).toBe(true)
  })

  test('verifyPasswordHash fails for the wrong password', async () => {
    const hash = await hashPassword('hunter2')
    expect(await verifyPasswordHash('hunter3', hash)).toBe(false)
  })

  test('verifyPasswordHash fails closed on a malformed or empty stored hash', async () => {
    expect(await verifyPasswordHash('anything', '')).toBe(false)
    expect(await verifyPasswordHash('anything', 'not-a-scrypt-string')).toBe(false)
    expect(await verifyPasswordHash('anything', 'scrypt$16384$8$1$only-four-fields')).toBe(false)
  })

  test('the same password hashes differently every time (salted)', async () => {
    const a = await hashPassword('same-pw')
    const b = await hashPassword('same-pw')
    expect(a).not.toBe(b)
    expect(await verifyPasswordHash('same-pw', a)).toBe(true)
    expect(await verifyPasswordHash('same-pw', b)).toBe(true)
  })

  test('the hash never contains the plaintext password', async () => {
    expect(await hashPassword('s3cr3t-plaintext')).not.toContain('s3cr3t-plaintext')
  })
})

describe('auth.json (the first-boot handoff)', () => {
  test('staged file is owner-only and holds no plaintext', async () => {
    await stagePasswordForFirstBoot('s3cr3t-plaintext', dir)
    const path = join(dir, 'auth.json')
    expect(readFileSync(path, 'utf8')).not.toContain('s3cr3t-plaintext')
    // mode 0600 (owner read/write only)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('the staged hash reads back and verifies — this is what boot migrates', async () => {
    await stagePasswordForFirstBoot('chosen-at-setup', dir)
    const staged = readLegacyInstancePasswordHash(dir)
    expect(staged).toBeDefined()
    expect(await verifyPasswordHash('chosen-at-setup', staged ?? '')).toBe(true)
  })

  test('reads as absent on a fresh state dir', () => {
    expect(readLegacyInstancePasswordHash(dir)).toBeUndefined()
  })

  test('staging rejects an empty password', async () => {
    await expect(stagePasswordForFirstBoot('', dir)).rejects.toThrow()
    await expect(stagePasswordForFirstBoot('   ', dir)).rejects.toThrow()
    expect(readLegacyInstancePasswordHash(dir)).toBeUndefined()
  })

  test('deleting the file leaves nothing to migrate, and is safe to repeat', async () => {
    await stagePasswordForFirstBoot('hunter2', dir)
    deleteLegacyInstancePasswordFile(dir)
    expect(existsSync(join(dir, 'auth.json'))).toBe(false)
    expect(readLegacyInstancePasswordHash(dir)).toBeUndefined()
    expect(() => deleteLegacyInstancePasswordFile(dir)).not.toThrow()
  })
})
