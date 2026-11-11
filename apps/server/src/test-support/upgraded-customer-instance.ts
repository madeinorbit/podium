/**
 * A REAL SERVER ON AN UPGRADED CUSTOMER FIXTURE (POD-6751;
 * docs/design/sign-in-carry-over.md, section 10).
 *
 * The customer-upgrade fixtures are written to a state directory at the
 * schema the customer ran, with the old sign-ins of
 * `old-sign-in-tokens.json`, and then upgraded by the server's own start:
 * migrations, the local identity upgrade, the carry-over's `start`. Tests talk
 * to it over real HTTP with real `Cookie` headers.
 *
 * | Fixture         | People                                               | From                                |
 * |-----------------|------------------------------------------------------|-------------------------------------|
 * | `two-members`   | Alice (admin), Bob (member), Carol (disabled)        | `multi-member-rows.json`            |
 * | `one-person`    | Alice alone, with a password                         | `multi-member-rows.json`, her half  |
 * | `sole-operator` | the retired `user:sole`, no password (open, as found)| `server-rows.json`, customer release|
 *
 * THE CLOCK. The fixture's old sign-ins carry fixed dates around
 * {@link UPGRADE_DAY}. A test file fakes `Date` (and nothing else) at that day
 * before it starts an instance: `useUpgradeDayClock()`.
 *
 * THE CONNECTION. The server trusts one proxy hop (the default of a loopback
 * bind), so one instance can be asked three ways:
 * - `sameMachine`: plain HTTP on loopback, no forwarding header;
 * - `https`: the proxy hop reports HTTPS for a client elsewhere;
 * - `remoteHttp`: plain HTTP for a client elsewhere.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SESSION_COOKIE } from '@podium/protocol'
import { hashPassword } from '@podium/runtime/auth-store'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { mintUpdateSigningKey } from '@podium/runtime/update-signing-key'
import { vi } from 'vitest'
import {
  identityShapes,
  oldSignInTokens,
  serverReleaseMigrations,
  serverRows,
  writeIdentityShape,
} from '../../../../packages/runtime/src/fixtures/customer-upgrade'
import type { IdentitySeam } from '../identity/server-identity'
import { noJanitorWorkerForTests } from '../janitor-host'
import { runDrizzleMigrations } from '../migrations'
import { DRIZZLE_MIGRATIONS } from '../migrations/drizzle-manifest.generated'
import { startServer } from '../server'
import { type FixtureRow, insertFixtureRow, seedCustomerMembers } from './customer-upgrade-database'

export type UpgradeFixture = 'two-members' | 'one-person' | 'sole-operator'

/** The old cookie values behind the fixture's `client_sessions` rows. */
export const OLD_TOKENS = oldSignInTokens.tokens
export type OldTokenName = keyof typeof OLD_TOKENS

/** The day of the upgrade in every carry-over test. */
export const UPGRADE_DAY = new Date('2026-11-12T09:00:00.000Z')
export const MINUTE = 60_000
export const DAY = 86_400_000

export const ALICE = 'mem_upgrade_alice'
export const BOB = 'mem_upgrade_bob'
export const CAROL = 'mem_upgrade_carol'
export const PASSWORDS = {
  [ALICE]: 'alice-legacy-fixture-password',
  [BOB]: 'bob-legacy-fixture-password',
} as const

/** Fakes `Date` only, at the upgrade day; time keeps running from there. */
export function useUpgradeDayClock(at: Date = UPGRADE_DAY): void {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true, now: at })
}

/** `Cookie` header value of an old sign-in. */
export const oldCookie = (token: string): string => `${SESSION_COOKIE}=${token}`

/** How a request reaches the server. */
export const sameMachine: Record<string, string> = {}
export const https: Record<string, string> = {
  'x-forwarded-proto': 'https',
  'x-forwarded-for': '203.0.113.7',
}
export const remoteHttp: Record<string, string> = { 'x-forwarded-for': '203.0.113.7' }

