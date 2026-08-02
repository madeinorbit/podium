/**
 * Host-local operator credentials (POD-1376, absorbing POD-801/POD-800).
 *
 * WHY THIS EXISTS. Podium's `/trpc` surface is gated by `clientAuthGuard`, which accepts
 * exactly one credential: the `podium_session` cookie a browser login issues. The direct
 * (non-relay) CLI carried none, on the assumption that reaching `/trpc` at all proved you
 * were the operator. On a password-protected instance that assumption is false — the port
 * is reachable and answers 401 — so there was NO working operator CLI path at all, and no
 * way to obtain a credential either: auth.json stores only a scrypt hash of the password
 * and PODIUM_PASSWORD is a one-shot seed, not something the running process keeps.
 *
 * THE TRUST ARGUMENT, stated rather than assumed. Minting here requires WRITE access to
 * `$PODIUM_STATE_DIR/podium.db`. A process with that access can already read every issue,
 * session, transcript and stored API key in the database, and can already insert this exact
 * row by hand — `docs/agents/driving-podium.md` documented that raw-sqlite INSERT as the
 * interim break-glass. So this grants no capability that filesystem access did not already
 * confer; it makes the existing one explicit, labelled and revocable.
 *
 * WHERE THE ARGUMENT STOPS. It holds because Podium is single-operator today: one person
 * owns the host, the state dir and everything in the database. Under the multi-user
 * direction (POD-1067) "can read the state dir" stops implying "owner of everything" —
 * a second user's process on the same host would mint a credential carrying the FIRST
 * user's authority. Whoever takes multi-user on must revisit this: the mint needs to be
 * bound to an identity, not to a file mode. Deliberately not solved here.
 *
 * The mint is NOT automatic. `podium auth mint-session` is an explicit operator act, so a
 * credential only ever exists because someone asked for one.
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stateDir } from './config'
import { openDatabase } from './sqlite'

/** Marks a session minted from local state-dir access, so `podium auth revoke-sessions`
 *  can drop the whole class without signing every browser out or cutting nodes off their
 *  hub. Mirrored by apps/server's AuthRepository.createClientSession default. */
export const BREAK_GLASS_LABEL = 'break-glass'

/** Matches the browser login's TTL (auth-route.ts SESSION_TTL_MS): a credential the
 *  operator has to re-mint every few hours is one they'll paste into a script instead. */
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface MintedSession {
  /** The plaintext cookie value. Returned exactly once — only its sha-256 is stored. */
  token: string
  expiresAt: string
}

export interface MintOptions {
  /** Instance state root holding podium.db. Defaults to the resolved state dir. */
  stateDir?: string
  ttlMs?: number
  now?: () => number
}

function databasePath(at: string): string {
  return join(at, 'podium.db')
}

/**
 * How long a `podium auth` connection waits for a lock before giving up.
 *
 * The default is 0 — fail instantly — which on a live instance under agent load means a
 * mint can lose a race with the server and error out. Captured at the call site as
 * `TOKEN=$(podium auth mint-session)`, that failure is INVISIBLE: `$(…)` takes stdout only,
 * so the operator gets an empty token and a 401 telling them to mint a session, which is
 * what they just did. Waiting is the fix; these writes are single-row and sub-millisecond.
 */
export function mintBusyTimeoutMs(): number {
  return 5_000
}

/** A connection to the instance DB that waits out contention rather than failing.
 *  Exported so a test can assert the pragma actually lands on the connection — asserting
 *  the constant alone would pass with the pragma deleted. */
export function openInstanceDatabase(path: string) {
  const db = openDatabase(path)
  db.exec(`PRAGMA busy_timeout = ${mintBusyTimeoutMs()}`)
  return db
}

/**
 * Insert a revocable `client_sessions` row and return its plaintext token.
 *
 * Safe against a RUNNING server, for the same reason `scripts/mint-upstream-token.ts` is:
 * a single WAL-mode write to a table the server only touches at login/logout.
 */
