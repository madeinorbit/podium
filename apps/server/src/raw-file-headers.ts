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
 * The sandbox rides HTML always, and any type the browser is loading as a
 * top-level document (`Sec-Fetch-Dest: document`) — which is how an SVG, the
 * other scriptable type here, becomes a page. Subresource loads (`<img src>` in
 * the markdown preview) are left alone, so embedding behaviour is unchanged.
 */
export function rawFileHeaders(args: {
  contentType: string
  cacheControl: string
  secFetchDest?: string | undefined
}): Record<string, string> {
  const { contentType, cacheControl, secFetchDest } = args
  const asDocument = isHtml(contentType) || secFetchDest === 'document'
  return {
    'content-type': contentType,
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff',
    ...(asDocument ? { 'content-security-policy': DOCUMENT_SANDBOX } : {}),
  }
}