export interface Answer {
  status: number
  // biome-ignore lint/suspicious/noExplicitAny: a JSON answer, read field by field in assertions
  body: any
  text: string
  /** Every `Set-Cookie` value of the answer. */
  setCookies: string[]
  /** `name=value` of each cookie the answer set, joined for a `Cookie` header. */
  cookie: string
  headers: Headers
}

export interface UpgradedInstance {
  readonly handle: Awaited<ReturnType<typeof startServer>>
  readonly origin: string
  readonly stateDir: string
  readonly dbPath: string
  /** One HTTP request. `cookie` becomes the `Cookie` header. */
  request(
    path: string,
    init?: { method?: string; cookie?: string; headers?: Record<string, string>; body?: unknown },
  ): Promise<Answer>
  /** `GET /auth/status` with this cookie. */
  status(cookie?: string, headers?: Record<string, string>): Promise<Answer>
  /** Rows of the database, read on a connection of the test's own. */
  rows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[]
  /** A write on a connection of the test's own, for a state the fixture lacks. */
  write(sql: string, ...params: unknown[]): void
  /** The old sign-ins still stored, as `label of member`, sorted. */
  oldSignIns(): string[]
  /** The device sign-ins of a member's account, unexpired. */
  deviceSignIns(
    memberId: string,
  ): Promise<{ id: string; kind: string; expiresAt: Date; deviceName: string; platform: string }[]>
  /** The member id of the fixture's only member (`one-person`, `sole-operator`). */
  soleMemberId(): string
  /** `keep`: leave the state directory for a later instance (a restart, a rollback). */
  close(opts?: { keep?: boolean }): Promise<void>
}

const templates = new Map<UpgradeFixture, string>()
const hashes = new Map<string, Promise<string>>()
const hashOf = (password: string): Promise<string> => {
  let hash = hashes.get(password)
  if (!hash) {
    hash = hashPassword(password)
    hashes.set(password, hash)
  }
  return hash
}

/** The customer's state directory before the upgrade, built once per fixture and copied. */
async function templateOf(fixture: UpgradeFixture): Promise<string> {
  const existing = templates.get(fixture)
  if (existing) return existing
  const dir = mkdtempSync(join(tmpdir(), `podium-carry-template-${fixture}-`))
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }))
  const db = openDatabase(join(dir, 'podium.db'))
  try {
    if (fixture === 'sole-operator') {
      // The captured release, as the rehearsal seeds it: exactly the migrations it shipped.
      const shipped = new Set(serverReleaseMigrations.migrations)
      runDrizzleMigrations(
        db,
        DRIZZLE_MIGRATIONS.filter((migration) => shipped.has(migration.name)),
      )
      for (const [table, rows] of [
        ['machines', serverRows.machines],
        ['sessions', serverRows.sessions],
        ['client_sessions', serverRows.client_sessions],
      ] as const) {
        for (const row of rows) insertFixtureRow(db, table, row as FixtureRow)
      }
    } else {
      const multiple = fixture === 'two-members'
      seedCustomerMembers(db, multiple)
      // The fixture's password hashes are made-up strings; a person who signs
      // in needs a real one, in the format the customer's release wrote.
      for (const [id, name] of [[ALICE, 'alice'], ...(multiple ? [[BOB, 'bob']] : [])] as const) {
        db.prepare('UPDATE user_credentials SET password_hash = ? WHERE user_id = ?').run(
          await hashOf(PASSWORDS[id as keyof typeof PASSWORDS]),
          id,
        )
        db.prepare('UPDATE users SET email = ? WHERE id = ?').run(`${name}@example.test`, id)
      }
    }
  } finally {
    db.close()
  }
  // The fixtures hold enrolled machines, so the host's identity and the
  // update signing key they trust are on the customer's disk too.
  const shape = identityShapes[0]
  if (!shape) throw new Error('the customer fixture has no identity shape')
  writeIdentityShape(dir, shape)
  writeFileSync(join(dir, 'update-signing-key.json'), JSON.stringify(mintUpdateSigningKey()))
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ configVersion: 2, mode: 'all-in-one', persistence: 'systemd' }),
  )
  templates.set(fixture, dir)
  return dir
}

