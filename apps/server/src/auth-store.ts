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
 * Single-user client-access password for the human UI channel (web/desktop).
 *
 * Distinct from the daemon credentials (`daemon.secret` / pairing tokens), which gate the
 * machine↔server channel and are unchanged. This gates the browser/desktop client surface
 * (/client WS, /trpc, /files, setup POST) when the server is reachable over a network.
 *
 * We hash with **scrypt** (node:crypto) rather than argon2: it is portable across the Bun
 * runtime and the legacy node/tsx path, fully deterministic, and needs no native module.
 * The KDF strength is not the security-relevant factor here — the hash lives in a 0600
 * file in the user's home, the same trust boundary as the agent OAuth creds, so anyone who
 * can read it already owns the machine. Online brute-force is handled by the login throttle
 * (see auth-route). Only a non-empty hash is ever written; presence of the hash means
 * "auth required", absence means "open" (the user opted out at setup).
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
async function hash(password: string): Promise<string> {
  const salt = randomBytes(16)
  const dk = (await scrypt(password, salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })) as Buffer
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${dk.toString('base64')}`
}

async function verifyAgainst(password: string, stored: string): Promise<boolean> {
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

/** True when a client-access password is configured (auth required). */
export function hasPassword(dir: string = stateDir()): boolean {
  return Boolean(readFile(dir).passwordHash)
}

/** Set (or replace) the client-access password. Rejects an empty/whitespace password. */
export async function setPassword(password: string, dir: string = stateDir()): Promise<void> {
  if (!password?.trim()) {
    throw new Error('password must not be empty')
  }
  const passwordHash = await hash(password)
  mkdirSync(dir, { recursive: true })
  const next: AuthFile = { ...readFile(dir), passwordHash }
  writeFileSync(authPath(dir), JSON.stringify(next), { mode: 0o600 })
}

/** Remove the client-access password (opt out of login). */
export function clearPassword(dir: string = stateDir()): void {
  const path = authPath(dir)
  if (existsSync(path)) rmSync(path, { force: true })
}

/** Verify a candidate password. False when no password is set or it doesn't match. */
export async function verifyPassword(password: string, dir: string = stateDir()): Promise<boolean> {
  const stored = readFile(dir).passwordHash
  if (!stored) return false
  return verifyAgainst(password, stored)
}
