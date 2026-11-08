import { addSink, type LogRecord, resetLogging, setLogLevel } from '@podium/logger'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  makeTrpc,
  reportingFetch,
  SERVER_UNAVAILABLE_MESSAGE,
  ServerUnavailableError,
  trpcProcedurePath,
} from './trpc'

/**
 * THE FAILURE SEAM every tRPC call in the web client passes through (POD-1935).
 *
 * The bug this covers was not a broken transport: it was a client with nothing
 * to say. Hundreds of `issues.markRead` 500s and a run of 502s across a restart
 * reached the browser console and the logger never heard about any of them, so
 * the forwarding sink had an empty queue and the operator's per-origin log file
 * was never even created.
 */

let logged: LogRecord[]

beforeEach(() => {
  resetLogging()
  logged = []
  addSink({ name: 'capture', write: (record) => logged.push(record) })
  setLogLevel('warn')
})

afterEach(() => {
  resetLogging()
})

describe('trpcProcedurePath', () => {
  it('names the procedures a batched call carried', () => {
    expect(trpcProcedurePath('https://relay.test/trpc/issues.markRead?batch=1')).toBe(
      'issues.markRead',
    )
    expect(trpcProcedurePath('https://relay.test/trpc/updates.fleet,quota.summary?batch=1')).toBe(
      'updates.fleet,quota.summary',
    )
  })

  it('degrades to the raw path rather than throwing on anything unexpected', () => {
    expect(trpcProcedurePath('not a url')).toBe('not a url')
  })
})

