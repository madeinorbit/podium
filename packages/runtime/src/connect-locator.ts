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

export interface LocatorEndpoint {
  url: string
  priority: number
}

export interface LocatorRecord {
  generation: number
  issuedAt: string
  expiresAt: string | null
  endpoints: LocatorEndpoint[]
}

/** At most this many endpoints are accepted from one record; the rest are dropped. */
export const CONNECT_LOCATOR_MAX_ENDPOINTS = 4
/** The largest locator body this client will parse; anything bigger is "no answer". */
export const CONNECT_LOCATOR_MAX_BODY_BYTES = 8_192
/** The largest `/version` body the verifier will parse. */
export const CONNECT_VERSION_MAX_BODY_BYTES = 32_768
/** One slow rescue attempt must never stall a reconnect loop. */
export const CONNECT_LOCATOR_TIMEOUT_MS = 10_000
/** Endpoints may name an https origin only — never plaintext, never a scheme upgrade. */
const LOCATOR_URL_SCHEME = 'https:'
const MAX_URL_CHARS = 2_048

/** Mirrors `isInstallationId` in `installation-identity.ts` (kept local: that
 *  module imports `node:crypto`, which this RN-safe file must not pull in). */
const INSTALLATION_ID_RE = /^pdm_[A-Za-z0-9_-]{43}$/
/** Mirrors `InstallationPublicKeyField` in `packages/protocol/src/pairing.ts`. */
const INSTALLATION_PUBLIC_KEY_RE = /^ed25519:[A-Za-z0-9_-]{43}$/

export const isLocatorInstallationId = (value: unknown): value is string =>
  typeof value === 'string' && INSTALLATION_ID_RE.test(value)

export const isLocatorInstallationPublicKey = (value: unknown): value is string =>
  typeof value === 'string' && INSTALLATION_PUBLIC_KEY_RE.test(value)

export interface ResolveLocatorOptions {
  /** A bare origin, e.g. https://connect.podium.do. */
  baseUrl: string
  installationId: string
  fetch?: typeof fetch
  /** Milliseconds. */
  timeoutMs?: number
}

function abortAfter(ms: number): { signal: AbortSignal | undefined } {
  try {
    return { signal: AbortSignal.timeout(ms) }
  } catch {
    // An older fetch without timeout support still resolves; the caller waits.
    return { signal: undefined }
  }
}

async function readCappedText(res: Response, maxBytes: number): Promise<string | undefined> {
  try {
    const declared = res.headers?.get('content-length')
    if (declared !== null && declared !== undefined && declared !== '') {
      const length = Number(declared)
      if (Number.isFinite(length) && length > maxBytes) return undefined
    }
    const text = await res.text()
    return text.length > maxBytes ? undefined : text
  } catch {
    return undefined
  }
}

function sanitizeEndpoint(value: unknown): LocatorEndpoint | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { url, priority } = value as { url?: unknown; priority?: unknown }
  if (typeof url !== 'string' || url.length < 1 || url.length > MAX_URL_CHARS) return undefined
  if (typeof priority !== 'number' || !Number.isFinite(priority)) return undefined
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return undefined
  }
  if (parsed.protocol !== LOCATOR_URL_SCHEME) return undefined
  if (parsed.username || parsed.password) return undefined
  if (!parsed.hostname) return undefined
  // Origins only: a path, query or fragment would be reinterpreted by every
  // caller that appends its own routes, the same reason `publicUrl` is bare.
  return { url: parsed.origin, priority }
}

function sanitizeLocatorRecord(body: unknown): LocatorRecord | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const { generation, issuedAt, expiresAt, endpoints } = body as {
    generation?: unknown
    issuedAt?: unknown
    expiresAt?: unknown
    endpoints?: unknown
  }
  if (!Number.isSafeInteger(generation) || (generation as number) < 1) return undefined
  if (typeof issuedAt !== 'string' || issuedAt.length === 0) return undefined
  if (expiresAt !== null && (typeof expiresAt !== 'string' || expiresAt.length === 0)) {
    return undefined
  }
  if (!Array.isArray(endpoints)) return undefined
  const accepted = endpoints
    .map(sanitizeEndpoint)
    .filter((endpoint): endpoint is LocatorEndpoint => endpoint !== undefined)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, CONNECT_LOCATOR_MAX_ENDPOINTS)
  if (accepted.length === 0) return undefined
  return {
    generation: generation as number,
    issuedAt,
    expiresAt: expiresAt as string | null,
    endpoints: accepted,
  }
}

