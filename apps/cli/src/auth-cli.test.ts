/**
 * `podium auth` tests (POD-1376).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { authCliMain } from './auth-cli'

let dir: string
const out: string[] = []
const err: string[] = []
const io = { print: (s: string) => out.push(s), printErr: (s: string) => err.push(s) }
const stdout = () => out.join('\n')
const stderr = () => err.join('\n')

function seedDatabase(): void {
  const db = openDatabase(join(dir, 'podium.db'))
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
  dir = mkdtempSync(join(tmpdir(), 'podium-auth-cli-'))
  process.env.PODIUM_STATE_DIR = dir
  out.length = 0
  err.length = 0
})
afterEach(() => {
  delete process.env.PODIUM_STATE_DIR
  rmSync(dir, { recursive: true, force: true })
})

// The token is the only thing on stdout so `TOKEN=$(podium auth mint-session)` works;
// everything a human needs to read goes to stderr.
it('prints the minted token alone on stdout', async () => {
  seedDatabase()
  await authCliMain(['mint-session'], io)
  expect(stdout()).toMatch(/^[A-Za-z0-9_-]{20,}$/)
  expect(stderr()).toContain('cli-session.json')
})

it('caches the token so later podium calls carry it', async () => {
  seedDatabase()
  await authCliMain(['mint-session'], io)
  const { resolveSessionToken } = await import('@podium/runtime/session-mint')
  expect(resolveSessionToken({}, dir)).toBe(stdout())
})

it('--print-only leaves no cached credential behind', async () => {
  seedDatabase()
  await authCliMain(['mint-session', '--print-only'], io)
  const { resolveSessionToken } = await import('@podium/runtime/session-mint')
  expect(stdout()).not.toBe('')
  expect(resolveSessionToken({}, dir)).toBeUndefined()
})

it('honours --ttl', async () => {
  seedDatabase()
  await authCliMain(['mint-session', '--ttl', '10m'], io)
  const { listSessions } = await import('@podium/runtime/session-mint')
  const expiry = Date.parse(listSessions(dir)[0]?.expiresAt ?? '')
  expect(expiry - Date.now()).toBeGreaterThan(9 * 60_000)
  expect(expiry - Date.now()).toBeLessThanOrEqual(10 * 60_000)
})

it('rejects an unparseable --ttl instead of silently defaulting', async () => {
  seedDatabase()
  await expect(authCliMain(['mint-session', '--ttl', 'soon'], io)).rejects.toThrow(/--ttl/)
})

it('explains itself when there is no instance to mint against', async () => {
  await expect(authCliMain(['mint-session'], io)).rejects.toThrow(/no Podium database/)
})

it('lists sessions by label without printing a usable credential', async () => {
  seedDatabase()
  await authCliMain(['mint-session', '--print-only'], io)
  const token = stdout()
  out.length = 0
  await authCliMain(['sessions'], io)
  expect(stdout()).toContain('break-glass')
  expect(stdout()).not.toContain(token)
})

it('revokes break-glass sessions by default, not browser logins', async () => {
  seedDatabase()
  const db = openDatabase(join(dir, 'podium.db'))
  db.prepare(
    "INSERT INTO client_sessions (token_hash, created_at, expires_at, label) VALUES ('login-hash','','2999-01-01T00:00:00.000Z','login')",
  ).run()
  db.close?.()
  await authCliMain(['mint-session', '--print-only'], io)
  out.length = 0

  await authCliMain(['revoke-sessions'], io)
  expect(stdout()).toContain('1')

  const { listSessions } = await import('@podium/runtime/session-mint')
  expect(listSessions(dir).map((s) => s.label)).toEqual(['login'])
})

it('refuses an unknown subcommand rather than doing something else', async () => {
  await expect(authCliMain(['mint'], io)).rejects.toThrow(/unknown/)
})
