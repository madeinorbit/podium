import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveCachedSessionToken } from '@podium/runtime/session-mint'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { makeOperatorIssueClient } from './operator-client'

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
    expect(srv.cookie()).toContain('podium_session=minted-token')
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