describe('reportingFetch', () => {
  it('omits an undefined harness clear from the real settings HTTP request', async () => {
    const base = vi
      .fn()
      .mockResolvedValue(new Response('[{"result":{"data":{}}}]', { status: 200 }))
    const trpc = makeTrpc('https://relay.test', { fetch: base as typeof fetch })
    await trpc.settings.updateInstance.mutate({
      values: { 'roles.superagent.harness': undefined, 'roles.superagent.model': 'saved-model' },
    })

    expect(base).toHaveBeenCalledTimes(1)
    expect(base.mock.calls[0]?.[0]).toContain('/trpc/settings.updateInstance')
    const received = JSON.parse(base.mock.calls[0]?.[1]?.body as string)
    expect(received['0'].values).toEqual({ 'roles.superagent.model': 'saved-model' })
    expect(received['0'].values).not.toHaveProperty('roles.superagent.harness')
  })

  it('logs a warn naming the procedure and status when the server refuses', async () => {
    const base = vi.fn().mockResolvedValue(new Response('{"error":{}}', { status: 500 }))
    const response = await reportingFetch(base)('https://relay.test/trpc/issues.markRead?batch=1', {
      method: 'POST',
    })

    expect(response.status).toBe(500)
    expect(logged).toHaveLength(1)
    expect(logged[0]?.level).toBe('warn')
    expect(logged[0]?.ns).toBe('web:trpc')
    expect(logged[0]).toMatchObject({ path: 'issues.markRead', status: 500 })
  })

  it('logs a warn and returns a user-safe transport failure when a mutation cannot connect', async () => {
    const base = vi.fn().mockRejectedValue(new Error('Failed to fetch'))

    await expect(
      reportingFetch(base)('https://relay.test/trpc/updates.fleet?batch=1', { method: 'POST' }),
    ).rejects.toMatchObject({
      code: 'SERVER_UNAVAILABLE',
      message: SERVER_UNAVAILABLE_MESSAGE,
    })
    expect(logged).toHaveLength(1)
    expect(logged[0]?.level).toBe('warn')
    expect(logged[0]).toMatchObject({ path: 'updates.fleet' })
  })

  it('says nothing about a call that succeeded', async () => {
    const base = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    await reportingFetch(base)('https://relay.test/trpc/issues.list?batch=1', { method: 'POST' })
    expect(logged).toEqual([])
  })

  it('carries the login cookie', async () => {
    const base = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    await reportingFetch(base)('https://relay.test/trpc/issues.list?batch=1', { method: 'POST' })
    expect(base.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', credentials: 'include' })
  })

  it('stays silent for the logging transport, whose failures would feed themselves', async () => {
    const base = vi.fn().mockResolvedValue(new Response('{"error":{}}', { status: 500 }))
    await reportingFetch(base, { report: false })('https://relay.test/trpc/logs.forward?batch=1', {
      method: 'POST',
    })
    expect(logged).toEqual([])
  })

  it('never reports a logs.* failure even on a reporting client', async () => {
    // Belt and braces: the log transport builds its own client with reporting
    // off, and a caller that forgets still cannot start the loop.
    const base = vi.fn().mockResolvedValue(new Response('{"error":{}}', { status: 500 }))
    await reportingFetch(base)('https://relay.test/trpc/logs.crash?batch=1', { method: 'POST' })
    expect(logged).toEqual([])
  })

  it.each([
    ['empty', ''],
    ['truncated', '[{"result":{"data":'],
  ])('turns a 200 with an %s body into a transport failure', async (_kind, body) => {
    const base = vi.fn().mockResolvedValue(new Response(body, { status: 200 }))
    const trpc = makeTrpc('https://relay.test', {
      fetch: base as typeof fetch,
      recoveryDelaysMs: [0],
    })

    const error = await trpc.updates.checkNow.mutate().catch((cause: unknown) => cause)

    expect(base).toHaveBeenCalledTimes(1)
    expect(error).toMatchObject({ message: SERVER_UNAVAILABLE_MESSAGE })
    expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(ServerUnavailableError)
    expect((error as Error).message).not.toMatch(/JSON|Unexpected end/i)
  })

  it('lets the client body reader consume a successful response exactly once', async () => {
    const bodyReader = vi.fn(async () => '[{"result":{"data":{"total":0,"behind":0}}}]')
    const response = {
      ok: true,
      status: 200,
      json: async () => JSON.parse(await bodyReader()),
      clone: () => ({ text: bodyReader }),
    } as unknown as Response
    const base = vi.fn().mockResolvedValue(response)
    const trpc = makeTrpc('https://relay.test', { fetch: base as typeof fetch })

    await expect(trpc.updates.fleet.query()).resolves.toEqual({ total: 0, behind: 0 })
    expect(bodyReader).toHaveBeenCalledTimes(1)
  })

  it('waits for readiness, then replays an interrupted idempotent query once', async () => {
    const base = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(
        new Response('[{"result":{"data":{"recovered":true}}}]', { status: 200 }),
      )
    const trpc = makeTrpc('https://relay.test', {
      fetch: base as typeof fetch,
      recoveryDelaysMs: [0, 0],
    })

    await expect(trpc.updates.fleet.query()).resolves.toEqual({ recovered: true })
    expect(base).toHaveBeenCalledTimes(4)
    expect(base.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'GET', 'GET', 'GET'])
    expect(base.mock.calls[1]?.[0]).toBe('https://relay.test/readiness')
    expect(base.mock.calls[3]?.[0]).toContain('/trpc/updates.fleet')
  })

  /**
   * WebKit (Safari, the macOS desktop webview, iOS) rejects `Response.json()` on
   * a non-JSON body with a DOMException named `SyntaxError` — NOT an instance of
   * the global `SyntaxError` — whose message is "The string did not match the
   * expected pattern." That reached the operator verbatim whenever the server was
   * down behind a proxy (an HTML 502) or shutting down (a plain-text 503).
   */
  function webkitBody(body: string, init: ResponseInit): Response {
    const response = new Response(body, init)
    Object.defineProperty(response, 'json', {
      value: async () => {
        throw new DOMException('The string did not match the expected pattern.', 'SyntaxError')
      },
    })
    return response
  }

  it('turns a WebKit body-parse failure on a proxy 502 into the server-unavailable message', async () => {
    const base = vi
      .fn()
      .mockResolvedValue(webkitBody('<html>502 Bad Gateway</html>', { status: 502 }))
    const trpc = makeTrpc('https://relay.test', {
      fetch: base as typeof fetch,
      recoveryDelaysMs: [0],
    })

    const error = await trpc.updates.checkNow.mutate().catch((cause: unknown) => cause)

    expect(base).toHaveBeenCalledTimes(1)
    expect((error as Error).message).toBe(SERVER_UNAVAILABLE_MESSAGE)
    expect((error as Error).message).not.toMatch(/expected pattern/i)
  })

  it('waits for readiness after a WebKit body-parse failure on a plain-text 503, then replays a query', async () => {
    const base = vi
      .fn()
      .mockResolvedValueOnce(webkitBody('Server is shutting down', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(
        new Response('[{"result":{"data":{"recovered":true}}}]', { status: 200 }),
      )
    const trpc = makeTrpc('https://relay.test', {
      fetch: base as typeof fetch,
      recoveryDelaysMs: [0],
    })

    await expect(trpc.updates.fleet.query()).resolves.toEqual({ recovered: true })
    expect(base.mock.calls[1]?.[0]).toBe('https://relay.test/readiness')
  })

  it('does not replay a mutation whose response was cut off', async () => {
    const base = vi.fn().mockResolvedValue(new Response('', { status: 200 }))
    const trpc = makeTrpc('https://relay.test', {
      fetch: base as typeof fetch,
      recoveryDelaysMs: [0],
    })

    const error = await trpc.updates.checkNow.mutate().catch((cause: unknown) => cause)

    expect(base).toHaveBeenCalledTimes(1)
    expect((error as Error).message).toBe(SERVER_UNAVAILABLE_MESSAGE)
    expect((error as Error).message).not.toMatch(/JSON|TRPCClientError/i)
  })
})

describe('the member fence (POD-6292, MU-12)', () => {
  it('stamps every call of a member’s client with that member', async () => {
    const base = vi
      .fn()
      .mockResolvedValue(new Response('[{"result":{"data":{}}}]', { status: 200 }))
    const trpc = makeTrpc('https://relay.test', {
      fetch: base as typeof fetch,
      member: 'mem_alice',
    })
    await trpc.settings.updateInstance.mutate({ values: { 'sidebar.repoSort': 'custom' } })
    const init = base.mock.calls[0]?.[1] as RequestInit
    expect(new Headers(init.headers).get('x-podium-member')).toBe('mem_alice')
  })

  it('leaves a pre-authentication client unfenced', async () => {
    const base = vi
      .fn()
      .mockResolvedValue(new Response('[{"result":{"data":{}}}]', { status: 200 }))
    const trpc = makeTrpc('https://relay.test', { fetch: base as typeof fetch })
    await trpc.settings.updateInstance.mutate({ values: { 'sidebar.repoSort': 'custom' } })
    const init = base.mock.calls[0]?.[1] as RequestInit
    expect(new Headers(init.headers).has('x-podium-member')).toBe(false)
  })
})

describe('the fence’s refusal ends the member’s runtime (POD-6292, MU-12)', () => {
  const refusal = (body: unknown) =>
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 401 }))

  it('tells the runtime when the server refuses a call as someone else’s', async () => {
    const onMemberRefused = vi.fn()
    const trpc = makeTrpc('https://relay.test', {
      fetch: refusal({ error: 'signed in as a different member', code: 'member-mismatch' }),
      member: 'mem_alice',
      onMemberRefused,
      recoveryDelaysMs: [],
    })
    await trpc.settings.updateInstance.mutate({ values: {} }).catch(() => {})
    await vi.waitFor(() => expect(onMemberRefused).toHaveBeenCalledTimes(1))
  })

  it('leaves an ordinary expired session to the existing path', async () => {
    const onMemberRefused = vi.fn()
    const trpc = makeTrpc('https://relay.test', {
      fetch: refusal({ error: 'unauthorized' }),
      member: 'mem_alice',
      onMemberRefused,
      recoveryDelaysMs: [],
    })
    await trpc.settings.updateInstance.mutate({ values: {} }).catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(onMemberRefused).not.toHaveBeenCalled()
  })
})
