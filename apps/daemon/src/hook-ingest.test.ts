import { createBoundaryContext } from '@podium/harness/driver/host'
import { primeHookResponse } from './prime-injector'
import { createPrimeInjector } from './prime-injector'
import { composeResponders } from './mail-injector'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, type SessionId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { HOOK_BODY_MAX_BYTES, type HookIngest, startHookIngest } from './hook-ingest'

describe('hook ingest', () => {
  let ingest: HookIngest

  afterEach(async () => {
    await ingest.close()
  })

  it('accepts a POST and hands the payload to the callback, replying 200 {}', async () => {
    const got: { sessionId: SessionId; payload: unknown }[] = []
    ingest = await startHookIngest({
      port: 0,
      onPayload: (sessionId, payload) => got.push({ sessionId, payload }),
    })
    const res = await fetch(ingest.endpointFor(asSessionId('s1')), {
      method: 'POST',
      body: JSON.stringify({ hook_event_name: 'Stop' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
    await new Promise((r) => setTimeout(r, 10))
    expect(got).toEqual([{ sessionId: 's1', payload: { hook_event_name: 'Stop' } }])
  })

  it('endpointFor embeds the session id and the actual port', async () => {
    ingest = await startHookIngest({ port: 0, onPayload: () => {} })
    expect(ingest.endpointFor(asSessionId('abc-123'))).toBe(
      `http://127.0.0.1:${ingest.port}/hooks/abc-123`,
    )
  })

  it('rejects non-POST and unknown paths with 404, malformed JSON is acked but dropped', async () => {
    const got: unknown[] = []
    ingest = await startHookIngest({ port: 0, onPayload: (_sid, p) => got.push(p) })
    expect((await fetch(ingest.endpointFor(asSessionId('s1')), { method: 'GET' })).status).toBe(404)
    expect(
      (await fetch(`http://127.0.0.1:${ingest.port}/other`, { method: 'POST', body: '{}' })).status,
    ).toBe(404)
    expect(
      (await fetch(ingest.endpointFor(asSessionId('s1')), { method: 'POST', body: 'not json' }))
        .status,
    ).toBe(200)
    await new Promise((r) => setTimeout(r, 10))
    expect(got).toEqual([])
  })

  it('rejects an over-cap body with 413 and never invokes onPayload', async () => {
    const got: unknown[] = []
    ingest = await startHookIngest({ port: 0, onPayload: (_sid, p) => got.push(p) })
    // One byte over the cap. Valid JSON shape so the only thing that can reject
    // it is the size guard, not a parse failure.
    const filler = 'x'.repeat(HOOK_BODY_MAX_BYTES + 1 - '{"a":""}'.length)
    const body = `{"a":"${filler}"}`
    expect(Buffer.byteLength(body)).toBe(HOOK_BODY_MAX_BYTES + 1)
    const res = await fetch(ingest.endpointFor(asSessionId('s1')), { method: 'POST', body })
    expect(res.status).toBe(413)
    await new Promise((r) => setTimeout(r, 10))
    expect(got).toEqual([])
  })

  it('accepts a body exactly at the cap', async () => {
    const got: unknown[] = []
    ingest = await startHookIngest({ port: 0, onPayload: (_sid, p) => got.push(p) })
    const filler = 'x'.repeat(HOOK_BODY_MAX_BYTES - '{"a":""}'.length)
    const body = `{"a":"${filler}"}`
    expect(Buffer.byteLength(body)).toBe(HOOK_BODY_MAX_BYTES)
    const res = await fetch(ingest.endpointFor(asSessionId('s1')), { method: 'POST', body })
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 10))
    expect(got).toEqual([{ a: filler }])
  })

  it('waits for the durable receipt write before observing or acknowledging the hook', async () => {
    const order: string[] = []
    ingest = await startHookIngest({
      port: 0,
      beforeAck: async () => {
        order.push('write-started')
        await new Promise((resolve) => setTimeout(resolve, 20))
        order.push('write-durable')
      },
      onPayload: () => order.push('observed'),
    })

    const res = await fetch(ingest.endpointFor(asSessionId('s1')), {
      method: 'POST',
      body: JSON.stringify({ session_id: 'native-a' }),
    })
    order.push('http-ack')

    expect(res.status).toBe(200)
    expect(order).toEqual(['write-started', 'write-durable', 'observed', 'http-ack'])
  })

  it('returns 503 and does not observe a hook whose durable write failed', async () => {
    const got: unknown[] = []
    ingest = await startHookIngest({
      port: 0,
      beforeAck: async () => {
        throw new Error('disk unavailable')
      },
      onPayload: (_sessionId, payload) => got.push(payload),
    })

    const res = await fetch(ingest.endpointFor(asSessionId('s1')), {
      method: 'POST',
      body: JSON.stringify({ session_id: 'native-a' }),
    })
    expect(res.status).toBe(503)
    expect(got).toEqual([])
  })

  // POD-1229: refusing to start took the whole daemon host down with it — the
  // machine read offline and nothing named the port. Ingest that works on a
  // moved port, and says so, beats an ingest that works nowhere and does not.
  it('falls back to an ephemeral port when the stable one is taken, and reports the conflict', async () => {
    ingest = await startHookIngest({ port: 0, onPayload: () => {} })
    const got: unknown[] = []
    const second = await startHookIngest({ port: ingest.port, onPayload: (_s, p) => got.push(p) })
    try {
      expect(second.port).not.toBe(ingest.port)
      expect(second.portConflict).toEqual({
        preferredPort: ingest.port,
        boundPort: second.port,
        detail: expect.stringContaining(String(ingest.port)),
      })
      // Degraded means MOVED, not broken: the endpoint it hands out serves.
      const res = await fetch(second.endpointFor(asSessionId('s1')), {
        method: 'POST',
        body: JSON.stringify({ hook_event_name: 'Stop' }),
      })
      expect(res.status).toBe(200)
      await new Promise((r) => setTimeout(r, 10))
      expect(got).toEqual([{ hook_event_name: 'Stop' }])
    } finally {
      await second.close()
    }
  })

  it('reports no conflict when it gets the port it asked for', async () => {
    ingest = await startHookIngest({ port: 0, onPayload: () => {} })
    expect(ingest.portConflict).toBeUndefined()
  })
})

function postSocket(
  socketPath: string,
  sessionId: SessionId,
  body: unknown,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: `/hooks/${sessionId}`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

describe('hook ingest Unix socket', () => {
  it.skipIf(process.platform === 'win32')(
    'accepts the same hook route and removes its stable name on close',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'podium-hook-socket-'))
      const socketPath = join(root, 'ingest.sock')
      const got: { sessionId: SessionId; payload: unknown }[] = []
      const ing = await startHookIngest({
        port: 0,
        socketPath,
        onPayload: (sessionId, payload) => got.push({ sessionId, payload }),
      })
      try {
        expect(
          await postSocket(socketPath, asSessionId('pane-a'), { session_id: 'thread-a' }),
        ).toEqual({
          status: 200,
          text: '{}',
        })
        expect(got).toEqual([{ sessionId: 'pane-a', payload: { session_id: 'thread-a' } }])
      } finally {
        await ing.close()
      }
      await expect(access(socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await rm(root, { recursive: true, force: true })
    },
  )

  it.skipIf(process.platform === 'win32')(
    'never unlinks another live instance socket',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'podium-hook-socket-'))
      const socketPath = join(root, 'ingest.sock')
      const first = await startHookIngest({ port: 0, socketPath, onPayload: () => {} })
      try {
        await expect(
          startHookIngest({ port: 0, socketPath, onPayload: () => {} }),
        ).rejects.toMatchObject({ code: 'EADDRINUSE' })
        expect((await postSocket(socketPath, asSessionId('pane-a'), {})).status).toBe(200)
      } finally {
        await first.close()
        await rm(root, { recursive: true, force: true })
      }
    },
  )
})

