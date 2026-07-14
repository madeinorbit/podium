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
  if (scope.kind === 'artifact') {
    // Artifact snapshots ([spec:SP-0fc9] #441): resolve inside the artifact dir
    // and serve from the permanent /files/artifact store. Escapes (`..` above
    // the artifact root) are refused, mirroring the server's traversal guard.
    const rel = resolveArtifactRel(fileDir, src)
    if (rel === null) return null
    const relEnc = rel.split('/').map(encodeURIComponent).join('/')
    const origin = httpOrigin.replace(/\/+$/, '')
    return `${origin}/files/artifact/${encodeURIComponent(scope.issueId)}/${encodeURIComponent(scope.artifactId)}/${relEnc}`
  }

  const abs = src.startsWith('/') ? src : resolveAgainstCwd(fileDir, src)
  const qs = new URLSearchParams({ root: scope.root, path: abs })
  if (scope.machineId) qs.set('machineId', scope.machineId)
  return `${httpOrigin.replace(/\/+$/, '')}/files/asset?${qs.toString()}`
}

/** Resolve `src` against `fileDir`, both relative to the artifact dir root.
 *  A leading `/` on `src` means the artifact root. Null = escapes the root. */
function resolveArtifactRel(fileDir: string, src: string): string | null {
  const joined = src.startsWith('/') ? src : `${fileDir}/${src}`
  const out: string[] = []
  for (const seg of joined.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return null
      out.pop()
    } else out.push(seg)
  }
  return out.length === 0 ? null : out.join('/')
}
