import { describe, expect, it, vi } from 'vitest'
import { createOpencode2Client } from '../opencode2/client.js'
import { createOpencodeClient, type OpencodeClientConfig } from './client.js'

const base: OpencodeClientConfig = {
  baseUrl: 'http://127.0.0.1:41234',
  username: 'test',
  password: 'invented',
  directory: '/bound-project',
}

describe.each([
  ['stable', createOpencodeClient],
  ['preview', createOpencode2Client],
] as const)('%s generic context transport', (generation, create) => {
  it('keeps bound authentication/origin and opaque adapter paths/responses', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ opaque: [1, 2, 3] }))
    const client = create({ ...base, fetch })
    expect(await client.readJson?.('/fixture-read?scope=exact', { timeoutMs: 100 })).toEqual({
      opaque: [1, 2, 3],
    })
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `${base.baseUrl}/fixture-read?scope=exact${generation === 'stable' ? '&directory=%2Fbound-project' : ''}`,
    )
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      headers: { authorization: 'Basic dGVzdDppbnZlbnRlZA==' },
    })
    expect(
      await client.readJson?.('/fixture-read?directory=%2Fnative-project', { timeoutMs: 100 }),
    ).toBeDefined()
    expect(fetch.mock.calls[1]?.[0]).toBe(
      `${base.baseUrl}/fixture-read?directory=%2Fnative-project`,
    )
  })

  it('refuses origin replacement and a pre-cancelled read before fetching', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = create({ ...base, fetch })
    await expect(client.readJson?.('https://example.com/read', { timeoutMs: 100 })).rejects.toThrow(
      'relative GET path',
    )
    await expect(client.readJson?.('//example.com/read', { timeoutMs: 100 })).rejects.toThrow(
      'relative GET path',
    )
    await expect(
      client.readJson?.('/fixture-read', { timeoutMs: 100, signal: AbortSignal.abort() }),
    ).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps cancellation active until the JSON body has completed', async () => {
    const controller = new AbortController()
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => {
      const body = new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"opaque":'))
          options?.signal?.addEventListener(
            'abort',
            () => stream.error(new Error('body cancelled')),
            { once: true },
          )
        },
      })
      return new Response(body)
    })
    const client = create({ ...base, fetch })
    const read = client.readJson?.('/fixture-read', { timeoutMs: 100, signal: controller.signal })
    await Promise.resolve()
    controller.abort()
    await expect(read).rejects.toThrow('body cancelled')
  })

  it('enforces the caller deadline on a stalled body after response headers', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_url, options) =>
        new Response(
          new ReadableStream({
            start(stream) {
              options?.signal?.addEventListener(
                'abort',
                () => stream.error(new Error('deadline')),
                { once: true },
              )
            },
          }),
        ),
    )
    const client = create({ ...base, timeoutMs: 30_000, fetch })
    await expect(client.readJson?.('/fixture-read', { timeoutMs: 10 })).rejects.toThrow('deadline')
  })

  it('forwards every opaque SSE JSON payload before lossy translation', async () => {
    const payload = { type: 'unrecognized-fixture-kind', opaque: { tokens: 'not parsed here' } }
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(`data: ${JSON.stringify(payload)}\n\n`),
    )
    const client = create({ ...base, fetch })
    const raw: unknown[] = []
    const translated: unknown[] = []
    const controller = new AbortController()
    for await (const event of client.events(controller.signal, (value) => raw.push(value)))
      translated.push(event)
    controller.abort()
    expect(raw).toEqual([payload])
    expect(translated).toEqual([])
  })
})
