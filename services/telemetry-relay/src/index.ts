/**
 * The Podium telemetry relay [spec:SP-f933].
 *
 * A Cloudflare Worker deployed in podium cloud. Its whole job is three steps:
 *
 *   1. Validate the body against the PUBLISHED schema — reject anything else.
 *   2. Drop the source IP. Never logged, never forwarded.
 *   3. Forward to PostHog Cloud with a server-side key.
 *
 * Why a relay exists at all: **vendor abstraction**. No third-party domain
 * appears in anyone's firewall logs, and PostHog can be swapped (or self-hosted,
 * or replaced with ClickHouse) without touching a single client — the thing that
 * turned Homebrew's analytics fight into a one-line release note. The vendor is
 * named explicitly in docs/TELEMETRY.md: an undisclosed processor being
 * DISCOVERED is the scandal pattern; a disclosed one is a footnote.
 *
 * This source lives in the public repo so the rules above are auditable.
 * docs/TELEMETRY.md states honestly that the DEPLOYMENT cannot be verified
 * against this source — you are trusting us either way; we would rather say so
 * than imply a proof we cannot give.
 *
 * Validation is deliberately the same zod schema the client emits against
 * (@podium/telemetry/schema), not a hand-copy: a relay that accepted a field the
 * client cannot send would be a place for one to appear later.
 */
import { TelemetryReport, tierOf } from '@podium/telemetry/schema'

export interface Env {
  /** PostHog project API key (server-side, set as a Worker secret). */
  POSTHOG_API_KEY: string
  /** PostHog ingest host, e.g. https://us.i.posthog.com. */
  POSTHOG_HOST: string
}

/** Max body we will even read — a report is <1KB; this is anti-abuse, not tuning. */
const MAX_BODY_BYTES = 8 * 1024

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

/**
 * Turn a validated report into a PostHog event.
 *
 * `distinct_id` is the installId — the random UUID the client minted on opt-in,
 * which is the ONLY identifier in the system and is resettable by the user at
 * any time (`podium telemetry reset-id`). We deliberately do not enrich it, join
 * it to anything, or derive a person profile: `$process_person_profile: false`
 * keeps PostHog from building one.
 */
export function toPostHogEvent(report: TelemetryReport): Record<string, unknown> {
  const tier = tierOf(report)
  const { installId, ...properties } = report
  return {
    event: `podium_${tier}`,
    distinct_id: installId,
    properties: {
      ...properties,
      // No person profiles: this is an install counter, not a user.
      $process_person_profile: false,
      // PostHog geolocates from the forwarding IP unless told not to. We never
      // send the client's IP (see the handler), but be explicit: the relay's own
      // IP must not become a location signal either.
      $geoip_disable: true,
      $ip: null,
    },
  }
}

/**
 * The handler. Note what is NOT here: any read of cf-connecting-ip /
 * x-forwarded-for / request.cf, any logging of the request, any storage. The
 * source IP arrives at the edge and dies there — the one thing a self-hosted
 * user cannot verify for themselves, and therefore the one we keep simplest.
 */
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405, headers: CORS })
  }

  const length = Number(request.headers.get('content-length') ?? '0')
  if (length > MAX_BODY_BYTES) {
    return new Response('payload too large', { status: 413, headers: CORS })
  }

  let body: unknown
  try {
    const text = await request.text()
    if (text.length > MAX_BODY_BYTES) {
      return new Response('payload too large', { status: 413, headers: CORS })
    }
    body = JSON.parse(text)
  } catch {
    return new Response('invalid json', { status: 400, headers: CORS })
  }

  // The gate: anything the published schema does not admit is refused. A 400 is
  // final on the client side (it does not retry), so a malformed sender stops
  // rather than beaconing.
  const parsed = TelemetryReport.safeParse(body)
  if (!parsed.success) {
    return new Response('does not match the published telemetry schema', {
      status: 400,
      headers: CORS,
    })
  }

  try {
    const res = await fetch(`${env.POSTHOG_HOST}/i/v0/e/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: env.POSTHOG_API_KEY, ...toPostHogEvent(parsed.data) }),
    })
    // Upstream trouble is OUR problem, not the client's: 502 lets it retry later
    // (bounded, one attempt per flush). A 200 here would silently drop the report.
    if (!res.ok) return new Response('upstream rejected', { status: 502, headers: CORS })
  } catch {
    return new Response('upstream unreachable', { status: 502, headers: CORS })
  }

  return new Response(null, { status: 204, headers: CORS })
}

export default {
  fetch: handleRequest,
}
