/**
 * THE EARLIEST-ADMIN RULE (A2).
 *
 * Four askers share this one statement — open mode, the break-glass mint, the
 * store's priming of `firstAdminMemberId()`, and the password login's resolution
 * of an absent identifier. They used to agree because a constant cannot disagree
 * with itself. They agree now because they ask the same question, so the
 * question's edges are worth pinning: which member wins when there are several,
 * what a disabled admin does, and what the two "no answer" cases are.
 */

import { describe, expect, it } from 'vitest'
import { earliestAdminMember, instanceModelsAccounts } from './earliest-admin'
import { openDatabase, type SqlDatabase } from './sqlite'

/** The `users` table as apps/server's migrations create it. */
function withUsers(rows: { id: string; role: string; createdAt: string; disabledAt?: string }[]) {
  const db = openDatabase(':memory:')
  db.prepare(
    `CREATE TABLE users (
       id TEXT PRIMARY KEY,
       display_name TEXT NOT NULL,
       role TEXT NOT NULL,
       created_at TEXT NOT NULL,
       disabled_at TEXT
     )`,
  ).run()
  for (const r of rows) {
    db.prepare(
      'INSERT INTO users (id, display_name, role, created_at, disabled_at) VALUES (?, ?, ?, ?, ?)',
    ).run(r.id, r.id, r.role, r.createdAt, r.disabledAt ?? null)
  }
  return db
}

const close = (db: SqlDatabase) => db.close?.()

describe('the earliest admin member', () => {
  it('is the admin created first, not the one the b-tree happens to reach first', () => {
    // Inserted newest-first on purpose: a rule that read "whichever row comes
    // back" would pass with the rows in the other order and fail here.
    const db = withUsers([
      { id: 'mem_late', role: 'admin', createdAt: '2026-09-01T00:00:00.000Z' },
      { id: 'mem_early', role: 'admin', createdAt: '2026-01-01T00:00:00.000Z' },
    ])
    expect(earliestAdminMember(db)).toBe('mem_early')
    close(db)
  })

  it('breaks a tie on the id, so the principal is never a coin flip', () => {
    // Two members created in the same millisecond is not hypothetical on a
    // seeded install. Without the tie-break the answer depends on storage order,
    // which means the instance could act as a different person after a VACUUM.
    const db = withUsers([
      { id: 'mem_b', role: 'admin', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'mem_a', role: 'admin', createdAt: '2026-01-01T00:00:00.000Z' },
    ])
    expect(earliestAdminMember(db)).toBe('mem_a')
    close(db)
  })

  it('ignores members who are not admins, however early they are', () => {
    const db = withUsers([
      { id: 'mem_member', role: 'member', createdAt: '2020-01-01T00:00:00.000Z' },
      { id: 'mem_admin', role: 'admin', createdAt: '2026-01-01T00:00:00.000Z' },
    ])
    expect(earliestAdminMember(db)).toBe('mem_admin')
    close(db)
  })

  it('skips a DISABLED admin and answers with the next one', () => {
    // ADR 9's disable-before-remove keeps the row and takes away the ability to
    // produce a principal. An instance whose first admin has been disabled must
    // not resolve to a member nothing may act as.
    const db = withUsers([
      {
        id: 'mem_disabled',
        role: 'admin',
        createdAt: '2026-01-01T00:00:00.000Z',
        disabledAt: '2026-06-01T00:00:00.000Z',
      },
      { id: 'mem_active', role: 'admin', createdAt: '2026-02-01T00:00:00.000Z' },
    ])
    expect(earliestAdminMember(db)).toBe('mem_active')
    close(db)
  })

  it('answers `undefined` when every admin is disabled', () => {
    const db = withUsers([
      {
        id: 'mem_disabled',
        role: 'admin',
        createdAt: '2026-01-01T00:00:00.000Z',
        disabledAt: '2026-06-01T00:00:00.000Z',
      },
    ])
    expect(earliestAdminMember(db)).toBeUndefined()
    close(db)
  })

  it('answers `undefined` on a database from before accounts existed', () => {
    const db = openDatabase(':memory:')
    expect(instanceModelsAccounts(db)).toBe(false)
    expect(earliestAdminMember(db)).toBeUndefined()
    close(db)
  })

  it('tells the two empty answers apart, because one caller must', () => {
    // The break-glass mint still mints on a pre-accounts schema (ADR 3 D14's
    // ACCEPT case) and refuses when every admin is disabled. Collapsing the two
    // into one `undefined` would make that decision unreachable.
    const preAccounts = openDatabase(':memory:')
    const disabled = withUsers([
      {
        id: 'mem_x',
        role: 'admin',
        createdAt: '2026-01-01T00:00:00.000Z',
        disabledAt: '2026-06-01T00:00:00.000Z',
      },
    ])
    expect(instanceModelsAccounts(preAccounts)).toBe(false)
    expect(instanceModelsAccounts(disabled)).toBe(true)
    close(preAccounts)
    close(disabled)
  })
})
