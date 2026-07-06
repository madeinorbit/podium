import { resolveAgainstCwd } from './file-path'
import type { FileScope } from './file-scope'

/**
 * Build a URL that serves a markdown-relative asset (image) through the server's
 * /files/asset route, scoped to a session. `fileDir` is the directory of the .md
 * file. Returns null for sources that should be left untouched (remote / data).
 */
export function assetUrl(args: {
  httpOrigin: string
  sessionId: string
  fileDir: string
  src: string
}): string | null {
  const { httpOrigin, sessionId, fileDir, src } = args
  if (/^(https?:|data:|blob:|\/\/)/i.test(src)) return null
  const abs = src.startsWith('/') ? src : resolveAgainstCwd(fileDir, src)
  const qs = new URLSearchParams({ sessionId, path: abs })
  return `${httpOrigin.replace(/\/+$/, '')}/files/asset?${qs.toString()}`
}

export function scopedAssetUrl(args: {
  httpOrigin: string
  scope: FileScope
  fileDir: string
  src: string
}): string | null {
  const { httpOrigin, scope, fileDir, src } = args
  if (/^(https?:|data:|blob:|\/\/)/i.test(src)) return null
  if (scope.kind === 'session')
    return assetUrl({ httpOrigin, sessionId: scope.sessionId, fileDir, src })

  const abs = src.startsWith('/') ? src : resolveAgainstCwd(fileDir, src)
  const qs = new URLSearchParams({ root: scope.root, path: abs })
  if (scope.machineId) qs.set('machineId', scope.machineId)
  return `${httpOrigin.replace(/\/+$/, '')}/files/asset?${qs.toString()}`
}
