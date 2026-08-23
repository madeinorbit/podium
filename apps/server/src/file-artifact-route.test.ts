import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { type ArtifactBundleReader, registerArtifactRoute } from './file-artifact-route'

function appWith(reader: ArtifactBundleReader): Hono {
  const app = new Hono()
  registerArtifactRoute(app, reader)
  return app
}

describe('GET /files/artifact/:issueId/:artifactId/* [spec:SP-0fc9]', () => {
  it('serves stored bytes with content-type + immutable cache-control', async () => {
    const seen: string[][] = []
    const app = appWith({
      read: async (issueId, artifactId, rel) => {
        seen.push([issueId, artifactId, rel])
        return { bytes: Buffer.from('PNGDATA'), contentType: 'image/png', size: 7 }
      },
    })
    const res = await app.request('/files/artifact/iss_1/abc123/shots/a.png')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('PNGDATA')
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(seen).toEqual([['iss_1', 'abc123', 'shots/a.png']])
  })

  it('404s a missing snapshot', async () => {
    const app = appWith({ read: async () => null })
    const res = await app.request('/files/artifact/iss_1/dead/entry.html')
    expect(res.status).toBe(404)
  })

  it('decodes encoded relpath segments', async () => {
    let got = ''
    const app = appWith({
      read: async (_i, _a, rel) => {
        got = rel
        return { bytes: Buffer.from('x'), contentType: 'text/plain; charset=utf-8', size: 1 }
      },
    })
    const res = await app.request('/files/artifact/iss_1/abc/my%20file.txt')
    expect(res.status).toBe(200)
    expect(got).toBe('my file.txt')
  })

  it('serves suffix ranges without loading the complete stored artifact', async () => {
    const source = Buffer.from('0123456789')
    const reads: Array<{ offset: number; length: number } | undefined> = []
    const app = appWith({
      read: async (_issueId, _artifactId, _rel, range) => {
        reads.push(range)
        const bytes = range ? source.subarray(range.offset, range.offset + range.length) : source
        return { bytes, contentType: 'video/mp4', size: source.length }
      },
    })
    const res = await app.request('/files/artifact/iss_1/abc/video.mp4', {
      headers: { range: 'bytes=-4' },
    })

    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 6-9/10')
    expect(await res.text()).toBe('6789')
    expect(reads).toEqual([
      { offset: 0, length: 1 },
      { offset: 6, length: 4 },
    ])
  })

  it('serves bounded ranges with one partial store read', async () => {
    const source = Buffer.from('0123456789')
    const reads: Array<{ offset: number; length: number } | undefined> = []
    const app = appWith({
      read: async (_issueId, _artifactId, _rel, range) => {
        reads.push(range)
        return {
          bytes: range ? source.subarray(range.offset, range.offset + range.length) : source,
          contentType: 'video/mp4',
          size: source.length,
        }
      },
    })
    const res = await app.request('/files/artifact/iss_1/abc/video.mp4', {
      headers: { range: 'bytes=3-5' },
    })

    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 3-5/10')
    expect(await res.text()).toBe('345')
    expect(reads).toEqual([{ offset: 3, length: 3 }])
  })

  it('returns the stored artifact size for an unsatisfiable range', async () => {
    const app = appWith({
      read: async () => ({ bytes: Buffer.from('0'), contentType: 'video/mp4', size: 10 }),
    })
    const res = await app.request('/files/artifact/iss_1/abc/video.mp4', {
      headers: { range: 'bytes=10-' },
    })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */10')
  })
})
