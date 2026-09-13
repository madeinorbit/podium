/**
 * THE ROUTE'S TRANSPORT BEHAVIOUR — ranges, headers, decoding, download names.
 *
 * THE DOOR THESE CASES PASS THROUGH IS A PERMISSIVE STUB, AND THAT IS THE
 * POINT: none of them is about authorization, so none of them should be able to
 * pass or fail because of it. The authorization is a separate claim with a
 * separate file — `file-artifact-route.authz.test.ts` builds a REAL
 * `fileAccessGate` and drives this route and `files.read` over one fixture.
 * Proving the rule here against a stub would prove nothing about the rule
 * (catalogue #20: a test that mocks the permission call covers nothing about
 * the permission), and would quietly make this file the place a reader looks
 * for a guarantee it does not offer.
 */
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { type ArtifactDoor, registerArtifactRoute } from './file-artifact-route'

function appWith(door: ArtifactDoor): Hono {
  const app = new Hono()
  registerArtifactRoute(app, { doorFor: async () => door })
  return app
}

describe('GET /files/artifact/:issueId/:artifactId/* [spec:SP-0fc9]', () => {
  it('serves stored bytes with content-type + immutable cache-control', async () => {
    const seen: string[][] = []
    const app = appWith({
      readArtifact: async (issueId, artifactId, rel) => {
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
    const app = appWith({ readArtifact: async () => null })
    const res = await app.request('/files/artifact/iss_1/dead/entry.html')
    expect(res.status).toBe(404)
  })

  it('decodes encoded relpath segments', async () => {
    let got = ''
    const app = appWith({
      readArtifact: async (_i, _a, rel) => {
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
      readArtifact: async (_issueId, _artifactId, _rel, range) => {
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
      readArtifact: async (_issueId, _artifactId, _rel, range) => {
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
      readArtifact: async () => ({ bytes: Buffer.from('0'), contentType: 'video/mp4', size: 10 }),
    })
    const res = await app.request('/files/artifact/iss_1/abc/video.mp4', {
      headers: { range: 'bytes=10-' },
    })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */10')
  })

  it('serves a snapshot file as a download named after its basename when asked', async () => {
    const app = appWith({
      readArtifact: async () => ({
        bytes: Buffer.from('<h1>hi</h1>'),
        contentType: 'text/html; charset=utf-8',
        size: 11,
      }),
    })
    const res = await app.request('/files/artifact/iss_1/abc123/site/index.html?download=1')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="index.html"')
    expect(res.headers.get('content-security-policy')).toBeNull()
  })
})
