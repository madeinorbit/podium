/**
 * Phone entry routing [POD-102, POD-359]: the Expo app at /mobile is the only
 * mobile UX, so a phone browser asking for the web root `/` belongs there.
 *
 * Three front doors can answer that request and every one of them has to make
 * the SAME decision, or the redirect looks broken on exactly the devices that
 * took the other door:
 *   - the backend           — apps/server/src/static-web.ts registerMobileRouting
 *   - the Vite dev/preview  — apps/web/mobile-routing.ts
 *   - the browser itself    — apps/web/src/app/mobile-entry-redirect.ts, which
 *     re-checks after boot because an installed service worker can answer `/`
 *     from its precache before the server ever sees the navigation.
 *
 * They used to carry hand-copied heuristics that drifted apart (the server
 * required `Android.+Mobile`, the Vite door matched a bare `Android`, so an
 * Android tablet was redirected by one and not the other). This module is the
 * single definition.
 *
 * A phone's desktop session link (`/workspace?pane=<id>`) is the same problem
 * one level down [POD-4689]: the shell it loads drops the pane instead of
 * opening the session, so the same three doors answer it with
 * `mobileSessionRedirect` — `/mobile/session/<id>` — before they try the root
 * rule.
 */

/** Query parameter that suppresses the phone redirect for one navigation. */
export const DESKTOP_PARAM = 'desktop'

/**
 * Phone user agents — the devices the Expo mobile app targets. Android must say
 * `Mobile` (Android tablets do not), and the iPad/Tablet exclusion is a second
 * guard for UAs that claim `Mobile` on a big screen.
 */
const PHONE_UA = /Android.+Mobile|iPhone|iPod/i
const TABLET_UA = /iPad|Tablet/i

/**
 * Whether `search` carries `name` as a query KEY, valued or not.
 *
 * This is a hand-rolled `new URLSearchParams(search).has(name)` [POD-1124]:
 * `URLSearchParams` is an ambient global, and this package is the L0 root —
 * browser-safe, zod-only, and compiled from SOURCE under each consumer's
 * compilerOptions, so leaning on it forced every lean-lib consumer to widen its
 * own `lib` just to typecheck ours. Nothing here re-serialises the query; the
 * callers below still append raw, which is what keeps `?server=wss://…` intact.
 *
 * Matching URLSearchParams means: a leading `?` is optional, empty segments are
 * skipped, only the text before the first `=` is the key, `+` is a space, and a
 * malformed escape (`%ZZ`) is left as written rather than throwing.
 */
function hasQueryKey(search: string, name: string): boolean {
  const query = search.startsWith('?') ? search.slice(1) : search
  for (const segment of query.split('&')) {
    if (segment === '') continue
    const eq = segment.indexOf('=')
    const rawKey = eq === -1 ? segment : segment.slice(0, eq)
    if (decodeQueryComponent(rawKey) === name) return true
  }
  return false
}

/** `+`-as-space plus percent-decoding, leaving malformed escapes as written. */
function decodeQueryComponent(value: string): string {
  const spaced = value.replace(/\+/g, ' ')
  try {
    return decodeURIComponent(spaced)
  } catch {
    return spaced
  }
}

/** Whether this user agent is a phone (and not a tablet or a desktop). */
export function isPhoneUserAgent(userAgent: string | undefined | null): boolean {
  const ua = userAgent ?? ''
  return PHONE_UA.test(ua) && !TABLET_UA.test(ua)
}

export interface MobileEntryRequest {
  /** URL pathname, e.g. `/` or `/session/s1`. */
  pathname: string
  /** URL search string including the leading `?`, or `''`. */
  search: string
  userAgent: string | undefined | null
  /**
   * Whether the Expo bundle is actually there to serve. The mobile dist is
   * gitignored and built separately, so this is a live probe on the server —
   * see `mobileEntryRedirect`'s note for what the browser passes.
   */
  mobilePresent: boolean
}

/**
 * Where a request for the web root should be sent, or null to serve it as-is.
 * Deep links (`/session/xyz`) and `?desktop` are never redirected, and the
 * query string is carried over verbatim so `?server=wss://…` keeps its encoding.
 */
