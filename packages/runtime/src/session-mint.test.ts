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
    `CREATE TABLE client_sessions (
       token_hash TEXT PRIMARY KEY,
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
    "INSERT INTO client_sessions (token_hash, created_at, expires_at, label) VALUES ('login-hash', '', '2999-01-01T00:00:00.000Z', 'login')",
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

/**
 * Schema tripwire (POD-1402 instrument). Reads the Authority drizzle schema from
 * this worktree via a relative path so we do not depend on @podium/* resolution
 * (worktrees often resolve workspace packages to the main checkout).
 *
 * A per-user column on client_sessions means "write the DB" no longer implies
 * "sole owner". While HOST_LOCAL_MINT_TRUST.assumesSingleOperator is true, that
 * column must not exist — multi-user must flip the trust object and bind mint.
 */
it('POD-1402 tripwire: client_sessions has no per-user binding while mint is FS-only', () => {
  const schemaPath = join(
    import.meta.dirname,
    '../../../apps/server/src/migrations/schema.ts',
  )
  const src = readFileSync(schemaPath, 'utf8')
  const tableMatch = /export const clientSessions = sqliteTable\(\s*'client_sessions',\s*\{([^}]+)\}/s.exec(
    src,
  )
  expect(
    tableMatch,
    `POD-1402 tripwire could not find clientSessions table in ${schemaPath}`,
  ).not.toBeNull()
  const body = tableMatch![1]!
  const columnKeys = [...body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]!)

  if (HOST_LOCAL_MINT_TRUST.assumesSingleOperator) {
    const forbidden = [
      'userId',
      'user_id',
      'ownerId',
      'owner_id',
      'accountId',
      'account_id',
      'principalId',
      'principal_id',
    ]
    for (const bad of forbidden) {
      expect(
        columnKeys,
        `POD-1402: client_sessions gained '${bad}' while assumesSingleOperator=true. ` +
          `FS-only mint ACCEPT has ended — bind mint to an identity before multi-user.`,
      ).not.toContain(bad)
    }
    expect(
      columnKeys.sort(),
      `POD-1402: client_sessions column set drifted (measured: ${columnKeys.join(',')})`,
    ).toEqual(['createdAt', 'expiresAt', 'label', 'tokenHash'].sort())
  } else {
    expect(
      HOST_LOCAL_MINT_TRUST.mintBoundToIdentity,
      'POD-1402: multi-user requires mintBoundToIdentity=true',
    ).toBe(true)
  }
})
