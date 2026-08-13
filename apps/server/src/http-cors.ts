/**
 * CORS FOR THE HUMAN-CLIENT HTTP PLANE — `/trpc`, `/auth` and `/setup`.
 *
 * These three were `cors()` with hono's defaults, which answers every request
 * with `Access-Control-Allow-Origin: *` and never sets
 * `Access-Control-Allow-Credentials`. That combination is unusable by the web
 * client, because `reportingFetch` sends every tRPC call with
 * `credentials: 'include'` (the login session cookie), and the Fetch spec's CORS
 * check FAILS a credentialed response whose allow-origin is the wildcard. The
 * browser rejects it before any handler sees it, so the call surfaces as a bare
 * network error — `TypeError: Load failed` in WKWebView.
 *
 * That is not a theoretical combination: it is the desktop all-in-one shape.
 * The window loads the bundled UI from `tauri://localhost` and talks to the
 * loopback backend on a picked port (apps/desktop/src-tauri/src/main.rs), so
 * EVERY call it makes is cross-origin and credentialed. The result was an app
 * whose queries all failed silently (each caller has a `.catch`) and whose first
 * mutation — `setup.complete`, behind "Finish without telemetry" — was the first
 * failure a human could see. Onboarding could not be completed at all, and the
 * client's own log forwarding (`logs.forward`, same transport) was dark for the
 * same reason, which is why nothing was written down about any of it.
 *
 * So the origin is REFLECTED rather than wildcarded, and only for origins this
 * server would answer a WebSocket from. Reflecting is what makes credentials
 * legal; the allow-list is what keeps that from being an invitation.
 */
import type { MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function hostHeaderName(host: string | null | undefined): string | undefined {
  if (!host) return undefined
  try {
    return new URL(`http://${host}`).hostname
  } catch {
    return undefined
  }
}

/**
 * May a page at `origin` make a CREDENTIALED cross-origin call to this server?
 *
 * Deliberately stricter than {@link isAllowedWsOrigin} in one place: that one
 * also allows any origin when the REQUEST's host is loopback, which would let
 * `https://evil.example` drive a Podium on 127.0.0.1 with the operator's cookie
 * attached. A socket upgrade and a credentialed `setup.complete` are not the
 * same risk, so this list is only the three cases that actually exist:
 *
 *  - `tauri:` — the desktop shell's bundled UI, whose backend is always
 *    cross-origin to it.
 *  - a loopback PAGE — the `apps/web` vite dev server on its own port, and the
 *    UI served from 127.0.0.1 while the relay listens elsewhere.
 *  - the same site — a reverse proxy that terminates TLS in front of us leaves
 *    the scheme and port differing while the host does not.
 *
 * No Origin header at all is `false`: that is a same-origin or non-browser
 * request, which needs no CORS headers rather than permissive ones.
 */
export function isAllowedHttpOrigin(
  origin: string | null | undefined,
  host: string | null | undefined,
): boolean {
  if (!origin) return false
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol === 'tauri:') return true
  if (LOOPBACK_HOSTS.has(parsed.hostname)) return true
  const reqHost = hostHeaderName(host)
  return Boolean(reqHost) && parsed.hostname === reqHost
}

/** The CORS middleware every credentialed human-client route mounts. */
export function podiumCors(): MiddlewareHandler {
  return cors({
    // hono passes '' when the request carried no Origin; returning null leaves
    // the response without an allow-origin header, which is the right answer
    // for a same-origin or non-browser caller.
    origin: (origin, c) => (isAllowedHttpOrigin(origin, c.req.header('host')) ? origin : null),
    // The whole point: the login session cookie rides these calls.
    credentials: true,
  })
}