export function mobileEntryRedirect(req: MobileEntryRequest): string | null {
  if (!req.mobilePresent) return null
  if (req.pathname !== '/') return null
  if (hasQueryKey(req.search, DESKTOP_PARAM)) return null
  if (!isPhoneUserAgent(req.userAgent)) return null
  return '/mobile' + req.search
}

/**
 * The FIRST `value` for query KEY `name`, or null when the key is absent.
 *
 * Mirrors `new URLSearchParams(search).get(name)` the way `hasQueryKey` mirrors
 * `.has(name)` (see above for why this package hand-rolls it): a leading `?`
 * is optional, empty segments are skipped, only the text before the first `=`
 * is the key, a bare key reads as `''`, `+` is a space, and a malformed escape
 * is left as written rather than throwing.
 */
function firstQueryValue(search: string, name: string): string | null {
  const query = search.startsWith('?') ? search.slice(1) : search
  for (const segment of query.split('&')) {
    if (segment === '') continue
    const eq = segment.indexOf('=')
    const rawKey = eq === -1 ? segment : segment.slice(0, eq)
    if (decodeQueryComponent(rawKey) !== name) continue
    return decodeQueryComponent(eq === -1 ? '' : segment.slice(eq + 1))
  }
  return null
}

/**
 * The request's query segments that survive a hop to the phone app, byte-for-
 * byte: everything except the desktop workspace selector (`wt`) and the pane
 * the redirect consumes into the path. `?server=wss://…` keeps its encoding
 * for the same reason `mobileEntryRedirect` carries the query verbatim.
 */
function phoneSessionQuery(search: string): string {
  const query = search.startsWith('?') ? search.slice(1) : search
  const kept = query.split('&').filter((segment) => {
    if (segment === '') return false
    const eq = segment.indexOf('=')
    const key = decodeQueryComponent(eq === -1 ? segment : segment.slice(0, eq))
    return key !== 'pane' && key !== 'wt'
  })
  return kept.length > 0 ? `?${kept.join('&')}` : ''
}

/**
 * Where a phone's desktop session link should be sent, or null to serve it
 * as-is [POD-4689].
 *
 * A phone opening `/workspace?pane=<id>` loaded the desktop shell (the root
 * rule above only answers `/`), which at phone width rewrote the URL to
 * `/workspace?wt=<repo>` with no `pane=` and showed the New task composer —
 * the linked session never opened. The phone app opens the same session at
 * `/mobile/session/<id>`, so the link is sent there instead.
 *
 * Both `/workspace` and `/` are the workspace view (the router reads `pane`
 * on either), so both are answered; the callers check this BEFORE the root
 * rule so a `/?pane=<id>` lands on the session rather than on `/mobile?pane=`
 * (which would drop it the same way). Full ids, short-id prefixes and birth
 * refs all redirect — the phone resolves them through the server's own rule —
 * while file tabs (`file:…`, which the phone has no screen for) and an empty
 * or absent `pane` stay put, as do `?desktop`, non-phones and a missing Expo
 * build. Desktop keeps its adopt-then-wait path (POD-4642) untouched.
 */
export function mobileSessionRedirect(req: MobileEntryRequest): string | null {
  if (!req.mobilePresent) return null
  if (req.pathname !== '/workspace' && req.pathname !== '/') return null
  if (hasQueryKey(req.search, DESKTOP_PARAM)) return null
  if (!isPhoneUserAgent(req.userAgent)) return null
  const pane = firstQueryValue(req.search, 'pane')
  if (!pane || pane.startsWith('file:')) return null
  return `/mobile/session/${encodeURIComponent(pane)}${phoneSessionQuery(req.search)}`
}

/**
 * The web root with the phone redirect suppressed for that navigation — where
 * `/desktop` (the Expo app's escape hatch) lands, and where `/mobile` bounces
 * to when the Expo build is absent.
 *
 * The `desktop` marker is what stops the browser-side redirect from ping-ponging:
 * a browser cannot probe for the Expo build, so it optimistically sends phones to
 * /mobile; if that build is missing, the bounce back carries the marker and the
 * next boot stays put. Raw-string append keeps `?server=wss://…` intact, which
 * re-serializing through a query builder would percent-encode.
 */
export function desktopShellLocation(search: string): string {
  if (hasQueryKey(search, DESKTOP_PARAM)) return '/' + search
  const marker = `${DESKTOP_PARAM}=1`
  return '/' + (search ? `${search}&${marker}` : `?${marker}`)
}
