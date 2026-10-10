/**
 * `POST /.well-known/podium/locate` — THE LOCATE PROOF (POD-5921).
 *
 * A client that lost this server reads Podium Connect, which only NAMES the
 * address the server published. Before it reconnects there (and, for a native
 * client, sends its credential), it asks the candidate to sign a fresh nonce:
 *
 *     utf8("podium-locate-v1\n") || nonce || utf8(publicUrl)
 *
 * with the installation key, where `publicUrl` is the origin this server is
 * CONFIGURED to be reachable at — the same value the Connect publisher sends,
 * never the Host header (a tunnel may rewrite it, and the point is to bind the
 * signature to the address the server claims).
 *
 * Why a public signing route is safe here, unlike `/.well-known/podium`:
 *
 *  - DOMAIN SEPARATION. The prefix is this route's alone, so an answer can
 *    never satisfy the reachability or probe contexts, and they never this one.
 *  - A RELAY GAINS NOTHING. Anyone can obtain a signature over this server's
 *    own `publicUrl`, which a client rejects at any other origin.
 *  - FRESHNESS. The client's nonce makes every answer single-use.
 *
 * Wildcard CORS and a body accepted as `text/plain` make a cross-origin
 * browser call a simple request; no cookie is read or set.
 */
import {
  LOCATE_PROOF_MAX_REQUEST_BYTES,
  LOCATE_PROOF_PATH,
  locateOrigin,
  locateProofMessage,
  parseLocateProofRequest,
} from '@podium/protocol'
import {
  type InstallationIdentity,
  signBytesWithInstallation,
} from '@podium/runtime/installation-identity'
import type { Context, Hono } from 'hono'

/** Per client address, per minute. Signing is cheap, but the route is public. */
export const LOCATE_PROOF_RATE_PER_MINUTE = 30
const WINDOW_MS = 60_000
const MAX_TRACKED = 10_000

export interface LocateProofRouteDeps {
  /** Absent on a box that is not a server: the route answers 404. */
  identity: () => InstallationIdentity | undefined
  /** The configured public origin, read per request — the publisher's own reader. */
  publicUrl: () => string | undefined
  /** The client's address for rate limiting; `undefined` shares one bucket. */
  clientAddress?: (request: Request) => string | undefined
  /** Milliseconds. */
  now?: () => number
  ratePerMinute?: number
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST',
  'access-control-allow-headers': 'content-type',
} as const

export function registerLocateProofRoute(app: Hono, deps: LocateProofRouteDeps): void {
  const now = deps.now ?? Date.now
  const limit = deps.ratePerMinute ?? LOCATE_PROOF_RATE_PER_MINUTE
  const windows = new Map<string, { startedAt: number; count: number }>()

  const overLimit = (key: string, at: number): boolean => {
    const current = windows.get(key)
    if (current && at - current.startedAt < WINDOW_MS) {
      current.count += 1
      return current.count > limit
    }
    if (current) windows.delete(key)
    if (windows.size >= MAX_TRACKED) {
      for (const [k, w] of windows) if (at - w.startedAt >= WINDOW_MS) windows.delete(k)
      if (windows.size >= MAX_TRACKED) {
        const oldest = windows.keys().next().value
        if (oldest !== undefined) windows.delete(oldest)
      }
    }
    windows.set(key, { startedAt: at, count: 1 })
    return false
  }

  const answer = (c: Context, body: unknown, status: 200 | 400 | 404 | 429) => {
    c.header('access-control-allow-origin', '*')
    c.header('cache-control', 'no-store')
    return c.json(body as object, status)
  }

  app.options(LOCATE_PROOF_PATH, (c) => {
    for (const [name, value] of Object.entries(CORS_HEADERS)) c.header(name, value)
    c.header('access-control-max-age', '600')
    return c.body(null, 204)
  })

  app.post(LOCATE_PROOF_PATH, async (c) => {
    const key = deps.clientAddress?.(c.req.raw) ?? 'unknown'
    if (overLimit(key, now())) {
      c.header('retry-after', '60')
      return answer(c, { error: 'too many requests' }, 429)
    }
    const identity = deps.identity()
    const configured = deps.publicUrl()
    const publicUrl = configured ? locateOrigin(configured) : undefined
    if (!identity || !publicUrl) return answer(c, { error: 'not found' }, 404)
    const declared = Number(c.req.header('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > LOCATE_PROOF_MAX_REQUEST_BYTES) {
      return answer(c, { error: 'body too large' }, 400)
    }
    let body: unknown
    try {
      const text = await c.req.text()
      if (text.length > LOCATE_PROOF_MAX_REQUEST_BYTES) {
        return answer(c, { error: 'body too large' }, 400)
      }
      body = JSON.parse(text)
    } catch {
      return answer(c, { error: 'body must be JSON' }, 400)
    }
    const parsed = parseLocateProofRequest(body)
    if ('error' in parsed) return answer(c, { error: parsed.error }, 400)
    return answer(
      c,
      {
        installationId: identity.installationId,
        publicUrl,
        signature: signBytesWithInstallation(identity, locateProofMessage(parsed.nonce, publicUrl)),
      },
      200,
    )
  })
}
