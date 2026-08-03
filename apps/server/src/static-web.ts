import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { desktopShellLocation, mobileEntryRedirect } from '@podium/model'
import type { Context, Hono } from 'hono'
import { gradeWebBundle, injectBundleWarning } from './web-bundle-stamp'

/**
 * Backend route prefixes that must never be shadowed by the SPA index.html.
 * A superset of the backend prefixes in apps/web NAVIGATION_FALLBACK_DENYLIST:
 * it also covers /version, /mcp, and /hooks (which the vite dev proxy doesn't list).
 * Do NOT trim it down to match that list — that would let the SPA shell shadow a
 * backend route. When adding a backend route, add its prefix here.
 *
 * The reverse is NOT true: that denylist also carries `/` and `/desktop`, the
 * entry redirects registered by registerMobileRouting. Those must reach the
 * server rather than a service worker's precache, but they are not backend
 * routes — `/` is served from here once the redirect declines. Adding either
 * one below would 404 the web root.
 */
const BACKEND_PREFIXES = [
  '/trpc',
  '/health',
  '/version',
  '/setup',
  '/auth',
  '/files',
  '/client',
  '/daemon',
  '/hooks',
  '/mcp',
]

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
}

export interface StaticWebOptions {
  basePath?: string
  /** Register routes even when the build is currently absent; each request
   *  re-checks. Lets a dist built after boot start serving without a restart
   *  (routes registered earlier, e.g. registerMobileRouting's fallback, own
   *  the absent case). */
  lazy?: boolean
  /** Compare this dist's build stamp against the running server and warn in the
   *  served HTML when they disagree (POD-1610). OPT-IN, not defaulted on: only
   *  the apps/web dist carries a stamp, so defaulting it would put a permanent
   *  "unstamped" banner on the Expo mobile shell, which is a different artefact
   *  built by a different toolchain. */
  stampCheck?: boolean
}

function contentType(p: string): string {
  return CONTENT_TYPES[extname(p).toLowerCase()] ?? 'application/octet-stream'
}

function normalizedBasePath(basePath: string | undefined): string {
  const raw = basePath?.trim() || '/'
  if (raw === '/') return '/'
  const withLeadingSlash = raw.startsWith('/') ? raw : '/' + raw
  return withLeadingSlash.replace(/\/+$/, '') || '/'
}

function routePattern(basePath: string): string {
  return basePath === '/' ? '/*' : basePath + '/*'
}

function pathInsideBase(pathname: string, basePath: string): string | null {
  if (basePath === '/') return pathname
  if (pathname === basePath) return '/'
  if (pathname.startsWith(basePath + '/')) return pathname.slice(basePath.length) || '/'
  return null
}

function isBackendRoute(pathname: string): boolean {
  return BACKEND_PREFIXES.some((pre) => pathname === pre || pathname.startsWith(pre + '/'))
}

/**
 * Mobile entry routing [POD-102, reverses SP-902c]: the Expo app at /mobile is
 * the ONLY mobile UX — phone browsers hitting exactly `/` are redirected there.
 * The responsive web shell is gone; /desktop remains as the Expo app's escape
 * hatch to the desktop web shell (`/?desktop=1` suppresses the phone redirect
 * for that navigation). Deep links (e.g. /session/xyz) are never redirected.
 * When the Expo build is absent, /mobile falls back to the desktop shell instead
 * of loading the main SPA under a wrong base path. Every redirect preserves the
 * query string (?server, ?e2e). The decision itself lives in @podium/model, so
 * this door and the two in apps/web cannot drift apart (POD-359).
 *
 * Presence is a live probe, not a boot-time flag: the mobile dist is gitignored
 * and built separately from the web dist, so a deploy can restart the server
 * before (or without) exporting it. With a boot-time flag that ordering silently
 * disabled the phone redirect until the next restart.
 *
 * `redirectPhoneRoot: false` withholds only the `/` redirect while /mobile keeps
 * serving Expo — the browser harness drives both shells from one server and would
 * otherwise never reach the web shell from a phone-sized Pixel profile.
 */
export function registerMobileRouting(
  app: Hono,
  opts: { expoMobilePresent: () => boolean; redirectPhoneRoot?: boolean },
): void {
  const present = opts.expoMobilePresent
  // Carries the ?desktop marker, which tells apps/web's browser-side redirect
  // that the Expo build is genuinely absent rather than bouncing back to it.
  const toDesktopShell = (c: Context) => c.redirect(desktopShellLocation(new URL(c.req.url).search))
  app.get('/', async (c, next) => {
    const url = new URL(c.req.url)
    if (opts.redirectPhoneRoot !== false) {
      const target = mobileEntryRedirect({
        pathname: url.pathname,
        search: url.search,
        userAgent: c.req.header('user-agent'),
        mobilePresent: present(),
      })
      if (target) return c.redirect(target)
    }
    await next()
  })
  app.get('/desktop', toDesktopShell)
  const mobileFallback = async (c: Context, next: () => Promise<void>) => {
    if (!present()) return toDesktopShell(c)
    await next()
  }
  app.get('/mobile', mobileFallback)
  app.get('/mobile/*', mobileFallback)
}

/**
 * The SPA shell, with the stale-build warning folded in when it applies.
 *
 * Read per request rather than cached at registration: `lazy` dists appear after
 * boot and every dev rebuild replaces this file, so a cached shell would serve a
 * warning about a build that no longer exists (see `gradeWebBundle`, which caches
 * the VERDICT on the stamp's mtime and so re-grades exactly when the stamp moves).
 */
function serveIndex(webDir: string, indexPath: string, stampCheck: boolean): string {
  const html = readFileSync(indexPath, 'utf8')
  return stampCheck ? injectBundleWarning(html, gradeWebBundle(webDir)) : html
}

/**
 * Serve the built web bundle for EXTERNAL clients (browser / phone / other desktop
 * app connecting to a running machine). The Tauri desktop window uses its own bundled
 * UI, not this route. Returns false (registers nothing) when no build is present, so a
 * source/dev run or an API-only server is unaffected. Call AFTER the API routes.
 */
export function registerWebStatic(app: Hono, webDir: string, opts: StaticWebOptions = {}): boolean {
  const indexPath = join(webDir, 'index.html')
  if (!opts.lazy && !existsSync(indexPath)) return false

  const basePath = normalizedBasePath(opts.basePath)
  const handler = (c: Context) => {
    if (opts.lazy && !existsSync(indexPath)) return c.notFound()
    const pathname = new URL(c.req.url).pathname
    const inside = pathInsideBase(pathname, basePath)
    if (inside === null) return c.notFound()
    if (isBackendRoute(pathname)) return c.notFound()

    const rel = normalize(decodeURIComponent(inside)).replace(/^(\.\.[/\\])+/, '')
    const filePath = join(webDir, rel)
    if (
      (filePath === webDir || filePath.startsWith(webDir + sep)) &&
      existsSync(filePath) &&
      statSync(filePath).isFile() &&
      filePath !== indexPath
    ) {
      return new Response(readFileSync(filePath), {
        status: 200,
        headers: { 'Content-Type': contentType(filePath) },
      })
    }
    // index.html goes out through ONE path — the fallback — even when it was
    // asked for by name. The service worker precaches `/index.html` explicitly,
    // so a second, un-annotated route for the same file is how the stale-build
    // warning (POD-1610) would be missing from precisely the installed PWA that
    // most needs it.
    return new Response(serveIndex(webDir, indexPath, opts.stampCheck === true), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }

  if (basePath !== '/') app.get(basePath, handler)
  app.get(routePattern(basePath), handler)
  return true
}
