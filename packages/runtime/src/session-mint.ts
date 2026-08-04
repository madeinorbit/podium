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
 * AGENT SCOPE DOES NOT SURVIVE THIS (POD-1402 / ADR 3 D14). A constrained agent session
 * runs as the same OS user with the same state-dir access, so it can mint and then call
 * `/trpc` as the operator (`PODIUM_SESSION_TOKEN=… env -u PODIUM_AGENT_RELAY …`). That is
 * accepted: agent/operator relay scope is accident prevention on the default path, not
 * adversarial containment of a co-resident process. Refusing mint when relay env vars are
 * set would only catch accidents and is bypassable with `env -u`; requiring the instance
 * password would not stop a DB INSERT. Do not design features that assume otherwise.
 *
 * WHERE THE ARGUMENT STOPS. It holds because Podium is single-operator today: one person
 * owns the host, the state dir and everything in the database. Under the multi-user
 * direction (POD-1067) "can write the state dir" stops implying "owner of everything" —
 * a second user's process on the same host would mint a credential carrying the FIRST
 * user's authority. Whoever takes multi-user on must revisit this: the mint needs to be
 * bound to an identity, not to a file mode.
 *
 * Multi-user has since landed, and the mint is still not bound. POD-1637 therefore makes
 * this fail closed once the instance holds more than one account (see the guard in
 * `mintBreakGlassSession`) — that removes the discoverable path without pretending the
 * trust root moved. The binding itself is still not solved here.
 *
 * The mint is NOT automatic. `podium auth mint-session` is an explicit act, so a
 * credential only ever exists because some process on the host asked for one.
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { FIRST_ADMIN_USER_ID } from '@podium/model'
import { stateDir } from './config'
import { openDatabase } from './sqlite'

/** Marks a session minted from local state-dir access, so `podium auth revoke-sessions`
 *  can drop the whole class without signing every browser out or cutting nodes off their
 *  hub. Mirrored by apps/server's AuthRepository.createClientSession default. */
export const BREAK_GLASS_LABEL = 'break-glass'

/**
 * POD-1402 decision instrument (ADR 3 D14).
 *
 * Single-operator host: mint from state-dir write access is ACCEPT — agent relay scope is
 * accident prevention, not adversarial containment of a co-resident process.
 *
 * Multi-user (POD-1067+) MUST flip this before a second human principal exists:
 *   1. set `assumesSingleOperator: false`
 *   2. set `mintBoundToIdentity: true` and actually bind mint to an identity (password
 *      step-up, OS keyring, user principal) — not file mode alone
 * The tripwire tests that import this object fail if (1) happens without (2), or if
 * `client_sessions` gains a per-user column while (1) is still true.
 */
export const HOST_LOCAL_MINT_TRUST = {
  decision: 'ACCEPT',
  issue: 'POD-1402',
  /** While true, FS write access to podium.db is a sufficient mint root. */
  assumesSingleOperator: true,
  /**
   * Must become true in the same change that sets assumesSingleOperator false.
   * False today because there is no second human and mint stays FS-bound.
   */
  mintBoundToIdentity: false,
  reopenWhen:
    'A second human principal exists on one instance (multi-user / POD-1067)',
  reopenIssue: 'POD-1067',
} as const

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
 * How many accounts the instance models, or `undefined` when it cannot model accounts at
 * all (no `users` table — a pre-multi-user schema, where "writes the state dir" and "owns
 * everything" are still the same statement).
 *
 * Counts DISABLED accounts too. A disabled row is still a second human the instance has
 * been told about, and re-enabling it is an in-product action; treating it as absent would
 * make the guard's answer depend on a flag any admin can flip.
 */
function userAccountCount(db: {
  prepare(sql: string): { get(...params: unknown[]): unknown }
}): number | undefined {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .get() as { name: string } | undefined
  if (!table) return undefined
  const row = db.prepare('SELECT count(*) AS n FROM users').get() as { n: number | bigint }
  return Number(row.n)
}

/**
 * Insert a revocable `client_sessions` row and return its plaintext token.
 *
 * Safe against a RUNNING server, for the same reason `scripts/mint-upstream-token.ts` is:
 * a single WAL-mode write to a table the server only touches at login/logout.
 *
 * FAILS CLOSED ON A MULTI-ACCOUNT INSTANCE (POD-1637, docs/decisions/1634-mint-root-after-multi-user.md).
 * ADR 3 D14 accepted this mint because it "does not enlarge the set of processes that could
 * already act as the operator" — it only converted a multi-step attack into one documented
 * verb. That argument holds on a single-operator host and fails the moment the instance
 * models a second human: then the verb hands the FIRST admin's authority to any co-resident
 * process, including a member-grade account holder's agent sessions. Refusing it once a
 * second account exists reverses exactly the delta D14 named.
 *
 * This does NOT make `mintBoundToIdentity` true and must not be recorded as doing so. The
 * raw-INSERT root survives — anything that can call this can equally write the row by hand —
 * so the POD-1402 tripwire stays red, correctly. What goes away is the discoverable path,
 * which is the only thing mint ever added. The actual binding is Part 2, an architecture
 * call (separate OS users / privileged issuance boundary / per-user datastore).
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
    // Checked on the mint's own connection, before the INSERT, so a refusal writes nothing.
    const accounts = userAccountCount(db)
    if (accounts !== undefined && accounts > 1)
      throw new Error(
        `refusing to mint: this instance holds ${accounts} user accounts, and a break-glass session carries the first admin's authority to anything that can write ${path}. ` +
          'Host-local mint is only sound while one person owns the instance (ADR 3 D14 / POD-1402); ' +
          'sign in as your own account instead. See docs/decisions/1634-mint-root-after-multi-user.md.',
      )
    // `user_id` is NOT NULL and carries no default (POD-1079): a login session
    // says WHO it is, and the server's own `createClientSession` takes the user
    // as a required parameter for the same reason. A break-glass session is
    // minted from local state-dir access, which is the first admin's authority —
    // the same owner `ensureHostMachine` and the password login resolve to.
    db.prepare(
      'INSERT OR REPLACE INTO client_sessions (token_hash, user_id, created_at, expires_at, label) VALUES (?, ?, ?, ?, ?)',
    ).run(
      createHash('sha256').update(token).digest('hex'),
      FIRST_ADMIN_USER_ID,
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
  // `Record<string, string | undefined>`, not a one-key literal: Bun's `ProcessEnv`
  // declares no properties of its own, so a literal parameter type has nothing in
  // common with it and `= process.env` will not typecheck against one.
  env: Record<string, string | undefined> = process.env,
  at: string = stateDir(),
  now: () => number = Date.now,
): string | undefined {
  const fromEnv = env.PODIUM_SESSION_TOKEN?.trim()
  if (fromEnv) return fromEnv
  return readCachedSessionToken(at, now)
}
