import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppRouter } from './router'
import { startServer } from './server'

/**
 * REGRESSION (#1148): what `setup.complete` STORES and what `/auth/login` VERIFIES have to be
 * the same string, and storing it has to leave the caller a way back in.
 *
 * Two separate bugs, both only visible through an assembled server:
 *
 *   - `complete()` trimmed the password before hashing it. Nothing else in the product trims —
 *     the login route verifies the raw body and `auth.setPassword` hashes the raw string — so a
 *     password pasted with a leading or trailing space was stored as a string its owner could
 *     never type again, and Settings → Network and Settings → Security stored DIFFERENT
 *     credentials for identical keystrokes.
 *   - The password is written LAST in `complete()`, and the instant it lands
 *     `credentialsRequired()` flips and the open-mode synthetic-admin fallback stops applying.
 *     The caller that just made the write is unauthenticated on its very next request, so the
 *     web step's `onSaved()` reload 401'd on a URL write that had already committed. The fix
 *     lives in the client (network-step.tsx re-logs-in immediately), and it only works if the
 *     credential just stored is one this route accepts — which is what the third case pins.
 *
 * A REAL BOOTED SERVER on purpose, per #1144: the router unit tests build their caller context
 * by hand, so they cannot see either the guard closing or the credential that closed it.
 */
const priorStateDir = process.env.PODIUM_STATE_DIR!
/** Surrounding whitespace is the whole point — the ordinary paste-from-a-password-manager case. */
const PASSWORD = '  spaced secret  '
const PUBLIC_URL = 'https://box.tail.ts.net'

describe('setup.complete stores the password it was given', () => {
  let stateDir: string
  let handle: Awaited<ReturnType<typeof startServer>>
  let trpc: ReturnType<typeof createTRPCClient<AppRouter>>
  let cookie = ''
  const url = (path: string): string => `http://127.0.0.1:${handle.port}${path}`
  const login = (password: string): Promise<Response> =>
    fetch(url('/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-setup-password-'))
    // Configured before boot for the same reason as server.context-users.test.ts: an empty
    // state dir reads as `unconfigured` and the readiness boundary answers every MUTATION
    // with 503 before it can reach the command under test.
    writeFileSync(
      join(stateDir, 'config.json'),
      JSON.stringify({ configVersion: 2, mode: 'all-in-one', persistence: 'systemd' }),
    )
    process.env.PODIUM_STATE_DIR = stateDir
    handle = await startServer({ port: 0 })
    trpc = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: url('/trpc') })] })
  })

  afterAll(async () => {
    await handle.close()
    process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(stateDir, { recursive: true, force: true })
  })

  /**
   * Runs first and unauthenticated, because it is the call that CLOSES the guard: with no
   * credential on the instance yet this client is the open-mode synthetic admin, and after
   * this lands it is nobody.
   */
  it('accepts a whitespace-surrounded password from the reachability step', async () => {
    await expect(
      trpc.setup.complete.mutate({ publicUrl: PUBLIC_URL, password: PASSWORD }),
    ).resolves.toMatchObject({ publicUrl: PUBLIC_URL })
  })

  it('verifies that password against the exact string that was entered', async () => {
    const res = await login(PASSWORD)
    expect(res.status).toBe(200)
    cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
    expect(cookie).not.toBe('')
  })

  /** The half of the bug a trim-at-login "fix" would have hidden rather than removed. */
  it('does not accept the trimmed form of that password', async () => {
    expect((await login(PASSWORD.trim())).status).toBe(401)
  })

  /**
   * The lockout, and the way out of it. The client that made the write above can no longer read
   * its own result — which is why network-step.tsx logs in immediately after a `complete` that
   * carried a password rather than calling `onSaved()` straight into a 401.
   */
  it('locks the writing client out until it presents the new credential', async () => {
    expect((await fetch(url('/trpc/setup.info'))).status).toBe(401)

    const res = await fetch(url('/trpc/setup.info'), { headers: { cookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { data: { publicUrl: string } } }
    expect(body.result.data.publicUrl).toBe(PUBLIC_URL)
  })
})
