import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CODEX_DAEMON_HTTP_TIMEOUT_MS,
  CodexDaemonAuthError,
  resolveCodexDaemonAuth,
  runCodexComplete,
} from './codex'

/** Build a (signature-less) JWT whose `exp` claim is `expSeconds`. */
function jwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')
  return `h.${payload}.s`
}

const nowSec = () => Math.floor(Date.now() / 1000)

const ACCESS = 'access-token-abc'
const REFRESH = 'refresh-single-use-xyz'
const ACCOUNT = 'acct-1'

function writeAuth(home: string, accessToken: string, accountId = ACCOUNT): void {
  const dir = join(home, '.codex')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: accessToken,
        refresh_token: REFRESH,
        account_id: accountId,
      },
      last_refresh: '2026-06-11T00:00:00Z',
    }),
  )
}

function authPath(home: string): string {
  return join(home, '.codex', 'auth.json')
}

/** A fetch that fails the test if called — proves auth resolution never hits the network. */
const FETCH_FORBIDDEN = (() => {
  throw new Error('fetch must not be called: codex auth is read-only and never rotates the token')
}) as unknown as typeof fetch

/** Build a Codex Responses SSE body from final output items. */
function sse(...items: object[]): string {
  const lines = [`event: response.created\ndata: ${JSON.stringify({ type: 'response.created' })}\n`]
  for (const item of items) {
    lines.push(
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', item })}\n`,
    )
  }
  lines.push(
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n`,
  )
  return lines.join('\n')
}

function mockFetch(body: string, status = 200) {
  const calls: { url: string; init: RequestInit }[] = []
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    } as Response
  }) as unknown as typeof fetch
  return Object.assign(fn, { calls })
}

const REQUEST = {
  type: 'codexCompleteRequest' as const,
  requestId: 'cc-1',
  model: 'gpt-5.5',
  messages: [{ role: 'user' as const, content: 'hi' }],
  tools: [],
  effort: 'medium' as const,
}

describe('resolveCodexDaemonAuth — read-only, self-healing (moved from server codex-auth)', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codex-daemon-auth-'))
  })

  it('returns the access token and account id for a valid token without touching the file', async () => {
    const token = jwt(nowSec() + 3600)
    writeAuth(home, token, 'acct-9')
    const before = readFileSync(authPath(home), 'utf8')

    const auth = await resolveCodexDaemonAuth(home)

    expect(auth).toEqual({ accessToken: token, accountId: 'acct-9' })
    expect(readFileSync(authPath(home), 'utf8')).toBe(before)
  })

  it('throws an actionable error instead of refreshing when the token is expired', async () => {
    writeAuth(home, jwt(nowSec() - 60))
    const before = readFileSync(authPath(home), 'utf8')

    await expect(resolveCodexDaemonAuth(home)).rejects.toBeInstanceOf(CodexDaemonAuthError)
    await expect(resolveCodexDaemonAuth(home)).rejects.toThrow(/codex login/)
    // Never rewrites the shared single-use credential.
    expect(readFileSync(authPath(home), 'utf8')).toBe(before)
  })

  it('self-heals: returns a token a concurrent codex session rotated in, not the rejected one', async () => {
    const fresh = jwt(nowSec() + 3600)
    writeAuth(home, fresh)

    const auth = await resolveCodexDaemonAuth(home, {
      rejectedAccessToken: 'previous-token-the-backend-401d',
    })

    expect(auth.accessToken).toBe(fresh)
  })

  it('does not loop on a token the backend already rejected when the file still holds it', async () => {
    const token = jwt(nowSec() + 3600) // structurally valid, but the backend 401'd it
    writeAuth(home, token)

    await expect(
      resolveCodexDaemonAuth(home, { rejectedAccessToken: token }),
    ).rejects.toBeInstanceOf(CodexDaemonAuthError)
  })

  it('reports a missing login instead of throwing a raw ENOENT', async () => {
    await expect(resolveCodexDaemonAuth(home)).rejects.toThrow(/isn't logged in/)
  })
})

describe('runCodexComplete', () => {
  let home: string
  let prevCodexHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codex-daemon-turn-'))
    prevCodexHome = process.env.CODEX_HOME
    delete process.env.CODEX_HOME
  })
  afterEach(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prevCodexHome
  })

  it('calls the Responses API with the local token and returns text + tool calls', async () => {
    const token = jwt(nowSec() + 3600)
    writeAuth(home, token)
    const fetchImpl = mockFetch(
      sse({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }),
    )

    const outcome = await runCodexComplete({ credentialHome: home, fetchImpl }, REQUEST)

    expect(outcome).toEqual({ ok: true, text: 'ok', toolCalls: [] })
    expect(fetchImpl.calls).toHaveLength(1)
    expect(fetchImpl.calls[0]!.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    const headers = fetchImpl.calls[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${token}`)
    expect(headers['chatgpt-account-id']).toBe(ACCOUNT)
  })

  it('returns the login error (not a throw) when the machine has no Codex login', async () => {
    const outcome = await runCodexComplete(
      { credentialHome: home, fetchImpl: FETCH_FORBIDDEN },
      REQUEST,
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toMatch(/isn't logged in/)
  })

  it('self-heals after a 401 when the CLI rotated a fresh token in', async () => {
    const stale = jwt(nowSec() + 3600)
    const fresh = jwt(nowSec() + 7200)
    writeAuth(home, stale)
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      if (calls === 1) {
        // First attempt with the stale token: the backend rejects it. The CLI
        // rotates the file before we re-read.
        writeAuth(home, fresh)
        return { ok: false, status: 401, text: async () => 'unauthorized' } as Response
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          sse({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'healed' }] }),
      } as Response
    }) as unknown as typeof fetch

    const outcome = await runCodexComplete({ credentialHome: home, fetchImpl }, REQUEST)

    expect(outcome).toEqual({ ok: true, text: 'healed', toolCalls: [] })
    expect(calls).toBe(2)
  })

  it('surfaces an actionable error (no retry loop) when the rejected token is still in the file', async () => {
    const token = jwt(nowSec() + 3600)
    writeAuth(home, token)
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return { ok: false, status: 401, text: async () => 'unauthorized' } as Response
    }) as unknown as typeof fetch

    const outcome = await runCodexComplete({ credentialHome: home, fetchImpl }, REQUEST)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toMatch(/won't refresh/)
    expect(calls).toBe(1)
  })

  it('maps a hung model to a clear timeout error within its own (shorter-than-server) budget', async () => {
    expect(CODEX_DAEMON_HTTP_TIMEOUT_MS).toBeLessThan(125_000)
    const token = jwt(nowSec() + 3600)
    writeAuth(home, token)
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        )
      })) as unknown as typeof fetch

    const outcome = await runCodexComplete(
      { credentialHome: home, fetchImpl: hanging, timeoutMs: 50 },
      REQUEST,
    )

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toMatch(/timed out/)
  })

  it.each(['success', 'login-missing', 'rejected-token'] as const)(
    'the reply for %s carries no credential material (token never leaves)',
    async (variant) => {
      const token = jwt(nowSec() + 3600)
      if (variant !== 'login-missing') writeAuth(home, token)
      const fetchImpl =
        variant === 'rejected-token'
          ? (async () => ({ ok: false, status: 401, text: async () => 'no' }) as Response)
          : mockFetch(
              sse({
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'hello' }],
              }),
            )

      const outcome = await runCodexComplete({ credentialHome: home, fetchImpl }, REQUEST)
      const frame = JSON.stringify({
        type: 'codexCompleteResult',
        requestId: REQUEST.requestId,
        ...outcome,
      })
      // Neither half of the refresh lineage nor the provider account id.
      expect(frame).not.toContain(token)
      expect(frame).not.toContain(REFRESH)
      expect(frame).not.toContain(ACCOUNT)
    },
  )
})
