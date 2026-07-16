import { access, mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HOOK_BODY_MAX_BYTES, type HookIngest, startHookIngest } from './hook-ingest'

describe('hook ingest', () => {
  let ingest: HookIngest

  afterEach(async () => {
    await ingest.close()
  })

  it('accepts a POST and hands the payload to the callback, replying 200 {}', async () => {
    const got: { sessionId: string; payload: unknown }[] = []
    ingest = await startHookIngest({
      port: 0,
      onPayload: (sessionId, payload) => got.push({ sessionId, payload }),
    })
    const res = await fetch(ingest.endpointFor('s1'), {
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
    expect(ingest.endpointFor('abc-123')).toBe(`http://127.0.0.1:${ingest.port}/hooks/abc-123`)
  })

  it('rejects non-POST and unknown paths with 404, malformed JSON is acked but dropped', async () => {
    const got: unknown[] = []
    ingest = await startHookIngest({ port: 0, onPayload: (_sid, p) => got.push(p) })
    expect((await fetch(ingest.endpointFor('s1'), { method: 'GET' })).status).toBe(404)
    expect(
      (await fetch(`http://127.0.0.1:${ingest.port}/other`, { method: 'POST', body: '{}' })).status,
    ).toBe(404)
    expect(
      (await fetch(ingest.endpointFor('s1'), { method: 'POST', body: 'not json' })).status,
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
    const res = await fetch(ingest.endpointFor('s1'), { method: 'POST', body })
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
    const res = await fetch(ingest.endpointFor('s1'), { method: 'POST', body })
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 10))
    expect(got).toEqual([{ a: filler }])
  })

  it('rejects startup when the stable preferred port is taken', async () => {
    ingest = await startHookIngest({ port: 0, onPayload: () => {} })
    await expect(startHookIngest({ port: ingest.port, onPayload: () => {} })).rejects.toMatchObject(
      { code: 'EADDRINUSE' },
    )
  })
})

function postSocket(
  socketPath: string,
  sessionId: string,
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
      const got: { sessionId: string; payload: unknown }[] = []
      const ing = await startHookIngest({
        port: 0,
        socketPath,
        onPayload: (sessionId, payload) => got.push({ sessionId, payload }),
      })
      try {
        expect(await postSocket(socketPath, 'pane-a', { session_id: 'thread-a' })).toEqual({
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
        expect((await postSocket(socketPath, 'pane-a', {})).status).toBe(200)
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
      const r = await post(ing.endpointFor('s1'), { hook_event_name: 'SessionStart' })
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
      const r = await post(ing.endpointFor('s1'), { hook_event_name: 'Stop' })
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
      const r = await post(ing.endpointFor('s1'), { hook_event_name: 'SessionStart' })
      expect(r.text).toBe('{}')
    } finally {
      await ing.close()
    }
  })

  it('with no respondTo, behaves exactly as before ({} ack)', async () => {
    const ing = await startHookIngest({ port: 0, onPayload: () => {} })
    try {
      const r = await post(ing.endpointFor('s1'), { hook_event_name: 'Stop' })
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
      const inflight = fetch(ing.endpointFor('s1'), {
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
      const r = await post(ing.endpointFor('s2'), { hook_event_name: 'SessionStart' })
      expect(r.status).toBe(200)
      expect(r.text).toBe('{}')
    } finally {
      await ing.close()
    }
  })
})
