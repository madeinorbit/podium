/**
 * THE SQLITE LEG OF THE SHARED IDENTITY SUITE (POD-6744;
 * docs/design/people-and-sign-in.md section 10.3).
 *
 * The suite itself lives in `@podium/identity/testing` and is the same code the
 * cloud runs on Postgres. This file gives it the server's real store on a
 * temporary file: the tables come from the server's migration chain, and every
 * statement goes through the server's executor and driver. It lives here, and
 * not in the package, because the package may not import the server.
 *
 * Two checks belong to this leg alone:
 *   - every case of the suite ran, under both configurations;
 *   - no statement issued during the suite, the sign-in library's included,
 *     reads an identity table by a table scan.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IdentityDatabase, SqliteDb } from '@podium/identity'
import { IDENTITY_SUITE_CASES, identitySuite, type StoredTable } from '@podium/identity/testing'
import { hashPassword, verifyPasswordHash } from '@podium/runtime/auth-store'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionStore } from '../store'
import { probeStatements } from '../store/executor'
import type { StoreQueries } from '../store/executor/sync-drizzle'

const TABLES: Record<StoredTable, string> = {
  user: 'identity_user',
  account: 'identity_account',
  session: 'identity_session',
  oneTimeCode: 'identity_one_time_code',
}

/** Every statement text the suite sent to the driver, for the plan check below. */
const observed = new Set<string>()

const run = identitySuite(
  { describe, it, beforeEach, afterEach, expect },
  {
    name: 'sqlite',
    // The self-hosted edition's own password functions.
    passwordHashing: {
      hash: hashPassword,
      verify: ({ password, hash }) => verifyPasswordHash(password, hash),
    },
    async open() {
      const dir = mkdtempSync(join(tmpdir(), 'podium-identity-suite-'))
      const path = join(dir, 'podium.db')
      const store = await SessionStore.open(path)
      // The store's one drizzle instance and its transaction runner. Nothing in
      // the server hands them to the identity package yet (POD-6746 does), so
      // this leg reads them where the store keeps them.
      const internals = store as unknown as { queries: StoreQueries; db: object }
      const { rootDb, createOrJoinTransaction } = internals.queries
      const database: IdentityDatabase = {
        dialect: 'sqlite',
        db: rootDb as unknown as SqliteDb,
        transaction: (fn) => createOrJoinTransaction(() => fn(rootDb as unknown as SqliteDb)),
      }
      let statements = 0
      const detach = probeStatements(internals, (observation) => {
        statements += 1
        observed.add(observation.sql)
      })
      // Raw reads use a connection of their own, so they are neither counted
      // nor planned as statements of the package.
      const reader = openDatabase(path)
      return {
        database,
        memberRows: {
          // The member rows port is the memberships task's (POD-6745): it adds
          // `MemberRows.write` to the users repository and binds it here.
          async write() {
            throw new Error('member rows are bound by the memberships task (POD-6745)')
          },
          async read() {
            return undefined
          },
        },
        async stored(table, column) {
          if (!/^[a-z_]+$/.test(column)) throw new Error(`not a column name: ${column}`)
          const rows = reader.prepare(`SELECT ${column} AS value FROM ${TABLES[table]}`).all()
          return (rows as { value: unknown }[]).map((row) => row.value)
        },
        statements: () => statements,
        async close() {
          detach()
          reader.close()
          await store.close()
          rmSync(dir, { recursive: true, force: true })
        },
      }
    },
  },
)

describe('identity suite on sqlite: the leg', () => {
  it('ran every case of the shared suite under both configurations', () => {
    expect(run.casesRun().sort()).toEqual([...IDENTITY_SUITE_CASES].sort())
  })

  it('reads no identity table by a table scan, the sign-in library included', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-identity-plans-'))
    const path = join(dir, 'podium.db')
    const store = await SessionStore.open(path)
    const reader = openDatabase(path)
    try {
      const statements = [...observed].filter((sql) => /\bidentity_/.test(sql))
      // The suite must have produced something to plan.
      expect(statements.length).toBeGreaterThan(20)
      const scans: string[] = []
      for (const sql of statements) {
        const plan = reader.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]
        for (const step of plan) {
          // "SCAN t" walks the whole table. "SEARCH t USING ..." and a scan of
          // an index ("SCAN t USING ... INDEX") do not.
          if (/^SCAN identity_\w+$/.test(step.detail.trim())) scans.push(`${step.detail}: ${sql}`)
        }
      }
      expect(scans).toEqual([])
    } finally {
      reader.close()
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