/**
 * The unsigned read: `GET /v1/installations/:id`. Unsigned because the id is
 * the capability — a reader holds no installation key to sign with — and the
 * record it names can only have been written by that key. Never throws: every
 * failure is `undefined`.
 */
export async function resolveLocatorRecord(
  opts: ResolveLocatorOptions,
): Promise<LocatorRecord | undefined> {
  try {
    if (!isLocatorInstallationId(opts.installationId)) return undefined
    let base: URL
    try {
      base = new URL(opts.baseUrl.trim().replace(/\/+$/, ''))
    } catch {
      return undefined
    }
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return undefined
    const fetchImpl = opts.fetch ?? fetch
    const timeoutMs = opts.timeoutMs ?? CONNECT_LOCATOR_TIMEOUT_MS
    const res = await fetchImpl(
      `${base.origin}/v1/installations/${encodeURIComponent(opts.installationId)}`,
      { headers: { accept: 'application/json' }, ...abortAfter(timeoutMs) },
    )
    if (!res.ok) return undefined
    const text = await readCappedText(res, CONNECT_LOCATOR_MAX_BODY_BYTES)
    if (text === undefined) return undefined
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return undefined
    }
    return sanitizeLocatorRecord(body)
  } catch {
    return undefined
  }
}

export interface VersionIdentity {
  installationId: string
  installationPublicKey?: string
}

export interface FetchVersionIdentityOptions {
  /** The candidate's https origin — or a ws(s) server URL, which is converted. */
  serverUrl: string
  fetch?: typeof fetch
  /** Milliseconds. */
  timeoutMs?: number
}

/**
 * What the thing at `serverUrl` claims to be, read from its public `/version`.
 * Never throws. A server older than the public-key advertisement names only
 * its id; that still verifies — the key check below simply has nothing to
 * compare against.
 */
export async function fetchVersionIdentity(
  opts: FetchVersionIdentityOptions,
): Promise<VersionIdentity | undefined> {
  try {
    let target: URL
    try {
      target = new URL(opts.serverUrl.trim())
    } catch {
      return undefined
    }
    const protocol =
      target.protocol === 'ws:' ? 'http:' : target.protocol === 'wss:' ? 'https:' : target.protocol
    if (protocol !== 'http:' && protocol !== 'https:') return undefined
    const fetchImpl = opts.fetch ?? fetch
    const timeoutMs = opts.timeoutMs ?? CONNECT_LOCATOR_TIMEOUT_MS
    const res = await fetchImpl(`${protocol}//${target.host}/version`, {
      headers: { accept: 'application/json' },
      ...abortAfter(timeoutMs),
    })
    if (!res.ok) return undefined
    const text = await readCappedText(res, CONNECT_VERSION_MAX_BODY_BYTES)
    if (text === undefined) return undefined
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return undefined
    }
    if (typeof body !== 'object' || body === null) return undefined
    const { installationId, installationPublicKey } = body as {
      installationId?: unknown
      installationPublicKey?: unknown
    }
    if (!isLocatorInstallationId(installationId)) return undefined
    return isLocatorInstallationPublicKey(installationPublicKey)
      ? { installationId, installationPublicKey }
      : { installationId }
  } catch {
    return undefined
  }
}

/** ws(s) and http(s) spellings of one origin, for skipping the URL already dialled. */
function httpsOriginOf(value: string): string | undefined {
  try {
    const parsed = new URL(value.trim())
    const protocol =
      parsed.protocol === 'ws:' ? 'http:' : parsed.protocol === 'wss:' ? 'https:' : parsed.protocol
    if (protocol !== 'http:' && protocol !== 'https:') return undefined
    return `${protocol}//${parsed.host}`
  } catch {
    return undefined
  }
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
}

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
    if (!record) return undefined
    const current = opts.currentServerUrl ? httpsOriginOf(opts.currentServerUrl) : undefined
    for (const endpoint of record.endpoints) {
      if (current !== undefined && httpsOriginOf(endpoint.url) === current) continue
      const identity = await fetchVersionIdentity({
        serverUrl: endpoint.url,
        fetch: opts.fetch,
        timeoutMs: opts.timeoutMs,
      })
      if (!identity) continue
      if (identity.installationId !== opts.installationId) continue
      if (
        identity.installationPublicKey !== undefined &&
        identity.installationPublicKey !== opts.installationPublicKey
      ) {
        continue
      }
      return endpoint.url
    }
    return undefined
  } catch {
    return undefined
  }
}
