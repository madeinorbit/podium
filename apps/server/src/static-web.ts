import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import type { Context, Hono } from 'hono'

/**
 * Backend route prefixes that must never be shadowed by the SPA index.html.
 * Intentionally a SUPERSET of apps/web/vite.config.ts navigateFallbackDenylist:
 * it also covers /version, /mcp, and /hooks (which the vite dev proxy doesn't list).
 * Do NOT trim it down to match vite — that would let the SPA shell shadow a backend
 * route. When adding a backend route, add its prefix here.
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

/** Phone (not tablet) user agents — the devices the Expo mobile app targets. */
const PHONE_UA = /Android.+Mobile|iPhone|iPod/i

/**
 * Mobile entry routing [POD-102, reverses SP-902c]: the Expo app at /mobile is
 * the ONLY mobile UX — phone browsers hitting exactly `/` are redirected there.
 * The responsive web shell is gone; /desktop remains as the Expo app's escape
 * hatch to the desktop web shell (`/?desktop=1` suppresses the phone redirect
 * for that navigation). Deep links (e.g. /session/xyz) are never redirected.
 * When the Expo build is absent, /mobile falls back to / instead of loading the
 * main SPA under a wrong base path. Every redirect preserves the query string
 * (?server, ?e2e).
 *
 * Presence is a live probe, not a boot-time flag: the mobile dist is gitignored
 * and built separately from the web dist, so a deploy can restart the server
 * before (or without) exporting it. With a boot-time flag that ordering silently
 * disabled the phone redirect until the next restart.
 */
export function registerMobileRouting(app: Hono, opts: { expoMobilePresent: () => boolean }): void {
  const present = opts.expoMobilePresent
  const toRoot = (c: Context) => c.redirect('/' + new URL(c.req.url).search)
  app.get('/', async (c, next) => {
    const url = new URL(c.req.url)
    const ua = c.req.header('user-agent') ?? ''
    if (present() && PHONE_UA.test(ua) && !url.searchParams.has('desktop')) {
      return c.redirect('/mobile' + url.search)
    }
    await next()
  })
  app.get('/desktop', (c) => {
    if (!present()) return toRoot(c)
    // Raw-string append keeps the original encoding of ?server=wss://… intact.
    const search = new URL(c.req.url).search
    return c.redirect('/' + (search ? search + '&desktop=1' : '?desktop=1'))
  })
  const mobileFallback = async (c: Context, next: () => Promise<void>) => {
    if (!present()) return toRoot(c)
    await next()
  }
  app.get('/mobile', mobileFallback)
  app.get('/mobile/*', mobileFallback)
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
      statSync(filePath).isFile()
    ) {
      return new Response(readFileSync(filePath), {
        status: 200,
        headers: { 'Content-Type': contentType(filePath) },
      })
    }
    return new Response(readFileSync(join(webDir, 'index.html'), 'utf8'), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }

  if (basePath !== '/') app.get(basePath, handler)
  app.get(routePattern(basePath), handler)
  return true
}
