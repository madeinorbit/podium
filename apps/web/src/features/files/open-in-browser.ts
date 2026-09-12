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
  workspace?: string
}): string | null {
  const { httpOrigin, scope, path } = args
  const slash = path.lastIndexOf('/')
  // Artifact-scope paths are relpaths: a slash-less entry sits at the artifact root.
  const fileDir = slash === -1 ? '' : path.slice(0, slash) || '/'
  const name = slash === -1 ? path : path.slice(slash + 1)
  if (!name) return null
  return scopedAssetUrl({ httpOrigin, scope, fileDir, src: name, workspace: args.workspace })
}

/**
 * The same bytes as `rawFileUrl`, served as an attachment (`download=1`), plus the
 * name the browser should save under — the file's basename, which is also what the
 * server puts in Content-Disposition.
 */
export function downloadFileUrl(args: {
  httpOrigin: string
  scope: FileScope
  path: string
  workspace?: string
}): { url: string; name: string } | null {
  const raw = rawFileUrl(args)
  if (!raw) return null
  const name = args.path.slice(args.path.lastIndexOf('/') + 1)
  return { url: `${raw}${raw.includes('?') ? '&' : '?'}download=1`, name }
}
