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
