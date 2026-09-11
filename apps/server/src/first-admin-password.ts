/**
 * THE FIRST ADMIN'S PASSWORD, FROM THE TWO PLACES ONE CAN ARRIVE BEFORE A BOOT —
 * `auth.json`, staged by `podium setup`, and `PODIUM_PASSWORD`, set by a
 * headless deploy.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACED, AND WHAT WAS ACTUALLY DELETED (A2)
 * ---------------------------------------------------------------------------
 *
 * This file is `instance-password-migration.ts` with its migration removed. That
 * module existed for POD-1554's one-shot: the SHARED INSTANCE PASSWORD — the
 * scrypt hash in `auth.json` that authenticated a connection rather than a
 * person — being copied into the first admin's per-account credential on the
 * first boot of a build that had accounts. A2's spec retires it, and the thing
 * it retires is that narrative: there is no instance password any more, so
 * nothing is being migrated from one.
 *
 * WHAT COULD NOT GO WITH IT, and the reading that would have broken a live
 * feature: `auth.json` is not only a legacy artefact. `podium setup` stages a
 * password into the SAME file on a box with no server and no database yet
 * (`stagePasswordForFirstBoot` in @podium/runtime's auth-store), precisely
 * because a CLI cannot write a credential row into a store that does not exist.
 * The first boot's read-write-verify-delete is how that password becomes real.
 * Deleting the whole module would have deleted the interactive installer's
 * password with it — silently, because a fresh install with no password looks
 * exactly like an install whose password was dropped.
 *
 * So what survives is a HANDOFF, named as one, and what went is the claim that
 * it is a migration from an older world.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER IS THE SAFETY PROPERTY
 * ---------------------------------------------------------------------------
 *
 * Written as write → RE-READ → verify → delete, never write → delete. The first
 * admin of an upgraded instance authenticates through this hash; a delete that
 * outran a failed write locks the operator out of their own machine, and the
 * failure is invisible until the next login attempt, which may be days later.
 * Every early return below leaves `auth.json` exactly where it was: not claiming
 * it is a recoverable state (the next boot retries), and a lockout is not.
 *
 * ---------------------------------------------------------------------------
 * THE ACCOUNT IS RESOLVED, NOT NAMED (A2)
 * ---------------------------------------------------------------------------
 *
 * Every site below used to spell `FIRST_ADMIN_USER_ID`, and POD-1669's census
 * recorded them as ambient-principal sites with no caller to resolve instead —
 * both functions run at boot, before the server can serve a login, so there is
 * no authenticated request to read a principal from. That reasoning is unchanged
 * and the sites are still ambient. What changed is what "the first admin" is: a
 * member row selected by `UsersRepository.earliestAdmin()`, not an id this build
 * compiles in. A staged password with no member to attach it to leaves the file
 * in place and says so, rather than writing a credential for a ghost.
 */

import { createLogger } from '@podium/logger'
import type { UserId } from '@podium/model'
import { asUserId } from '@podium/model'
import {
  deleteLegacyInstancePasswordFile,
  hashPassword,
  readLegacyInstancePasswordHash,
} from '@podium/runtime/auth-store'

const log = createLogger('server:first-admin-password')

/** The slice of `UsersRepository` this file needs — narrow so a test can pass a fake and so
 *  nothing here can reach a repository method that mints accounts. */
export interface FirstAdminCredentialStore {
  earliestAdmin(): { id: string } | undefined | Promise<{ id: string } | undefined>
  credentialFor(
    userId: UserId,
  ):
    | { source: string; passwordHash: string | null }
    | undefined
    | Promise<{ source: string; passwordHash: string | null } | undefined>
  setPasswordHash(userId: UserId, passwordHash: string, updatedAt: string): void | Promise<void>
}

export interface AdoptStagedPasswordResult {
  /** What the boot actually did. `adopted` is the only outcome that wrote a credential. */
  outcome: 'adopted' | 'nothing-staged' | 'no-first-admin' | 'verify-failed'
}

export interface AdoptStagedPasswordOptions {
  users: FirstAdminCredentialStore
  /** State dir holding the staged `auth.json`. Defaults to the real one. */
  authDir?: string | undefined
  now?: () => Date
  warn?: (message: string) => void
}

