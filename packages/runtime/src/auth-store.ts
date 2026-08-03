import { randomBytes, type ScryptOptions, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './local-machine'

/** Promisified scrypt that preserves the options arg (node's promisify overload drops it). */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  opts: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, opts, (err, dk) => (err ? reject(err) : resolve(dk)))
  })
}

/**
 * THE CREDENTIAL FORMAT for every human login — and, until POD-1554, the home of the
 * instance's ONE shared password.
 *
 * What remains here is the KDF: `hashPassword` / `verifyPasswordHash` produce and check the
 * self-describing scrypt string stored in `user_credentials.password_hash`, one row per
 * account. Distinct from the daemon credentials (`daemon.secret` / pairing tokens), which
 * gate the machine↔server channel and are unchanged.
 *
 * We hash with **scrypt** (node:crypto) rather than argon2: it is portable across the Bun
 * runtime and the legacy node/tsx path, fully deterministic, and needs no native module.
 * The KDF strength is not the security-relevant factor here — the hash lives in the state
 * directory in the user's home, the same trust boundary as the agent OAuth creds, so anyone
 * who can read it already owns the machine. Online brute-force is handled by the login
 * throttle (see auth-route).
 *
 * WHAT LEFT, AND WHY (POD-1554). `hasPassword` / `setPassword` / `clearPassword` /
 * `verifyPassword` / `applyEnvPassword` are gone. They read and wrote ONE hash per instance
 * in `auth.json`, and "presence of the hash means auth required" was the whole authentication
 * policy of a single-operator product. Under real accounts that question is
 * `users.hasPerUserCredentials()`, and *whose* password a call is about is a question
 * `auth.json` could not even ask. The two functions below are the only readers left: they
 * exist so the one-shot boot migration can move the legacy hash into the first admin's row
 * and then delete the file. Nothing else may use them, and when no upgraded instance is left
 * in the wild they go too.
 */

const FILE = 'auth.json'

// scrypt cost params. N must be a power of two; these are interactive-login defaults.
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEYLEN = 64

type AuthFile = { passwordHash?: string }

function authPath(dir: string): string {
  return join(dir, FILE)
}

function readFile(dir: string): AuthFile {
  try {
    const raw = readFileSync(authPath(dir), 'utf8')
    const parsed = JSON.parse(raw) as AuthFile
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Encode a scrypt hash self-describingly so verify can recover the params + salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const dk = (await scrypt(password, salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })) as Buffer
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString(
    'base64',
  )}$${dk.toString('base64')}`
}

export async function verifyPasswordHash(password: string, stored: string): Promise<boolean> {
  const [tag, n, r, p, saltB64, hashB64] = stored.split('$')
  if (tag !== 'scrypt' || !n || !r || !p || !saltB64 || !hashB64) return false
  const salt = Buffer.from(saltB64, 'base64')
  const expected = Buffer.from(hashB64, 'base64')
  let dk: Buffer
  try {
    dk = (await scrypt(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    })) as Buffer
  } catch {
    return false
  }
  return dk.length === expected.length && timingSafeEqual(dk, expected)
}

/**
 * THE LEGACY INSTANCE PASSWORD, for the one-shot migration that retires it (POD-1554).
 *
 * Returns the scrypt string an upgraded instance still has in `auth.json`, or `undefined`
 * on a box that never had one. The string is the SAME encoding `hashPassword` produces and
 * `user_credentials.password_hash` stores, which is why the migration is a copy rather than
 * a rehash — the operator's existing password keeps working, and at no point does the
 * plaintext need to exist.
 *
 * The ONE caller is `retireInstancePassword` in apps/server. There is deliberately no
 * `hasLegacyInstancePassword`: a boolean would invite a second policy reader, which is what
 * `hasPassword` became.
 */
export function readLegacyInstancePasswordHash(dir: string = stateDir()): string | undefined {
  return readFile(dir).passwordHash || undefined
}

/**
 * `podium setup` CHOOSING A PASSWORD BEFORE THERE IS A DATABASE TO PUT IT IN.
 *
 * The interactive CLI setup asks for a login password on a box that has no server running
 * and, on a fresh install, no store file yet — so it cannot write a credential row. It
 * stages the hash here, and the FIRST BOOT's `retireInstancePassword` moves it into the
 * first admin's credential and deletes the file, exactly as it does for an upgraded
 * instance. Same one-shot, same verify-then-delete.
 *
 * `auth.json` is therefore a HANDOFF, not a credential store: nothing authenticates against
 * it any more (`POST /auth/login` reads credential rows and nothing else), and it never
 * survives a boot. The alternative — having `podium setup` start a server just to set a
 * password — buys nothing and adds a failure mode to the one flow that must work on a
 * fresh machine.
 */
export async function stagePasswordForFirstBoot(
  password: string,
  dir: string = stateDir(),
): Promise<void> {
  if (!password?.trim()) throw new Error('password must not be empty')
  const passwordHash = await hashPassword(password)
  mkdirSync(dir, { recursive: true })
  writeFileSync(authPath(dir), JSON.stringify({ passwordHash } satisfies AuthFile), { mode: 0o600 })
}

/**
 * Delete `auth.json` once its hash has been VERIFIED to live in the first admin's credential
 * row. Callers must not reach this before that check — see `retireInstancePassword`, which
 * re-reads the row and compares before it calls this.
 */
export function deleteLegacyInstancePasswordFile(dir: string = stateDir()): void {
  const path = authPath(dir)
  if (existsSync(path)) rmSync(path, { force: true })
}
