/**
 * `/files/artifact` OVER A WORKSPACE'S BLOB STORE (POD-6963 design 2.7).
 *
 * The route runs against the real `IssueArtifactStore` over the in-memory blob
 * store, which has object-store range semantics (a range past the end is an
 * empty body with the real size). Members are written straight to their keys;
 * snapshotting is the store's own test file.
 */

import { type BlobStore, joinKey, keySegment } from '@podium/blob-store'
import { MemoryBlobStorage } from '@podium/blob-store/memory'
import { asWorkspaceId, type WorkspaceId } from '@podium/model'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  type ArtifactStreamReader,
  edgeWorkspaceBinding,
  registerArtifactRoute,
  type WorkspaceArtifacts,
  workspaceArtifacts,
} from './file-artifact-route'
import { IssueArtifactStore } from './modules/issues/artifact-store'
import { SELF_HOSTED_WORKSPACE_ID } from './self-hosted-workspace'
import { bindRequestsTo } from './test-support/workspace-binding'

/** A self-hosted server's route: every request bound to its one workspace by the edge. */
function selfHostedRoute(app: Hono, store: ArtifactStreamReader): void {
  bindRequestsTo(app, SELF_HOSTED_WORKSPACE_ID)
  registerArtifactRoute(
    app,
    workspaceArtifacts(SELF_HOSTED_WORKSPACE_ID, store),
    edgeWorkspaceBinding('self-hosted', [{ id: SELF_HOSTED_WORKSPACE_ID, slug: null }]),
  )
}

const storeOver = (files: BlobStore): IssueArtifactStore =>
  // Only reads run here: the upload rows and the daemon are never reached.
  new IssueArtifactStore({ files, uploads: {} as never, rpc: {} as never })

async function put(files: BlobStore, rel: string, bytes: string | Uint8Array): Promise<void> {
  const body = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
  await files.put(joinKey('artifacts', 'iss_1', 'abc123', ...rel.split('/').map(keySegment)), body)
}

/** A self-hosted app whose one workspace holds `members`. */
async function selfHostedApp(members: Record<string, string | Uint8Array>): Promise<Hono> {
  const files = new MemoryBlobStorage().forWorkspace(SELF_HOSTED_WORKSPACE_ID)
  for (const [rel, bytes] of Object.entries(members)) await put(files, rel, bytes)
  const app = new Hono()
  selfHostedRoute(app, storeOver(files))
  return app
}

const url = (rel: string) => `/files/artifact/iss_1/abc123/${rel}`
const ranged = (range: string) => ({ headers: { range } })