async function post(url: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, text: await res.text() }
}

describe('hook-ingest respondTo', () => {
  it('returns respondTo body when provided, still calls onPayload', async () => {
    const seen: unknown[] = []
    const ing = await startHookIngest({
      port: 0,
      onPayload: (_s, p) => seen.push(p),
      respondTo: async (_s, p) =>
        (p as any).hook_event_name === 'SessionStart' ? '{"x":1}' : null,
    })
    try {
      const r = await post(ing.endpointFor(asSessionId('s1')), { hook_event_name: 'SessionStart' })
      expect(r.status).toBe(200)
      expect(r.text).toBe('{"x":1}')
      expect(seen).toHaveLength(1)
    } finally {
      await ing.close()
    }
  })

  it('falls back to {} when respondTo returns null', async () => {
    const ing = await startHookIngest({ port: 0, onPayload: () => {}, respondTo: async () => null })
    try {
      const r = await post(ing.endpointFor(asSessionId('s1')), { hook_event_name: 'Stop' })
      expect(r.text).toBe('{}')
    } finally {
      await ing.close()
    }
  })

  it('falls back to {} when respondTo exceeds the timeout', async () => {
    const ing = await startHookIngest({
      port: 0,
      onPayload: () => {},
      respondTimeoutMs: 50,
      respondTo: () => new Promise((r) => setTimeout(() => r('"late"'), 500)),
    })
    try {
      const r = await post(ing.endpointFor(asSessionId('s1')), { hook_event_name: 'SessionStart' })
      expect(r.text).toBe('{}')
    } finally {
      await ing.close()
    }
  })

  it('with no respondTo, behaves exactly as before ({} ack)', async () => {
    const ing = await startHookIngest({ port: 0, onPayload: () => {} })
    try {
      const r = await post(ing.endpointFor(asSessionId('s1')), { hook_event_name: 'Stop' })
      expect(r.text).toBe('{}')
    } finally {
      await ing.close()
    }
  })

  it('a client abort mid-respondTo does not crash; the server still serves the next request', async () => {
    const ing = await startHookIngest({
      port: 0,
      onPayload: () => {},
      respondTimeoutMs: 120,
      // Never resolves, so the ONLY thing that would write the response is the
      // fallback timer — firing onto a socket the aborted client already closed.
      // Without the guard that write throws uncaught out of the timer callback.
      respondTo: () => new Promise<string>(() => {}),
    })
    try {
      const ac = new AbortController()
      const inflight = fetch(ing.endpointFor(asSessionId('s1')), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hook_event_name: 'SessionStart' }),
        signal: ac.signal,
        // Aborted fetch rejects; swallow so it doesn't surface as unhandled.
      }).catch(() => {})
      await new Promise((r) => setTimeout(r, 20)) // let the request reach the server
      ac.abort()
      await inflight
      // Wait past the fallback timeout so the timer would have fired onto the
      // now-closed socket. A regression crashes the process here.
      await new Promise((r) => setTimeout(r, 250))
      // Process/server survived: a fresh request is served normally (times out
      // to the {} fallback since respondTo never resolves).
      const r = await post(ing.endpointFor(asSessionId('s2')), { hook_event_name: 'SessionStart' })
      expect(r.status).toBe(200)
      expect(r.text).toBe('{}')
    } finally {
      await ing.close()
    }
  })
})


