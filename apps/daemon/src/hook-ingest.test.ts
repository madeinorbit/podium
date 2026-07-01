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

  it('falls back to an ephemeral port when the preferred port is taken', async () => {
    ingest = await startHookIngest({ port: 0, onPayload: () => {} })
    const second = await startHookIngest({ port: ingest.port, onPayload: () => {} })
    expect(second.port).not.toBe(ingest.port)
    expect(second.port).toBeGreaterThan(0)
    await second.close()
  })
})

async function post(url: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, text: await res.text() }
}

describe('hook-ingest respondTo', () => {
  it('returns respondTo body when provided, still calls onPayload', async () => {
    const seen: unknown[] = []
    const ing = await startHookIngest({
      port: 0,
      onPayload: (_s, p) => seen.push(p),
      respondTo: async (_s, p) => ((p as any).hook_event_name === 'SessionStart' ? '{"x":1}' : null),
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
})