const cookiePairs = (setCookies: string[]): string =>
  setCookies.map((value) => value.split(';', 1)[0]).join('; ')

/**
 * Start a server on a copy of the fixture. `before` changes the customer's
 * database before the upgrade runs; `stateDir` reuses a directory an earlier
 * instance left (a restart).
 */
export async function startUpgradedInstance(
  fixture: UpgradeFixture,
  opts: {
    before?: (db: SqlDatabase) => void
    identity?: IdentitySeam
    stateDir?: string
  } = {},
): Promise<UpgradedInstance> {
  const priorStateDir = process.env.PODIUM_STATE_DIR
  let stateDir = opts.stateDir
  if (!stateDir) {
    stateDir = mkdtempSync(join(tmpdir(), `podium-carry-${fixture}-`))
    cpSync(await templateOf(fixture), stateDir, { recursive: true })
    if (opts.before) {
      const db = openDatabase(join(stateDir, 'podium.db'))
      try {
        opts.before(db)
      } finally {
        db.close()
      }
    }
  }
  mkdirSync(stateDir, { recursive: true })
  const dbPath = join(stateDir, 'podium.db')
  process.env.PODIUM_STATE_DIR = stateDir
  const restoreEnv = () => {
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
  }
  let handle: Awaited<ReturnType<typeof startServer>>
  try {
    handle = await startServer({
      port: 0,
      janitorWorkerForTests: noJanitorWorkerForTests,
      ...(opts.identity ? { identity: opts.identity } : {}),
    })
  } catch (error) {
    restoreEnv()
    throw error
  }
  const origin = `http://127.0.0.1:${handle.port}`

  const withDb = <T>(use: (db: SqlDatabase) => T): T => {
    const db = openDatabase(dbPath)
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      return use(db)
    } finally {
      db.close()
    }
  }
  const rows = <T>(sql: string, ...params: unknown[]): T[] =>
    withDb((db) => db.prepare(sql).all(...params) as T[])

  const request: UpgradedInstance['request'] = async (path, init = {}) => {
    const response = await fetch(new URL(path, origin), {
      method: init.method ?? 'GET',
      headers: {
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      redirect: 'manual',
    })
    const text = await response.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    const setCookies = response.headers.getSetCookie()
    return {
      status: response.status,
      body,
      text,
      setCookies,
      cookie: cookiePairs(setCookies),
      headers: response.headers,
    }
  }

  return {
    handle,
    origin,
    stateDir,
    dbPath,
    request,
    status: (cookie, headers) =>
      request('/auth/status', { ...(cookie ? { cookie } : {}), ...(headers ? { headers } : {}) }),
    rows,
    write: (sql, ...params) => withDb((db) => void db.prepare(sql).run(...params)),
    oldSignIns: () =>
      rows<{ label: string; user_id: string }>(
        'SELECT label, user_id FROM client_sessions ORDER BY label, user_id, token_hash',
      ).map((row) => `${row.label} of ${row.user_id}`),
    async deviceSignIns(memberId) {
      const member = (await handle.identity.memberships.list()).find(
        (membership) => membership.memberId === memberId,
      )
      if (!member?.account) return []
      return (await handle.identity.core.deviceSignIns.listForAccount(member.account.id)).map(
        ({ id, kind, expiresAt, deviceName, platform }) => ({
          id,
          kind,
          expiresAt,
          deviceName,
          platform,
        }),
      )
    },
    soleMemberId() {
      const [only, ...others] = rows<{ id: string }>('SELECT id FROM users')
      if (!only || others.length > 0) throw new Error('this fixture has not exactly one member')
      return only.id
    },
    async close(closing = {}) {
      await handle.close()
      restoreEnv()
      if (!closing.keep) rmSync(stateDir, { recursive: true, force: true })
    },
  }
}
