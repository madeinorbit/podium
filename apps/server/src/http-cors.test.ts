import { Hono } from 'hono'
import { describe, expect, test } from 'vitest'
import { httpOriginVerdict, isAllowedHttpOrigin, podiumCors } from './http-cors'

describe('isAllowedHttpOrigin', () => {
  test('the desktop shell origin is allowed against any backend host', () => {
    expect(isAllowedHttpOrigin('tauri://localhost', '127.0.0.1:60961')).toBe(true)
    expect(isAllowedHttpOrigin('tauri://localhost', 'box.tailnet.ts.net')).toBe(true)
  })

  test('a loopback page is allowed (the vite dev server on its own port)', () => {
    expect(isAllowedHttpOrigin('http://localhost:55556', '127.0.0.1:18787')).toBe(true)
    expect(isAllowedHttpOrigin('http://127.0.0.1:18787', '127.0.0.1:18787')).toBe(true)
  })

  test('the same site is allowed across scheme and port (TLS-terminating proxy)', () => {
    expect(isAllowedHttpOrigin('https://box.tailnet.ts.net', 'box.tailnet.ts.net:18787')).toBe(true)
  })

  test('a foreign site is refused even when the backend listens on loopback', () => {
    // Deliberately unlike isAllowedWsOrigin, which allows any origin once the
    // REQUEST host is loopback: that would hand a hostile page the operator's
    // cookie against a Podium on 127.0.0.1.
    expect(isAllowedHttpOrigin('https://evil.example', '127.0.0.1:18787')).toBe(false)
    expect(isAllowedHttpOrigin('https://evil.example', 'box.tailnet.ts.net')).toBe(false)
  })

  test('an absent or unparseable Origin gets no allowance', () => {
    expect(isAllowedHttpOrigin(undefined, '127.0.0.1:18787')).toBe(false)
    expect(isAllowedHttpOrigin('', '127.0.0.1:18787')).toBe(false)
    expect(isAllowedHttpOrigin('not a url', '127.0.0.1:18787')).toBe(false)
  })
})

describe('podiumCors', () => {
  const app = new Hono()
  app.use('/trpc/*', podiumCors())
  app.post('/trpc/setup.complete', (c) => c.json({ ok: true }))

  const call = (method: string, headers: Record<string, string>) =>
    app.request('http://127.0.0.1:60961/trpc/setup.complete?batch=1', {
      method,
      headers: { host: '127.0.0.1:60961', ...headers },
      ...(method === 'POST' ? { body: '{}' } : {}),
    })

  test('a credentialed desktop call gets a reflected origin, never the wildcard', async () => {
    // The regression this exists for: `Access-Control-Allow-Origin: *` fails the
    // CORS check for a `credentials: 'include'` fetch, which is every tRPC call
    // the web client makes — WKWebView surfaces that as "Load failed".
    const res = await call('POST', { origin: 'tauri://localhost', 'content-type': 'text/plain' })
    expect(res.headers.get('access-control-allow-origin')).toBe('tauri://localhost')
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
  })

  test('the preflight for that call is answered', async () => {
    const res = await call('OPTIONS', {
      origin: 'tauri://localhost',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('tauri://localhost')
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
    expect(res.headers.get('access-control-allow-headers')).toContain('content-type')
  })

  test('a foreign origin gets no allowance at all', async () => {
    const res = await call('POST', { origin: 'https://evil.example', 'content-type': 'text/plain' })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('the response varies on Origin so a cache cannot cross-serve it', async () => {
    const res = await call('POST', { origin: 'tauri://localhost', 'content-type': 'text/plain' })
    expect(res.headers.get('vary')).toContain('Origin')
  })
})

describe('isAllowedHttpOrigin with an allowed-origins list', () => {
  const allowed = new Set(['https://app.meetpodium.com'])

  test('an exact allowed origin is accepted against a foreign backend host', () => {
    expect(isAllowedHttpOrigin('https://app.meetpodium.com', 'api.meetpodium.com', allowed)).toBe(
      true,
    )
  })

  test('scheme, host and port must all match', () => {
    expect(isAllowedHttpOrigin('http://app.meetpodium.com', 'api.meetpodium.com', allowed)).toBe(
      false,
    )
    expect(
      isAllowedHttpOrigin('https://app.meetpodium.com:8443', 'api.meetpodium.com', allowed),
    ).toBe(false)
    expect(isAllowedHttpOrigin('https://evil.meetpodium.com', 'api.meetpodium.com', allowed)).toBe(
      false,
    )
  })

  test('the list is an additional accept path, never a replacement', () => {
    expect(isAllowedHttpOrigin('tauri://localhost', 'api.meetpodium.com', allowed)).toBe(true)
    expect(isAllowedHttpOrigin(undefined, 'api.meetpodium.com', allowed)).toBe(false)
    expect(isAllowedHttpOrigin('https://evil.example', '127.0.0.1:18787', allowed)).toBe(false)
  })

  test('an omitted list behaves exactly as before', () => {
    expect(isAllowedHttpOrigin('https://app.meetpodium.com', 'api.meetpodium.com')).toBe(false)
  })
})

describe('httpOriginVerdict names why it refused', () => {
  test('each refusal has its own reason', () => {
    expect(httpOriginVerdict(undefined, 'api.meetpodium.com')).toBe('no-origin')
    expect(httpOriginVerdict('not a url', 'api.meetpodium.com')).toBe('parse')
    expect(httpOriginVerdict('https://evil.example', 'api.meetpodium.com')).toBe('not-allowed')
    expect(
      httpOriginVerdict(
        'https://app.meetpodium.com',
        'api.meetpodium.com',
        new Set(['https://app.meetpodium.com']),
      ),
    ).toBe('allowed')
  })
})

describe('podiumCors with an allowed origin', () => {
  const refusals: string[] = []
  const app = new Hono()
  app.use(
    '/trpc/*',
    podiumCors({
      allowed: new Set(['https://app.meetpodium.com']),
      onRefused: (info) => refusals.push(`${info.reason}:${info.origin}`),
    }),
  )
  app.post('/trpc/issues.list', (c) => c.json({ ok: true }))

  const call = (origin: string) =>
    app.request('http://api.meetpodium.com/trpc/issues.list', {
      method: 'POST',
      headers: {
        host: 'api.meetpodium.com',
        origin,
        'content-type': 'application/json',
      },
      body: '{}',
    })

  test('the app host gets a reflected origin and credentials', async () => {
    const res = await call('https://app.meetpodium.com')
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.meetpodium.com')
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
  })

  test('an unknown origin is refused, and the refusal is reported with its reason', async () => {
    const res = await call('https://evil.example')
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(refusals).toEqual(['not-allowed:https://evil.example'])
  })

  test('a caller with no Origin is not a misconfiguration and is not reported', async () => {
    refusals.length = 0
    const res = await app.request('http://api.meetpodium.com/trpc/issues.list', {
      method: 'POST',
      headers: { host: 'api.meetpodium.com', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(refusals).toEqual([])
  })
})
