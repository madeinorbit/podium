import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  BREAK_GLASS_LABEL,
  HOST_LOCAL_MINT_TRUST,
  listSessions,
  mintBreakGlassSession,
  mintBusyTimeoutMs,
  openInstanceDatabase,
  readCachedSessionToken,
  resolveSessionToken,
  revokeSessionsByLabel,
  saveCachedSessionToken,
  sessionTokenPath,
} from './session-mint'
import { openDatabase } from './sqlite'

let dir: string

/** The client_sessions table as apps/server's migrations create it. The cross-check that
 *  this stays in step with the real schema is apps/server/src/auth-route.test.ts, which
 *  mints through THIS module and authenticates through the server's own guard. */
function seedDatabase(at: string): void {
  const db = openDatabase(join(at, 'podium.db'))
  db.prepare(
    // `user_id NOT NULL` is POD-1075's identity column (migrations/schema.ts
     // `clientSessions`). It has no default on purpose — a session says WHO it
     // is — so a fixture missing it lets the mint compile and fail only at the
     // server, which is precisely what the cross-check above caught.
    `CREATE TABLE client_sessions (
       token_hash TEXT PRIMARY KEY,
       user_id TEXT NOT NULL,
       created_at TEXT NOT NULL,
       expires_at TEXT NOT NULL,
       label TEXT NOT NULL DEFAULT 'login'
     )`,
  ).run()
  db.close?.()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-session-mint-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('mints a token and stores only its sha-256', () => {
  seedDatabase(dir)
  const minted = mintBreakGlassSession({ stateDir: dir })

  const db = openDatabase(join(dir, 'podium.db'))
  const row = db.prepare('SELECT token_hash, label FROM client_sessions').get() as {
    token_hash: string
    label: string
  }
  expect(row.token_hash).toBe(createHash('sha256').update(minted.token).digest('hex'))
  expect(row.token_hash).not.toBe(minted.token)
  expect(row.label).toBe(BREAK_GLASS_LABEL)
})

// Reported from the live instance: `TOKEN=$(podium auth mint-session ...)` came back EMPTY
// once, and the next call then told the operator to mint a session — the thing they had just
// done. `$(...)` captures stdout only, so a failed mint is invisible at the call site.
//
// The defence is to not fail on transient contention in the first place (below). There is
// deliberately NO read-back after the insert: a write that does not land THROWS — the next
// test pins that with a read-only database file — so a read-back would assert something
// already guaranteed and would pass with the INSERT deleted. The other half of the fix is
// not here at all: it is the 401 message learning to say "the session you carried was
// rejected" instead of "mint one", in packages/issue-client/src/client.ts.
it('waits out a busy database instead of failing the mint', () => {
  seedDatabase(dir)
  const path = join(dir, 'podium.db')
  const readTimeout = (db: { prepare(sql: string): { get(): unknown } }) =>
    Number((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout)

  // Counterfactual: a plain connection fails a contended write instantly (the default is 0).
  const plain = openDatabase(path)
  expect(readTimeout(plain)).toBe(0)
  plain.close?.()

  const mintConn = openInstanceDatabase(path)
  expect(readTimeout(mintConn)).toBeGreaterThanOrEqual(5_000)
  expect(readTimeout(mintConn)).toBe(mintBusyTimeoutMs())
  mintConn.close?.()
})

it('reports a mint that could not be written instead of returning a token', () => {
  seedDatabase(dir)
  chmodSync(join(dir, 'podium.db'), 0o444)
  try {
    expect(() => mintBreakGlassSession({ stateDir: dir })).toThrow()
  } finally {
    chmodSync(join(dir, 'podium.db'), 0o644)
  }
})

it('honours the requested ttl', () => {
  seedDatabase(dir)
  const now = Date.parse('2026-08-02T00:00:00.000Z')
  const minted = mintBreakGlassSession({ stateDir: dir, ttlMs: 600_000, now: () => now })
  expect(minted.expiresAt).toBe('2026-08-02T00:10:00.000Z')
})

// A caller that cannot read the state dir is not the owner, and must not get a
// credential-shaped error it might mistake for a transient failure.
it('refuses when there is no database to mint against', () => {
  expect(() => mintBreakGlassSession({ stateDir: dir })).toThrow(/no Podium database/)
})

it('lists sessions newest first without exposing any token', () => {
  seedDatabase(dir)
  const now = Date.parse('2026-08-02T00:00:00.000Z')
  const minted = mintBreakGlassSession({ stateDir: dir, now: () => now })
  const listed = listSessions(dir)
  expect(listed).toHaveLength(1)
  expect(listed[0]?.label).toBe(BREAK_GLASS_LABEL)
  expect(listed[0]?.tokenHash).not.toBe(minted.token)
  expect(listed[0]?.expiresAt).toBe(minted.expiresAt)
})

it('revokes only the labelled class, leaving browser logins signed in', () => {
  seedDatabase(dir)
  const db = openDatabase(join(dir, 'podium.db'))
  db.prepare(
    "INSERT INTO client_sessions (token_hash, user_id, created_at, expires_at, label) VALUES ('login-hash', 'user_first_admin', '', '2999-01-01T00:00:00.000Z', 'login')",
  ).run()
  db.close?.()
  mintBreakGlassSession({ stateDir: dir })

  expect(revokeSessionsByLabel(BREAK_GLASS_LABEL, dir)).toBe(1)
  expect(listSessions(dir).map((s) => s.label)).toEqual(['login'])
})

it('caches a minted token readable only by its owner', () => {
  seedDatabase(dir)
  const minted = mintBreakGlassSession({ stateDir: dir })
  saveCachedSessionToken(minted, dir)

  expect(readCachedSessionToken(dir)).toBe(minted.token)
  expect(statSync(sessionTokenPath(dir)).mode & 0o077).toBe(0)
  expect(readFileSync(sessionTokenPath(dir), 'utf8')).toContain(minted.token)
})

it('ignores a cached token that has expired', () => {
  const past = '2020-01-01T00:00:00.000Z'
  saveCachedSessionToken({ token: 'stale', expiresAt: past }, dir)
  expect(readCachedSessionToken(dir)).toBeUndefined()
})

it('ignores an unreadable or malformed cache rather than throwing', () => {
  writeFileSync(sessionTokenPath(dir), 'not json')
  expect(readCachedSessionToken(dir)).toBeUndefined()
})

it('prefers an explicit PODIUM_SESSION_TOKEN over the cache', () => {
  saveCachedSessionToken({ token: 'cached', expiresAt: '2999-01-01T00:00:00.000Z' }, dir)
  expect(resolveSessionToken({ PODIUM_SESSION_TOKEN: 'from-env' }, dir)).toBe('from-env')
  expect(resolveSessionToken({}, dir)).toBe('cached')
})

it('resolves to undefined when there is no credential anywhere', () => {
  expect(resolveSessionToken({}, dir)).toBeUndefined()
})

// ─── POD-1402: host-local mint trust (ACCEPT under single-operator) ─────────
//
// Live probe (agent shell, 2026-08-02): `podium auth mint-session` +
// `PODIUM_SESSION_TOKEN=$TOKEN env -u PODIUM_AGENT_RELAY podium issue promote …`
// reached the Authority as operator. Trust root is write access to podium.db only
// (strace: config.json, instance.json, podium.db[+wal/shm] — not auth.json).
//
// Shape: decision instrument, not a security lock. Multi-user must reopen (see
// HOST_LOCAL_MINT_TRUST). Coherence test fails if assumesSingleOperator flips
// without mintBoundToIdentity.

it('POD-1402 instrument: single-operator mint trust is coherent', () => {
  const t = HOST_LOCAL_MINT_TRUST
  expect(t.decision).toBe('ACCEPT')
  expect(t.issue).toBe('POD-1402')
  expect(t.reopenIssue).toBe('POD-1067')
  if (t.assumesSingleOperator) {
    // ACCEPT still in force: mint may stay FS-bound.
    expect(
      t.mintBoundToIdentity,
      'POD-1402: assumesSingleOperator=true implies mintBoundToIdentity=false',
    ).toBe(false)
  } else {
    // Multi-user landed: mint MUST be bound to an identity, not file mode alone.
    expect(
      t.mintBoundToIdentity,
      'POD-1402: assumesSingleOperator=false requires mintBoundToIdentity=true — rebind mint before shipping a second human',
    ).toBe(true)
  }
})

// MintOptions has no password / principal / agent-env field. A process that can
// write the state dir mints; relay env is not consulted (agent shells included).
it('POD-1402: mint needs only state-dir write access — no password, no principal', () => {
  seedDatabase(dir)
  // No auth.json in dir; mint still succeeds. That is the ACCEPT trust root.
  expect(existsSync(join(dir, 'auth.json'))).toBe(false)
  const minted = mintBreakGlassSession({ stateDir: dir, ttlMs: 60_000 })
  expect(minted.token.length).toBeGreaterThan(20)
  expect(listSessions(dir)).toHaveLength(1)
})

// ─── POD-1637: fail the mint closed on a second account ────────────────────
//
// docs/decisions/1634-mint-root-after-multi-user.md Part 1. Both sides are pinned
// against a real on-disk database: a guard that only ever says yes is worth nothing,
// and one that only ever says no would break every single-operator instance.

/** The `users` table as apps/server's migrations create it, with `n` accounts. */
function seedUsers(at: string, n: number): void {
  const db = openDatabase(join(at, 'podium.db'))
  db.prepare(
    `CREATE TABLE users (
       id TEXT PRIMARY KEY,
       display_name TEXT NOT NULL,
       role TEXT NOT NULL,
       created_at TEXT NOT NULL,
       disabled_at TEXT
     )`,
  ).run()
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO users (id, display_name, role, created_at) VALUES (?, ?, ?, ?)').run(
      i === 0 ? 'user:sole' : `user:other-${i}`,
      i === 0 ? 'Operator' : `Other ${i}`,
      i === 0 ? 'admin' : 'member',
      '2026-08-04T00:00:00.000Z',
    )
  }
  db.close?.()
}

