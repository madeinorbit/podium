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

function wantsMobile(userAgent: string): boolean {
  return /Android|iPhone|iPod|Mobile/i.test(userAgent) && !/iPad|Tablet/i.test(userAgent)
}

function hasDesktopCookie(cookie: string): boolean {
  return cookie.split(';').some((part) => part.trim() === 'podium_desktop=1')
}

/**
 * Redirect phone browsers from the desktop root into the dedicated mobile SPA while keeping
 * /desktop as an explicit escape hatch. The cookie only affects the same Podium origin.
 */
export function registerMobileRedirect(app: Hono): void {
  app.get('/desktop', (c) => {
    c.header('Set-Cookie', 'podium_desktop=1; Path=/; SameSite=Lax; Max-Age=2592000')
    return c.redirect('/')
  })

  app.use('*', async (c, next) => {
    const pathname = new URL(c.req.url).pathname
    if (
      pathname === '/' &&
      wantsMobile(c.req.header('user-agent') ?? '') &&
      !hasDesktopCookie(c.req.header('cookie') ?? '')
    ) {
      return c.redirect('/mobile')
    }
    await next()
  })
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
