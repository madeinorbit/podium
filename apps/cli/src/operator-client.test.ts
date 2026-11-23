import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveCachedSessionToken } from '@podium/runtime/session-token'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  makeOperatorIssueClient,
  OLD_ENV_TOKEN_MESSAGE,
  operatorSessionToken,
} from './operator-client'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-operator-client-'))
  process.env.PODIUM_STATE_DIR = dir
})
afterEach(() => {
  // Do NOT delete PODIUM_STATE_DIR: the hermetic guard runs as a GLOBAL
  // afterEach (test-hermetic-vitest-hooks.ts) and requires it set on the way out
  // too, so clearing it here trips the very protection it exists to give. The
  // temp dir is removed instead, and the next file sets its own. Same fix as
  // apps/cli/src/auth-cli.test.ts (05e21ad6).
  delete process.env.PODIUM_SESSION_TOKEN
  rmSync(dir, { recursive: true, force: true })
})

/** Records the cookie of the first request, then answers a tRPC batch envelope. */
async function recordingServer(): Promise<{
  url: string
  cookie: () => string | undefined
  close: () => void
}> {
  let seen: string | undefined
  const srv = createServer((req, res) => {
    seen ??= req.headers.cookie
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify([{ result: { data: { open: 0 } } }]))
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, cookie: () => seen, close: () => srv.close() }
}

// This is the wiring POD-1376 turns on: a credential minted by `podium auth mint-session`
// has to reach the server on an ordinary `podium issue` call, with no further ceremony.
it('carries the cached operator credential on a direct call', async () => {
  saveCachedSessionToken({ token: 'minted-token', expiresAt: '2999-01-01T00:00:00.000Z' }, dir)
  const srv = await recordingServer()
  try {
    await (
      makeOperatorIssueClient(srv.url) as never as {
        issues: { stats: { query(i: unknown): Promise<unknown> } }
      }
    ).issues.stats.query({})
    expect(srv.cookie()).toContain('podium.session_token=minted-token')
  } finally {
    srv.close()
  }
})

it('sends no cookie when the host has no credential (open instance)', async () => {
  const srv = await recordingServer()
  try {
    await (
      makeOperatorIssueClient(srv.url) as never as {
        issues: { stats: { query(i: unknown): Promise<unknown> } }
      }
    ).issues.stats.query({})
    expect(srv.cookie()).toBeUndefined()
  } finally {
    srv.close()
  }
})

// ---------------------------------------------------------------------------
// The sign-in carry-over for the host's cached session (POD-6751;
// docs/design/sign-in-carry-over.md, section 6.1, test 29).
// ---------------------------------------------------------------------------

const OLD_TOKEN = 'Krhai8IVO7WU7uCc6cw94ZJckKFeeQ2iVNKGOm-di1U'
const NEW_TOKEN = 'device-sign-in-token.c2lnbmF0dXJlK3dpdGgvc2lnbnM9'
const cachePath = () => join(dir, 'cli-session.json')
const writeOldFormCache = (token = OLD_TOKEN, expiresAt = '2999-01-01T00:00:00.000Z') =>
  writeFileSync(cachePath(), `${JSON.stringify({ token, expiresAt }, null, 2)}\n`, { mode: 0o600 })

