import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { Context, Hono } from 'hono'
import type { BuiltDevBundle } from './dev-bundle'
import { DEV_FEED_MANIFEST, DEV_FEED_ROUTE } from './release-target'

export const DEV_BUNDLE_CONTENT_TYPE = 'application/gzip'

/** The artifact leg of the dev feed, under {@link DEV_FEED_ROUTE}. */
export const DEV_FEED_ARTIFACT_SEGMENT = 'artifact'

export interface OpenedDevBundle {
  stream: ReadableStream
  size: number
}

export interface DevFeedRouteDeps {
  /** The last successful build only; a failed build must not become readable. */
  current(): BuiltDevBundle | null
  /**
   * Where the publisher wrote `podium-update.json`, or nothing on a server that
   * publishes no feed. Read per request rather than captured: the manifest is a
   * few hundred bytes and it changes underneath this process every publish.
   */
  manifestPath(): string | undefined
  /** Machine authentication is mandatory, even when the human UI is open-mode. */
  authenticate(request: Request, context: Context): boolean | Promise<boolean>
  /** Seam for tests; defaults to a read stream over the published path. */
  open?(path: string): Promise<OpenedDevBundle | null>
  /** Seam for tests; defaults to reading the file. */
  readManifest?(path: string): Promise<string | null>
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

async function readManifestFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * SERVE THE DEVELOPMENT FEED — a manifest and the artifacts it names.
 *
 * This used to be one route serving one pushed tarball. It is a FEED now (spec
 * §1, §6 step 4): the same two documents `resolveReleaseTarget` fetches from
 * GitHub for edge and stable, served by the source server for `dev`, so all
 * three channels resolve through one code path. Nothing about the dev channel
 * is special here except who signed the artifact and who is allowed to ask.
 *
 * AUTHENTICATED, 401-FIRST, ON BOTH LEGS (disposition 3). The manifest names
 * artifact URLs carrying this server's artifact token; handing it to an
 * unauthenticated caller would hand over the credential too. Authentication is
 * still not a substitute for verification — the daemon checks the digest and
 * the signature against its pinned key regardless.
 *
 * NOTHING IS BUFFERED on the artifact leg. A headless bundle is ~264 MB and
 * this server shares its host with the daemon and every agent session; reading
 * one into the heap to answer a request — or to hold it between requests — is a
 * cost the development host cannot absorb. Integrity does not depend on
 * buffering either: the digest and signature the daemon checks are computed over
 * the file at publication, and the daemon verifies both end to end before it
 * swaps anything in. A truncated or altered download fails there, which is where
 * it must fail anyway, since the network sits between the two.
 *
 * The platform is in the PATH because one build mints several bundles, and a
 * request for a platform this build did not mint is `not found` rather than a
 * fallback to the host's tarball — handing a Mac a Linux bundle would fail its
 * signature after a 200 MB download.
 */
export function registerDevFeedRoutes(app: Hono, deps: DevFeedRouteDeps): void {
  const open = deps.open ?? openDevBundle
  const readManifest = deps.readManifest ?? readManifestFile

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

  app.get(`${DEV_FEED_ROUTE}/${DEV_FEED_MANIFEST}`, async (c) => {
    if (!(await deps.authenticate(c.req.raw, c))) return c.text('unauthorized', 401)

    const path = deps.manifestPath()
    const body = path ? await readManifest(path) : null
    // Nothing published yet is a 404, not an empty manifest: the resolver's
    // "unavailable" reason should say the feed has nothing, never parse a
    // placeholder into a target with no artifacts.
    if (!body) return c.text('not found', 404)

    return c.body(body, 200, {
      'content-type': 'application/json',
      // The manifest is the one document a stale copy of would republish a
      // withdrawn release, so it is never cacheable — the same reason the
      // resolver asks for `no-store` at the other end.
      'cache-control': 'no-store',
    })
  })

  app.get(`${DEV_FEED_ROUTE}/${DEV_FEED_ARTIFACT_SEGMENT}/:version/:platform`, async (c) =>
    serve(
      c,
      decodeURIComponent(c.req.param('version')),
      decodeURIComponent(c.req.param('platform')),
    ),
  )

  // Kept for a daemon still holding a URL minted before one build published several
  // platforms. It serves the host's bundle, which is what that URL always meant.
  app.get(`${DEV_FEED_ROUTE}/${DEV_FEED_ARTIFACT_SEGMENT}/:version`, async (c) =>
    serve(c, decodeURIComponent(c.req.param('version')), undefined),
  )
}
