/**
 * THE FIRST ADMIN'S PASSWORD, from the two places one can arrive before a boot.
 *
 * This is `instance-password-migration.test.ts` after A2, and it is the same
 * suite for the same reasons: the module it covers kept its behaviour and lost
 * its migration narrative. What changed is WHO the password lands on — a member
 * resolved by `earliestAdmin()`, not an id the build compiles in — so the fake
 * answers that question instead of comparing against a constant.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashPassword, verifyPasswordHash } from '@podium/runtime/auth-store'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  adoptStagedFirstAdminPassword,
  applyEnvFirstAdminPassword,
  type FirstAdminCredentialStore,
} from './first-admin-password'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-pw-migration-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** The member this instance's `earliestAdmin()` answers with. A `mem_` id, as
 *  A2's migration mints — the point being that the module under test never
 *  names it, it asks. */
const FIRST_ADMIN = 'mem_0ujtsYcgvSTl8PAuAdqWYSMnLOv'

/** A real `auth.json` in the shape `podium setup` stages it on disk. */
async function seedLegacyAuthFile(password: string): Promise<string> {
  const passwordHash = await hashPassword(password)
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ passwordHash }), { mode: 0o600 })
  return passwordHash
}

const authFileExists = (): boolean => existsSync(join(dir, 'auth.json'))

/**
 * A fake that COUNTS ITS WRITES. The count is what makes the idempotence test a property
 * rather than a claim: "the second run changed nothing" is only observable if something
 * records whether a write happened at all.
 */
class FakeUsers implements FirstAdminCredentialStore {
  writes = 0
  private account: { id: string } | undefined = { id: FIRST_ADMIN }
  private credential: { source: string; passwordHash: string | null } | undefined = {
    source: 'instance-password',
    passwordHash: null,
  }

  static withoutAccount(): FakeUsers {
    const f = new FakeUsers()
    f.account = undefined
    return f
  }

  static withPerUserCredential(passwordHash: string): FakeUsers {
    const f = new FakeUsers()
    f.credential = { source: 'per-user-scrypt', passwordHash }
    return f
  }

  earliestAdmin(): { id: string } | undefined {
    return this.account
  }

  credentialFor(userId: string): { source: string; passwordHash: string | null } | undefined {
    return userId === FIRST_ADMIN ? this.credential : undefined
  }

  setPasswordHash(userId: string, passwordHash: string): void {
    if (userId !== FIRST_ADMIN) throw new Error(`unexpected user: ${userId}`)
    this.writes += 1
    this.credential = { source: 'per-user-scrypt', passwordHash }
  }
}

