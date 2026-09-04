/**
 * `GET /.well-known/podium` — the REACHABILITY ANSWER for Podium Connect (PDM-51).
 *
 * Connect probes the public URL an operator typed and asks "is the thing
 * answering here this installation?" This route answers by signing the probe's
 * challenge with the installation key. Two properties make that safe:
 *
 *  - ONLY PODIUM CLOUD IS ANSWERED. The probe carries a signature by a cloud key
 *    the server already trusts — the pinned Podium Cloud key, or one the operator
 *    added — over the installation id, the challenge and a timestamp. Anything
 *    unsigned, mis-signed, stale, or by an unknown key gets the same 404 an
 *    unknown path gets, so the installation key is never a public signing oracle.
 *  - NOTHING IDENTIFYING IS RETURNED. No installation id, no key, no metadata:
 *    the caller already knows the expected key, and the answer is meaningless to
 *    anyone who does not.
 *
 * The signature domains are separated by prefix, so this answer can never be
 * replayed as a locator write and a probe signature can never become anything
 * else (packages/runtime/src/installation-identity.ts).
 */
import {
  CONNECT_PROBE_PREFIX,
  CONNECT_REACHABILITY_PREFIX,
  connectProbeMessage,
  type InstallationIdentity,
  signWithInstallation,
  verifyWithWireKey,
} from '@podium/runtime/installation-identity'
import type { Hono } from 'hono'

/** Probes this far from this server's clock are refused (Connect uses the same window). */
export const PROBE_SKEW_SECONDS = 300
const CHALLENGE_RE = /^[A-Za-z0-9_-]{16,128}$/

export interface WellKnownRouteDeps {
  /** Absent on a box that is not a server (a paired daemon): the route answers nothing. */
  identity: () => InstallationIdentity | undefined
  /** Wire-form cloud keys whose probes are answered. Read per request so a config
   *  change lands without a restart. */
  trustedProbeKeys: () => readonly string[]
  /** Unix seconds. */
  now?: () => number
}

export function registerWellKnownRoute(app: Hono, deps: WellKnownRouteDeps): void {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  app.get('/.well-known/podium', (c) => {
    const identity = deps.identity()
    if (!identity) return c.notFound()
    const challenge = c.req.query('challenge')
    if (!challenge || !CHALLENGE_RE.test(challenge)) return c.notFound()
    const probeKey = c.req.header('podium-probe-key')
    const tsHeader = c.req.header('podium-timestamp')
    const signature = c.req.header('podium-probe-signature')
    if (!probeKey || !tsHeader || !signature) return c.notFound()
    if (!deps.trustedProbeKeys().includes(probeKey)) return c.notFound()
    if (!/^\d+$/.test(tsHeader)) return c.notFound()
    const ts = Number(tsHeader)
    if (!Number.isSafeInteger(ts) || Math.abs(now() - ts) > PROBE_SKEW_SECONDS) return c.notFound()
    const message = connectProbeMessage(identity.installationId, challenge, ts)
    if (!verifyWithWireKey(probeKey, CONNECT_PROBE_PREFIX, message, signature)) return c.notFound()
    c.header('cache-control', 'no-store')
    return c.json({
      challenge,
      signature: signWithInstallation(identity, CONNECT_REACHABILITY_PREFIX, challenge),
    })
  })
}
