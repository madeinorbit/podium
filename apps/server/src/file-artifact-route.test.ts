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
        return { bytes: Buffer.from('PNGDATA'), contentType: 'image/png' }
      },
    })
    const res = await app.request('/files/artifact/iss_1/abc123/shots/a.png')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('PNGDATA')
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
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
        return { bytes: Buffer.from('x'), contentType: 'text/plain; charset=utf-8' }
      },
    })
    const res = await app.request('/files/artifact/iss_1/abc/my%20file.txt')
    expect(res.status).toBe(200)
    expect(got).toBe('my file.txt')
  })
})