/**
 * Move a staged password into the first admin's credential.
 *
 * IDEMPOTENT BY CONSTRUCTION rather than by a flag: the trigger is the presence of
 * `auth.json`, and the last thing a successful run does is delete it. A second run finds
 * nothing to read and returns `nothing-staged` without touching the database — which is
 * also what a box that never had a password does, and what every boot after the first
 * does forever. `first-admin-password.test.ts` runs it twice and reddens if the second
 * run writes.
 */
export async function adoptStagedFirstAdminPassword(
  opts: AdoptStagedPasswordOptions,
): Promise<AdoptStagedPasswordResult> {
  const { users, authDir } = opts
  const warn = opts.warn ?? ((m: string) => log.warn(m))

  const stagedHash = readLegacyInstancePasswordHash(authDir)
  if (!stagedHash) return { outcome: 'nothing-staged' }

  // No member to attach it to: a database from before accounts, or one whose admins are
  // all disabled. Leave the file — the instance keeps booting, and the next boot on a
  // fixed build adopts it. Deleting here would strand the hash with nothing holding it.
  const firstAdmin = await users.earliestAdmin()
  if (!firstAdmin) {
    warn(
      '[podium] the staged login password in auth.json could not be adopted: this instance has ' +
        'no admin member. auth.json is left in place and the next boot will retry.',
    )
    return { outcome: 'no-first-admin' }
  }
  const userId = asUserId(firstAdmin.id)

  // Already a real per-user credential — an operator who set a password through the UI
  // after upgrading. Their row wins; the file is stale and goes. NOT a silent overwrite:
  // clobbering the newer credential with the older file is the one way this function could
  // change someone's working password out from under them.
  const existing = await users.credentialFor(userId)
  if (existing?.source === 'per-user-scrypt' && existing.passwordHash) {
    deleteLegacyInstancePasswordFile(authDir)
    return { outcome: 'nothing-staged' }
  }

  const updatedAt = (opts.now?.() ?? new Date()).toISOString()
  await users.setPasswordHash(userId, stagedHash, updatedAt)

  // THE RE-READ. Not a formality: it goes back to the database rather than trusting the
  // write's return, because what must be true before the file goes is that a LOGIN would
  // now succeed — and a login reads this row through exactly this call.
  const written = await users.credentialFor(userId)
  if (written?.source !== 'per-user-scrypt' || written.passwordHash !== stagedHash) {
    warn(
      '[podium] the staged login password in auth.json was NOT adopted: the credential did not ' +
        'read back. auth.json is left in place, so login still works; the next boot will retry.',
    )
    return { outcome: 'verify-failed' }
  }

  deleteLegacyInstancePasswordFile(authDir)
  return { outcome: 'adopted' }
}

/**
 * THE HEADLESS SEAM. `PODIUM_PASSWORD` lets a non-interactive deploy (a VPS, a
 * container) enable login without the setup UI. It writes the FIRST ADMIN's per-user
 * credential — the same account, the same login, one home.
 *
 * Still deliberately ONE-SHOT: it never overwrites an existing credential, so leaving the
 * variable set across restarts cannot clobber a password the user later changed in the UI.
 * That was the shipped guarantee and it is preserved verbatim.
 *
 * The hosted image stops setting this variable (spec §10); nothing here knows that, and
 * nothing should — a self-hosted deploy is still entitled to it.
 */
export async function applyEnvFirstAdminPassword(opts: {
  users: FirstAdminCredentialStore
  env?: NodeJS.ProcessEnv
  now?: () => Date
}): Promise<{ applied: boolean }> {
  const env = opts.env ?? process.env
  const pw = env.PODIUM_PASSWORD
  if (!pw?.trim()) return { applied: false }
  const firstAdmin = await opts.users.earliestAdmin()
  if (!firstAdmin) return { applied: false }
  const userId = asUserId(firstAdmin.id)

  const existing = await opts.users.credentialFor(userId)
  if (existing?.source === 'per-user-scrypt' && existing.passwordHash) return { applied: false }

  const updatedAt = (opts.now?.() ?? new Date()).toISOString()
  await opts.users.setPasswordHash(userId, await hashPassword(pw), updatedAt)
  return { applied: true }
}