describe('GET /files/artifact/:issueId/:artifactId/*', () => {
  it('streams a whole member with its type, length and immutable cache-control', async () => {
    const app = await selfHostedApp({ 'shots/a.png': 'PNGDATA' })
    const res = await app.request(url('shots/a.png'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('PNGDATA')
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-length')).toBe('7')
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-range')).toBeNull()
  })

  it('streams a large member byte for byte', async () => {
    const big = new Uint8Array(3 * 1024 * 1024 + 17)
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 251
    const app = await selfHostedApp({ 'video.mp4': big })
    const res = await app.request(url('video.mp4'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(String(big.length))
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(big))).toBe(true)
  })

  it('answers before the store has produced the whole body', async () => {
    let finish: (() => void) | undefined
    const reader: ArtifactStreamReader = {
      readStream: async () => ({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('first'))
            finish = () => {
              controller.enqueue(new TextEncoder().encode('-last'))
              controller.close()
            }
          },
        }),
        contentType: 'text/plain; charset=utf-8',
        size: 10,
        etag: 'e',
      }),
    }
    const app = new Hono()
    selfHostedRoute(app, reader)
    const res = await app.request(url('log.txt'))
    expect(res.status).toBe(200)
    const body = res.body?.getReader()
    if (!body) throw new Error('no body')
    const first = await body.read()
    expect(new TextDecoder().decode(first.value)).toBe('first')
    finish?.()
    const rest = await body.read()
    expect(new TextDecoder().decode(rest.value)).toBe('-last')
    expect((await body.read()).done).toBe(true)
  })

  it('serves a bounded range as one partial stream', async () => {
    const reads: Array<{ offset: number; length: number } | undefined> = []
    const files = new MemoryBlobStorage().forWorkspace(SELF_HOSTED_WORKSPACE_ID)
    await put(files, 'video.mp4', '0123456789')
    const store = storeOver(files)
    const counting: ArtifactStreamReader = {
      readStream: (i, a, rel, range) => {
        reads.push(range)
        return store.readStream(i, a, rel, range)
      },
    }
    const app = new Hono()
    selfHostedRoute(app, counting)
    const res = await app.request(url('video.mp4'), ranged('bytes=3-5'))
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 3-5/10')
    expect(res.headers.get('content-length')).toBe('3')
    expect(await res.text()).toBe('345')
    expect(reads).toEqual([{ offset: 3, length: 3 }])
  })

  it('serves an open range to the end of the member', async () => {
    const app = await selfHostedApp({ 'video.mp4': '0123456789' })
    const res = await app.request(url('video.mp4'), ranged('bytes=7-'))
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 7-9/10')
    expect(res.headers.get('content-length')).toBe('3')
    expect(await res.text()).toBe('789')
  })

  it('clips a range that runs past the end to the member', async () => {
    const app = await selfHostedApp({ 'video.mp4': '0123456789' })
    const res = await app.request(url('video.mp4'), ranged('bytes=8-40'))
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 8-9/10')
    expect(res.headers.get('content-length')).toBe('2')
    expect(await res.text()).toBe('89')
  })

  it('serves a suffix range from a one-byte probe and one partial stream', async () => {
    const reads: Array<{ offset: number; length: number } | undefined> = []
    const files = new MemoryBlobStorage().forWorkspace(SELF_HOSTED_WORKSPACE_ID)
    await put(files, 'video.mp4', '0123456789')
    const store = storeOver(files)
    const app = new Hono()
    selfHostedRoute(app, {
      readStream: (i, a, rel, range) => {
        reads.push(range)
        return store.readStream(i, a, rel, range)
      },
    })
    const res = await app.request(url('video.mp4'), ranged('bytes=-4'))
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 6-9/10')
    expect(res.headers.get('content-length')).toBe('4')
    expect(await res.text()).toBe('6789')
    expect(reads).toEqual([
      { offset: 0, length: 1 },
      { offset: 6, length: 4 },
    ])
  })

  it('serves a suffix longer than the member as the whole member', async () => {
    const app = await selfHostedApp({ 'video.mp4': '0123456789' })
    const res = await app.request(url('video.mp4'), ranged('bytes=-40'))
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-9/10')
    expect(await res.text()).toBe('0123456789')
  })

  it('answers 416 with the member size for a range starting at or past the end', async () => {
    const app = await selfHostedApp({ 'video.mp4': '0123456789' })
    for (const range of ['bytes=10-', 'bytes=25-30']) {
      const res = await app.request(url('video.mp4'), ranged(range))
      expect(res.status).toBe(416)
      expect(res.headers.get('content-range')).toBe('bytes */10')
    }
  })

  it('answers 416 for a malformed range and for any range of an empty member', async () => {
    const app = await selfHostedApp({ 'empty.txt': '' })
    expect((await app.request(url('empty.txt'), ranged('bytes=5-2'))).status).toBe(416)
    const suffix = await app.request(url('empty.txt'), ranged('bytes=-3'))
    expect(suffix.status).toBe(416)
    expect(suffix.headers.get('content-range')).toBe('bytes */0')
    const whole = await app.request(url('empty.txt'))
    expect(whole.status).toBe(200)
    expect(await whole.text()).toBe('')
  })

  it('404s a missing member, also for ranged reads', async () => {
    const app = await selfHostedApp({ 'entry.html': '<p>x</p>' })
    expect((await app.request(url('gone.html'))).status).toBe(404)
    expect((await app.request(url('gone.html'), ranged('bytes=0-1'))).status).toBe(404)
    expect((await app.request(url('gone.html'), ranged('bytes=-1'))).status).toBe(404)
    expect((await app.request('/files/artifact/iss_1/dead/entry.html')).status).toBe(404)
  })

  it('decodes encoded relpath segments and refuses undecodable ones', async () => {
    const app = await selfHostedApp({ 'notes/my file.txt': 'spaced' })
    const res = await app.request(url('notes/my%20file.txt'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('spaced')
    expect((await app.request(url('bad%E0%A4%A.txt'))).status).toBe(400)
  })

  it('sandboxes an HTML member rendered as a page', async () => {
    const app = await selfHostedApp({ 'site/index.html': '<h1>hi</h1>' })
    const res = await app.request(url('site/index.html'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts/)
    expect(res.headers.get('content-security-policy')).not.toContain('allow-same-origin')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await res.text()).toBe('<h1>hi</h1>')
  })

  it('serves a member as a download named after its basename when asked', async () => {
    const app = await selfHostedApp({ 'site/index.html': '<h1>hi</h1>' })
    const res = await app.request(url('site/index.html?download=1'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="index.html"')
    expect(res.headers.get('content-security-policy')).toBeNull()
  })
})

describe('the workspace bound to the request (POD-6963 design 2.7)', () => {
  const A = asWorkspaceId('ws_a')
  const B = asWorkspaceId('ws_b')

  /** Two workspaces over one bucket, holding different bytes under the same ids. */
  async function twoWorkspaces(): Promise<WorkspaceArtifacts> {
    const storage = new MemoryBlobStorage()
    const stores: Record<string, IssueArtifactStore> = {}
    for (const ws of [A, B]) {
      const files = storage.forWorkspace(ws)
      await put(files, 'site/index.html', `BYTES OF ${ws}`)
      stores[ws] = storeOver(files)
    }
    return (ws) => stores[ws]
  }

  /** A fake POD-6960 binding: bound to `bound`, naming only what `mayName` accepts. */
  const appBoundTo = (
    artifactsOf: WorkspaceArtifacts,
    bound: WorkspaceId,
    mayName: (segment: string) => boolean,
  ): Hono => {
    const app = new Hono()
    registerArtifactRoute(app, artifactsOf, {
      bound: () => bound,
      mayName: (_c, segment) => mayName(segment),
    })
    return app
  }

  const prefixed = (ws: string) => `/files/artifact/workspace/${ws}/iss_1/abc123/site/index.html`

  it('serves any workspace segment on a one-workspace server, from its own store', async () => {
    const app = await selfHostedApp({ 'site/index.html': 'HTML' })
    for (const segment of ['second', SELF_HOSTED_WORKSPACE_ID, 'a%20slug']) {
      const res = await app.request(prefixed(segment))
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('HTML')
      expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    }
  })

  it('on hosted, answers only a segment that names the bound workspace by id or slug', async () => {
    const artifactsOf = await twoWorkspaces()
    const app = new Hono()
    bindRequestsTo(app, A, 'acme')
    registerArtifactRoute(
      app,
      artifactsOf,
      edgeWorkspaceBinding('hosted', [
        { id: A, slug: 'acme' },
        { id: B, slug: 'other' },
      ]),
    )
    for (const segment of [A, 'acme']) {
      const own = await app.request(prefixed(segment))
      expect(own.status).toBe(200)
      expect(await own.text()).toBe(`BYTES OF ${A}`)
    }
    for (const segment of [B, 'other', 'second']) {
      expect((await app.request(prefixed(segment))).status).toBe(404)
    }
  })

  it('does not find a request bound to A that names B, and reads A when it names A', async () => {
    const app = appBoundTo(await twoWorkspaces(), A, (segment) => segment === A)
    const named = await app.request(prefixed(B))
    expect(named.status).toBe(404)
    expect(await named.text()).not.toContain(B)
    const own = await app.request(prefixed(A))
    expect(own.status).toBe(200)
    expect(await own.text()).toBe(`BYTES OF ${A}`)
  })

  it('never reads B for a request bound to A, whatever the path says', async () => {
    const app = appBoundTo(await twoWorkspaces(), A, () => true)
    for (const path of [prefixed(B), prefixed(A), url('site/index.html')]) {
      const res = await app.request(path)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe(`BYTES OF ${A}`)
    }
    for (const range of ['bytes=0-4', 'bytes=-3']) {
      const res = await app.request(prefixed(B), ranged(range))
      expect(res.status).toBe(206)
      expect(`BYTES OF ${A}`).toContain(await res.text())
    }
  })

  it('does not find anything for a bound workspace this process holds no store for', async () => {
    const app = appBoundTo(await twoWorkspaces(), asWorkspaceId('ws_unknown'), () => true)
    expect((await app.request(url('site/index.html'))).status).toBe(404)
    expect((await app.request(prefixed(A))).status).toBe(404)
  })

  it("gives a process's resolver no store for a workspace it did not load", () => {
    const store = storeOver(new MemoryBlobStorage().forWorkspace(SELF_HOSTED_WORKSPACE_ID))
    const artifactsOf = workspaceArtifacts(SELF_HOSTED_WORKSPACE_ID, store)
    expect(artifactsOf(SELF_HOSTED_WORKSPACE_ID)).toBe(store)
    expect(artifactsOf(B)).toBeUndefined()
  })
})
