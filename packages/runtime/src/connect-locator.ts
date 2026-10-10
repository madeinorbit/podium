/**
 * THE READ HALF OF PODIUM CONNECT (POD-4533).
 *
 * The server publishes where it is reachable to Connect (`PUT
 * /v1/installations/:id`, signed by the installation key); this module reads
 * that record back. A joined machine or client calls it when the server URL it
 * last knew stops working — a rotated cloudflared quick tunnel, a transferred
 * server — instead of dialling the dead address for ever.
 *
 * Two rules keep this small and safe:
 *
 *  - FAILURE ONLY, NEVER A TIMER. Callers resolve after a failed dial or on a
 *    dropped link, then cache the answer (the adopted URL, persisted in
 *    config) and stay quiet while the link is healthy.
 *  - NEVER THROWS. Every failure — Connect down, unknown id, oversized or
 *    malformed body, unreachable candidate — is "no answer" (`undefined`).
 *    Resolution is a best-effort rescue; the normal reconnect backoff is what
 *    runs when there is no answer.
 *
 * RN-SAFE ON PURPOSE. A phone calls the same entry point as a daemon, so this
 * file uses only `fetch` and `URL` — no `node:` imports, no `Buffer` — the
 * same constraint `packages/protocol/src/pairing.ts` documents.
 *
 * IDENTITY DECISION — OPTION (a): TRUST THE LOCATOR RECORD FOR DISCOVERY, THEN
 * VERIFY THE CANDIDATE BEFORE ADOPTING IT.
 *
 * The locator record is trusted to NAME candidates because only the
 * installation private key may write it: Connect verifies the Ed25519
 * signature byte for byte against the registered key, and the installation id
 * itself (`pdm_` plus 32 random bytes) is an unguessable capability, which is
 * why the read is unsigned — a reader holds no installation key to sign with.
 * An attacker who cannot sign as the installation cannot plant a URL in its
 * record, and an attacker who does not know the id cannot even ask for it.
 *
 * Option (b) — a client-callable mode on `/.well-known/podium` — was rejected
 * because that route's whole safety argument is that it answers ONLY
 * cloud-signed probes. Opening it to unsigned client challenges would turn the
 * installation key into a public signing oracle, which is exactly what the
 * route's own header comment says it must never become.
 *
 * THE THREAT THIS ACCEPTS, STATED PLAINLY. The check before adopting a URL is
 * that the thing serving it presents the same installation on its public
 * `/version` (id always, public key when the server advertises one). That
 * refuses mixups — a stale record, a transferred-away source, an operator
 * pointing two installs at one name — and the daemon's existing credential
 * handshake then fails closed against an honest-but-wrong server, which does
 * not know the machine's token. What it does NOT prove is possession of the
 * installation key: `/version` is self-reported, so an attacker who has both
 * compromised Connect AND serves a valid-HTTPS origin can claim any id they
 * like. Targeted impersonation at that level is outside what discovery can
 * defend; TLS and the trust established at pairing time bound the rest.
 */

import {
  httpOriginOf as httpsOriginOf,
  isLocatorInstallationId,
  isLocatorInstallationPublicKey,
  readVersionIdentity,
  resolveLocatorRecord,
  type FetchVersionIdentityOptions,
  type VersionIdentity,
} from './server-follow'

// Moved to server-follow (POD-5921); re-exported until the last caller of the
// self-reported resolver below is switched to the proof and this file goes.
export {
  CONNECT_LOCATOR_MAX_BODY_BYTES,
  CONNECT_LOCATOR_MAX_ENDPOINTS,
  CONNECT_LOCATOR_TIMEOUT_MS,
  CONNECT_VERSION_MAX_BODY_BYTES,
  fetchVersionIdentity,
  isLocatorInstallationId,
  isLocatorInstallationPublicKey,
  resolveLocatorRecord,
  type FetchVersionIdentityOptions,
  type LocatorEndpoint,
  type LocatorRecord,
  type ResolveLocatorOptions,
  type VersionIdentity,
} from './server-follow'

/**
 * {@link fetchVersionIdentity}, keeping WHY a candidate gave no identity, so a
 * daemon that rejects an address can say so (POD-3274).
 */
export async function probeVersionIdentity(
  opts: FetchVersionIdentityOptions,
): Promise<{ identity: VersionIdentity } | { failure: string }> {
  return readVersionIdentity(opts)
}

export interface ResolveServerUrlOptions {
  /** This box's pairing: both must be present, or there is nothing to verify
   *  against and resolution stays off (a pre-identity box works as before). */
  installationId: string
  installationPublicKey: string
  connectBaseUrl: string
  /** The URL already being dialled: never "resolve" to what just failed. */
  currentServerUrl?: string
  fetch?: typeof fetch
  /** Milliseconds, per request. */
  timeoutMs?: number
  /**
   * Told what the lookup found when it adopts nothing, so the caller can log it
   * (POD-3274). Optional: the answer itself is unchanged.
   */
  report?: (event: LocatorLookupEvent) => void
}

/** Why a lookup adopted nothing. */
export type LocatorLookupEvent =
  /** Connect gave no usable record: unreachable, unknown id, or malformed. */
  | { kind: 'no-record' }
  /** The record names only the address already failing — not republished yet. */
  | { kind: 'no-new-address' }
  /** A candidate was tried and refused. */
  | { kind: 'rejected'; url: string; reason: string }

/**
 * Discovery plus verification in one call: read the locator record, then walk
 * its endpoints highest-priority first and return the first https origin whose
 * `/version` names THIS installation. A candidate naming a different
 * installation — or a different key when it advertises one — is refused and
 * the walk continues. Never throws; `undefined` means "keep dialling".
 */
export async function resolveServerUrl(
  opts: ResolveServerUrlOptions,
): Promise<string | undefined> {
  try {
    if (!isLocatorInstallationId(opts.installationId)) return undefined
    if (!isLocatorInstallationPublicKey(opts.installationPublicKey)) return undefined
    const record = await resolveLocatorRecord({
      baseUrl: opts.connectBaseUrl,
      installationId: opts.installationId,
      fetch: opts.fetch,
      timeoutMs: opts.timeoutMs,
    })
    if (!record) {
      opts.report?.({ kind: 'no-record' })
      return undefined
    }
    const current = opts.currentServerUrl ? httpsOriginOf(opts.currentServerUrl) : undefined
    let tried = 0
    for (const endpoint of record.endpoints) {
      if (current !== undefined && httpsOriginOf(endpoint.url) === current) continue
      tried += 1
      const probe = await probeVersionIdentity({
        serverUrl: endpoint.url,
        fetch: opts.fetch,
        timeoutMs: opts.timeoutMs,
      })
      if ('failure' in probe) {
        opts.report?.({ kind: 'rejected', url: endpoint.url, reason: probe.failure })
        continue
      }
      const identity = probe.identity
      if (identity.installationId !== opts.installationId) {
        opts.report?.({
          kind: 'rejected',
          url: endpoint.url,
          reason: `serves a different installation (${identity.installationId})`,
        })
        continue
      }
      if (
        identity.installationPublicKey !== undefined &&
        identity.installationPublicKey !== opts.installationPublicKey
      ) {
        opts.report?.({
          kind: 'rejected',
          url: endpoint.url,
          reason: 'serves this installation id with a different key',
        })
        continue
      }
      return endpoint.url
    }
    if (tried === 0) opts.report?.({ kind: 'no-new-address' })
    return undefined
  } catch {
    return undefined
  }
}
