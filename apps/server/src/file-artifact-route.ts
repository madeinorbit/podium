// apps/server/src/file-artifact-route.ts
import type { Hono } from 'hono'

/** The store face the route needs (IssueArtifactStore, structurally). */
export interface ArtifactBundleReader {
  read(
    issueId: string,
    artifactId: string,
    relPath: string,
  ): Promise<{ bytes: Buffer; contentType: string } | null>
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
    const r = await store.read(issueId, artifactId, rel)
    if (!r) return c.text('not found', 404)
    return c.body(new Uint8Array(r.bytes), 200, {
      'content-type': r.contentType,
      'cache-control': 'private, max-age=31536000, immutable',
    })
  })
}
