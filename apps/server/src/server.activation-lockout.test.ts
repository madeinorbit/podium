import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppRouter } from './router'
import { startServer } from './server'

/**
 * POD-2766 — SETTING A PASSWORD LOCKED THE OPERATOR OUT OF THEIR OWN SERVER.
 *
 * A REAL BOOTED SERVER, for the reason server.setup-password.test.ts gives and
 * more so here: every seam in this failure is one the router unit tests build by
 * hand. The readiness boundary, the auth boundary, and the principal resolver
 * that decides whether a session is even LOOKED UP are all wired in server.ts,
 * and the bug lived in the disagreement between them. A test that reconstructs
 * that wiring is testing its own copy of the rule.
 *
 * What happened, in order:
 *
 *   1. The box ran the binary directly, so `config.json` named no `persistence`.
 *      Since config v2 that is an ANSWER — "not headless-managed" — not a gap.
 *   2. `setup.complete` was called to set a password. It also back-filled
 *      `persistence: 'systemd'`.
 *   3. `persistence` is boot-relevant, so the running process compared the file
 *      against what it booted with, found a difference, and correctly declared
 *      itself stale: `activation_pending`, data plane blocked.
 *   4. Login sat behind the data plane. The remedy — a restart — sat behind the
 *      login. Recovery meant getting a shell inside the container.
 *
 * Two independent defects, so two describes. The first must never happen; the
 * second must be survivable when it does, because a mode change is a legitimate
 * reason to reach this state and the operator still has to get back in.
 */
const priorStateDir = process.env.PODIUM_STATE_DIR!
const PASSWORD = 'operator'
const PUBLIC_URL = 'https://sandbox.example.com'

interface Readiness {
  state: string
  dataPlane: string
  controlPlane?: string
  stale?: string[]
}

