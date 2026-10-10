import { createPrivateKey, sign } from 'node:crypto'
import vectors from '@podium/protocol/server-locate-vectors'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchAdvertisedIdentity,
  type LocateMiss,
  locateDelayMs,
  locateServer,
  proveServer,
  type ServerIdentity,
  type ServerMove,
  ServerFollower,
  type FollowEvent,
} from './server-follow'

const SERVER: ServerIdentity = {
  installationId: vectors.server.installationId,
  installationPublicKey: vectors.server.installationPublicKey,
}
const serverKey = createPrivateKey({
  key: Buffer.from(vectors.server.privateKeyPkcs8, 'base64'),
  format: 'der',
  type: 'pkcs8',
})
const OTHER_ID = vectors.other.installationId

const bytes = (b64url: string) => new Uint8Array(Buffer.from(b64url, 'base64url'))

type Route = (url: string, init: RequestInit | undefined) => Response | Promise<Response>

function stubFetch(route: Route) {
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
    return route(String(input), init)
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, calls }
}

const recordBody = (endpoints: Array<{ url: string; priority: number }>) => ({
  generation: 3,
  issuedAt: '2026-10-10T00:00:00.000Z',
  expiresAt: null,
  endpoints,
})

/** A real server: signs whatever nonce it is sent, over `publicUrl`, with the vectors key. */
function proofAnswer(init: RequestInit | undefined, over: { publicUrl: string; installationId?: string }) {
  const { nonce } = JSON.parse(String(init?.body)) as { nonce: string }
  const message = Buffer.concat([
    Buffer.from('podium-locate-v1\n'),
    Buffer.from(nonce, 'base64url'),
    Buffer.from(over.publicUrl),
  ])
  return Response.json({
    installationId: over.installationId ?? SERVER.installationId,
    publicUrl: over.publicUrl,
    signature: sign(null, message, serverKey).toString('base64url'),
  })
}

describe('proveServer against the shared vectors (POD-5921)', () => {
  for (const vector of vectors.cases) {
    it(`${vector.name} → ${vector.verdict}`, async () => {
      const { fetch } = stubFetch(() => Response.json(vector.response))
      const result = await proveServer({
        origin: vector.candidate,
        identity: vector.stored,
        fetch,
        nonce: bytes(vector.nonce),
      })
      if (vector.verdict === 'ok') expect(result).toEqual({ ok: true })
      else {
        expect(result.ok).toBe(false)
        const reason = (result as { reason: string }).reason
        if (vector.verdict === 'wrong-id') expect(reason).toMatch(/different installation/)
        if (vector.verdict === 'origin-mismatch') expect(reason).toMatch(/different address/)
        if (vector.verdict === 'bad-signature') expect(reason).toMatch(/does not verify/)
      }
    })
  }

  it('POSTs a fresh 32-byte nonce as text/plain to the locate path, every time', async () => {
    const sent: string[] = []
    const { fetch, calls } = stubFetch((_url, init) => {
      expect(new Headers(init?.headers).get('content-type')).toBe('text/plain')
      sent.push(JSON.parse(String(init?.body)).nonce)
      return proofAnswer(init, { publicUrl: 'https://a.example' })
    })
    expect(await proveServer({ origin: 'https://a.example', identity: SERVER, fetch })).toEqual({ ok: true })
    expect(await proveServer({ origin: 'wss://a.example', identity: SERVER, fetch })).toEqual({ ok: true })
    expect(calls).toEqual([
      'POST https://a.example/.well-known/podium/locate',
      'POST https://a.example/.well-known/podium/locate',
    ])
    expect(sent[0]).not.toBe(sent[1])
    expect(bytes(sent[0]!).length).toBe(32)
  })

  it('a 404 carries its status, so the daemon transition can tell an old server apart', async () => {
    const { fetch } = stubFetch(() => new Response('nope', { status: 404 }))
    expect(await proveServer({ origin: 'https://a.example', identity: SERVER, fetch })).toEqual({
      ok: false,
      reason: 'answers no locate proof (HTTP 404)',
      status: 404,
    })
  })

  it('times out a slow candidate and never throws', async () => {
    const { fetch } = stubFetch(() => new Promise<Response>(() => {}))
    expect(await proveServer({ origin: 'https://a.example', identity: SERVER, fetch, timeoutMs: 20 })).toEqual({
      ok: false,
      reason: 'timed out after 20 ms',
    })
    const throwing = stubFetch(() => {
      throw Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' })
    })
    const result = await proveServer({ origin: 'https://a.example', identity: SERVER, fetch: throwing.fetch })
    expect(result).toEqual({ ok: false, reason: 'name does not resolve (ENOTFOUND)' })
  })

  it('refuses a malformed answer', async () => {
    const { fetch } = stubFetch(() => Response.json({ installationId: SERVER.installationId }))
    expect(await proveServer({ origin: 'https://a.example', identity: SERVER, fetch })).toEqual({
      ok: false,
      reason: 'malformed locate proof',
    })
  })
})

