/**
 * Relay contract tests [spec:SP-f933].
 *
 * The relay is the one part of this feature a self-hosted user cannot audit at
 * runtime (they can read this source; they cannot prove the deployment matches
 * it — docs/TELEMETRY.md says so plainly). That makes these tests the closest
 * thing to a proof we can offer, so they assert the promises literally: the
 * source IP is never forwarded, and nothing outside the published schema passes.
 */
import type { CrashReport, UsageReport } from '@podium/telemetry/schema'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type Env, handleRequest, toPostHogEvent } from './index'

const env: Env = { POSTHOG_API_KEY: 'phc_test', POSTHOG_HOST: 'https://us.i.posthog.com' }

const usage: UsageReport = {
  schema: 1,
  installId: '3f9c1a2e-0000-4000-8000-000000000000',
  version: '1.4.2',
  os: 'linux',
  arch: 'x64',
  installAge: '1-7d',
  machines: '2-5',
  sessions: { 'claude-code': 14, codex: 2 },
  features: { issues: true },
}

const crash: CrashReport = {
  schema: 1,
  installId: '3f9c1a2e-0000-4000-8000-000000000000',
  version: '1.4.2',
  os: 'linux',
  arch: 'x64',
  errorType: 'TypeError',
  frames: [{ file: 'apps/server/src/router.ts', line: 412, fn: 'handleSession' }],
}

/** A request carrying every header a real client/edge would attach, including
 *  the IP headers the relay must ignore. */
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://telemetry.podium.dev/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.42',
      'x-forwarded-for': '203.0.113.42, 198.51.100.7',
      'x-real-ip': '203.0.113.42',
      'user-agent': 'podium/1.4.2',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

/** The body the relay forwarded upstream. */
const forwarded = (): Record<string, unknown> =>
  JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))

describe('the source IP never leaves the edge', () => {
  it('forwards no IP header value anywhere in the upstream body', async () => {
    await handleRequest(post(usage), env)
    const body = JSON.stringify(forwarded())
    expect(body).not.toContain('203.0.113.42')
    expect(body).not.toContain('198.51.100.7')
  })

  it('forwards none of the client request headers upstream', async () => {
    await handleRequest(post(usage), env)
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>
    expect(Object.keys(headers).map((h) => h.toLowerCase())).toEqual(['content-type'])
  })

  it('explicitly disables PostHog geolocation + IP capture', async () => {
    // PostHog geolocates from the forwarding IP unless told not to — the relay's
    // own IP must not become a location signal either.
    await handleRequest(post(usage), env)
    expect(forwarded().properties).toMatchObject({ $geoip_disable: true, $ip: null })
  })

  it('builds no person profile — this is an install counter, not a user', async () => {
    await handleRequest(post(usage), env)
    expect(forwarded().properties).toMatchObject({ $process_person_profile: false })
  })
})

describe('schema round-trip', () => {
  it('forwards a usage report with every field intact', async () => {
    const res = await handleRequest(post(usage), env)
    expect(res.status).toBe(204)
    expect(forwarded()).toMatchObject({
      event: 'podium_usage',
      distinct_id: usage.installId,
      api_key: 'phc_test',
      properties: expect.objectContaining({
        schema: 1,
        version: '1.4.2',
        installAge: '1-7d',
        machines: '2-5',
        sessions: { 'claude-code': 14, codex: 2 },
      }),
    })
  })

  it('classifies a crash report by shape, with no discriminator field', async () => {
    await handleRequest(post(crash), env)
    expect(forwarded()).toMatchObject({
      event: 'podium_crash',
      properties: expect.objectContaining({ errorType: 'TypeError' }),
    })
  })

  it('never puts the installId in the properties (it is the distinct_id)', async () => {
    await handleRequest(post(usage), env)
    expect(forwarded().properties).not.toHaveProperty('installId')
  })

  it('posts to the configured PostHog host', async () => {
    await handleRequest(post(usage), env)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://us.i.posthog.com/i/v0/e/')
  })
})

describe('malformed bodies are rejected, not forwarded', () => {
  it.each([
    ['a free-text field the schema does not admit', { ...usage, note: '/home/alice/secret-repo' }],
    ['an unknown session harness', { ...usage, sessions: { 'my-tool': 1 } }],
    ['a raw path in a frame', { ...crash, frames: [{ file: '/home/alice/x.ts', line: 1 }] }],
    ['an error message field', { ...crash, message: 'failed to open /home/alice/key' }],
    ['a non-uuid installId', { ...usage, installId: 'alices-macbook' }],
    ['an unknown schema version', { ...usage, schema: 99 }],
    ['a hybrid of both report types', { ...usage, ...crash }],
    ['an empty object', {}],
    ['an array', [usage]],
    ['a string', 'hello'],
  ])('rejects %s', async (_label, body) => {
    const res = await handleRequest(post(body), env)
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects invalid json', async () => {
    const res = await handleRequest(post('{not json'), env)
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an oversized body without reading it', async () => {
    const res = await handleRequest(post(usage, { 'content-length': '999999' }), env)
    expect(res.status).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a body that lies about its content-length', async () => {
    const huge = { ...usage, features: { issues: true } }
    const req = new Request('https://telemetry.podium.dev/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `${JSON.stringify(huge)}${' '.repeat(9000)}`,
    })
    expect((await handleRequest(req, env)).status).toBe(413)
  })
})

describe('method handling', () => {
  it('answers CORS preflight', async () => {
    const res = await handleRequest(
      new Request('https://telemetry.podium.dev/', { method: 'OPTIONS' }),
      env,
    )
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
  })

  it('refuses GET — there is nothing to read back', async () => {
    const res = await handleRequest(
      new Request('https://telemetry.podium.dev/', { method: 'GET' }),
      env,
    )
    expect(res.status).toBe(405)
  })
})

describe('upstream failure', () => {
  it('502s when PostHog rejects, so the client retries later rather than dropping', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }))
    expect((await handleRequest(post(usage), env)).status).toBe(502)
  })

  it('502s when PostHog is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    expect((await handleRequest(post(usage), env)).status).toBe(502)
  })
})

describe('toPostHogEvent', () => {
  it('is a pure mapping — no clock, no randomness, no IO', () => {
    expect(toPostHogEvent(usage)).toEqual(toPostHogEvent(usage))
  })
})
