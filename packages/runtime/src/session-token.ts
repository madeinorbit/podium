/**
 * The CLI caches the signed device sign-in redeemed through the server's
 * local control socket. Old, unsigned caches belong to sign-in carry-over.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stateDir } from './config'

export interface MintedSession {
  token: string
  expiresAt: string
}

const CACHE_VERSION = 2

/** Where the CLI keeps the operator's credential between invocations. */
export function sessionTokenPath(at: string = stateDir()): string {
  return join(at, 'cli-session.json')
}

/** Persist a minted session for later CLI calls, owner-readable only. */
export function saveCachedSessionToken(session: MintedSession, at: string = stateDir()): void {
  const path = sessionTokenPath(at)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ version: CACHE_VERSION, ...session }, null, 2)}\n`, {
    mode: 0o600,
  })
}

/** The cached token if one is present and unexpired. Any problem — missing, unreadable,
 *  malformed, stale — reads as "no credential" rather than throwing: the caller's next
 *  step is a 401 that names the fix, which is a better error than a parse failure here. */
export function readCachedSessionToken(
  at: string = stateDir(),
  now: () => number = Date.now,
): string | undefined {
  let parsed: Partial<MintedSession> & { version?: number }
  try {
    parsed = JSON.parse(readFileSync(sessionTokenPath(at), 'utf8')) as Partial<MintedSession> & {
      version?: number
    }
  } catch {
    return undefined
  }
  if (parsed?.version !== CACHE_VERSION) return undefined
  if (typeof parsed.token !== 'string' || typeof parsed.expiresAt !== 'string') return undefined
  return Date.parse(parsed.expiresAt) > now() ? parsed.token : undefined
}

/** The form of a session token from before shared sign-in: 32 random bytes, base64url, unsigned. */
const OLD_SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/

/** A signed device sign-in token always carries a signature after a dot; an old token never does. */
export function isOldFormSessionToken(value: string): boolean {
  return OLD_SESSION_TOKEN.test(value)
}

// LEGACY(remove-after: 2027-06): reads the `cli-session.json` a `podium auth mint-session` from before shared sign-in wrote; removing it makes the host mint a new session once after such an upgrade.
/**
 * The token of an OLD-FORM cache file, unexpired: `{ token, expiresAt }` with
 * no version, as the command wrote it before shared sign-in. It is not a
 * credential any more. The `podium` command exchanges it once at the server's
 * status route for a signed device sign-in and rewrites the file
 * (docs/design/sign-in-carry-over.md, section 6.1). Never deletes the file.
 */
export function readOldFormSessionToken(
  at: string = stateDir(),
  now: () => number = Date.now,
): { token: string; expiresAt: string } | undefined {
  let parsed: Partial<MintedSession> & { version?: number }
  try {
    parsed = JSON.parse(readFileSync(sessionTokenPath(at), 'utf8')) as Partial<MintedSession> & {
      version?: number
    }
  } catch {
    return undefined
  }
  if (parsed?.version !== undefined) return undefined
  if (typeof parsed.token !== 'string' || typeof parsed.expiresAt !== 'string') return undefined
  if (!isOldFormSessionToken(parsed.token)) return undefined
  return Date.parse(parsed.expiresAt) > now()
    ? { token: parsed.token, expiresAt: parsed.expiresAt }
    : undefined
}

/**
 * The operator credential for a direct (non-relay) CLI call, or undefined when there is
 * none — which is the correct state on an instance with no password configured, where
 * same-machine requests are already admitted.
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
