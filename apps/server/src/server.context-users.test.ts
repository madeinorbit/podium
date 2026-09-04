import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { noJanitorWorkerForTests } from './janitor-host'
import type { AppRouter } from './router'
import { startServer } from './server'

/**
 * REGRESSION (#1144): `createContext` must put the accounts repository — and the composed
 * `loginRequired` predicate — on the tRPC context.
 *
 * POD-1554 added `Context.users` / `Context.loginRequired` (trpc.ts) and the `familyState`
 * forwarding (modules/derived-family.ts) but never the PRODUCER in `createContext`. Both
 * fields are optional — a server assembled without a user store legitimately serves no login
 * — so the omission type-checked and failed only at runtime, in two different ways:
 *
 *   - `users` absent  → `requireAccountStore` threw 'account store unavailable' for
 *     setup.complete-with-password, auth.setPassword and auth.setLoginRequired, i.e. every
 *     credential write the product has.
 *   - `loginRequired` absent → `auth.status` fell back to `?? false` and reported login as
 *     OFF however many credentials existed. A wrong answer rather than a refusal, which is
 *     why nothing surfaced it.
 *
 * These assertions go through a REAL booted server on purpose. The router unit tests pass
 * `users` into `createCaller` by hand, so they build a context production never produces —
 * which is exactly why they stayed green for the whole time the surface was dead. A test that
 * constructs its own context cannot catch a bug whose shape is "production and the tests
 * assemble different contexts".
 */
const priorStateDir = process.env.PODIUM_STATE_DIR!
const PASSWORD = 'correct-horse-battery-staple'

describe('tRPC context carries the accounts repository', () => {
  let stateDir: string
  let handle: Awaited<ReturnType<typeof startServer>>
  let trpc: ReturnType<typeof createTRPCClient<AppRouter>>
  const url = (path: string): string => `http://127.0.0.1:${handle.port}${path}`

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-ctx-users-'))
    // CONFIGURED BEFORE BOOT, deliberately. An empty state dir reads as `unconfigured`, and
    // the readiness boundary answers every MUTATION with 503 server_not_ready — which would
    // fail these tests without ever reaching the context they are about. Writing it before
    // `startServer` also keeps boot config and live config identical, so readiness does not
    // land on `restart_required` instead.
    writeFileSync(
      join(stateDir, 'config.json'),
      JSON.stringify({ configVersion: 2, mode: 'all-in-one', persistence: 'systemd' }),
    )
    process.env.PODIUM_STATE_DIR = stateDir
    handle = await startServer({ janitorWorkerForTests: noJanitorWorkerForTests, port: 0 })
    trpc = createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: url('/trpc') })],
    })
  })

  afterAll(async () => {
    await handle.close()
    process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(stateDir, { recursive: true, force: true })
  })

  /**
   * `canManageInstance` is `users.get(callerUserId).role === 'admin'`, so it is false in
   * BOTH the "not an admin" and the "no users repository at all" cases. On a fresh instance
   * the caller IS the first admin, which makes this a direct read of whether `users` arrived.
   */
  it('auth.status resolves the caller as an admin (false ⇒ `users` never reached the service)', async () => {
    await expect(trpc.auth.status.query()).resolves.toMatchObject({ canManageInstance: true })
  })

  /**
   * The failure the user actually hit. Ordered before the login-required check because it is
   * what CLOSES the guard: with no credential on the instance yet, this client reaches /trpc
   * unauthenticated, and after it lands it no longer can.
   */
  it('auth.setPassword does not refuse with "account store unavailable"', async () => {
    await expect(trpc.auth.setPassword.mutate({ next: PASSWORD })).resolves.toMatchObject({
      loginRequired: true,
    })
  })

  /**
   * Raw fetch with a session cookie rather than the shared client: the write above closed the
   * guard, so this is also the end-to-end proof that the credential it stored is the one the
   * login route verifies.
   */
  it('auth.status reports login as required once a credential exists', async () => {
    const login = await fetch(url('/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
    expect(cookie).not.toBe('')

    const res = await fetch(url('/trpc/auth.status'), { headers: { cookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { data: { loginRequired: boolean } } }
    expect(body.result.data.loginRequired).toBe(true)
  })
})
