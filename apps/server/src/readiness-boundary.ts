import type { ServerReadiness } from '@podium/model'
import type { MiddlewareHandler } from 'hono'

const BOOTSTRAP_PROCEDURES = new Set([
  'setup.info',
  'setup.options',
  'setup.commandFor',
  'setup.complete',
  'setup.join',
  'setup.connect',
  // Read-only facts the existing first-run form needs to render honestly.
  'auth.status',
  'telemetry.state',
])

/** tRPC batches comma-separate procedure names in one path. Every member must
 * be in the bootstrap allowlist; one setup read cannot smuggle a data-plane call. */
export function isSetupBootstrapPath(pathname: string): boolean {
  if (!pathname.startsWith('/trpc/')) return false
  const procedures = pathname.slice('/trpc/'.length).split(',').map(decodeURIComponent)
  return (
    procedures.length > 0 && procedures.every((procedure) => BOOTSTRAP_PROCEDURES.has(procedure))
  )
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '')
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized.startsWith('::ffff:127.') ||
    normalized.startsWith('127.')
  )
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false
  try {
    const hostname = new URL(`http://${host}`).hostname
    return hostname === 'localhost' || isLoopbackAddress(hostname)
  } catch {
    return false
  }
}

/** The native boundary overwrites x-podium-peer-address from Bun.requestIP, so
 * callers cannot nominate themselves as local. Host/origin/forwarding checks
 * prevent a local reverse proxy from turning a remote browser into bootstrap. */
export function isHostLocalRequest(request: Request): boolean {
  if (!isLoopbackAddress(request.headers.get('x-podium-peer-address') ?? undefined)) return false
  if (!isLoopbackHost(new URL(request.url).host)) return false

  const origin = request.headers.get('origin')
  if (origin) {
    try {
      const parsed = new URL(origin)
      if (
        parsed.protocol !== 'tauri:' &&
        parsed.hostname !== 'localhost' &&
        !isLoopbackAddress(parsed.hostname)
      ) {
        return false
      }
    } catch {
      return false
    }
  }

  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  if (forwardedHost && !isLoopbackHost(forwardedHost)) return false
  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (forwardedFor && !isLoopbackAddress(forwardedFor)) return false
  return true
}

export function readinessBoundary(opts: {
  readiness: () => ServerReadiness
  isHostLocal: (request: Request) => boolean
}): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') return next()
    const readiness = opts.readiness()
    if (readiness.dataPlane === 'available') return next()
    if (isHostSetupBootstrap(readiness, c.req.path, c.req.raw, opts.isHostLocal)) return next()
    return c.json({ error: 'server_not_ready', readiness }, 503)
  }
}

export function isHostSetupBootstrap(
  readiness: ServerReadiness,
  pathname: string,
  request: Request,
  isHostLocal: (request: Request) => boolean = isHostLocalRequest,
): boolean {
  return readiness.dataPlane === 'blocked' && isSetupBootstrapPath(pathname) && isHostLocal(request)
}

/** /auth/status is part of the public status surface. Login/session mutation is
 * not useful before activation and must not become a second bootstrap door. */
export function authReadinessBoundary(readiness: () => ServerReadiness): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS' || c.req.path === '/auth/status') return next()
    const status = readiness()
    if (status.dataPlane === 'available') return next()
    return c.json({ error: 'server_not_ready', readiness: status }, 503)
  }
}
