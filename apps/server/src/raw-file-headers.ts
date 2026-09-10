// apps/server/src/raw-file-headers.ts

/**
 * The sandbox a repo/artifact document gets when a browser renders it as a page.
 *
 * `allow-same-origin` is deliberately absent: the document lands in an opaque
 * origin, so an .html file that happens to sit in a checkout cannot read the
 * app's storage or ride the (httpOnly, SameSite=Lax) session cookie into /trpc.
 * Everything a standalone page legitimately needs stays granted — its own
 * scripts, forms, dialogs, popups, downloads, and navigating its own tab.
 * Mirrors the stance the HTML panel's preview iframe already takes.
 */
const DOCUMENT_SANDBOX =
  'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-top-navigation-by-user-activation'

function isHtml(contentType: string): boolean {
  return /^text\/html\b/i.test(contentType)
}

/**
 * Response headers for raw bytes served out of a checkout or an artifact snapshot
 * (`/files/asset`, `/files/artifact`).
 *
 * `download` names the file the browser should save as (`?download=1` on the
 * routes; the caller passes the basename). It turns the response into an
 * attachment, which is what makes a download link work from a page on ANOTHER
 * origin (browsers ignore `<a download>` cross-origin) and from the desktop
 * webview. A saved file is never rendered as a page, so the sandbox is moot.
 *
 * The sandbox rides HTML always, and any type the browser is loading as a
 * top-level document (`Sec-Fetch-Dest: document`) — which is how an SVG, the
 * other scriptable type here, becomes a page. Subresource loads (`<img src>` in
 * the markdown preview) are left alone, so embedding behaviour is unchanged.
 */
export function rawFileHeaders(args: {
  contentType: string
  cacheControl: string
  secFetchDest?: string | undefined
  download?: string | undefined
}): Record<string, string> {
  const { contentType, cacheControl, secFetchDest, download } = args
  if (download) {
    return {
      'content-type': contentType,
      'cache-control': cacheControl,
      'x-content-type-options': 'nosniff',
      'content-disposition': attachmentDisposition(download),
    }
  }
  const asDocument = isHtml(contentType) || secFetchDest === 'document'
  return {
    'content-type': contentType,
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff',
    ...(asDocument ? { 'content-security-policy': DOCUMENT_SANDBOX } : {}),
  }
}

/**
 * RFC 6266 attachment with both a quoted ASCII fallback and, when the name
 * carries anything beyond ASCII, the UTF-8 `filename*` form modern browsers
 * prefer. Control characters cannot ride a header line at all, so they go.
 */
function attachmentDisposition(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const clean = name.replace(/[\x00-\x1f\x7f]/g, '')
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '\\$&')
  const disposition = `attachment; filename="${ascii}"`
  return /^[\x20-\x7e]*$/.test(clean)
    ? disposition
    : `${disposition}; filename*=UTF-8''${encodeURIComponent(clean)}`
}

/** The save-as name for a `?download=1` request, or undefined for an inline response. */
export function downloadName(query: string | undefined, path: string): string | undefined {
  if (!query || query === '0' || query === 'false') return undefined
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base || 'download'
}