function sessionRowCount(at: string): number {
  const db = openDatabase(join(at, 'podium.db'))
  try {
    return Number(
      (db.prepare('SELECT count(*) AS n FROM client_sessions').get() as { n: number }).n,
    )
  } finally {
    db.close?.()
  }
}

// The live shape (ludovico, 2026-08-04: `select count(*) from users` -> 1). This change is
// a no-op there, and this test is what says so.
it('POD-1637: mints on a single-account instance, and the token validates', () => {
  seedDatabase(dir)
  seedUsers(dir, 1)

  const minted = mintBreakGlassSession({ stateDir: dir })

  // "Validates" at this layer = the stored hash is the one a guard looks the token up by;
  // the end-to-end check against the server's own clientAuthGuard is
  // apps/server/src/auth-route.test.ts.
  const db = openDatabase(join(dir, 'podium.db'))
  const row = db
    .prepare('SELECT user_id, label, expires_at FROM client_sessions WHERE token_hash = ?')
    .get(createHash('sha256').update(minted.token).digest('hex')) as
    | { user_id: string; label: string; expires_at: string }
    | undefined
  db.close?.()
  expect(row?.label).toBe(BREAK_GLASS_LABEL)
  expect(row?.expires_at).toBe(minted.expiresAt)
})

it('POD-1637: refuses on a two-account instance, writing no session row', () => {
  seedDatabase(dir)
  seedUsers(dir, 2)

  expect(() => mintBreakGlassSession({ stateDir: dir })).toThrow(
    /refusing to mint.*2 user accounts/s,
  )
  expect(sessionRowCount(dir), 'a refused mint must leave no credential behind').toBe(0)
})