describe('locateServer: every failure row of the spec (§9)', () => {
  const connect = 'https://connect.test'

  function world(opts: {
    record?: Array<{ url: string; priority: number }> | 'down' | 'unknown'
    servers?: Record<string, Route>
    versions?: Record<string, object>
  }) {
    return stubFetch((url, init) => {
      if (url.startsWith(`${connect}/v1/installations/`)) {
        if (opts.record === 'down') throw new Error('ECONNREFUSED')
        if (opts.record === 'unknown' || !opts.record) return new Response('{}', { status: 404 })
        return Response.json(recordBody(opts.record))
      }
      const origin = new URL(url).origin
      if (url.endsWith('/version') && opts.versions?.[origin]) return Response.json(opts.versions[origin])
      const server = opts.servers?.[origin]
      if (!server) throw new TypeError('fetch failed')
      return server(url, init)
    })
  }

  const honest = (publicUrl: string): Route => (_url, init) => proofAnswer(init, { publicUrl })

  async function run(w: ReturnType<typeof world>, over: { identity?: ServerIdentity | undefined; legacy?: boolean } = {}) {
    const misses: LocateMiss[] = []
    const found = await locateServer({
      identity: 'identity' in over ? over.identity : SERVER,
      currentOrigin: 'wss://old.example',
      connectBaseUrl: connect,
      fetch: w.fetch,
      timeoutMs: 50,
      report: (miss) => misses.push(miss),
      ...(over.legacy ? { legacyVersionCheck: true } : {}),
    })
    return { found, misses }
  }

  it('adopts a candidate that proves it holds the stored key', async () => {
    const w = world({
      record: [{ url: 'https://new.example', priority: 100 }],
      servers: { 'https://new.example': honest('https://new.example') },
    })
    expect(await run(w)).toEqual({ found: 'https://new.example', misses: [] })
  })

  it('no identity stored: phones nobody', async () => {
    const w = world({ record: [{ url: 'https://new.example', priority: 100 }] })
    expect(await run(w, { identity: undefined })).toEqual({ found: undefined, misses: [{ kind: 'no-identity' }] })
    expect(w.calls).toEqual([])
  })

  it('Connect down or the id unknown: no record', async () => {
    expect((await run(world({ record: 'down' }))).misses).toEqual([{ kind: 'no-record' }])
    expect((await run(world({ record: 'unknown' }))).misses).toEqual([{ kind: 'no-record' }])
  })

  it('the record names only the current origin: no new address, and it is not probed', async () => {
    const w = world({ record: [{ url: 'https://old.example', priority: 100 }] })
    expect(await run(w)).toEqual({ found: undefined, misses: [{ kind: 'no-new-address' }] })
    expect(w.calls.filter((c) => c.startsWith('POST'))).toEqual([])
  })

  it('refuses each bad candidate with its reason and takes the next that proves itself', async () => {
    const w = world({
      record: [
        { url: 'https://unreachable.example', priority: 100 },
        { url: 'https://slow.example', priority: 90 },
        { url: 'https://old-server.example', priority: 80 },
        { url: 'https://relay.example', priority: 70 },
      ],
      servers: {
        'https://slow.example': () => new Promise<Response>(() => {}),
        'https://old-server.example': () => new Response('', { status: 404 }),
        // A relay forwarding to the real server gets a signature over the REAL address.
        'https://relay.example': honest('https://real.example'),
      },
    })
    const { found, misses } = await run(w)
    expect(found).toBeUndefined()
    expect(misses).toEqual([
      { kind: 'rejected', url: 'https://unreachable.example', reason: 'fetch failed' },
      { kind: 'rejected', url: 'https://slow.example', reason: 'timed out after 50 ms' },
      { kind: 'rejected', url: 'https://old-server.example', reason: 'answers no locate proof (HTTP 404)' },
      {
        kind: 'rejected',
        url: 'https://relay.example',
        reason: 'signs for a different address (https://real.example)',
      },
    ])
  })

  it('refuses a different installation and a forged signature, then finds the real one', async () => {
    const w = world({
      record: [
        { url: 'https://impostor.example', priority: 100 },
        { url: 'https://forger.example', priority: 90 },
        { url: 'https://new.example', priority: 80 },
      ],
      servers: {
        'https://impostor.example': (_u, init) =>
          proofAnswer(init, { publicUrl: 'https://impostor.example', installationId: OTHER_ID }),
        'https://forger.example': () =>
          Response.json({
            installationId: SERVER.installationId,
            publicUrl: 'https://forger.example',
            signature: vectors.cases[0]!.response.signature,
          }),
        'https://new.example': honest('https://new.example'),
      },
    })
    const { found, misses } = await run(w)
    expect(found).toBe('https://new.example')
    expect(misses.map((m) => (m.kind === 'rejected' ? m.reason : m.kind))).toEqual([
      `serves a different installation (${OTHER_ID})`,
      'signature does not verify under the stored installation key',
    ])
  })

  it('the daemon transition: a 404 proof falls back to /version only when asked to', async () => {
    const versions = {
      'https://new.example': { installationId: SERVER.installationId, installationPublicKey: SERVER.installationPublicKey },
    }
    const servers = { 'https://new.example': () => new Response('', { status: 404 }) }
    const record = [{ url: 'https://new.example', priority: 100 }]
    expect((await run(world({ record, servers, versions }))).found).toBeUndefined()
    expect((await run(world({ record, servers, versions }), { legacy: true })).found).toBe('https://new.example')
    // Never for a candidate that answered the proof and failed it.
    const forged = { 'https://new.example': honest('https://elsewhere.example') }
    expect((await run(world({ record, servers: forged, versions }), { legacy: true })).found).toBeUndefined()
    // And /version must still name this installation.
    const wrong = { 'https://new.example': { installationId: OTHER_ID } }
    const { found, misses } = await run(world({ record, servers, versions: wrong }), { legacy: true })
    expect(found).toBeUndefined()
    expect(misses).toEqual([
      { kind: 'rejected', url: 'https://new.example', reason: `serves a different installation (${OTHER_ID})` },
    ])
  })
})

