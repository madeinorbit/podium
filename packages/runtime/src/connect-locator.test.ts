import { describe, expect, it } from 'vitest'
import {
  CONNECT_LOCATOR_MAX_BODY_BYTES,
  fetchVersionIdentity,
  resolveLocatorRecord,
  resolveServerUrl,
} from './connect-locator'

const INSTALLATION_ID = `pdm_${'a'.repeat(43)}`
const INSTALLATION_KEY = `ed25519:${'B'.repeat(43)}`
const OTHER_ID = `pdm_${'z'.repeat(43)}`
const OTHER_KEY = `ed25519:${'C'.repeat(43)}`

const recordBody = (endpoints: Array<{ url: string; priority: number }>) =>
  JSON.stringify({ generation: 3, issuedAt: '2026-09-22T00:00:00.000Z', expiresAt: null, endpoints })

const versionBody = (installationId: string, installationPublicKey?: string) =>
  JSON.stringify({
    wireVersion: 1,
    appVersion: 'dev',
    instanceId: 'default',
    installationId,
    ...(installationPublicKey ? { installationPublicKey } : {}),
  })

type Route = (url: string) => Response | Promise<Response>

function stubFetch(route: Route) {
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input))
    return route(String(input))
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, calls }
}

describe('resolveLocatorRecord', () => {
  it('reads the record unsigned: no installation headers on the wire', async () => {
    const { fetch, calls } = stubFetch(() => Response.json(JSON.parse(recordBody([]))))
    // An empty endpoint list is "no answer", but the request shape is what matters here.
    await resolveLocatorRecord({ baseUrl: 'https://connect.test/', installationId: INSTALLATION_ID, fetch })
    expect(calls).toEqual([`https://connect.test/v1/installations/${INSTALLATION_ID}`])
  })

  it('returns endpoints ordered by priority, highest first', async () => {
    const { fetch } = stubFetch(() =>
      Response.json(
        JSON.parse(
          recordBody([
            { url: 'https://low.example', priority: 1 },
            { url: 'https://high.example', priority: 100 },
            { url: 'https://mid.example', priority: 50 },
          ]),
        ),
      ),
    )
    const record = await resolveLocatorRecord({
      baseUrl: 'https://connect.test',
      installationId: INSTALLATION_ID,
      fetch,
    })
    expect(record?.endpoints.map((endpoint) => endpoint.url)).toEqual([
      'https://high.example',
      'https://mid.example',
      'https://low.example',
    ])
  })

  it('caps endpoints at four and drops non-https URLs', async () => {
    const { fetch } = stubFetch(() =>
      Response.json(
        JSON.parse(
          recordBody([
            { url: 'http://plain.example', priority: 999 },
            { url: 'ws://socket.example', priority: 998 },
            { url: 'https://a.example', priority: 5 },
            { url: 'https://b.example', priority: 4 },
            { url: 'https://c.example', priority: 3 },
            { url: 'https://d.example', priority: 2 },
            { url: 'https://e.example', priority: 1 },
          ]),
        ),
      ),
    )
    const record = await resolveLocatorRecord({
      baseUrl: 'https://connect.test',
      installationId: INSTALLATION_ID,
      fetch,
    })
    expect(record?.endpoints.map((endpoint) => endpoint.url)).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example',
      'https://d.example',
    ])
  })

  it('never throws: unknown id, bad JSON, oversized body and network failure are no answer', async () => {
    const notFound = stubFetch(() => new Response('nope', { status: 404 }))
    await expect(
      resolveLocatorRecord({ baseUrl: 'https://connect.test', installationId: INSTALLATION_ID, fetch: notFound.fetch }),
    ).resolves.toBeUndefined()

    const garbage = stubFetch(() => new Response('{{not json', { status: 200 }))
    await expect(
      resolveLocatorRecord({ baseUrl: 'https://connect.test', installationId: INSTALLATION_ID, fetch: garbage.fetch }),
    ).resolves.toBeUndefined()

    const huge = stubFetch(
      () => new Response('x'.repeat(CONNECT_LOCATOR_MAX_BODY_BYTES + 1), { status: 200 }),
    )
    await expect(
      resolveLocatorRecord({ baseUrl: 'https://connect.test', installationId: INSTALLATION_ID, fetch: huge.fetch }),
    ).resolves.toBeUndefined()

    const down: typeof fetch = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(
      resolveLocatorRecord({ baseUrl: 'https://connect.test', installationId: INSTALLATION_ID, fetch: down }),
    ).resolves.toBeUndefined()

    const malformedId = stubFetch(() => {
      throw new Error('must never be called')
    })
    await expect(
      resolveLocatorRecord({ baseUrl: 'https://connect.test', installationId: 'not-an-id', fetch: malformedId.fetch }),
    ).resolves.toBeUndefined()
    expect(malformedId.calls).toEqual([])
  })

  it('refuses a record with no usable endpoints', async () => {
    const { fetch } = stubFetch(() => Response.json(JSON.parse(recordBody([{ url: 'http://plain.example', priority: 1 }]))))
    await expect(
      resolveLocatorRecord({ baseUrl: 'https://connect.test', installationId: INSTALLATION_ID, fetch }),
    ).resolves.toBeUndefined()
  })
})

