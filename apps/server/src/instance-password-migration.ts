/**
 * RETIRING THE INSTANCE PASSWORD (POD-1554) — the one-shot that moves the hash in
 * `auth.json` into the first admin's `per-user-scrypt` credential row, and the headless
 * `PODIUM_PASSWORD` seam rewritten to write the same row.
 *
 * WHY THIS IS NOT A SQL MIGRATION. POD-1075 wrote the first admin a credential row with
 * `source = 'instance-password'` and a NULL hash, meaning *this account authenticates with
 * the instance password that already exists in `auth.json`* — because SQL cannot read a
 * file in the state directory. That is still true. So the move has to happen in the
 * process, at boot, before anything can serve a login.
 *
 * THE ORDER IS THE SAFETY PROPERTY, and it is written as write → RE-READ → verify →
 * delete, never write → delete. The first admin of every upgraded instance authenticates
 * through this hash; a delete that outran a failed write locks the operator out of their
 * own machine, and the failure is invisible until the next login attempt, which may be days
 * later. Every early return below leaves `auth.json` exactly where it was: not migrating is
 * a recoverable state (the next boot retries), and a lockout is not.
 *
 * AMBIENT PRINCIPAL, DELIBERATE AND PERMANENT (POD-1669). Every
 * `FIRST_ADMIN_USER_ID` below is an ambient-principal site by the census's
 * definition, and NO CALLER EXISTS HERE TO RESOLVE INSTEAD. Both functions run at
 * boot, before the server can serve a login, so there is no authenticated request
 * to read a principal from; and the account is not a choice this code makes — the
 * legacy `auth.json` hash belongs to exactly one account by construction, the
 * first admin of a pre-multi-user instance. Resolving a caller here would be
 * resolving the wrong thing. These sites survive multi-user unchanged; see
 * `scripts/audit-ambient-principals.ts` BASELINE.
 */

import { FIRST_ADMIN_USER_ID } from '@podium/model'
import {
  deleteLegacyInstancePasswordFile,
  hashPassword,
  readLegacyInstancePasswordHash,
} from '@podium/runtime/auth-store'

/** The slice of `UsersRepository` this file needs — narrow so a test can pass a fake and so
 *  nothing here can reach a repository method that mints accounts. */
export interface FirstAdminCredentialStore {
  get(userId: string): { role: string } | undefined
  credentialFor(userId: string): { source: string; passwordHash: string | null } | undefined
  setPasswordHash(userId: string, passwordHash: string, updatedAt: string): void
}

export interface RetireInstancePasswordResult {
  /** What the boot actually did. `migrated` is the only outcome that wrote a credential. */
  outcome: 'migrated' | 'nothing-to-migrate' | 'no-first-admin' | 'verify-failed'
}

export interface RetireInstancePasswordOptions {
  users: FirstAdminCredentialStore
  /** State dir holding the legacy `auth.json`. Defaults to the real one. */
  authDir?: string | undefined
  now?: () => Date
  warn?: (message: string) => void
}

/**
 * Move the legacy instance password into the first admin's per-user credential.
 *
 * IDEMPOTENT BY CONSTRUCTION rather than by a flag: the trigger is the presence of
 * `auth.json`, and the last thing a successful run does is delete it. A second run finds
 * nothing to read and returns `nothing-to-migrate` without touching the database — which is
 * also what a box that never had a password does, and what every boot after the upgrade
 * does forever. `instance-password-migration.test.ts` runs it twice and reddens if the
 * second run writes.
 */
export async function retireInstancePassword(
  opts: RetireInstancePasswordOptions,
): Promise<RetireInstancePasswordResult> {
  const { users, authDir } = opts
  const warn = opts.warn ?? ((m: string) => console.warn(m))

  const legacyHash = readLegacyInstancePasswordHash(authDir)
  if (!legacyHash) return { outcome: 'nothing-to-migrate' }

  // No account to move it TO. Can only happen if the store is a shape this build does not
  // recognise (the POD-1075 migration inserts this row unconditionally, on fresh installs
  // too). Leave the file: the instance keeps booting, and the next boot on a fixed build
  // migrates. Deleting here would strand the hash with nothing holding it.
  if (!users.get(FIRST_ADMIN_USER_ID)) {
    warn(
      '[podium] the login password in auth.json could not be migrated: no first-admin account. ' +
        'auth.json is left in place and the next boot will retry.',
    )
    return { outcome: 'no-first-admin' }
  }

  // Already a real per-user credential — an operator who set a password through the UI
  // after upgrading. Their row wins; the file is stale and goes. NOT a silent overwrite:
  // clobbering the newer credential with the older file is the one way this function could
  // change someone's working password out from under them.
  const existing = users.credentialFor(FIRST_ADMIN_USER_ID)
  if (existing?.source === 'per-user-scrypt' && existing.passwordHash) {
    deleteLegacyInstancePasswordFile(authDir)
    return { outcome: 'nothing-to-migrate' }
  }

  const updatedAt = (opts.now?.() ?? new Date()).toISOString()
  users.setPasswordHash(FIRST_ADMIN_USER_ID, legacyHash, updatedAt)

  // THE RE-READ. Not a formality: it goes back to the database rather than trusting the
  // write's return, because what must be true before the file goes is that a LOGIN would
  // now succeed — and a login reads this row through exactly this call.
  const written = users.credentialFor(FIRST_ADMIN_USER_ID)
  if (written?.source !== 'per-user-scrypt' || written.passwordHash !== legacyHash) {
    warn(
      '[podium] the login password in auth.json was NOT migrated: the credential did not read ' +
        'back. auth.json is left in place, so login still works; the next boot will retry.',
    )
    return { outcome: 'verify-failed' }
  }

  deleteLegacyInstancePasswordFile(authDir)
  return { outcome: 'migrated' }
}

/**
 * THE HEADLESS SEAM, rehomed. `PODIUM_PASSWORD` lets a non-interactive deploy (a VPS, a
 * container) enable login without the setup UI. It now writes the FIRST ADMIN's per-user
 * credential instead of `auth.json` — the same account, the same login, one home.
 *
 * Still deliberately ONE-SHOT: it never overwrites an existing credential, so leaving the
 * variable set across restarts cannot clobber a password the user later changed in the UI.
 * That was the shipped guarantee and it is preserved verbatim; only the destination moved.
 */
export async function applyEnvFirstAdminPassword(opts: {
  users: FirstAdminCredentialStore
  env?: NodeJS.ProcessEnv
  now?: () => Date
}): Promise<{ applied: boolean }> {
  const env = opts.env ?? process.env
  const pw = env.PODIUM_PASSWORD
  if (!pw?.trim()) return { applied: false }
  if (!opts.users.get(FIRST_ADMIN_USER_ID)) return { applied: false }

  const existing = opts.users.credentialFor(FIRST_ADMIN_USER_ID)
  if (existing?.source === 'per-user-scrypt' && existing.passwordHash) return { applied: false }

  const updatedAt = (opts.now?.() ?? new Date()).toISOString()
  opts.users.setPasswordHash(FIRST_ADMIN_USER_ID, await hashPassword(pw), updatedAt)
  return { applied: true }
}