export function mintBreakGlassSession(opts: MintOptions = {}): MintedSession {
  const root = opts.stateDir ?? stateDir()
  const path = databasePath(root)
  if (!existsSync(path))
    throw new Error(
      `no Podium database at ${path} — mint-session must run on the host that owns this instance's state dir (set PODIUM_STATE_DIR to target another instance)`,
    )
  const nowMs = (opts.now ?? Date.now)()
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(nowMs + (opts.ttlMs ?? DEFAULT_TTL_MS)).toISOString()
  const db = openInstanceDatabase(path)
  try {
    db.prepare(
      'INSERT OR REPLACE INTO client_sessions (token_hash, created_at, expires_at, label) VALUES (?, ?, ?, ?)',
    ).run(
      createHash('sha256').update(token).digest('hex'),
      new Date(nowMs).toISOString(),
      expiresAt,
      BREAK_GLASS_LABEL,
    )
  } finally {
    db.close?.()
  }
  return { token, expiresAt }
}

export interface SessionRow {
  /** The sha-256 of the token. The token itself is not stored and cannot be recovered. */
  tokenHash: string
  createdAt: string
  expiresAt: string
  label: string
}

/** Every session row, newest first — what `podium auth sessions` prints. */
export function listSessions(at: string = stateDir()): SessionRow[] {
  const db = openInstanceDatabase(databasePath(at))
  try {
    const rows = db
      .prepare(
        'SELECT token_hash, created_at, expires_at, label FROM client_sessions ORDER BY created_at DESC',
      )
      .all() as { token_hash: string; created_at: string; expires_at: string; label: string }[]
    return rows.map((r) => ({
      tokenHash: r.token_hash,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      label: r.label,
    }))
  } finally {
    db.close?.()
  }
}

/** Revoke every session minted under `label`; returns how many rows went. Labelled rather
 *  than wholesale so revoking break-glass credentials never signs a browser out or cuts a
 *  node off its hub. */
export function revokeSessionsByLabel(label: string, at: string = stateDir()): number {
  const db = openInstanceDatabase(databasePath(at))
  try {
    // `changes` is number|bigint across the two drivers; the count here is always small.
    return Number(db.prepare('DELETE FROM client_sessions WHERE label = ?').run(label).changes)
  } finally {
    db.close?.()
  }
}

/** Where the CLI keeps the operator's credential between invocations. */
export function sessionTokenPath(at: string = stateDir()): string {
  return join(at, 'cli-session.json')
}

/** Persist a minted session for later CLI calls, owner-readable only. */
export function saveCachedSessionToken(session: MintedSession, at: string = stateDir()): void {
  const path = sessionTokenPath(at)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
}

/** The cached token if one is present and unexpired. Any problem — missing, unreadable,
 *  malformed, stale — reads as "no credential" rather than throwing: the caller's next
 *  step is a 401 that names the fix, which is a better error than a parse failure here. */
export function readCachedSessionToken(
  at: string = stateDir(),
  now: () => number = Date.now,
): string | undefined {
  let parsed: Partial<MintedSession>
  try {
    parsed = JSON.parse(readFileSync(sessionTokenPath(at), 'utf8')) as Partial<MintedSession>
  } catch {
    return undefined
  }
  if (typeof parsed.token !== 'string' || typeof parsed.expiresAt !== 'string') return undefined
  return Date.parse(parsed.expiresAt) > now() ? parsed.token : undefined
}

/**
 * The operator credential for a direct (non-relay) CLI call, or undefined when there is
 * none — which is the correct state on an instance with no password configured, where
 * `clientAuthGuard` passes everything through.
 *
 * PODIUM_SESSION_TOKEN wins over the cache so a caller can drive another instance, or a
 * short-lived session, without disturbing the stored one.
 */
export function resolveSessionToken(
  env: { PODIUM_SESSION_TOKEN?: string } = process.env,
  at: string = stateDir(),
  now: () => number = Date.now,
): string | undefined {
  const fromEnv = env.PODIUM_SESSION_TOKEN?.trim()
  if (fromEnv) return fromEnv
  return readCachedSessionToken(at, now)
}