describe('fetchAdvertisedIdentity', () => {
  it('reads both halves from /version, converting ws(s), and refuses half an identity', async () => {
    const full = stubFetch(() => Response.json({ ...SERVER, appVersion: 'dev' }))
    expect(await fetchAdvertisedIdentity({ serverUrl: 'wss://a.example', fetch: full.fetch })).toEqual(SERVER)
    expect(full.calls).toEqual(['GET https://a.example/version'])
    const half = stubFetch(() => Response.json({ installationId: SERVER.installationId }))
    expect(await fetchAdvertisedIdentity({ serverUrl: 'https://a.example', fetch: half.fetch })).toBeUndefined()
  })
})

describe('locateDelayMs: the re-ask schedule (POD-3274)', () => {
  const exact = () => 0.5

  it('asks after 2, 4 and 8 s, then every 15 s for the first ten minutes of an outage', () => {
    expect([1, 2, 3].map((n) => locateDelayMs(n, 0, exact))).toEqual([2_000, 4_000, 8_000])
    expect(locateDelayMs(4, 20_000, exact)).toBe(15_000)
    expect(locateDelayMs(30, 599_999, exact)).toBe(15_000)
  })

  it('slows to every five minutes once the outage has lasted ten', () => {
    expect(locateDelayMs(40, 600_000, exact)).toBe(300_000)
    expect(locateDelayMs(90, 3_600_000, exact)).toBe(300_000)
  })

  it('jitters each wait by ±50%, so a stranded fleet does not ask in lockstep', () => {
    expect(locateDelayMs(40, 600_000, () => 0)).toBe(150_000)
    expect(locateDelayMs(40, 600_000, () => 0.999_999)).toBe(450_000)
    expect(locateDelayMs(5, 60_000, () => 0)).toBe(7_500)
  })
})

