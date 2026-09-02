/**
 * THE WHOLE SPLIT, ON REAL WIRES (PDM-24).
 *
 * Every predicate in this change is unit-tested, and none of those tests can
 * tell you that a browser on another host can actually log in, call, fetch a
 * file and open a socket against this server — that answer is made of the CORS
 * mounts, their ORDER relative to their handlers, the auth guard letting a
 * preflight through, and the socket boundary reading the same list. Each piece
 * was already right at some point in this change while the whole was not.
 *
 * `app.localtest.me` and `api.localtest.me` both resolve to 127.0.0.1 and are
 * same-site under `localtest.me`, which is NOT on the public suffix list — so
 * this is the production shape rather than an approximation of it. `localhost`
 * subdomains would not be: browsers treat `localhost` specially, and the
 * predicates here treat a loopback host specially too, which would make the
 * allow-list irrelevant and the test vacuous. The socket leg forges `Host:
 * api.localtest.me` for exactly that reason: a test server necessarily binds
 * loopback, and the WS guard defers to the edge whenever the request host is
 * loopback, so without the forged Host it would admit everything and prove
 * nothing.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WIRE_VERSION } from '@podium/protocol'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { AppRouter } from './router'
import { startServer } from './server'

/** The page's origin. Nothing listens there; only the header matters. */
const APP_ORIGIN = 'http://app.localtest.me:55556'
const FOREIGN_ORIGIN = 'http://evil.localtest.me:55556'
const PASSWORD = 'same-site-secret'

const priorStateDir = process.env.PODIUM_STATE_DIR
const priorAllowedOrigins = process.env.PODIUM_ALLOWED_ORIGINS

describe('a same-site app host talking to an API on another host', () => {
  let stateDir: string
  let handle: Awaited<ReturnType<typeof startServer>>
  let cookie = ''

  const url = (path: string): string => `http://127.0.0.1:${handle.port}${path}`

  const preflight = (path: string, origin: string, method: string): Promise<Response> =>
    fetch(url(path), {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': method,
        'access-control-request-headers': 'content-type',
      },
    })

  /** Resolve 'open' or 'rejected', with `Host` forged to the API's real name. */
  const socket = (origin: string, withCookie: boolean): Promise<'open' | 'rejected'> =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/client?v=${WIRE_VERSION}`, {
        headers: {
          host: 'api.localtest.me',
          origin,
          ...(withCookie ? { cookie } : {}),
        },
      })
      ws.on('open', () => {
        ws.close()
        resolve('open')
      })
      ws.on('error', () => resolve('rejected'))
      ws.on('unexpected-response', () => resolve('rejected'))
    })

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-cross-origin-'))
    // Configured before boot, or the readiness boundary answers every mutation
    // with 503 and `setup.complete` never reaches the password store.
    writeFileSync(
      join(stateDir, 'config.json'),
      JSON.stringify({ configVersion: 2, mode: 'all-in-one', persistence: 'systemd' }),
    )
    process.env.PODIUM_STATE_DIR = stateDir
    // Read once at boot, so it has to be here rather than in a test.
    process.env.PODIUM_ALLOWED_ORIGINS = APP_ORIGIN
    handle = await startServer({ port: 0 })
    const trpc = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: url('/trpc') })] })
    await trpc.setup.complete.mutate({ publicUrl: 'https://api.localtest.me', password: PASSWORD })
  })

  afterAll(async () => {
    await handle.close()
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
    if (priorAllowedOrigins === undefined) delete process.env.PODIUM_ALLOWED_ORIGINS
    else process.env.PODIUM_ALLOWED_ORIGINS = priorAllowedOrigins
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('answers the login preflight for the app host', async () => {
    // A JSON POST is never simple, so this preflight is the first thing a
    // browser does and the first thing that can fail.
    const res = await preflight('/auth/login', APP_ORIGIN, 'POST')
    expect(res.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    expect(res.headers.get('vary')).toContain('Origin')
  })

  it('logs in and sets the session cookie', async () => {
    const res = await fetch(url('/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: APP_ORIGIN },
      body: JSON.stringify({ password: PASSWORD }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN)
    cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
    expect(cookie).not.toBe('')
  })

  it('serves tRPC to the cookie the app host now holds', async () => {
    const res = await fetch(url('/trpc/setup.info'), { headers: { cookie, origin: APP_ORIGIN } })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN)
  })

  it('answers the /files preflight, so app code can fetch an asset', async () => {
    // The mount this change adds. Without it an <img src> works and a fetch()
    // of the same URL does not, which is how it stayed missing.
    const res = await preflight('/files/asset', APP_ORIGIN, 'GET')
    expect(res.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('answers /version across the origin, so a page can check its own build', async () => {
    const res = await fetch(url('/version'), { headers: { origin: APP_ORIGIN } })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN)
  })

  it('upgrades the client socket with that cookie and Origin', async () => {
    expect(await socket(APP_ORIGIN, true)).toBe('open')
  })

  it('refuses an origin nobody named, on both planes', async () => {
    const res = await preflight('/auth/login', FOREIGN_ORIGIN, 'POST')
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(await socket(FOREIGN_ORIGIN, true)).toBe('rejected')
  })
})