describe('fetchVersionIdentity', () => {
  it('reads the candidate identity from /version, converting ws(s) to http(s)', async () => {
    const { fetch, calls } = stubFetch((url) => {
      expect(url).toBe('https://candidate.example/version')
      return new Response(versionBody(INSTALLATION_ID, INSTALLATION_KEY))
    })
    await expect(
      fetchVersionIdentity({ serverUrl: 'wss://candidate.example', fetch }),
    ).resolves.toEqual({ installationId: INSTALLATION_ID, installationPublicKey: INSTALLATION_KEY })
    expect(calls).toEqual(['https://candidate.example/version'])
  })

  it('answers undefined when the candidate names no installation', async () => {
    const { fetch } = stubFetch(() => new Response(JSON.stringify({ appVersion: 'dev' })))
    await expect(fetchVersionIdentity({ serverUrl: 'https://candidate.example', fetch })).resolves.toBeUndefined()
  })
})

describe('resolveServerUrl', () => {
  const locator = (endpoints: Array<{ url: string; priority: number }>) =>
    new Response(recordBody(endpoints))

  function harness(opts: {
    endpoints: Array<{ url: string; priority: number }>
    versions: Record<string, { installationId: string; installationPublicKey?: string } | undefined>
  }) {
    return stubFetch((url) => {
      if (url.startsWith('https://connect.test/v1/installations/')) return locator(opts.endpoints)
      const identity = opts.versions[url]
      if (!identity) return new Response('down', { status: 500 })
      return new Response(versionBody(identity.installationId, identity.installationPublicKey))
    })
  }

  it('returns the first candidate whose /version names this installation', async () => {
    const { fetch, calls } = harness({
      endpoints: [
        { url: 'https://new.example', priority: 100 },
        { url: 'https://fallback.example', priority: 1 },
      ],
      versions: {
        'https://new.example/version': { installationId: INSTALLATION_ID, installationPublicKey: INSTALLATION_KEY },
        'https://fallback.example/version': { installationId: INSTALLATION_ID, installationPublicKey: INSTALLATION_KEY },
      },
    })
    await expect(
      resolveServerUrl({
        installationId: INSTALLATION_ID,
        installationPublicKey: INSTALLATION_KEY,
        connectBaseUrl: 'https://connect.test',
        currentServerUrl: 'wss://old.example',
        fetch,
      }),
    ).resolves.toBe('https://new.example')
    expect(calls[0]).toBe(`https://connect.test/v1/installations/${INSTALLATION_ID}`)
  })

  it('refuses a candidate belonging to a different installation and tries the next', async () => {
    const { fetch } = harness({
      endpoints: [
        { url: 'https://impostor.example', priority: 100 },
        { url: 'https://real.example', priority: 1 },
      ],
      versions: {
        'https://impostor.example/version': { installationId: OTHER_ID, installationPublicKey: OTHER_KEY },
        'https://real.example/version': { installationId: INSTALLATION_ID, installationPublicKey: INSTALLATION_KEY },
      },
    })
    await expect(
      resolveServerUrl({
        installationId: INSTALLATION_ID,
        installationPublicKey: INSTALLATION_KEY,
        connectBaseUrl: 'https://connect.test',
        fetch,
      }),
    ).resolves.toBe('https://real.example')
  })

  it('refuses every candidate when all name a different installation', async () => {
    const { fetch } = harness({
      endpoints: [{ url: 'https://impostor.example', priority: 100 }],
      versions: {
        'https://impostor.example/version': { installationId: OTHER_ID, installationPublicKey: OTHER_KEY },
      },
    })
    await expect(
      resolveServerUrl({
        installationId: INSTALLATION_ID,
        installationPublicKey: INSTALLATION_KEY,
        connectBaseUrl: 'https://connect.test',
        fetch,
      }),
    ).resolves.toBeUndefined()
  })

  it('refuses a key mismatch when the candidate advertises a key', async () => {
    const { fetch } = harness({
      endpoints: [{ url: 'https://rotated.example', priority: 100 }],
      versions: {
        'https://rotated.example/version': { installationId: INSTALLATION_ID, installationPublicKey: OTHER_KEY },
      },
    })
    await expect(
      resolveServerUrl({
        installationId: INSTALLATION_ID,
        installationPublicKey: INSTALLATION_KEY,
        connectBaseUrl: 'https://connect.test',
        fetch,
      }),
    ).resolves.toBeUndefined()
  })

  it('accepts an id match from a server older than the key advertisement', async () => {
    const { fetch } = harness({
      endpoints: [{ url: 'https://legacy-server.example', priority: 100 }],
      versions: {
        'https://legacy-server.example/version': { installationId: INSTALLATION_ID },
      },
    })
    await expect(
      resolveServerUrl({
        installationId: INSTALLATION_ID,
        installationPublicKey: INSTALLATION_KEY,
        connectBaseUrl: 'https://connect.test',
        fetch,
      }),
    ).resolves.toBe('https://legacy-server.example')
  })

  it('never re-resolves to the URL that just failed', async () => {
    const { fetch, calls } = harness({
      endpoints: [{ url: 'https://old.example', priority: 100 }],
      versions: {
        'https://old.example/version': { installationId: INSTALLATION_ID, installationPublicKey: INSTALLATION_KEY },
      },
    })
    await expect(
      resolveServerUrl({
        installationId: INSTALLATION_ID,
        installationPublicKey: INSTALLATION_KEY,
        connectBaseUrl: 'https://connect.test',
        currentServerUrl: 'wss://old.example',
        fetch,
      }),
    ).resolves.toBeUndefined()
    // The locator was read, but the dead URL itself was never probed again.
    expect(calls).toEqual([`https://connect.test/v1/installations/${INSTALLATION_ID}`])
  })

  it('stays off without both stored halves, phoning nobody', async () => {
    const { fetch, calls } = harness({ endpoints: [], versions: {} })
    const base = {
      installationPublicKey: INSTALLATION_KEY,
      connectBaseUrl: 'https://connect.test',
      fetch,
    } as const
    await expect(resolveServerUrl({ ...base, installationId: '' })).resolves.toBeUndefined()
    await expect(
      resolveServerUrl({ installationId: INSTALLATION_ID, connectBaseUrl: 'https://connect.test', installationPublicKey: '', fetch }),
    ).resolves.toBeUndefined()
    expect(calls).toEqual([])
  })
})