// A disabled account is still an account the instance was told about, and any admin can
// re-enable it. Pinned so the guard's answer cannot be flipped by a mutable flag.
it('POD-1637: counts a disabled second account', () => {
  seedDatabase(dir)
  seedUsers(dir, 2)
  const db = openDatabase(join(dir, 'podium.db'))
  db.prepare(
    "UPDATE users SET disabled_at = '2026-08-04T00:00:00.000Z' WHERE id = 'user:other-1'",
  ).run()
  db.close?.()

  expect(() => mintBreakGlassSession({ stateDir: dir })).toThrow(/refusing to mint/)
})

// No `users` table = a pre-multi-user schema, which cannot express a second human at all.
// That is the ACCEPT case D14 argued for, so it must still mint — and it is what every
// other test in this file relies on.
it('POD-1637: still mints against a schema with no users table', () => {
  seedDatabase(dir)
  expect(mintBreakGlassSession({ stateDir: dir }).token.length).toBeGreaterThan(20)
})

/**
 * Schema tripwire (POD-1402 instrument / ADR 3 D14).
 *
 * ACCEPT rests on "this host cannot express a second human": no per-user binding
 * on client_sessions, no owner on machines, no grants/users tables. When that
 * storage appears while HOST_LOCAL_MINT_TRUST.assumesSingleOperator is still true,
 * this fails and names D14 so the mint trust root cannot be forgotten.
 *
 * Schema is read via a relative path so worktrees without node_modules/@podium
 * still see *this* branch's Authority schema (package-name imports resolve to main).
 */
