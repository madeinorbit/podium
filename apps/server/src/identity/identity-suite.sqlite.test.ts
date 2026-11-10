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
 * Three checks belong to this leg alone:
 *   - every case of the suite ran, under both configurations;
 *   - no statement issued during the suite, the sign-in library's included,
 *     reads an identity table by a table scan;
 *   - resolving a request to its member is one statement and revalidating a
 *     held sign-in is one statement, each prepared once, for 5 and for 200
 *     accounts.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIdentityCore, type IdentityDatabase, type SqliteDb } from '@podium/identity'
import {
  IDENTITY_SUITE_CASES,
  identitySuite,
  type StoredTable,
  type SuiteHarness,
} from '@podium/identity/testing'
import { hashPassword, verifyPasswordHash } from '@podium/runtime/auth-store'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionStore } from '../store'
import { probeStatements } from '../store/executor'
import {
  preparationsOf,
  type StoreDrizzle,
  type StoreQueries,
} from '../store/executor/sync-drizzle'

const TABLES: Record<StoredTable, string> = {
  user: 'identity_user',
  account: 'identity_account',
  session: 'identity_session',
  oneTimeCode: 'identity_one_time_code',
  membership: 'identity_membership',
  invitation: 'identity_invitation',
}

/** Every statement text the suite sent to the driver, for the plan check below. */
const observed = new Set<string>()

const harness: SuiteHarness = {
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
        // The server's real member rows: the users repository's one writer.
        ...store.users.memberRows,
        async read(memberId) {
          const row = reader.prepare('SELECT * FROM users WHERE id = ?').get(memberId) as
            | {
                id: string
                display_name: string
                email: string | null
                account_id: string | null
                role: 'admin' | 'member'
                disabled_at: string | null
                authz_generation: number
                membership_version: number
              }
            | undefined
          if (!row) return undefined
          return {
            memberId: row.id,
            // A removed member is a disabled member row; only the membership tells them apart.
            state: row.disabled_at === null ? 'active' : 'disabled',
            role: row.role,
            accountId: row.account_id,
            version: row.membership_version,
            generation: row.authz_generation,
            name: row.display_name,
            email: row.email,
          }
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
}

const run = identitySuite({ describe, it, beforeEach, afterEach, expect }, harness)

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

  for (const accounts of [5, 200]) {
    it(`resolves and revalidates a member in one statement each, prepared once, with ${accounts} accounts`, async () => {
      const opened = await harness.open()
      try {
        const core = await createIdentityCore({
          database: opened.database,
          secret: 'identity-leg-secret-identity-leg-secret-0001',
          loginMethods: { password: true },
          mail: null,
          selfSignUp: false,
          accounts: 'local',
          hosts: { kind: 'self-hosted' },
          sameMachine: { waived: () => false },
          rateLimit: { storage: 'memory' },
        })
        const workspace = core.workspace('local', { rows: opened.memberRows, sameDatabase: true })
        const facts = { scheme: 'https' as const, sameMachine: false, clientAddress: '10.9.9.9' }
        const held: { request: Request; held: Parameters<typeof workspace.revalidate>[0] }[] = []
        for (let index = 0; index < accounts; index++) {
          // Every account is an active member: the first by setup, the rest invited.
          let member: { memberId: string; accountId: string }
          if (index === 0) {
            const first = await workspace.memberships.adopt({
              by: 'setup',
              role: 'admin',
              status: 'active',
              account: { kind: 'new', name: 'Person 0' },
            })
            member = { memberId: first.memberId, accountId: first.account?.id as string }
          } else {
            const { invitation } = await workspace.memberships.invite({
              actor: { system: 'host' },
              role: 'member',
            })
            member = await workspace.memberships.accept({
              token: invitation.token,
              account: { kind: 'new', name: `Person ${index}` },
            })
          }
          // Alice and Bob stand for the first and the last of them.
          if (index !== 0 && index !== accounts - 1) continue
          const signIn = await core.deviceSignIns.create(
            member.accountId,
            { kind: 'phone' },
            'bearer',
            facts,
          )
          held.push({
            request: new Request('https://unused.invalid/', {
              headers: { authorization: `Bearer ${signIn.bearer}` },
            }),
            held: {
              deviceSignInId: signIn.deviceSignInId,
              memberId: member.memberId,
              role: index === 0 ? 'admin' : 'member',
            },
          })
        }
        // The first resolution of each also writes "last seen"; after it, a
        // resolution is the one prepared statement and nothing else.
        for (const entry of held) {
          await workspace.resolve(entry.request, facts)
          await workspace.revalidate(entry.held)
        }
        const db = opened.database.db as unknown as StoreDrizzle
        const statementsBefore = opened.statements()
        const preparedBefore = preparationsOf(db)
        for (let round = 0; round < 10; round++) {
          for (const entry of held) {
            const resolution = await workspace.resolve(entry.request, facts)
            expect(resolution.kind).toBe('member')
            if (resolution.kind === 'member') expect(resolution.memberId).toBe(entry.held.memberId)
          }
        }
        expect(opened.statements() - statementsBefore).toBe(10 * held.length)
        const afterResolve = opened.statements()
        for (let round = 0; round < 10; round++) {
          for (const entry of held) expect(await workspace.revalidate(entry.held)).toBe(true)
        }
        expect(opened.statements() - afterResolve).toBe(10 * held.length)
        expect(preparationsOf(db) - preparedBefore).toBe(0)
      } finally {
        await opened.close()
      }
    })
  }
})
