// apps/server/src/file-artifact-route.ts
import { type ArtifactId, asArtifactId, asIssueId, type IssueId } from '@podium/model'
import type { Hono } from 'hono'
import { parseByteRange, type ResolvedByteRange, resolveByteRange } from './http-byte-range'
import { rawFileHeaders } from './raw-file-headers'

const MAX_RANGE_BYTES = 10 * 1024 * 1024

/** The store face the route needs (IssueArtifactStore, structurally). */
export interface ArtifactBundleReader {
  read(
    issueId: IssueId,
    artifactId: ArtifactId,
    relPath: string,
    range?: { offset: number; length: number },
  ): Promise<{ bytes: Buffer; contentType: string; size: number } | null>
}

/**
 * Serve permanent-store artifact snapshots ([spec:SP-0fc9] #441):
 * GET /files/artifact/<issueId>/<artifactId>/<relpath...>. Path-style so a
 * bundle's HTML entry resolves relative src/href to sibling files. Server-local
 * read — no daemon round-trip, works with the owning machine offline. Auth
 * matches the rest of /files/* (clientAuthGuard in server.ts). Content is
 * immutable under a given artifactId (re-add mints a new id), hence the
 * immutable cache-control.
 */
export function registerArtifactRoute(app: Hono, store: ArtifactBundleReader): void {
  app.get('/files/artifact/:issueId/:artifactId/*', async (c) => {
    const issueId = c.req.param('issueId')
    const artifactId = c.req.param('artifactId')
    // ['files','artifact',issueId,artifactId, ...relpath segments]
    const rel = c.req.path.split('/').filter(Boolean).slice(4).map(decodeURIComponent).join('/')
    if (!rel) return c.text('bad request', 400)
    const requestedRange = parseByteRange(c.req.header('range'))
    if (requestedRange === 'invalid') return c.body(null, 416)
    let range: ResolvedByteRange | null = null
    let r: Awaited<ReturnType<ArtifactBundleReader['read']>>
    if (requestedRange?.kind === 'suffix') {
      const probe = await store.read(asIssueId(issueId), asArtifactId(artifactId), rel, {
        offset: 0,
        length: 1,
      })
      if (!probe) return c.text('not found', 404)
      const resolved = resolveByteRange(requestedRange, probe.size, MAX_RANGE_BYTES)
      if (resolved === 'unsatisfiable') {
        return c.body(null, 416, { 'content-range': `bytes */${probe.size}` })
      }
      range = resolved
      r = await store.read(asIssueId(issueId), asArtifactId(artifactId), rel, {
        offset: range.offset,
        length: range.length,
      })
    } else if (requestedRange) {
      const tentative = {
        offset: requestedRange.start,
        length:
          requestedRange.end === undefined
            ? MAX_RANGE_BYTES
            : Math.min(requestedRange.end - requestedRange.start, MAX_RANGE_BYTES - 1) + 1,
      }
      r = await store.read(asIssueId(issueId), asArtifactId(artifactId), rel, tentative)
      if (!r) return c.text('not found', 404)
      const resolved = resolveByteRange(requestedRange, r.size, MAX_RANGE_BYTES)
      if (resolved === 'unsatisfiable') {
        return c.body(null, 416, { 'content-range': `bytes */${r.size}` })
      }
      range = resolved
    } else {
      r = await store.read(asIssueId(issueId), asArtifactId(artifactId), rel)
    }
    if (!r) return c.text('not found', 404)
    if (range && r.bytes.length === 0) {
      return c.body(null, 416, { 'content-range': `bytes */${r.size}` })
    }
    const responseHeaders = {
      ...rawFileHeaders({
        contentType: r.contentType,
        cacheControl: 'private, max-age=31536000, immutable',
        secFetchDest: c.req.header('sec-fetch-dest'),
      }),
      'accept-ranges': 'bytes',
      ...(range
        ? {
            'content-range': `bytes ${range.offset}-${range.offset + r.bytes.length - 1}/${r.size}`,
            'content-length': String(r.bytes.length),
          }
        : {}),
    }
    const body = r.bytes.buffer.slice(
      r.bytes.byteOffset,
      r.bytes.byteOffset + r.bytes.byteLength,
    ) as ArrayBuffer
    return range ? c.body(body, 206, responseHeaders) : c.body(body, 200, responseHeaders)
  })
}
