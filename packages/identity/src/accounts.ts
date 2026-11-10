/** Accounts and their password login method (specification, sections 2.4 and 7.1). */
import type { Runtime } from './runtime'
import {
  generatedIdentifier,
  inGeneratedDomain,
  isGeneratedIdentifier,
  normaliseEmail,
} from './secrets'
import {
  type AccountRow,
  accountByEmail,
  accountById,
  insertPasswordMethod,
  passwordOfAccount,
  updatePassword,
} from './statements'
import { type Account, type AccountOperations, IdentityRefused } from './types'

/** The public form of an account row: a generated identifier is never shown. */
export function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    email: isGeneratedIdentifier(row.email) ? null : row.email,
    image: row.image,
  }
}

/** A real address a person typed, normalised; an address in the reserved domain is refused. */
function acceptedEmail(value: string): string {
  const email = normaliseEmail(value)
  if (email === '' || inGeneratedDomain(email)) throw new IdentityRefused('email-invalid')
  return email
}

export function accountOperations(runtime: Runtime): AccountOperations {
  /** Writes the password login method of an account, replacing an earlier one. */
  async function writePassword(accountId: string, hash: string): Promise<void> {
    const now = runtime.now()
    const updated = await updatePassword(runtime.db()).run({ accountId, password: hash, now })
    if (updated.length > 0) return
    await insertPasswordMethod(runtime.db()).run({
      id: runtime.newId('account'),
      accountId,
      password: hash,
      now,
    })
  }

  async function setPasswordHash(accountId: string, hash: string): Promise<void> {
    if (!runtime.isPasswordHash(hash)) throw new IdentityRefused('password-hash-invalid')
    await runtime.transaction(async () => {
      if ((await accountById(runtime.db()).run({ id: accountId })).length === 0) {
        throw new IdentityRefused('unknown-account')
      }
      await writePassword(accountId, hash)
    })
  }

  return {
    async create(input) {
      const email = input.email === undefined ? generatedIdentifier() : acceptedEmail(input.email)
      // Hashed before the transaction opens: a password hash takes long on purpose.
      const hash =
        input.passwordHash ??
        (input.password === undefined ? undefined : await runtime.hashPassword(input.password))
      return await runtime.transaction(async () => {
        if ((await accountByEmail(runtime.db()).run({ email })).length > 0) {
          throw new IdentityRefused('email-taken')
        }
        const user = await runtime.library.internalAdapter.createUser(
          { name: input.name, email, emailVerified: false },
          // Provisioned by the server, never by a person's own sign-up.
          { method: 'admin' },
        )
        if (hash !== undefined) await writePassword(user.id, hash)
        return toAccount({
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image ?? null,
        })
      })
    },

    async get(accountId) {
      const [row] = await accountById(runtime.db()).run({ id: accountId })
      return row ? toAccount(row) : undefined
    },

    async byEmail(email) {
      const normalised = normaliseEmail(email)
      if (inGeneratedDomain(normalised)) return undefined
      const [row] = await accountByEmail(runtime.db()).run({ email: normalised })
      return row ? toAccount(row) : undefined
    },

    async hasPassword(accountId) {
      const [row] = await passwordOfAccount(runtime.db()).run({ accountId })
      return Boolean(row?.password)
    },

    async verifyPassword(accountId, password) {
      const [row] = await passwordOfAccount(runtime.db()).run({ accountId })
      if (!row?.password) return false
      return await runtime.verifyPassword(password, row.password)
    },

    async setPassword(accountId, password) {
      // Hashed before the transaction opens: a password hash takes long on purpose.
      await setPasswordHash(accountId, await runtime.hashPassword(password))
    },

    setPasswordHash,

    async setEmail(accountId, value) {
      const email = acceptedEmail(value)
      await runtime.transaction(async () => {
        const [holder] = await accountByEmail(runtime.db()).run({ email })
        if (holder && holder.id !== accountId) throw new IdentityRefused('email-taken')
        if ((await accountById(runtime.db()).run({ id: accountId })).length === 0) {
          throw new IdentityRefused('unknown-account')
        }
        // Through the library, so its account hook tells the memberships.
        await runtime.library.internalAdapter.updateUser(accountId, { email })
      })
    },

    async updateProfile(accountId, profile) {
      const change: { name?: string; image?: string | null } = {}
      if (profile.name !== undefined) change.name = profile.name
      if (profile.image !== undefined) change.image = profile.image
      if (Object.keys(change).length === 0) return
      await runtime.transaction(async () => {
        if ((await accountById(runtime.db()).run({ id: accountId })).length === 0) {
          throw new IdentityRefused('unknown-account')
        }
        await runtime.library.internalAdapter.updateUser(accountId, change)
      })
    },
  }
}
