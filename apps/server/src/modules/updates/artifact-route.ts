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

  /**
   * Serve one platform's bundle, or nothing.
   *
   * A request for a platform this build did not mint is `not found` and NOT a fallback
   * to the host's bundle: handing a Mac a Linux tarball would fail its signature check
   * after a 200 MB download, which is a far worse answer than a 404 it can act on.
   */
  const serve = async (
    c: Context,
    requestedVersion: string,
    requestedPlatform: string | undefined,
  ) => {
    if (!(await deps.authenticate(c.req.raw, c))) return c.text('unauthorized', 401)

    const current = deps.current()
    if (!current || requestedVersion !== current.version) return c.text('not found', 404)

    const artifact = requestedPlatform
      ? current.artifacts.find((candidate) => candidate.platform === requestedPlatform)
      : // No platform in the URL is the pre-multi-platform form, which only ever named
        // this host's own bundle — `current.path` is still exactly that.
        { path: current.path }
    if (!artifact) return c.text('not found', 404)

    const opened = await open(artifact.path)
    if (!opened) return c.text('not found', 404)

    return c.body(opened.stream, 200, {
      'content-type': DEV_BUNDLE_CONTENT_TYPE,
      'content-length': String(opened.size),
      'cache-control': 'no-store',
    })
  }

  app.get('/updates/dev-bundle/:version/:platform', async (c) =>
    serve(
      c,
      decodeURIComponent(c.req.param('version')),
      decodeURIComponent(c.req.param('platform')),
    ),
  )

  // Kept for a daemon still holding a URL minted before one build published several
  // platforms. It serves the host's bundle, which is what that URL always meant.
  app.get('/updates/dev-bundle/:version', async (c) =>
    serve(c, decodeURIComponent(c.req.param('version')), undefined),
  )
}