describe('prime response deadline', () => {
  it('cancels a timed-out fetch without consuming prime or calling later responders', async () => {
    let resolve!: (value: { ok: boolean; result: string }) => void
    let calls = 0
    let laterCalls = 0
    const injector = createPrimeInjector(async () => {
      if (++calls === 1) return new Promise<{ ok: boolean; result: string }>((done) => { resolve = done })
      return { ok: true, result: 'fresh prime' }
    })
    const ing = await startHookIngest({
      port: 0,
      onPayload: () => {},
      respondTimeoutMs: 30,
      boundaryContext: injector.respondTo,
      respondTo: composeResponders(async () => { laterCalls++; return null }),
    })
    try {
      const endpoint = ing.endpointFor(asSessionId('deadline'))
      expect((await post(endpoint, { hook_event_name: 'SessionStart' })).text).toBe('{}')
      const next = await post(endpoint, { hook_event_name: 'UserPromptSubmit' })
      expect(JSON.parse(next.text).hookSpecificOutput.additionalContext).toBe('fresh prime')
      resolve({ ok: true, result: 'expired prime' })
      await new Promise<void>((done) => setImmediate(done))
      expect(laterCalls).toBe(0)
      expect((await post(endpoint, { hook_event_name: 'UserPromptSubmit' })).text).toBe('{}')
      expect(laterCalls).toBe(1)
      expect(calls).toBe(2)
    } finally {
      await ing.close()
    }
  })
})


