// apps/server/src/file-artifact-route.ts
import { type ArtifactId, asArtifactId, asIssueId, type IssueId } from '@podium/model'
import { TRPCError } from '@trpc/server'
import type { Hono } from 'hono'
import { parseByteRange, type ResolvedByteRange, resolveByteRange } from './http-byte-range'
import { downloadName, rawFileHeaders } from './raw-file-headers'

const MAX_RANGE_BYTES = 10 * 1024 * 1024

/**
 * THE ONE ARTIFACT DOOR — `FileAccessGate.readArtifact`, structurally (PDM-261).
 *
 * This is deliberately NOT the artifact store. The route used to be handed
 * `IssueArtifactStore` itself, and a store cannot refuse: it answers for any
 * issue id in the path because an issue id is all it is given. Taking the
 * gate's own method instead means there is no second way to the bytes from
 * here, so the authorization is not something this handler can forget to run —
 * the same property `FileState = { files: FileAccessGate }` bought for the tRPC
 * side, argued in `modules/files/file-access-gate.ts`.
 */
export interface ArtifactDoor {
  readArtifact(
    issueId: IssueId,
    artifactId: ArtifactId,
    relPath: string,
    range?: { offset: number; length: number },
  ): Promise<{ bytes: Buffer; contentType: string; size: number } | null>
}

/** The door bound to ONE caller, resolved per request. */
export interface ArtifactRouteAccess {
  /**
   * This request's artifact door, or `undefined` when no principal can be
   * resolved from it — which the route answers 401, the same as any other
   * unauthenticated read.
   *
   * A FUNCTION OF THE REQUEST, not a value captured at registration. A gate is
   * bound to one caller by construction, so a route serving many callers cannot
   * hold one: capturing a gate here would authorize every later request as
   * whoever happened to arrive first.
   */
  doorFor(request: Request): Promise<ArtifactDoor | undefined>
}

/**
 * HOW A REFUSAL FROM THE GATE BECOMES A RESPONSE.
 *
 * The gate throws `TRPCError` because it is shared with the tRPC reads, and its
 * codes carry decisions this route must not flatten. In particular
 * `checkIssueAccess` answers an owned-scope caller NOT_FOUND rather than
 * FORBIDDEN precisely so the surface is not an existence oracle over other
 * people's issues — mapping that to 403 would undo the distinction the
 * predicate went to trouble to make.
 *
 * THE BODIES ARE THE ROUTE'S OWN WORDS, not the error's. `checkIssueAccess`
 * names the issue it refused ("unknown issue iss_x"), which is fine inside an
 * authenticated tRPC error payload and is a needless detail on a raw byte
 * route. 404 here is spelled exactly as the missing-artifact 404 below it, so
 * "you may not read this issue" and "there is no such file" are one answer.
 *
 * PRECONDITION_FAILED IS UNREACHABLE TODAY AND NOTHING WITNESSES IT — said out
 * loud rather than left for the next reader to discover, because an unexercised
 * branch that looks exercised is worse than an absent one. `checkIssueAccess` is
 * called here with the `read` action against an ISSUE target, and no member of
 * the closed `IssueScope` set answers `confirm-required` for that pair: D20.2's
 * issue-read short-circuit allows before the scope arm is reached, and `owned`
 * and `self` are `forbidden` and deliberately not override-liftable. The route's
 * own principal source narrows it further, minting only `all` and `owned`.
 *
 * It is KEPT anyway, and that is the third honest option rather than laziness —
 * see PDM-134, which kept a redundant filter and wrote down that nothing
 * witnessed it. The alternative is worse in the one direction that matters: drop
 * the row and a future `confirm-required` on a read falls through to the rethrow
 * below and reaches the caller as a 500, turning a policy answer into an
 * incident. 412 degrades safely; a 500 does not. Delete this row only together
 * with a check that the model still cannot produce the code.
 */
