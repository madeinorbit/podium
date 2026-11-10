/**
 * One sign-in read per web request [POD-6220, server-data rule 8; POD-6746].
 *
 * Every tRPC call passes the guard and then builds its context, and both ask
 * who the caller is. They share one resolution per request, and the resolution
 * is one statement of the identity package: the device sign-in by its hashed
 * token, joined to its account and to that account's membership.
 *
 * The request runs against a REAL booted server, because the guard, the
 * resolver and the context are assembled inside `startServer`; a hand-built
 * composition would pin its own assembly, not production's. The data that must
 * not matter is how many members and device sign-ins the instance holds: 5
 * and 200.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
  // The data that must not matter: other members, each with an account and a
  // device sign-in of their own, and more sign-ins of the admin.
  const { memberships, core } = handle.identity
  const admin = (await store.users.earliestAdmin())!
  const adminAccount = (await store.users.get(admin.id as never))?.accountId
  if (!adminAccount) throw new Error('the first admin has no account')
  const facts = (i: number) =>
    ({ scheme: 'https', sameMachine: false, clientAddress: `10.7.${i >> 8}.${i & 255}` }) as const
  for (let i = 0; i < size; i++) {
    const { invitation } = await memberships.invite({ actor: { system: 'host' }, role: 'member' })
    const { accountId } = await memberships.accept({
      token: invitation.token,
      account: { kind: 'new', name: `Member ${i}` },
    })
    await core.deviceSignIns.create(accountId, { kind: 'browser' }, 'cookie', facts(i))
    await core.deviceSignIns.create(adminAccount, { kind: 'browser' }, 'cookie', facts(i))
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

/** Statements whose per-query key contains `from` text. Keys are truncated, so a
 *  needle is the part a key keeps. */
const reading = (tally: StatementTally, from: string): number =>
  [...tally.byQuery].reduce((n, [key, count]) => (key.includes(from) ? n + count : n), 0)

describe('an authenticated tRPC request', () => {
  it('reads its device sign-in once, whatever the instance holds', async () => {
    const pin: StatementPin<Fixture> = {
      name: `GET ${PROCEDURE} with a sign-in cookie`,
      setup: boot,
      target: (f) => f.store,
      run: (f) => request(f),
      check: (status) => expect(status).toBe(200),
      teardown,
    }
    // The resolution (one statement), the member row behind it (its role, for
    // the principal), and the procedure's own read of that member.
    const counts = await expectConstantStatements(pin, 3)
    for (const tally of [counts.small, counts.large]) {
      // One resolution for the guard AND the context, and nothing of the
      // removed hand-written sign-in.
      expect(reading(tally, 'identity_session')).toBe(1)
      expect(reading(tally, 'from "cli')).toBe(0)
      expect(reading(tally, 'from "user_credentials"')).toBe(0)
    }
  }, 120_000)
})
