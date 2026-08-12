import type { Hono } from 'hono'
import type { Context } from 'hono'
import type { BuiltDevBundle } from './dev-bundle'

export const DEV_BUNDLE_CONTENT_TYPE = 'application/gzip'

export interface DevArtifactRouteDeps {
  /** The last successful build only; a failed build must not become readable. */
  current(): BuiltDevBundle | null
  /** Machine authentication is mandatory, even when the human UI is open-mode. */
  authenticate(request: Request, context: Context): boolean | Promise<boolean>
}

/**
 * Serve exactly the bytes that were read and hashed by buildDevBundle. The route
 * authenticates before looking up the requested version and then compares the
 * URL label with the current build, so stale files cannot be served after a new
 * target is published.
 */
export function registerDevArtifactRoute(app: Hono, deps: DevArtifactRouteDeps): void {
  app.get('/updates/dev-bundle/:version', async (c) => {
    if (!(await deps.authenticate(c.req.raw, c))) return c.text('unauthorized', 401)

    const requested = decodeURIComponent(c.req.param('version'))
    const current = deps.current()
    if (!current || requested !== current.version) return c.text('not found', 404)

    try {
      return c.body(current.bytes, 200, {
        'content-type': DEV_BUNDLE_CONTENT_TYPE,
        'cache-control': 'no-store',
      })
    } catch {
      return c.text('not found', 404)
    }
  })
}
