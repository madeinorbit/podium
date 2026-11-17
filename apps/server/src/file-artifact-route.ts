// apps/server/src/file-artifact-route.ts
import {
  type ArtifactId,
  asArtifactId,
  asIssueId,
  type IssueId,
  type WorkspaceId,
} from '@podium/model'
import type { Context, Hono } from 'hono'
import { parseByteRange, type ResolvedByteRange, resolveByteRange } from './http-byte-range'
import type { ArtifactStream } from './modules/issues/artifact-store'
import { downloadName, rawFileHeaders } from './raw-file-headers'
import { SELF_HOSTED_WORKSPACE_ID } from './self-hosted-workspace'

const MAX_RANGE_BYTES = 10 * 1024 * 1024

/** The store face the route needs (IssueArtifactStore, structurally). */
export interface ArtifactStreamReader {
  readStream(
    issueId: IssueId,
    artifactId: ArtifactId,
    relPath: string,
    range?: { offset: number; length: number },
  ): Promise<ArtifactStream | null>
}

/** The artifact store of each workspace this process serves; undefined for any other. */
export type WorkspaceArtifacts = (workspaceId: WorkspaceId) => ArtifactStreamReader | undefined

/** A self-hosted process serves one workspace, so it has one artifact store. */
export function selfHostedArtifacts(store: ArtifactStreamReader): WorkspaceArtifacts {
  return (workspaceId) => (workspaceId === SELF_HOSTED_WORKSPACE_ID ? store : undefined)
}

/**
 * THE WORKSPACE BOUND TO THIS REQUEST [POD-6963 design 2.7].
 *
 * The one seam for POD-6960's request binding: hosted routing replaces this body
 * with the workspace it bound the request to. A self-hosted install has one
 * workspace, so every request is bound to it. The route never takes the
 * workspace from the path: a `/workspace/<ws>/` segment is only checked against
 * this, and the store is always this workspace's. If the binding identifies
 * workspaces by the slug the clients put in that segment rather than by id,
 * POD-6960 changes the comparison in `pathNamesBoundWorkspace` with it.
 */
export function workspaceBoundToRequest(_c: Context): WorkspaceId {
  return SELF_HOSTED_WORKSPACE_ID
}

function pathNamesBoundWorkspace(segment: string, bound: WorkspaceId): boolean {
  return segment === bound
}

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

/** Release a store body the route will not send. */
function discard(body: ReadableStream<Uint8Array>): void {
  void body.cancel().catch(() => {})
}

/**
 * Serve permanent-store artifact snapshots ([spec:SP-0fc9] #441):
 * GET /files/artifact/<issueId>/<artifactId>/<relpath...>. Path-style so a
 * bundle's HTML entry resolves relative src/href to sibling files. Server-local
 * read — no daemon round-trip, works with the owning machine offline. Auth
 * matches the rest of /files/* (clientAuthGuard in server.ts). Content is
 * immutable under a given artifactId (re-add mints a new id), hence the
 * immutable cache-control.
 *
 * Bytes are streamed from the bound workspace's blob store (POD-6963 design
 * 2.7, F1): a full read and a range are each one store `get`, and nothing is
 * buffered whole. A suffix range first reads one byte to learn the size.
 */
export function registerArtifactRoute(
  app: Hono,
  artifactsOf: WorkspaceArtifacts,
  boundWorkspace: (c: Context) => WorkspaceId = workspaceBoundToRequest,
): void {
  const serve = async (c: Context, relStart: number): Promise<Response> => {
    const issueId = c.req.param('issueId')
    const artifactId = c.req.param('artifactId')
    if (!issueId || !artifactId) return c.text('bad request', 400)
    const bound = boundWorkspace(c)
    // Hono decodes route params; an undecodable one stays raw and matches nothing.
    const pathWorkspace = c.req.param('workspace')
    if (pathWorkspace !== undefined && !pathNamesBoundWorkspace(pathWorkspace, bound)) {
      return c.text('not found', 404)
    }
    const store = artifactsOf(bound)
    if (!store) return c.text('not found', 404)
    // The workspace path segment is routing metadata, not part of the bundle.
    // Keeping it before the issue/artifact ids means relative browser requests
    // inherit it when an artifact HTML entry refers to a sibling asset.
    const segments = c.req.path.split('/').filter(Boolean).slice(relStart).map(decodeSegment)
    if (segments.some((s) => s === undefined)) return c.text('bad request', 400)
    const rel = segments.join('/')
    if (!rel) return c.text('bad request', 400)
    const requestedRange = parseByteRange(c.req.header('range'))
    if (requestedRange === 'invalid') return c.body(null, 416)
    const read = (range?: { offset: number; length: number }) =>
      store.readStream(asIssueId(issueId), asArtifactId(artifactId), rel, range)

    let range: ResolvedByteRange | null = null
    let r: ArtifactStream | null
    if (requestedRange?.kind === 'suffix') {
      const probe = await read({ offset: 0, length: 1 })
      if (!probe) return c.text('not found', 404)
      discard(probe.body)
      const resolved = resolveByteRange(requestedRange, probe.size, MAX_RANGE_BYTES)
      if (resolved === 'unsatisfiable') {
        return c.body(null, 416, { 'content-range': `bytes */${probe.size}` })
      }
      range = resolved
      r = await read({ offset: range.offset, length: range.length })
    } else if (requestedRange) {
      // The store clips the range to the member, so one read serves it: its
      // length is the resolved length whenever the start is inside the member.
      r = await read({
        offset: requestedRange.start,
        length:
          requestedRange.end === undefined
            ? MAX_RANGE_BYTES
            : Math.min(requestedRange.end - requestedRange.start + 1, MAX_RANGE_BYTES),
      })
      if (!r) return c.text('not found', 404)
      const resolved = resolveByteRange(requestedRange, r.size, MAX_RANGE_BYTES)
      if (resolved === 'unsatisfiable') {
        discard(r.body)
        return c.body(null, 416, { 'content-range': `bytes */${r.size}` })
      }
      range = resolved
    } else {
      r = await read()
    }
    if (!r) return c.text('not found', 404)
    if (range && range.end >= r.size) {
      // The member changed size between the probe and the read; under an
      // immutable artifact id that is only a vanished member.
      discard(r.body)
      return c.body(null, 416, { 'content-range': `bytes */${r.size}` })
    }
    const responseHeaders = {
      ...rawFileHeaders({
        contentType: r.contentType,
        cacheControl: 'private, max-age=31536000, immutable',
        secFetchDest: c.req.header('sec-fetch-dest'),
        download: downloadName(c.req.query('download'), rel),
      }),
      'accept-ranges': 'bytes',
      ...(range
        ? {
            'content-range': `bytes ${range.offset}-${range.end}/${r.size}`,
            'content-length': String(range.length),
          }
        : { 'content-length': String(r.size) }),
    }
    return c.body(r.body, range ? 206 : 200, responseHeaders)
  }

  // This path form is deliberately a prefix rather than a query parameter:
  // relative URLs inside an opened artifact HTML document retain the workspace
  // identity automatically. The hosted router consumes the same segment before
  // this local route or authentication can run; this route then serves it only
  // when it names the workspace the request is bound to.
  app.get('/files/artifact/workspace/:workspace/:issueId/:artifactId/*', (c) => serve(c, 6))
  app.get('/files/artifact/:issueId/:artifactId/*', (c) => serve(c, 4))
}