describe('adoptStagedFirstAdminPassword', () => {
  test('moves the staged auth.json hash onto the first admin and deletes the file', async () => {
    const legacyHash = await seedLegacyAuthFile('correct horse battery staple')
    const users = new FakeUsers()

    const result = await adoptStagedFirstAdminPassword({ users, authDir: dir })

    expect(result.outcome).toBe('adopted')
    const credential = users.credentialFor(FIRST_ADMIN)
    expect(credential?.source).toBe('per-user-scrypt')
    // The COPY, not a rehash: the operator's existing password must still verify.
    expect(credential?.passwordHash).toBe(legacyHash)
    expect(
      await verifyPasswordHash('correct horse battery staple', credential?.passwordHash ?? ''),
    ).toBe(true)
    expect(authFileExists()).toBe(false)
  })

  test('IS IDEMPOTENT — a second run writes nothing', async () => {
    await seedLegacyAuthFile('hunter2')
    const users = new FakeUsers()

    const first = await adoptStagedFirstAdminPassword({ users, authDir: dir })
    const writesAfterFirst = users.writes
    const credentialAfterFirst = users.credentialFor(FIRST_ADMIN)?.passwordHash

    const second = await adoptStagedFirstAdminPassword({ users, authDir: dir })

    expect(first.outcome).toBe('adopted')
    expect(second.outcome).toBe('nothing-staged')
    expect(writesAfterFirst).toBe(1)
    // The assertion that reddens if a second run does anything at all.
    expect(users.writes).toBe(1)
    expect(users.credentialFor(FIRST_ADMIN)?.passwordHash).toBe(credentialAfterFirst)
  })

  test('a box with no staged password writes nothing', async () => {
    const users = new FakeUsers()

    const result = await adoptStagedFirstAdminPassword({ users, authDir: dir })

    expect(result.outcome).toBe('nothing-staged')
    expect(users.writes).toBe(0)
  })

  test('leaves auth.json in place when no member may act as the first admin', async () => {
    await seedLegacyAuthFile('hunter2')
    const users = FakeUsers.withoutAccount()

    const result = await adoptStagedFirstAdminPassword({ users, authDir: dir, warn: () => {} })

    expect(result.outcome).toBe('no-first-admin')
    expect(users.writes).toBe(0)
    // The lockout guard: the hash the operator logs in with must still exist somewhere.
    expect(authFileExists()).toBe(true)
  })

  test('leaves auth.json in place when the credential does not read back', async () => {
    await seedLegacyAuthFile('hunter2')
    const users = new FakeUsers()
    // A store that accepts the write and does not persist it — the failure mode the re-read
    // exists to catch. Without the re-read this deletes the only copy of the password.
    users.setPasswordHash = () => {
      users.writes += 1
    }

    const result = await adoptStagedFirstAdminPassword({ users, authDir: dir, warn: () => {} })

    expect(result.outcome).toBe('verify-failed')
    expect(authFileExists()).toBe(true)
  })

  test('does not clobber a per-user credential set after the upgrade', async () => {
    await seedLegacyAuthFile('the-old-one')
    const newer = await hashPassword('the-one-they-actually-use')
    const users = FakeUsers.withPerUserCredential(newer)

    const result = await adoptStagedFirstAdminPassword({ users, authDir: dir })

    expect(result.outcome).toBe('nothing-staged')
    expect(users.writes).toBe(0)
    expect(users.credentialFor(FIRST_ADMIN)?.passwordHash).toBe(newer)
    // Stale file, and it goes — but only because the credential that replaced it verified.
    expect(authFileExists()).toBe(false)
  })
})

describe('applyEnvFirstAdminPassword', () => {
  test('sets the first admin credential from PODIUM_PASSWORD', async () => {
    const users = new FakeUsers()

    const result = await applyEnvFirstAdminPassword({ users, env: { PODIUM_PASSWORD: 'from-env' } })

    expect(result.applied).toBe(true)
    const credential = users.credentialFor(FIRST_ADMIN)
    expect(credential?.source).toBe('per-user-scrypt')
    expect(await verifyPasswordHash('from-env', credential?.passwordHash ?? '')).toBe(true)
    // Nothing was written to auth.json — the seam writes a credential row.
    expect(authFileExists()).toBe(false)
  })

  test('IS ONE-SHOT — never overwrites an existing per-user credential', async () => {
    const existing = await hashPassword('set-in-the-ui')
    const users = FakeUsers.withPerUserCredential(existing)

    const result = await applyEnvFirstAdminPassword({ users, env: { PODIUM_PASSWORD: 'from-env' } })

    expect(result.applied).toBe(false)
    expect(users.writes).toBe(0)
    expect(users.credentialFor(FIRST_ADMIN)?.passwordHash).toBe(existing)
  })

  test('is a no-op when PODIUM_PASSWORD is unset or blank', async () => {
    const users = new FakeUsers()

    expect((await applyEnvFirstAdminPassword({ users, env: {} })).applied).toBe(false)
    expect(
      (await applyEnvFirstAdminPassword({ users, env: { PODIUM_PASSWORD: '   ' } })).applied,
    ).toBe(false)
    expect(users.writes).toBe(0)
  })
})
