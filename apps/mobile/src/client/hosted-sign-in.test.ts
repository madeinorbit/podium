// @vitest-environment node
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  createHostedSignIn,
  isHostedReturn,
  parseHostedReturn,
  type HostedSignInDependencies,
} from './hosted-sign-in'
const verifier = 'a'.repeat(64)
const challenge = createHash('sha256').update(verifier).digest('hex')
const code = 'hoff_' + 'B'.repeat(27)
const link = { code, challenge }
const callback = `podium://signed-in?code=${code}&challenge=${challenge}`
function rig() {
  let stored: string | null = null
  let now = Date.now()
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
    String(url).endsWith('/begin')
      ? Response.json(
          { challenge },
          {
            headers: {
              'set-cookie': `__Host-podium-handoff=${verifier}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
            },
          },
        )
      : Response.json({
          token: 'session-token',
          expiresAt: new Date(now + 86400_000).toISOString(),
        }),
  )
  const deps: HostedSignInDependencies = {
    fetch: fetcher,
    read: async () => stored,
    write: async (value) => {
      stored = value
    },
    remove: async () => {
      stored = null
    },
    digest: async (value) => createHash('sha256').update(value).digest('hex'),
    open: vi.fn(async () => {}),
    now: () => now,
  }
  return {
    deps,
    fetcher,
    client: createHostedSignIn(deps),
    stored: () => stored,
    advance: () => {
      now += 600_001
    },
  }
}
describe('hosted phone sign-in', () => {
  it('persists proof before opening the system browser, without exposing the verifier', async () => {
    const r = rig()
    r.deps.open = vi.fn(async (url) => {
      expect(r.stored()).toContain(verifier)
      expect(url).toBe(
        `https://ade.podium.do/account/sign-in?handoff=desktop&challenge=${challenge}&switchAccount=1`,
      )
      expect(url).not.toContain(verifier)
    })
    await r.client.begin()
    expect(r.fetcher).toHaveBeenCalledWith(
      'https://api.podium.do/platform/auth/handoff/begin',
      expect.objectContaining({
        credentials: 'omit',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', Origin: 'https://ade.podium.do' },
      }),
    )
    expect(r.deps.open).toHaveBeenCalledOnce()
  })
  it('restores an attempt after restart and redeems a bearer once, consuming before I/O', async () => {
    const r = rig()
    await r.client.begin(
      'https://api.podium.do',
      'https://ade.podium.do/account/sign-in',
      'ws_blue',
    )
    expect(JSON.parse(r.stored() ?? 'null').workspaceId).toBe('ws_blue')
    expect(r.fetcher.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'Podium-Workspace-Id': 'ws_blue' },
    })
    const restarted = createHostedSignIn(r.deps)
    r.fetcher.mockImplementationOnce(async (_url, options) => {
      expect(new Headers(options?.headers).get('Podium-Workspace-Id')).toBe('ws_blue')
      expect(r.stored()).toBeNull()
      expect(JSON.parse(String(options?.body))).toEqual({ code, transport: 'bearer', verifier })
      return Response.json({
        token: 'phone-token',
        expiresAt: new Date(Date.now() + 10_000).toISOString(),
      })
    })
    expect(await restarted.redeem(parseHostedReturn(callback))).toEqual({
      server: 'https://api.podium.do',
      token: 'phone-token',
      workspaceId: 'ws_blue',
    })
    await expect(restarted.redeem(link)).rejects.toThrow('ended')
    expect(r.fetcher).toHaveBeenCalledTimes(2)
  })
  it('rejects unsolicited and mismatched links without replacing a pending attempt', async () => {
    const r = rig()
    await expect(r.client.redeem(link)).rejects.toThrow('ended')
    await r.client.begin()
    const saved = r.stored()
    await expect(r.client.redeem({ ...link, challenge: 'b'.repeat(64) })).rejects.toThrow('ended')
    expect(r.stored()).toBe(saved)
    expect(r.fetcher).toHaveBeenCalledTimes(1)
  })
  it('rejects expired and canceled attempts before redemption', async () => {
    const r = rig()
    await r.client.begin()
    r.advance()
    await expect(r.client.redeem(link)).rejects.toThrow('ended')
    await r.client.begin()
    await r.client.cancel()
    await expect(r.client.redeem(link)).rejects.toThrow('ended')
    expect(r.fetcher).toHaveBeenCalledTimes(2)
  })
  it('permits only one concurrent redemption', async () => {
    const r = rig()
    await r.client.begin()
    const results = await Promise.allSettled([r.client.redeem(link), r.client.redeem(link)])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(r.fetcher).toHaveBeenCalledTimes(2)
  })
  it('does not retry a code after ambiguous network failure', async () => {
    const r = rig()
    await r.client.begin()
    r.fetcher.mockRejectedValueOnce(new Error('offline'))
    await expect(r.client.redeem(link)).rejects.toThrow('offline')
    await expect(r.client.redeem(link)).rejects.toThrow('ended')
    expect(r.stored()).toBeNull()
  })
  it.each([
    null,
    {},
    { token: 'bad\nheader', expiresAt: '2099-01-01' },
    { token: 'token', expiresAt: '2000-01-01' },
  ])('rejects invalid redemption response %j', async (body) => {
    const r = rig()
    await r.client.begin()
    r.fetcher.mockResolvedValueOnce(Response.json(body))
    await expect(r.client.redeem(link)).rejects.toThrow()
    expect(r.stored()).toBeNull()
  })
  it('does not open a browser when keychain storage fails', async () => {
    const r = rig()
    r.deps.write = async () => {
      throw new Error('locked')
    }
    await expect(r.client.begin()).rejects.toThrow('locked')
    expect(r.deps.open).not.toHaveBeenCalled()
  })
  it('clears pending proof if browser launch fails', async () => {
    const r = rig()
    r.deps.open = async () => {
      throw new Error('no browser')
    }
    await expect(r.client.begin()).rejects.toThrow('open the browser')
    expect(r.stored()).toBeNull()
  })
  it('rejects mismatching server proof and non-HTTPS destinations', async () => {
    const r = rig()
    r.fetcher.mockResolvedValueOnce(
      Response.json(
        { challenge: 'c'.repeat(64) },
        { headers: { 'set-cookie': `__Host-podium-handoff=${verifier}; Secure` } },
      ),
    )
    await expect(r.client.begin()).rejects.toThrow('valid sign-in attempt')
    await expect(r.client.begin('http://api.podium.do')).rejects.toThrow('HTTPS')
    expect(r.deps.open).not.toHaveBeenCalled()
  })
  it.each([
    `${callback}&code=${code}`,
    `${callback}&server=https://evil.example`,
    `${callback}#secret`,
    callback.replace('signed-in?', 'signed-in/path?'),
    callback.replace(code, 'bad'),
    'podium://signed-in',
  ])('rejects malformed callback %s', (raw) => {
    expect(() => parseHostedReturn(raw)).toThrow()
  })
  it('leaves pairing and navigation links to their existing handlers', () => {
    expect(isHostedReturn('podium://pair?token=secret')).toBe(false)
    expect(isHostedReturn('podium://session/abc')).toBe(false)
    expect(isHostedReturn(callback)).toBe(true)
  })
})
