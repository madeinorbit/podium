/**
 * One credential read per web request [POD-6220, server-data rule 8].
 *
 * Every tRPC call passes the auth guard and then builds its context, and both
 * ask who the caller is. Each asked the store on its own, and each ask was two
 * reads of the session row (a validity check, then the row), so a call read
 * `cli_sessions` four times and asked "is login required" once before its
 * procedure ran: about six auth statements per request, 4.5% of all SQL wall
 * time in the POD-6140 bench. The guard and the context now share one
 * resolution per request, and the resolution is one read.
 *
 * The request runs against a REAL booted server, because the guard, the
 * principal resolver and the context are assembled inside `startServer`; a
 * hand-built composition would pin its own assembly, not production's (the
 * reasoning `server.context-users.test.ts` records). The data that must not
 * matter is how many members and login sessions the instance holds: 5 and 200.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asUserId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { hashToken } from './auth-route'
import { noJanitorWorkerForTests } from './janitor-host'
import { startServer } from './server'
import type { SessionStore } from './store'
import {
  expectConstantStatements,
  quietShipping,
  type StatementPin,
  type StatementTally,
} from './test-support/statement-count'

const PASSWORD = 'correct-horse-battery-staple'
/** A procedure whose own work does not depend on the data sizes below. */
const PROCEDURE = '/trpc/settings.viewer'

interface Fixture {
  handle: Awaited<ReturnType<typeof startServer>>
  store: SessionStore
  stateDir: string
  priorStateDir: string | undefined
  cookie: string
}

const url = (f: Pick<Fixture, 'handle'>, path: string) => `http://127.0.0.1:${f.handle.port}${path}`

async function boot(size: number): Promise<Fixture> {
  const priorStateDir = process.env.PODIUM_STATE_DIR
  const stateDir = mkdtempSync(join(tmpdir(), 'podium-request-credential-'))
  // Configured before boot, or the readiness boundary answers every call 503.
  writeFileSync(
    join(stateDir, 'config.json'),
    JSON.stringify({ configVersion: 2, mode: 'all-in-one', persistence: 'systemd' }),
  )
  process.env.PODIUM_STATE_DIR = stateDir
  const handle = await startServer({ janitorWorkerForTests: noJanitorWorkerForTests, port: 0 })
  await quietShipping(handle.registry)
  // The registry holds the server's one store; the probe counts on its connection.
  const store = (handle.registry as unknown as { store: SessionStore }).store
  const f = { handle, store, stateDir, priorStateDir, cookie: '' }

  // Close the guard the way an operator does: set a password (open mode, local caller), log in.
  const set = await fetch(url(f, '/trpc/auth.setPassword'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ next: PASSWORD }),
  })
  expect(set.status).toBe(200)
  const login = await fetch(url(f, '/auth/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  expect(login.status).toBe(200)
  f.cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
  expect(f.cookie).not.toBe('')
  const admin = (await store.users.earliestAdmin())!

  // The data that must not matter: other members, and other login sessions.
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  for (let i = 0; i < size; i++) {
    await store.users.create(
      {
        id: `usr_pin_${i}`,
        displayName: `Member ${i}`,
        role: 'member',
        createdAt: '2026-07-01T00:00:00.000Z',
        disabledAt: null,
      },
      'unused-hash',
    )
    await store.auth.createClientSession(hashToken(`other-${i}`), asUserId(admin.id), expiresAt)
    await store.auth.createClientSession(
      hashToken(`member-${i}`),
      asUserId(`usr_pin_${i}`),
      expiresAt,
    )
  }
  // Warm: first-request work (prepared statements, lazy reads) is not the request's own.
  for (let i = 0; i < 2; i++) await request(f)
  return f
}

async function request(f: Fixture): Promise<number> {
  const res = await fetch(url(f, PROCEDURE), { headers: { cookie: f.cookie } })
  await res.arrayBuffer()
  return res.status
}

async function teardown(f: Fixture): Promise<void> {
  await f.handle.close()
  if (f.priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
  else process.env.PODIUM_STATE_DIR = f.priorStateDir
  rmSync(f.stateDir, { recursive: true, force: true })
}

/** Statements whose per-query key contains `from` text. Keys are truncated (the session
 *  read's ends `from "cli…`), so a needle is the part a key keeps. */
const reading = (tally: StatementTally, from: string): number =>
  [...tally.byQuery].reduce((n, [key, count]) => (key.includes(from) ? n + count : n), 0)

describe('an authenticated tRPC request', () => {
  it('reads its login session once, whatever the instance holds', async () => {
    const pin: StatementPin<Fixture> = {
      name: `GET ${PROCEDURE} with a session cookie`,
      setup: boot,
      target: (f) => f.store,
      run: (f) => request(f),
      check: (status) => expect(status).toBe(200),
      teardown,
    }
    // The session row, the caller's account (its role, for the context), and the
    // procedure's own read of that account. It was 7: the session row four times, "is
    // login required" once, and the same two account reads.
    const counts = await expectConstantStatements(pin, 3)
    for (const tally of [counts.small, counts.large]) {
      // One session read for the guard AND the context, and no "is login required" read
      // for a caller who holds a valid credential.
      expect(reading(tally, 'from "cli')).toBe(1)
      expect(reading(tally, 'from "user_credentials"')).toBe(0)
      expect(reading(tally, 'from "users" ')).toBe(2)
    }
  }, 120_000)
})
