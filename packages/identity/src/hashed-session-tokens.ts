/**
 * The hashing layer around the database adapter the sign-in library is given
 * (people and sign-in specification, section 1.6).
 *
 * The library stores a device sign-in token in clear and looks it up by
 * equality. This layer keeps the stronger property the server had before: the
 * database holds only the SHA-256 of a token.
 *
 *  - On create of a `session` row the token is replaced by its hash before the
 *    insert, and the row handed back carries the original token, because the
 *    library builds the cookie from that row.
 *  - On every find, update, delete or count of `session` whose condition names
 *    `token`, the values are hashed, and rows found by token are handed back
 *    carrying the token that was asked for.
 *  - A `session` row read any other way (by account, by id) carries the hash,
 *    which opens nothing.
 *  - An update that would set `token` is refused.
 *  - The library's own transaction call goes to the edition's transaction runner.
 *
 * No other model is touched.
 */
import { storedTokenForm } from './secrets'

interface Where {
  field: string
  value: unknown
  operator?: string
  connector?: string
}

// biome-ignore lint/suspicious/noExplicitAny: the library's adapter is a wide generic interface; this layer forwards it unchanged
export type LibraryAdapter = any

function hashWhere(where: Where[] | undefined): {
  where: Where[] | undefined
  raws: Map<string, string>
} {
  const raws = new Map<string, string>()
  const hashed = where?.map((clause) => {
    if (clause.field !== 'token') return clause
    if (Array.isArray(clause.value)) {
      return {
        ...clause,
        value: clause.value.map((raw) => {
          const stored = storedTokenForm(String(raw))
          raws.set(stored, String(raw))
          return stored
        }),
      }
    }
    const stored = storedTokenForm(String(clause.value))
    raws.set(stored, String(clause.value))
    return { ...clause, value: stored }
  })
  return { where: hashed, raws }
}

// biome-ignore lint/suspicious/noExplicitAny: a library row
function restore(row: any, raws: Map<string, string>): any {
  return row && typeof row.token === 'string' && raws.has(row.token)
    ? { ...row, token: raws.get(row.token) }
    : row
}

function refuseTokenRewrite(update: unknown): void {
  if (update && typeof update === 'object' && 'token' in update) {
    throw new Error('identity: a device sign-in token is never rewritten')
  }
}

/**
 * Wraps `inner`. `transaction` runs the library's multi-statement operations in
 * the edition's transaction and hands the callback the adapter of that transaction.
 */
export function hashedSessionTokens(
  inner: LibraryAdapter,
  transaction: <T>(fn: (adapter: LibraryAdapter) => Promise<T>) => Promise<T>,
): LibraryAdapter {
  // biome-ignore lint/suspicious/noExplicitAny: adapter call arguments
  type Args = any
  return {
    ...inner,
    async create(args: Args) {
      if (args.model !== 'session') return inner.create(args)
      const raw = String(args.data.token)
      const row = await inner.create({
        ...args,
        data: { ...args.data, token: storedTokenForm(raw) },
      })
      return row ? { ...row, token: raw } : row
    },
    async findOne(args: Args) {
      if (args.model !== 'session') return inner.findOne(args)
      const { where, raws } = hashWhere(args.where)
      return restore(await inner.findOne({ ...args, where }), raws)
    },
    async findMany(args: Args) {
      if (args.model !== 'session') return inner.findMany(args)
      const { where, raws } = hashWhere(args.where)
      const rows = await inner.findMany({ ...args, where })
      // biome-ignore lint/suspicious/noExplicitAny: a library row
      return rows.map((row: any) => restore(row, raws))
    },
    async update(args: Args) {
      if (args.model !== 'session') return inner.update(args)
      refuseTokenRewrite(args.update)
      const { where, raws } = hashWhere(args.where)
      return restore(await inner.update({ ...args, where }), raws)
    },
    async updateMany(args: Args) {
      if (args.model !== 'session') return inner.updateMany(args)
      refuseTokenRewrite(args.update)
      return inner.updateMany({ ...args, where: hashWhere(args.where).where })
    },
    async delete(args: Args) {
      if (args.model !== 'session') return inner.delete(args)
      return inner.delete({ ...args, where: hashWhere(args.where).where })
    },
    async deleteMany(args: Args) {
      if (args.model !== 'session') return inner.deleteMany(args)
      return inner.deleteMany({ ...args, where: hashWhere(args.where).where })
    },
    async count(args: Args) {
      if (args.model !== 'session') return inner.count(args)
      return inner.count({ ...args, where: hashWhere(args.where).where })
    },
    transaction: (callback: (adapter: LibraryAdapter) => Promise<unknown>) => transaction(callback),
  }
}