it('delivers driver prime even when all legacy responders are absent', async () => {
  const context = createBoundaryContext(async () => ({ ok: true, result: 'driver prime' }))
  const ing = await startHookIngest({
    port: 0,
    onPayload: () => {},
    boundaryContext: (_sessionId, payload, signal) => primeHookResponse(context.respond, payload, signal),
  })
  try {
    const endpoint = ing.endpointFor(asSessionId('driver-only'))
    const first = await post(endpoint, { hook_event_name: 'SessionStart' })
    expect(JSON.parse(first.text).hookSpecificOutput.additionalContext).toBe('driver prime')
    expect((await post(endpoint, { hook_event_name: 'UserPromptSubmit' })).text).toBe('{}')
    expect((await post(endpoint, { hook_event_name: 'PreCompact' })).text).toBe('{}')
    const next = await post(endpoint, { hook_event_name: 'UserPromptSubmit' })
    expect(JSON.parse(next.text).hookSpecificOutput.additionalContext).toBe('driver prime')
  } finally {
    await ing.close()
  }
})

/**
 * PRIME BOUNDARY PER-HARNESS PARITY (this issue).
 *
 * POD-4295 verified the boundary for Claude over HTTP with snake_case
 * payloads. Codex rides the instance Unix socket (same snake_case codec) and
 * Grok rides HTTP with camelCase payloads. The daemon must answer all three
 * wires identically: driver prime first, an expired hook cancelled instead of
 * continuing to mail, and fail-open to the legacy chain only once prime
 * declines. Each arm posts the payload shape its real hooks send.
 */
type ParityHarness = 'claude-code' | 'codex' | 'grok'

const parityPayload = (harness: ParityHarness, event: string): Record<string, string> =>
  harness === 'grok' ? { hookEventName: event } : { hook_event_name: event }

interface ParityIngest {
  post: (body: unknown) => Promise<{ status: number; text: string }>
  close: () => Promise<void>
}

async function startParityIngest(
  harness: ParityHarness,
  opts: {
    boundaryContext: (
      sessionId: SessionId,
      payload: unknown,
      signal: AbortSignal,
    ) => Promise<string | null>
    respondTo?: (
      sessionId: SessionId,
      payload: unknown,
      signal: AbortSignal,
    ) => Promise<string | null>
    respondTimeoutMs?: number
  },
): Promise<ParityIngest> {
  const sessionId = asSessionId(`parity-${harness}`)
  if (harness === 'codex') {
    const root = await mkdtemp(join(tmpdir(), 'podium-parity-codex-'))
    const socketPath = join(root, 'ingest.sock')
    const ing = await startHookIngest({ port: 0, socketPath, onPayload: () => {}, ...opts })
    return {
      post: (body) => postSocket(socketPath, sessionId, body),
      close: async () => {
        await ing.close()
        await rm(root, { recursive: true, force: true })
      },
    }
  }
  const ing = await startHookIngest({ port: 0, onPayload: () => {}, ...opts })
  const endpoint = ing.endpointFor(sessionId)
  return { post: (body) => post(endpoint, body), close: () => ing.close() }
}