function authoritySchemaSource(): string {
  const schemaPath = join(
    import.meta.dirname,
    '../../../apps/server/src/migrations/schema.ts',
  )
  return readFileSync(schemaPath, 'utf8')
}

function tableColumnKeys(src: string, exportName: string, sqlName: string): string[] {
  const re = new RegExp(
    `export const ${exportName} = sqliteTable\\(\\s*'${sqlName}',\\s*\\{([^}]+)\\}`,
    's',
  )
  const tableMatch = re.exec(src)
  expect(
    tableMatch,
    `POD-1402 tripwire could not find ${exportName} ('${sqlName}') in Authority schema — ADR 3 D14`,
  ).not.toBeNull()
  return [...tableMatch![1]!.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]!)
}

const PER_USER_COLUMN_KEYS = [
  'userId',
  'user_id',
  'ownerId',
  'owner_id',
  'ownerUserId',
  'owner_user_id',
  'accountId',
  'account_id',
  'principalId',
  'principal_id',
] as const

/** Tables that would represent a second human / sharing grants (not OAuth `accounts`). */
const MULTI_USER_TABLE_SQL_NAMES = ['grants', 'users', 'memberships', 'user_grants'] as const

it('POD-1402 tripwire: host cannot express a second human while mint is FS-only (ADR 3 D14)', () => {
  const src = authoritySchemaSource()

  if (!HOST_LOCAL_MINT_TRUST.assumesSingleOperator) {
    expect(
      HOST_LOCAL_MINT_TRUST.mintBoundToIdentity,
      'POD-1402 / ADR 3 D14: multi-user requires mintBoundToIdentity=true — rebind mint before shipping a second human',
    ).toBe(true)
    return
  }

  // --- client_sessions: no per-user binding ---
  const sessionCols = tableColumnKeys(src, 'clientSessions', 'client_sessions')
  for (const bad of PER_USER_COLUMN_KEYS) {
    expect(
      sessionCols,
      `POD-1402 / ADR 3 D14: client_sessions gained '${bad}' while assumesSingleOperator=true. ` +
        `FS-only mint ACCEPT has ended — bind mint to an identity (HOST_LOCAL_MINT_TRUST) before multi-user.`,
    ).not.toContain(bad)
  }
  expect(
    sessionCols.sort(),
    `POD-1402: client_sessions column set drifted (measured: ${sessionCols.join(',')})`,
  ).toEqual(['createdAt', 'expiresAt', 'label', 'tokenHash'].sort())

  // --- machines: no owner_user_id (second human ownership) ---
  const machineCols = tableColumnKeys(src, 'machines', 'machines')
  for (const bad of PER_USER_COLUMN_KEYS) {
    expect(
      machineCols,
      `POD-1402 / ADR 3 D14: machines gained '${bad}' while assumesSingleOperator=true. ` +
        `Host can express a second human — reopen the mint trust root before multi-user.`,
    ).not.toContain(bad)
  }

  // --- no grants / users / memberships tables ---
  for (const table of MULTI_USER_TABLE_SQL_NAMES) {
    const present = new RegExp(`sqliteTable\\(\\s*'${table}'`).test(src)
    expect(
      present,
      `POD-1402 / ADR 3 D14: multi-user table '${table}' appeared while assumesSingleOperator=true. ` +
        `Reopen the mint trust root (HOST_LOCAL_MINT_TRUST / POD-1067) before shipping a second human.`,
    ).toBe(false)
  }
})
