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
import type { ServerMode } from './server-mode'
import { boundWorkspaceOf, type ServedWorkspace } from './workspace-edge'

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

/** A process that loaded one workspace has that workspace's artifact store. */
export function workspaceArtifacts(
  loaded: WorkspaceId,
  store: ArtifactStreamReader,
): WorkspaceArtifacts {
  return (workspaceId) => (workspaceId === loaded ? store : undefined)
}

/** How a request is tied to a workspace (POD-6963 design 2.7). */
export interface RequestWorkspaceBinding {
  /** The workspace whose store serves the request. Never derived from the path. */
  readonly bound: (c: Context) => WorkspaceId
  /** Whether the request may name `segment` in `/files/artifact/workspace/<segment>/`. */
  readonly mayName: (c: Context, segment: string) => boolean
}

/**
 * THE EDGE'S BINDING (POD-7309): the store is the bound workspace's
 * (workspace-edge.ts), whatever the path says.
 *
 * On hosted the path segment is a selector the edge already read, so it names
 * the bound workspace by id or slug, or the request was refused; checking it
 * again here keeps the route closed on its own. A self-hosted server reads no
 * selector: the segment is a router's in front of it (today's per-tenant
 * hosted machines put their page's slug there), so any segment is accepted.
 */
export function edgeWorkspaceBinding(
  mode: ServerMode,
  served: readonly Pick<ServedWorkspace, 'id' | 'slug'>[],
): RequestWorkspaceBinding {
  return {
    bound: (c) => boundWorkspaceOf(c.req.raw),
    mayName: (c, segment) => {
      if (mode === 'self-hosted') return true
      const bound = boundWorkspaceOf(c.req.raw)
      return served.some(
        (workspace) =>
          workspace.id === bound && (segment === workspace.id || segment === workspace.slug),
      )
    },
  }
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
 * Serve permanent-store artifact snapshots (#441):
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
  binding: RequestWorkspaceBinding,
): void {
  const serve = async (c: Context, relStart: number): Promise<Response> => {
    const issueId = c.req.param('issueId')
    const artifactId = c.req.param('artifactId')
    if (!issueId || !artifactId) return c.text('bad request', 400)
    // Hono decodes route params; an undecodable one reaches the seam raw.
    const pathWorkspace = c.req.param('workspace')
    if (pathWorkspace !== undefined && !binding.mayName(c, pathWorkspace)) {
      return c.text('not found', 404)
    }
    const store = artifactsOf(binding.bound(c))
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
  // this local route or authentication can run; `binding.mayName` decides
  // whether this server answers for it.
  app.get('/files/artifact/workspace/:workspace/:issueId/:artifactId/*', (c) => serve(c, 6))
  app.get('/files/artifact/:issueId/:artifactId/*', (c) => serve(c, 4))
}
