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

/** No deployment has said anything, which is every self-hosted install. */
const NO_ALLOWED_ORIGINS: ReadonlySet<string> = new Set()

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
 *  - an origin THIS DEPLOYMENT NAMED, in `allowedOrigins` — the split-hosting
 *    case, where the UI is served from `app.<site>` and this API answers on
 *    `api.<site>`. Exact match on the full origin, so `http://` never rides in
 *    on an `https://` entry and a neighbouring port is a different origin.
 *    The list is an ADDITIONAL accept path; an empty one (every self-hosted
 *    install) leaves every answer below exactly as it was.
 *
 * No Origin header at all is `false`: that is a same-origin or non-browser
 * request, which needs no CORS headers rather than permissive ones.
 */
export function isAllowedHttpOrigin(
  origin: string | null | undefined,
  host: string | null | undefined,
  allowed: ReadonlySet<string> = NO_ALLOWED_ORIGINS,
): boolean {
  return httpOriginVerdict(origin, host, allowed) === 'allowed'
}

/** Whether an origin is allowed, and when it is not, WHY — so the refusal can
 *  be logged as something an operator can act on rather than a bare 403. */
export type OriginVerdict = 'allowed' | 'no-origin' | 'parse' | 'not-allowed'

/** {@link isAllowedHttpOrigin}, keeping the reason it refused. */
export function httpOriginVerdict(
  origin: string | null | undefined,
  host: string | null | undefined,
  allowed: ReadonlySet<string> = NO_ALLOWED_ORIGINS,
): OriginVerdict {
  if (!origin) return 'no-origin'
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return 'parse'
  }
  if (parsed.protocol === 'tauri:') return 'allowed'
  if (LOOPBACK_HOSTS.has(parsed.hostname)) return 'allowed'
  const reqHost = hostHeaderName(host)
  if (reqHost && parsed.hostname === reqHost) return 'allowed'
  // `URL.origin` is already normalized, and so is every entry in the set: the
  // config parser stores `new URL(entry).origin`, so a trailing slash or a
  // default port written out compares equal here.
  return allowed.has(parsed.origin) ? 'allowed' : 'not-allowed'
}

export interface OriginPolicy {
  /** The exact origins this deployment named in `allowedOrigins`. */
  readonly allowed?: ReadonlySet<string> | undefined
  /**
   * Told about every refusal that could be a misconfiguration. A missing Origin
   * is not one — that is a same-origin or non-browser caller — so it is not
   * reported.
   */
  readonly onRefused?:
    | ((info: {
        origin: string | undefined
        host: string | undefined
        reason: Exclude<OriginVerdict, 'allowed' | 'no-origin'>
      }) => void)
    | undefined
}

/** The CORS middleware every credentialed human-client route mounts. */
export function podiumCors(policy: OriginPolicy = {}): MiddlewareHandler {
  const allowed = policy.allowed ?? NO_ALLOWED_ORIGINS
  return cors({
    // hono passes '' when the request carried no Origin; returning null leaves
    // the response without an allow-origin header, which is the right answer
    // for a same-origin or non-browser caller.
    origin: (origin, c) => {
      const host = c.req.header('host')
      const verdict = httpOriginVerdict(origin, host, allowed)
      if (verdict === 'allowed') return origin
      if (verdict !== 'no-origin') {
        policy.onRefused?.({
          origin: origin || undefined,
          host: host || undefined,
          reason: verdict,
        })
      }
      return null
    },
    // The whole point: the login session cookie rides these calls.
    credentials: true,
  })
}
