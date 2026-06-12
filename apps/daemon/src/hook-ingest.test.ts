import { afterEach, describe, expect, it } from 'vitest'
import { type HookIngest, startHookIngest } from './hook-ingest'

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
    expect((await fetch(ingest.endpointFor('s1'), { method: 'POST', body: 'not json' })).status).toBe(
      200,
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(got).toEqual([])
  })

  it('falls back to an ephemeral port when the preferred port is taken', async () => {
    ingest = await startHookIngest({ port: 0, onPayload: () => {} })
    const second = await startHookIngest({ port: ingest.port, onPayload: () => {} })
    expect(second.port).not.toBe(ingest.port)
    expect(second.port).toBeGreaterThan(0)
    await second.close()
  })
})