describe('ServerFollower', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function follower(over: {
    locate?: (n: number) => Promise<string | undefined>
    adopt?: (move: ServerMove) => Promise<void>
    identity?: ServerIdentity | undefined
  } = {}) {
    vi.useFakeTimers()
    let asks = 0
    const adopted: ServerMove[] = []
    const events: FollowEvent[] = []
    let current = 'https://old.example'
    const f = new ServerFollower({
      identity: () => ('identity' in over ? over.identity : SERVER),
      currentOrigin: () => current,
      connectBaseUrl: () => 'https://connect.test',
      adopt: async (move) => {
        if (over.adopt) await over.adopt(move)
        adopted.push(move)
        current = move.origin
      },
      locate: async () => {
        asks += 1
        return over.locate ? over.locate(asks) : undefined
      },
      random: () => 0.5,
      log: (event) => events.push(event),
    })
    return { f, adopted, events, asks: () => asks }
  }

  it('asks at once, then on the schedule; disconnected() while looking is a no-op', async () => {
    const h = follower()
    h.f.disconnected()
    h.f.disconnected()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.asks()).toBe(1)
    h.f.disconnected()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(h.asks()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.asks()).toBe(2)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(h.asks()).toBe(3)
    await vi.advanceTimersByTimeAsync(8_000)
    expect(h.asks()).toBe(4)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.asks()).toBe(5)
    h.f.dispose()
  })

  it('connected() cancels the wait: a healthy connection never asks', async () => {
    const h = follower()
    h.f.disconnected()
    await vi.advanceTimersByTimeAsync(0)
    h.f.connected()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(h.asks()).toBe(1)
    expect(h.f.looking).toBe(false)
  })

  it('ignores a locate still in flight when connected() arrives', async () => {
    let answer: (value: string | undefined) => void = () => {}
    const h = follower({ locate: () => new Promise((resolve) => (answer = resolve)) })
    h.f.disconnected()
    await vi.advanceTimersByTimeAsync(0)
    h.f.connected()
    answer('https://new.example')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.adopted).toEqual([])
    expect(h.asks()).toBe(1)
  })

  it('adopts what it finds, then waits for connected() — and a new failure starts afresh', async () => {
    const h = follower({ locate: async (n) => (n === 1 ? 'https://new.example' : undefined) })
    h.f.disconnected()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.adopted).toEqual([{ via: 'connect', origin: 'https://new.example' }])
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(h.asks()).toBe(1)
    h.f.disconnected()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.asks()).toBe(2)
    h.f.dispose()
  })

  it('an adopt that throws is logged and the schedule continues', async () => {
    let fail = true
    const h = follower({
      locate: async () => 'https://new.example',
      adopt: async () => {
        if (fail) throw new Error('profile clash')
      },
    })
    h.f.disconnected()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.adopted).toEqual([])
    expect(h.events.some((e) => e.kind === 'adopt-failed')).toBe(true)
    fail = false
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.asks()).toBe(2)
    expect(h.adopted).toEqual([{ via: 'connect', origin: 'https://new.example' }])
  })

  it('never adopts the current origin', async () => {
    const h = follower({ locate: async () => 'wss://old.example' })
    h.f.disconnected()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.adopted).toEqual([])
    h.f.dispose()
  })

  it('pushed() adopts a transfer at once, without locating', async () => {
    const h = follower()
    h.f.pushed({ via: 'transfer', origin: 'https://target.example', transferId: 't1', claimToken: 'c' })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.asks()).toBe(0)
    expect(h.adopted).toEqual([
      { via: 'transfer', origin: 'https://target.example', transferId: 't1', claimToken: 'c' },
    ])
  })

  it('logs why each ask missed', async () => {
    vi.useFakeTimers()
    const events: FollowEvent[] = []
    const f = new ServerFollower({
      identity: () => undefined,
      currentOrigin: () => 'https://old.example',
      connectBaseUrl: () => 'https://connect.test',
      adopt: async () => {},
      log: (event) => events.push(event),
      random: () => 0.5,
    })
    f.disconnected()
    await vi.advanceTimersByTimeAsync(0)
    expect(events).toContainEqual({ kind: 'miss', miss: { kind: 'no-identity' } })
    f.dispose()
  })
})
