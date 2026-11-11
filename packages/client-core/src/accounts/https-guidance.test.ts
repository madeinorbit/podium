import { expect, test, vi } from 'vitest'
import { cookieCredentials, createAuthClient, preflightServer } from './index'

const guidance = {
  error: 'https_required',
  message:
    'This server needs HTTPS for sign-in from other computers. Open https://podium.example and connect again.',
  httpsUrl: 'https://podium.example',
  docsUrl:
    'https://github.com/madeinorbit/podium/blob/main/docs/adding-a-machine.md#https-for-sign-in',
}

test.each([
  'browser',
  'native',
] as const)('%s startup preserves server HTTPS guidance', async (delivery) => {
  const fetch = vi.fn(async () => Response.json(guidance, { status: 400 }))
  const client = createAuthClient({ credentials: { ...cookieCredentials, delivery }, fetch })
  expect(await client.probeAuth('http://192.0.2.8:18787')).toMatchObject({
    kind: 'ready',
    auth: {
      kind: 'failure',
      message: guidance.message,
      failure: { kind: 'auth-insecure', guidance },
    },
  })
})

test('browser password refusal shows the server message', async () => {
  const client = createAuthClient({
    credentials: cookieCredentials,
    fetch: async () => Response.json(guidance, { status: 400 }),
  })
  expect(await client.login('http://192.0.2.8:18787', 'password')).toEqual({
    ok: false,
    error: guidance.message,
  })
})

test('native manual connection reports a server refusal with its HTTPS address', async () => {
  const fetch = vi.fn(async (url: string) =>
    url.endsWith('/version')
      ? Response.json({ instanceId: 'instance', wireVersion: 1_000_000, minSupportedVersion: 0 })
      : Response.json(guidance, { status: 400 }),
  )
  vi.stubGlobal('fetch', fetch)
  try {
    expect(
      await preflightServer('http://192.0.2.8:18787', undefined, { native: true }),
    ).toMatchObject({
      ok: false,
      kind: 'cleartext-blocked',
      detail: expect.stringContaining('HTTPS for sign-in from other computers'),
    })
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/auth/status'))).toBe(true)
  } finally {
    vi.unstubAllGlobals()
  }
})

test.each([
  'localhost',
  '127.0.0.1',
])('does not show guidance for an admitted HTTP %s client', async (host) => {
  const client = createAuthClient({
    credentials: cookieCredentials,
    fetch: async () =>
      Response.json({
        needsAuth: false,
        authed: true,
        userId: 'alice',
        memberId: 'alice',
        syncBoundaryId: 'instance',
      }),
  })
  expect(await client.probeAuth(`http://${host}:18787`)).toMatchObject({
    kind: 'ready',
    auth: { kind: 'principal' },
  })
})
