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
 * Mobile entry routing [spec:SP-902c]: phone browsers get the responsive web shell at /
 * (no user-agent redirect); the Expo build is opt-in at /mobile. When the Expo build is
 * absent, /mobile redirects to / instead of falling through to the main SPA under a wrong
 * base path. /desktop stays as the Expo app's link back to the web shell. Every redirect
 * preserves the query string (?server, ?e2e).
 */
export function registerMobileRouting(app: Hono, opts: { expoMobileServed: boolean }): void {
  const toRoot = (c: Context) => c.redirect('/' + new URL(c.req.url).search)
  app.get('/desktop', toRoot)
  if (!opts.expoMobileServed) {
    app.get('/mobile', toRoot)
    app.get('/mobile/*', toRoot)
  }
}

/**
 * Serve the built web bundle for EXTERNAL clients (browser / phone / other desktop
 * app connecting to a running machine). The Tauri desktop window uses its own bundled
 * UI, not this route. Returns false (registers nothing) when no build is present, so a
 * source/dev run or an API-only server is unaffected. Call AFTER the API routes.
 */
export function registerWebStatic(
  app: Hono,
  webDir: string,
  opts: StaticWebOptions = {},
): boolean {
  if (!existsSync(join(webDir, 'index.html'))) return false

  const basePath = normalizedBasePath(opts.basePath)
  const handler = (c: Context) => {
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
