// apps/server/src/file-asset-route.ts

import { asSessionId, type MachineId, asMachineId } from '@podium/model'
import { TRPCError } from '@trpc/server'
import type { Hono } from 'hono'
import { parseByteRange, type ResolvedByteRange, resolveByteRange } from './http-byte-range'
import type { FileAccessGate } from './modules/files/file-access-gate'
import { downloadName, rawFileHeaders } from './raw-file-headers'

/**
 * THE TWO DOORS THIS ROUTE HAS, AND NOTHING ELSE (PDM-262).
 *
 * This used to be an `AssetReader` with `readAsset` and `allowsRoot` on it, and
 * the defect was not that the handler forgot a check — it was that there was
 * NOWHERE TO PUT ONE. `readAsset` took a locator and returned bytes;
 * `allowsRoot` took a path and a machine. Neither had an argument for the person
 * asking, so the session arm asked nothing at all and the root arm asked a
 * question about paths and called it authorization.
 *
 * A `Pick` of the `FileAccessGate` PDM-272 built, so the fix is not a second
 * predicate that has to be kept in step with the tRPC one: it is the same
 * object, pre-bound to this request's caller, that `files.read` addresses. The
 * route can no longer SPELL an unauthorized read — there is no `readAsset` in
 * its seam to reach for, and no allowlist boolean to forget.
 */
export type AssetGate = Pick<FileAccessGate, 'readSessionAsset' | 'readRootAsset'>

/**
 * THIS REQUEST'S CALLER, RESOLVED BY THE COMPOSITION ROOT.
 *
 * `undefined` means no principal could be resolved, which is a 401 and not an
 * empty-handed read. `/files/*` already sits behind `clientAuthGuard`, so this
 * should be unreachable in the assembled server — it is still handled rather
 * than asserted away, because "something upstream already rejects this" is a
 * convention about wiring and this file cannot see the wiring.
 */
export type AssetGateForRequest = (request: Request) => Promise<AssetGate | undefined>

const MAX_RANGE_BYTES = 10 * 1024 * 1024

/** Both halves always set — every call site below passes a resolved pair. The
 *  spelling matches `readArtifact`'s, adopted on PDM-261's precedent rather
 *  than re-decided; see the gate header. */
type AssetRange = { offset: number; length: number }
type AssetResult = Awaited<ReturnType<AssetGate['readSessionAsset']>>

/** A gate refusal is a domain answer; this is the only place it becomes a status.
 *  NOT_FOUND stays NOT_FOUND for the session arm on purpose — see
 *  `readSessionAsset`'s note on why 403 would be an existence oracle for
 *  somebody else's session id. */
const refusalStatus = (error: unknown): 403 | 404 | undefined => {
  if (!(error instanceof TRPCError)) return undefined
  if (error.code === 'FORBIDDEN') return 403
  if (error.code === 'NOT_FOUND') return 404
  return undefined
}

/** Serve a checkout file as raw bytes: the markdown preview's images, and the file
 *  viewer's Open in browser, which points a real browser tab here. Worktree variant
 *  (`root` [+ `machineId`] instead of `sessionId`) serves issue-panel artifacts from
 *  a worktree checkout. Both arms authorize through the gate: a session read asks
 *  whether this caller may read THAT SESSION, and a root read asks the root
 *  allowlist and then whether this caller may use the machine that serves it. The
 *  daemon still enforces the path sandbox beneath both. */
export function registerAssetRoute(app: Hono, gateFor: AssetGateForRequest): void {
  app.get('/files/asset', async (c) => {
    const sessionId = c.req.query('sessionId')
    const root = c.req.query('root')
    const machineId = c.req.query('machineId')
    const path = c.req.query('path')
    if ((!sessionId && !root) || !path) return c.text('bad request', 400)
    const parsedMachineId: MachineId | undefined = machineId ? asMachineId(machineId) : undefined

    const gate = await gateFor(c.req.raw)
    if (!gate) return c.text('unauthorized', 401)

    // ONE spelling of the read, bound once, so a ranged retry cannot address a
    // different resource than the one the first call authorized.
    const read = async (range?: AssetRange): Promise<AssetResult> =>
      sessionId
        ? await gate.readSessionAsset(asSessionId(sessionId), path, range)
        : await gate.readRootAsset(root as string, path, parsedMachineId, range)

    const requestedRange = parseByteRange(c.req.header('range'))
    if (requestedRange === 'invalid') return c.body(null, 416)

    let range: ResolvedByteRange | null = null
    let r: AssetResult
    try {
      if (requestedRange?.kind === 'suffix') {
        const probe = await read({ offset: 0, length: 1 })
        if (!probe.ok) return c.text(probe.error ?? 'not found', probe.tooLarge ? 413 : 404)
        if (probe.size === undefined) return c.text('asset size unavailable', 500)
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
        if (!r.ok) return c.text(r.error ?? 'not found', r.tooLarge ? 413 : 404)
        if (r.size === undefined) return c.text('asset size unavailable', 500)
        const resolved = resolveByteRange(requestedRange, r.size, MAX_RANGE_BYTES)
        if (resolved === 'unsatisfiable') {
          return c.body(null, 416, { 'content-range': `bytes */${r.size}` })
        }
        range = resolved
      } else {
        r = await read()
      }
    } catch (error) {
      const status = refusalStatus(error)
      if (status === undefined) throw error
      return c.text(status === 403 ? 'forbidden' : 'not found', status)
    }

    if (!r.ok) return c.text(r.error ?? 'not found', r.tooLarge ? 413 : 404)
    if (r.dataBase64 == null) return c.text(r.error ?? 'not found', 404)
    const bytes = Buffer.from(r.dataBase64, 'base64')
    if (range && (bytes.length === 0 || (r.size !== undefined && range.offset >= r.size))) {
      return c.body(null, 416, { 'content-range': `bytes */${r.size ?? '*'}` })
    }
    const responseHeaders: Record<string, string> = {
      ...rawFileHeaders({
        contentType: r.contentType ?? 'application/octet-stream',
        cacheControl: 'no-cache',
        secFetchDest: c.req.header('sec-fetch-dest'),
        download: downloadName(c.req.query('download'), path),
      }),
      'accept-ranges': 'bytes',
      ...(range
        ? {
            'content-range': `bytes ${range.offset}-${range.offset + bytes.length - 1}/${r.size ?? '*'}`,
            'content-length': String(bytes.length),
          }
        : {}),
    }
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer
    return range ? c.body(body, 206, responseHeaders) : c.body(body, 200, responseHeaders)
  })
}
