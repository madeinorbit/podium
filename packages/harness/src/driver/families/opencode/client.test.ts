import { describe, expect, it, vi } from 'vitest'
import { createOpencodeClient } from './client.js'

function client(fetch: typeof globalThis.fetch) {
  return createOpencodeClient({
    baseUrl: 'http://127.0.0.1:41234',
    username: 'podium',
    password: 'secret',
    directory: '/repo',
    fetch,
  })
}

describe('OpenCode abort delivery', () => {
  it('resolves only after the abort endpoint accepts the request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('true', { status: 200 }))

    await expect(client(fetch).abort('ses_success')).resolves.toBeUndefined()

    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:41234/session/ses_success/abort?directory=%2Frepo',
    )
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: '{}' })
  })

  it('rejects when the abort transport rejects', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError('loopback connection refused')
    })

    await expect(client(fetch).abort('ses_transport')).rejects.toThrow(
      'loopback connection refused',
    )
  })

  it('rejects a non-successful abort response with its HTTP status', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response('server unavailable', { status: 503 }),
    )

    await expect(client(fetch).abort('ses_http')).rejects.toMatchObject({
      status: 503,
      route: 'POST /session/ses_http/abort',
    })
  })
})
