import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { Context, Hono } from 'hono'
import type { BuiltDevBundle } from './dev-bundle'

export const DEV_BUNDLE_CONTENT_TYPE = 'application/gzip'

export interface OpenedDevBundle {
  stream: ReadableStream
  size: number
}

export interface DevArtifactRouteDeps {
  /** The last successful build only; a failed build must not become readable. */
  current(): BuiltDevBundle | null
  /** Machine authentication is mandatory, even when the human UI is open-mode. */
  authenticate(request: Request, context: Context): boolean | Promise<boolean>
  /** Seam for tests; defaults to a read stream over the published path. */
  open?(path: string): Promise<OpenedDevBundle | null>
}

/**
 * Open the published artifact as a stream, or nothing.
 *
 * Nothing is a normal outcome, not an error: retention may have reclaimed the
 * file, or the checkout may have been cleaned, between publication and this
 * request. Either way the honest answer to the daemon is "not here", so it can
 * ask again and get the current target.
 */
async function openDevBundle(path: string): Promise<OpenedDevBundle | null> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return null
    // node:stream/web's ReadableStream and the global one are the same object at
    // runtime and separate declarations to the compiler.
    const stream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream
    return { stream, size: info.size }
  } catch {
    return null
  }
}

/**
 * Serve the published development bundle by streaming it off disk.
 *
 * The route authenticates before looking up the requested version and then
 * compares the URL label with the current build, so a superseded artifact
 * cannot be served after a new target is published.
 *
 * NOTHING IS BUFFERED. A headless bundle is ~264 MB and this server shares its
 * host with the daemon and every agent session; reading one into the heap to
 * answer a request — or to hold it between requests — is a cost the development
 * host cannot absorb. Integrity does not depend on buffering either: the digest
 * and signature the daemon checks are computed over the file at publication,
 * and the daemon verifies both end to end before it swaps anything in. A
 * truncated or altered download fails there, which is where it must fail
 * anyway, since the network sits between the two.
 */
export function registerDevArtifactRoute(app: Hono, deps: DevArtifactRouteDeps): void {
  const open = deps.open ?? openDevBundle

  app.get('/updates/dev-bundle/:version', async (c) => {
    if (!(await deps.authenticate(c.req.raw, c))) return c.text('unauthorized', 401)

    const requested = decodeURIComponent(c.req.param('version'))
    const current = deps.current()
    if (!current || requested !== current.version) return c.text('not found', 404)

    const opened = await open(current.path)
    if (!opened) return c.text('not found', 404)

    return c.body(opened.stream, 200, {
      'content-type': DEV_BUNDLE_CONTENT_TYPE,
      'content-length': String(opened.size),
      'cache-control': 'no-store',
    })
  })
}