const REFUSALS: Record<string, { status: 401 | 403 | 404 | 412; body: string }> = {
  UNAUTHORIZED: { status: 401, body: 'unauthorized' },
  FORBIDDEN: { status: 403, body: 'forbidden' },
  NOT_FOUND: { status: 404, body: 'not found' },
  PRECONDITION_FAILED: { status: 412, body: 'issue is outside your scope' },
}

/**
 * Serve permanent-store artifact snapshots ([spec:SP-0fc9] #441):
 * GET /files/artifact/<issueId>/<artifactId>/<relpath...>. Path-style so a
 * bundle's HTML entry resolves relative src/href to sibling files. Server-local
 * read — no daemon round-trip, works with the owning machine offline. Content is
 * immutable under a given artifactId (re-add mints a new id), hence the
 * immutable cache-control.
 *
 * AUTHORIZATION, AND WHY THE OLD COMMENT HERE WAS THE BUG (PDM-261). It used to
 * read "Auth matches the rest of /files/* (clientAuthGuard in server.ts)". That
 * is a true sentence about AUTHENTICATION and it was standing in for a sentence
 * about authorization that nothing in this file had ever made true: the guard
 * establishes that the caller is signed in and says nothing about whether these
 * particular bytes are theirs, so any signed-in member could fetch any issue's
 * artifacts by naming its id. The route now reads through `FileAccessGate`,
 * which asks `checkIssueAccess` — the same ONE issue-access rule `files.read`
 * runs over these same bytes on the tRPC side. `clientAuthGuard` still runs in
 * front of it and is still worth having; it is simply not this question.
 */
export function registerArtifactRoute(app: Hono, access: ArtifactRouteAccess): void {
  app.get('/files/artifact/:issueId/:artifactId/*', async (c) => {
    const issueId = c.req.param('issueId')
    const artifactId = c.req.param('artifactId')
    // ['files','artifact',issueId,artifactId, ...relpath segments]
    const rel = c.req.path.split('/').filter(Boolean).slice(4).map(decodeURIComponent).join('/')
    if (!rel) return c.text('bad request', 400)
    const requestedRange = parseByteRange(c.req.header('range'))
    if (requestedRange === 'invalid') return c.body(null, 416)
    const door = await access.doorFor(c.req.raw)
    if (!door) return c.text('unauthorized', 401)
    const read = async (range?: { offset: number; length: number }) =>
      await door.readArtifact(asIssueId(issueId), asArtifactId(artifactId), rel, range)
    let range: ResolvedByteRange | null = null
    let r: Awaited<ReturnType<ArtifactDoor['readArtifact']>>
    try {
      if (requestedRange?.kind === 'suffix') {
        const probe = await read({ offset: 0, length: 1 })
        if (!probe) return c.text('not found', 404)
        const resolved = resolveByteRange(requestedRange, probe.size, MAX_RANGE_BYTES)
        if (resolved === 'unsatisfiable') {
          return c.body(null, 416, { 'content-range': `bytes */${probe.size}` })
        }
        range = resolved
        r = await read({ offset: range.offset, length: range.length })
      } else if (requestedRange) {
        const tentative = {
          offset: requestedRange.start,
          length:
            requestedRange.end === undefined
              ? MAX_RANGE_BYTES
              : Math.min(requestedRange.end - requestedRange.start, MAX_RANGE_BYTES - 1) + 1,
        }
        r = await read(tentative)
        if (!r) return c.text('not found', 404)
        const resolved = resolveByteRange(requestedRange, r.size, MAX_RANGE_BYTES)
        if (resolved === 'unsatisfiable') {
          return c.body(null, 416, { 'content-range': `bytes */${r.size}` })
        }
        range = resolved
      } else {
        r = await read()
      }
    } catch (err) {
      // Only a refusal the gate states is turned into a status. Anything else —
      // a store failure, a bug — keeps propagating to the server's error
      // handling rather than being laundered into a tidy 404 here.
      const refusal = err instanceof TRPCError ? REFUSALS[err.code] : undefined
      if (!refusal) throw err
      return c.text(refusal.body, refusal.status)
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
        download: downloadName(c.req.query('download'), rel),
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
