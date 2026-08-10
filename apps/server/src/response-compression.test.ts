import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  compressHttpResponse,
  HTTP_COMPRESSION_MAX_BYTES,
  HTTP_COMPRESSION_MIN_BYTES,
} from './response-compression'

function request(acceptEncoding = 'gzip'): Request {
  return new Request('http://podium.test/trpc/example', {
    headers: { 'accept-encoding': acceptEncoding },
  })
}

describe('compressHttpResponse', () => {
  it('gzips large JSON and preserves response metadata', async () => {
    const text = JSON.stringify({
      rows: Array.from({ length: 500 }, (_, i) => ({ i, value: 'same' })),
    })
    const response = await compressHttpResponse(
      request(),
      new Response(text, {
        status: 201,
        statusText: 'Created',
        headers: { 'content-type': 'application/json', 'x-proof': 'kept' },
      }),
    )
    expect(response.status).toBe(201)
    expect(response.statusText).toBe('Created')
    expect(response.headers.get('content-encoding')).toBe('gzip')
    expect(response.headers.get('vary')).toBe('Accept-Encoding')
    expect(response.headers.get('x-proof')).toBe('kept')
    expect(gunzipSync(new Uint8Array(await response.arrayBuffer())).toString()).toBe(text)
  })

  it.each([
    ['tiny text', 'x'.repeat(HTTP_COMPRESSION_MIN_BYTES - 1), 'text/plain'],
    ['already compressed type', 'x'.repeat(HTTP_COMPRESSION_MIN_BYTES * 2), 'image/png'],
    ['oversized text', 'x'.repeat(HTTP_COMPRESSION_MAX_BYTES + 1), 'text/plain'],
  ])('keeps %s as identity', async (_name, text, contentType) => {
    const response = await compressHttpResponse(
      request(),
      new Response(text, { headers: { 'content-type': contentType } }),
    )
    expect(response.headers.get('content-encoding')).toBe(null)
    expect(await response.text()).toBe(text)
  })

  it('honours negotiation and response exclusions', async () => {
    const text = 'compressible '.repeat(300)
    for (const [acceptEncoding, headers] of [
      ['gzip;q=0, br', { 'content-type': 'text/plain' }],
      ['identity', { 'content-type': 'text/plain' }],
      ['gzip', { 'content-type': 'text/plain', 'content-encoding': 'br' }],
      ['gzip', { 'content-type': 'text/plain', 'cache-control': 'private, no-transform' }],
    ] as const) {
      const response = await compressHttpResponse(
        request(acceptEncoding),
        new Response(text, { headers }),
      )
      expect(response.headers.get('content-encoding')).not.toBe('gzip')
    }
  })
})
