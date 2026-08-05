import type { FileScope } from '@podium/client-core/viewmodels'
import { scopedAssetUrl } from '@/lib/asset-url'

/**
 * The URL that serves this file's own bytes over HTTP, with a real content-type —
 * what "Open in browser" hands to a new tab, so an .html file renders as a page
 * instead of as the panel's script-stripped preview.
 *
 * Splitting on the last slash lets `scopedAssetUrl` do the routing: session and
 * worktree scopes go to `/files/asset`, artifact snapshots to their path-style
 * `/files/artifact` route (with its traversal guard, hence the null).
 */
export function rawFileUrl(args: {
  httpOrigin: string
  scope: FileScope
  path: string
}): string | null {
  const { httpOrigin, scope, path } = args
  const slash = path.lastIndexOf('/')
  // Artifact-scope paths are relpaths: a slash-less entry sits at the artifact root.
  const fileDir = slash === -1 ? '' : path.slice(0, slash) || '/'
  const name = slash === -1 ? path : path.slice(slash + 1)
  if (!name) return null
  return scopedAssetUrl({ httpOrigin, scope, fileDir, src: name })
}