describe('setting a password on a live server does not block it [POD-2766]', () => {
  let stateDir: string
  let handle: Awaited<ReturnType<typeof startServer>>
  let trpc: ReturnType<typeof createTRPCClient<AppRouter>>
  const url = (path: string): string => `http://127.0.0.1:${handle.port}${path}`

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-activation-lockout-'))
    // NO `persistence`, which is the whole setup. The existing password test
    // writes `systemd` here, which is exactly why it never saw this: the
    // back-fill was a no-op on a box that had already answered.
    writeFileSync(
      join(stateDir, 'config.json'),
      JSON.stringify({ configVersion: 2, mode: 'all-in-one' }),
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

  it('serves a normal readiness before the password is set', async () => {
    const readiness = (await (await fetch(url('/readiness'))).json()) as Readiness
    expect(readiness.dataPlane).toBe('available')
  })

  it('keeps the data plane open after setup.complete sets a password', async () => {
    await trpc.setup.complete.mutate({ publicUrl: PUBLIC_URL, password: PASSWORD })
    const readiness = (await (await fetch(url('/readiness'))).json()) as Readiness
    // THE ASSERTION THIS ISSUE EXISTS FOR. Before the fix this was
    // `activation_pending` / `blocked`, and everything below was unreachable.
    expect(readiness.state).not.toBe('activation_pending')
    expect(readiness.dataPlane).toBe('available')
  })

  it('lets the operator log in with the password they just set', async () => {
    const res = await fetch(url('/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })
    expect(res.status).toBe(200)
  })
})

describe('an operator can recover a genuinely stale server [POD-2766]', () => {
  let stateDir: string
  let handle: Awaited<ReturnType<typeof startServer>>
  let trpc: ReturnType<typeof createTRPCClient<AppRouter>>
  let cookie = ''
  let priorInvocationId: string | undefined
  const url = (path: string): string => `http://127.0.0.1:${handle.port}${path}`

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-activation-recovery-'))
    // THE RESTART CAPABILITY IS DELIBERATELY WITHHELD FROM THIS SERVER, and the
    // one line that does it is `INVOCATION_ID`.
    //
    // `createSourceRedeployRequest` hands back a real capability whenever it
    // finds that variable, because inside a systemd service a restart means
    // `systemctl --user start podium-redeploy.service`. A test process launched
    // from an agent session INHERITS it — so an authorized `setup.activate` here
    // would schedule a genuine redeploy of the developer's live instance,
    // measured and confirmed once before this guard was added.
    //
    // Withholding it costs nothing that matters. Every check `activate` makes —
    // activation-pending, authenticated, admin — runs BEFORE the capability
    // check, so reaching "cannot restart itself" proves the call cleared both
    // readiness boundaries, the login guard and the admin floor. That the
    // capability is then actually CALLED is router.setup.test.ts's job, where the
    // restart is a `vi.fn()` and nothing can reach the host.
    priorInvocationId = process.env.INVOCATION_ID
    delete process.env.INVOCATION_ID
    writeFileSync(
      join(stateDir, 'config.json'),
      JSON.stringify({ configVersion: 2, mode: 'all-in-one', persistence: 'systemd' }),
    )
    process.env.PODIUM_STATE_DIR = stateDir
    handle = await startServer({ port: 0 })
    trpc = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: url('/trpc') })] })
    // A credential first, while the instance is still open — this is the account
    // the operator will need on the far side of the block.
    await trpc.setup.complete.mutate({ publicUrl: PUBLIC_URL, password: PASSWORD })
    // Now make it genuinely stale, the way a real reconfiguration would: the file
    // says one thing about how this box is supervised, the process booted with
    // another. The guard SHOULD trip here and this test does not weaken it.
    writeFileSync(
      join(stateDir, 'config.json'),
      JSON.stringify({
        configVersion: 2,
        mode: 'all-in-one',
        persistence: 'detached',
        publicUrl: PUBLIC_URL,
      }),
    )
  })

  afterAll(async () => {
    await handle.close()
    process.env.PODIUM_STATE_DIR = priorStateDir
    if (priorInvocationId !== undefined) process.env.INVOCATION_ID = priorInvocationId
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('blocks the data plane and says which setting is stale', async () => {
    const readiness = (await (await fetch(url('/readiness'))).json()) as Readiness
    expect(readiness).toMatchObject({
      state: 'activation_pending',
      dataPlane: 'blocked',
      // The half that is new: the instance can still be TALKED TO about itself,
      // and it names what it is waiting on rather than saying "something changed".
      controlPlane: 'available',
      stale: ['persistence'],
    })
  })

  it('still lets the operator log in — the remedy is no longer behind the failure', async () => {
    const res = await fetch(url('/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })
    expect(res.status).toBe(200)
    cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
    expect(cookie).not.toBe('')
  })

  it('reports that session as authenticated instead of silently ignoring it', async () => {
    // The seam that would otherwise loop the login screen forever: a login that
    // succeeds and then reports `authed: false` sends the browser straight back
    // to the password field against a server that already accepted it.
    const status = (await (await fetch(url('/auth/status'), { headers: { cookie } })).json()) as {
      authed: boolean
      readiness?: Readiness
    }
    expect(status.authed).toBe(true)
    expect(status.readiness).toMatchObject({ state: 'activation_pending' })
  })

  it('refuses work to that same session — the guard is scoped, not weakened', async () => {
    // A control-plane session buys the control plane and nothing else. This is
    // the line POD-2462 has refused four times to cross, and it stays uncrossed.
    const res = await fetch(url('/trpc/sessions.list'), { headers: { cookie } })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe('server_not_ready')
  })

  it('serves the restart to that session, which is the way out', async () => {
    // The call REACHES the procedure and is authorized, instead of meeting the
    // 503 that trapped the operator. See the beforeAll for why the answer is the
    // capability refusal rather than a restart: getting this far is the proof —
    // readiness, session and admin floor are all checked before it.
    const res = await fetch(url('/trpc/setup.activate'), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).not.toBe(503)
    expect(res.status).not.toBe(401)
    expect(await res.text()).toContain('cannot restart itself')
  })

  it('refuses that same restart to an anonymous caller', async () => {
    // Reachable does not mean open. The control plane is served to the internet,
    // so the login guard is the only thing standing between a stale instance and
    // a free remote bounce lever.
    const res = await fetch(url('/trpc/setup.activate'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(401)
  })
})