describe('prime boundary per-harness parity', () => {
  // HTTP arms run everywhere; the Codex arm rides the instance Unix socket
  // its real hooks post to, so it skips where sockets are unavailable.
  const httpHarnesses = ['claude-code', 'grok'] as const
  const runHttp = (
    name: string,
    fn: (harness: ParityHarness) => Promise<void>,
  ): void => {
    it.each(httpHarnesses)(`%s ${name}`, fn)
  }
  const runCodex = (name: string, fn: (harness: ParityHarness) => Promise<void>): void => {
    it.skipIf(process.platform === 'win32')(`codex ${name}`, () => fn('codex'))
  }

  const answersStartOnce: (harness: ParityHarness) => Promise<void> = async (harness) => {
    const context = createBoundaryContext(async () => ({ ok: true, result: `${harness} prime` }))
    const mailPayloads: unknown[] = []
    const ing = await startParityIngest(harness, {
      boundaryContext: (_sessionId, payload, signal) =>
        primeHookResponse(context.respond, payload, signal),
      respondTo: async (_sessionId, payload) => {
        mailPayloads.push(payload)
        return null
      },
    })
    try {
      const first = await ing.post(parityPayload(harness, 'SessionStart'))
      expect(first.status).toBe(200)
      expect(JSON.parse(first.text)).toEqual({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `${harness} prime` },
      })
      // Prime-first: the legacy/mail chain is never consulted while the
      // driver answers, so it cannot double-deliver or consume its cooldown.
      expect(mailPayloads).toEqual([])
      expect((await ing.post(parityPayload(harness, 'UserPromptSubmit'))).text).toBe('{}')
      // Fail-open: once prime declines, the same event reaches the legacy chain.
      expect(mailPayloads).toHaveLength(1)
    } finally {
      await ing.close()
    }
  }
  runHttp('answers start with driver prime and leaves mail silent while prime answers', answersStartOnce)
  runCodex('answers start with driver prime and leaves mail silent while prime answers', answersStartOnce)

  const cancelsExpired: (harness: ParityHarness) => Promise<void> = async (harness) => {
    let resolve!: (value: { ok: boolean; result: string }) => void
    let calls = 0
    const context = createBoundaryContext(() => {
      if (++calls === 1)
        return new Promise<{ ok: boolean; result: string }>((done) => {
          resolve = done
        })
      return Promise.resolve({ ok: true, result: 'fresh prime' })
    })
    let mailCalls = 0
    const ing = await startParityIngest(harness, {
      respondTimeoutMs: 30,
      boundaryContext: (_sessionId, payload, signal) =>
        primeHookResponse(context.respond, payload, signal),
      respondTo: async () => {
        mailCalls++
        return null
      },
    })
    try {
      expect((await ing.post(parityPayload(harness, 'SessionStart'))).text).toBe('{}')
      resolve({ ok: true, result: 'stale prime' })
      await new Promise<void>((done) => setImmediate(done))
      // The expired hook must not continue into the mail chain after the
      // shared deadline, on any transport.
      expect(mailCalls).toBe(0)
      const next = await ing.post(parityPayload(harness, 'UserPromptSubmit'))
      expect(JSON.parse(next.text).hookSpecificOutput.additionalContext).toBe('fresh prime')
      expect(calls).toBe(2)
    } finally {
      await ing.close()
    }
  }
  runHttp('cancels an expired prime fetch instead of continuing to mail', cancelsExpired)
  runCodex('cancels an expired prime fetch instead of continuing to mail', cancelsExpired)

  const prefersDriver: (harness: ParityHarness) => Promise<void> = async (harness) => {
    const context = createBoundaryContext(async () => ({ ok: true, result: 'driver prime' }))
    const legacy = createPrimeInjector(async () => ({ ok: true, result: 'legacy prime' }))
    let legacyCalls = 0
    const ing = await startParityIngest(harness, {
      boundaryContext: (_sessionId, payload, signal) =>
        primeHookResponse(context.respond, payload, signal),
      respondTo: composeResponders(async (sessionId, payload, signal) => {
        legacyCalls++
        return legacy.respondTo(sessionId, payload, signal)
      }),
    })
    try {
      const first = await ing.post(parityPayload(harness, 'SessionStart'))
      expect(JSON.parse(first.text).hookSpecificOutput.additionalContext).toBe('driver prime')
      expect(legacyCalls).toBe(0)
      // The legacy responder stays armed behind the driver: once the driver
      // is consumed, the same event falls through to it instead of going empty.
      const second = await ing.post(parityPayload(harness, 'UserPromptSubmit'))
      expect(JSON.parse(second.text).hookSpecificOutput.additionalContext).toBe('legacy prime')
      expect(legacyCalls).toBe(1)
    } finally {
      await ing.close()
    }
  }
  runHttp('prefers driver prime over a legacy responder answering the same event', prefersDriver)
  runCodex('prefers driver prime over a legacy responder answering the same event', prefersDriver)
})