/** A server that carries `OLD_TOKEN` at its status route, and records every request. */
async function carryingServer(opts: { carries?: boolean } = {}): Promise<{
  url: string
  requests: { path: string; cookie: string | undefined }[]
  close: () => void
}> {
  const requests: { path: string; cookie: string | undefined }[] = []
  const srv = createServer((req, res) => {
    requests.push({ path: req.url ?? '', cookie: req.headers.cookie })
    if (req.url === '/auth/status') {
      const carried = opts.carries !== false && req.headers.cookie === `podium_session=${OLD_TOKEN}`
      res.writeHead(200, {
        'content-type': 'application/json',
        ...(carried
          ? {
              'set-cookie': `podium.session_token=${encodeURIComponent(NEW_TOKEN)}; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax`,
            }
          : {}),
      })
      res.end(JSON.stringify({ authed: carried }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify([{ result: { data: { open: 0 } } }]))
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, requests, close: () => srv.close() }
}

const stats = (url: string) =>
  (
    makeOperatorIssueClient(url) as never as {
      issues: { stats: { query(i: unknown): Promise<unknown> } }
    }
  ).issues.stats.query({})

it('exchanges an old-form cache once, rewrites it, and uses the new form from then on', async () => {
  writeOldFormCache()
  const srv = await carryingServer()
  try {
    const before = Date.now()
    await stats(srv.url)
    // One status request with the old token as the OLD cookie, then the call with the new one.
    expect(srv.requests).toEqual([
      { path: '/auth/status', cookie: `podium_session=${OLD_TOKEN}` },
      {
        path: expect.stringContaining('/trpc/'),
        cookie: `podium.session_token=${encodeURIComponent(NEW_TOKEN)}`,
      },
    ])
    const rewritten = JSON.parse(readFileSync(cachePath(), 'utf8'))
    expect(rewritten).toMatchObject({ version: 2, token: NEW_TOKEN })
    expect(JSON.stringify(rewritten)).not.toContain(OLD_TOKEN)
    const life = Date.parse(rewritten.expiresAt) - before
    expect(life).toBeGreaterThan(3_590_000)
    expect(life).toBeLessThan(3_610_000)
    expect(statSync(cachePath()).mode & 0o777).toBe(0o600)

    // The second command reads the new form and asks the status route nothing.
    srv.requests.length = 0
    await stats(srv.url)
    expect(srv.requests.map((request) => request.path)).toEqual([expect.stringContaining('/trpc/')])
    expect(srv.requests[0]?.cookie).toBe(`podium.session_token=${encodeURIComponent(NEW_TOKEN)}`)
  } finally {
    srv.close()
  }
})

it('leaves an old-form cache alone when the server does not carry it, and sends no cookie', async () => {
  writeOldFormCache()
  const untouched = readFileSync(cachePath(), 'utf8')
  const srv = await carryingServer({ carries: false })
  try {
    await stats(srv.url)
    expect(srv.requests.at(-1)?.cookie).toBeUndefined()
    expect(readFileSync(cachePath(), 'utf8')).toBe(untouched)
  } finally {
    srv.close()
  }
})

it('never sends an old-form cache to another machine over plain HTTP, or an expired one anywhere', async () => {
  const asked: string[] = []
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    asked.push(String(input))
    return new Response('{}')
  }) as typeof fetch
  writeOldFormCache()
  expect(await operatorSessionToken('http://podium.example:18787', { at: dir, fetchImpl })).toBe(
    undefined,
  )
  writeOldFormCache(OLD_TOKEN, '2020-01-01T00:00:00.000Z')
  expect(await operatorSessionToken('http://127.0.0.1:18787', { at: dir, fetchImpl })).toBe(
    undefined,
  )
  expect(asked).toEqual([])
})

it('refuses an old token in PODIUM_SESSION_TOKEN with the message that names the fix', async () => {
  const srv = await carryingServer()
  try {
    process.env.PODIUM_SESSION_TOKEN = OLD_TOKEN
    await expect(stats(srv.url)).rejects.toThrow(/before the upgrade to shared sign-in/)
    await expect(stats(srv.url)).rejects.toThrow(/podium auth mint-session/)
    expect(OLD_ENV_TOKEN_MESSAGE).toContain('podium auth mint-session')
    // Nothing was sent anywhere: not to the status route, not as a credential.
    expect(srv.requests).toEqual([])
    // A signed token in the variable is used as before.
    process.env.PODIUM_SESSION_TOKEN = NEW_TOKEN
    await stats(srv.url)
    expect(srv.requests.map((request) => request.cookie)).toEqual([
      `podium.session_token=${encodeURIComponent(NEW_TOKEN)}`,
    ])
  } finally {
    srv.close()
  }
})
