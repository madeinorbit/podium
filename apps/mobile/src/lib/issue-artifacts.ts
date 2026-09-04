import { artifactKind, artifactUrl, basename } from '@podium/client-core/viewmodels'
import type { IssuePanelArtifact, IssueWire } from '@podium/model'

export type IssueArtifactPreview = 'image' | 'video' | 'html' | 'markdown' | 'text' | 'file'

const TEXT_EXTS = new Set(['txt', 'json', 'ts', 'tsx', 'js', 'jsx', 'css', 'svg', 'log', 'csv'])

export function issueArtifactHref(
  issue: IssueWire,
  artifact: IssuePanelArtifact,
  httpOrigin: string,
): string | null {
  const root = issue.worktreePath ?? issue.repoPath
  return artifactUrl({
    httpOrigin,
    issueId: issue.id,
    artifact,
    ...(root ? { root } : {}),
    ...(issue.machineId ? { machineId: issue.machineId } : {}),
  })
}

export function issueArtifactPreview(path: string): IssueArtifactPreview {
  const kind = artifactKind(path)
  if (kind === 'image' || kind === 'video') return kind
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'file'
}

export function issueArtifactLabel(artifact: IssuePanelArtifact): string {
  return artifact.title ?? basename(artifact.entry ?? artifact.path)
}

/**
 * Anchor fetched artifact HTML before it renders from a `data:` document.
 *
 * The native app authenticates /files/* with a bearer header, and a WebView's
 * own document request cannot carry one — so the HTML is fetched through the
 * authenticated fetch path and handed to the WebView inline. A data: document
 * has no base URL, which would silently break every relative src/href in an
 * artifact bundle, so the artifact's own URL is injected as `<base>` unless the
 * document already declares one. Insertion respects the parser: after `<head>`
 * when present, after the doctype otherwise — prepending before `<!doctype>`
 * would drop the page into quirks mode.
 */
export function htmlWithBase(html: string, baseUrl: string): string {
  if (/<base[\s/>]/i.test(html)) return html
  const tag = `<base href="${baseUrl.replace(/"/g, '&quot;')}">`
  const insertAfter = (m: RegExpMatchArray | null): string | null => {
    if (!m || m.index === undefined) return null
    const at = m.index + m[0].length
    return html.slice(0, at) + tag + html.slice(at)
  }
  return (
    insertAfter(html.match(/<head(?:\s[^>]*)?>/i)) ??
    insertAfter(html.match(/^\s*<!doctype[^>]*>/i)) ??
    tag + html
  )
}

/**
 * Drop a trailing half-written tag from a document that was cut at a byte cap.
 *
 * A cap slices wherever the byte count runs out — including in the middle of
 * `<div class="`. HTML has no error for that: the parser keeps consuming the
 * rest of the document as attribute text, and since there is no rest, the
 * markup after the cut simply never becomes elements. On a page whose visible
 * content happens to live past the cut that renders as a WHITE, EMPTY frame —
 * indistinguishable from "the artifact did not open". Ending on the last
 * complete tag keeps the prefix a real document that shows what it has.
 */
export function endAtTagBoundary(html: string): string {
  const lastOpen = html.lastIndexOf('<')
  const lastClose = html.lastIndexOf('>')
  return lastOpen > lastClose ? html.slice(0, lastOpen) : html
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** UTF-8 → base64 `data:text/html` URI. Hermes has neither Buffer nor btoa,
 *  hence the hand-rolled (and hermetically testable) encoder. */
export function htmlDataUri(html: string): string {
  const bytes = new TextEncoder().encode(html)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    out += B64.charAt(a >> 2) + B64.charAt(((a & 3) << 4) | (b >> 4))
    out += i + 1 < bytes.length ? B64.charAt(((b & 15) << 2) | (c >> 6)) : '='
    out += i + 2 < bytes.length ? B64.charAt(c & 63) : '='
  }
  return `data:text/html;charset=utf-8;base64,${out}`
}
