import { controlPlaneAvailable, type ServerReadiness } from '@podium/model'
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

/**
 * THE CONTROL PLANE (POD-2766) — talking ABOUT the instance while it refuses to
 * serve work.
 *
 * `activation_pending` means this process is running stale config, and blocking
 * the data plane for it is correct. It also blocked the RESTART that clears the
 * state, so the remedy sat behind the failure and the only way out was to reach
 * into the container. This list is the way out, and it is exactly one procedure
 * wide on purpose: the operator needs to press restart, and nothing else.
 *
 * DIFFERENT FROM THE BOOTSTRAP LIST ABOVE IN THE WAY THAT MATTERS. Bootstrap
 * bypasses the login guard, so it is fenced to host-local requests. These do NOT:
 * the ordinary `clientAuthGuard` still runs, and the procedure's own `admin`
 * floor still applies, so an anonymous caller reaching a remote instance gets 401
 * rather than a free restart button. That is what lets it be served to a browser
 * on the other side of the internet, which is where the locked-out operator was.
 */
const CONTROL_PLANE_PROCEDURES = new Set(['setup.activate'])

/** As {@link isSetupBootstrapPath}: every member of a tRPC batch must be on the
 *  list, so one control-plane call cannot carry a data-plane call alongside it. */
export function isControlPlanePath(pathname: string): boolean {
  if (!pathname.startsWith('/trpc/')) return false
  const procedures = pathname.slice('/trpc/'.length).split(',').map(decodeURIComponent)
  return (
    procedures.length > 0 &&
    procedures.every((procedure) => CONTROL_PLANE_PROCEDURES.has(procedure))
  )
}

/**
 * The auth surface a blocked-but-reachable instance keeps open: the status read,
 * and the login/logout that let an operator BECOME the admin who can restart it.
 *
 * Deliberately not all of `/auth/*`. `POST /auth/users` mints an account in the
 * live database, which is work — it belongs to the data plane and stays shut
 * until the process is running the config it was asked to run.
 */
const CONTROL_PLANE_AUTH_PATHS = new Set(['/auth/status', '/auth/login', '/auth/logout'])

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
    // The restart, from anywhere, once the state says the instance may be talked
    // to about itself. The login guard downstream is what keeps it authenticated.
    if (controlPlaneAvailable(readiness) && isControlPlanePath(c.req.path)) return next()
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

/**
 * /auth/status is part of the public status surface, always.
 *
 * LOGIN IS THE ONE THAT CHANGED (POD-2766). It used to be refused whenever the
 * data plane was blocked, on the reasoning that logging in before activation
 * achieves nothing and would be a second bootstrap door. Half of that held and
 * half of it did not: in `unconfigured` there is no account to log into and the
 * host-local setup bootstrap is the door, so login stays shut. In
 * `activation_pending` there IS an account — the same credential a restart would
 * have honoured — and refusing it locked the operator out of the restart that
 * was the entire remedy.
 *
 * So the gate is now the CONTROL plane rather than the data plane, and the state
 * decides which instance has one. A session minted here still buys nothing but
 * the control plane: `readinessBoundary` keeps every data-plane call at 503.
 */
export function authReadinessBoundary(readiness: () => ServerReadiness): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS' || c.req.path === '/auth/status') return next()
    const status = readiness()
    if (status.dataPlane === 'available') return next()
    if (controlPlaneAvailable(status) && CONTROL_PLANE_AUTH_PATHS.has(c.req.path)) return next()
    return c.json({ error: 'server_not_ready', readiness: status }, 503)
  }
}
