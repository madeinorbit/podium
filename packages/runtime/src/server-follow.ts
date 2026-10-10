/**
 * FOLLOWING A MOVED SERVER (POD-4533, POD-5921).
 *
 * A server's public origin can change while the old one is simply gone — a
 * Cloudflare quick tunnel mints a new address on every restart, a server is
 * transferred, an operator retypes the URL. The server publishes where it is
 * to Podium Connect (`PUT /v1/installations/:id`, signed by the installation
 * key). Every client — daemon, browser tab, desktop window, phone — reads that
 * record back when the address it knows stops working, and follows.
 *
 * THE RULES (spec: docs/internal/superpowers/specs/2026-10-10-clients-follow-moved-server.md):
 *
 *  - FAILURE ONLY, NEVER A TIMER. A locate runs while disconnected, on the
 *    schedule {@link locateDelayMs} spells out. A healthy connection never
 *    asks Connect.
 *  - DISCOVERY IS UNTRUSTED. Connect only NAMES candidates. A candidate is
 *    adopted only after it signs a fresh client nonce with the installation
 *    key over its own configured `publicUrl` ({@link proveServer}), verified
 *    against the key the client STORED at pairing or its last authenticated
 *    login. Possession of the key, bound to the candidate's origin — not the
 *    self-reported `/version` the first version of this trusted.
 *  - NEVER THROWS, NEVER WORSE THAN TODAY. Every failure — no identity,
 *    Connect off or down, unknown id, a candidate that is unreachable, slow
 *    or unproven — is "no answer", and the caller keeps retrying the address
 *    it has, exactly as before.
 *
 * RN-SAFE ON PURPOSE. A phone runs the same code as a daemon: only `fetch`,
 * `URL`, `setTimeout` and `crypto.getRandomValues` — no `node:` imports, no
 * `Buffer`. The Ed25519 verifier (`@noble/curves`, one implementation for
 * Bun, browsers, Hermes and Workers — Hermes has no WebCrypto Ed25519) is
 * loaded with a dynamic `import()` so it stays out of the web app's startup
 * bundle.
 */
import {
  bytesFromBase64url,
  LOCATE_NONCE_BYTES,
  LOCATE_PROOF_MAX_RESPONSE_BYTES,
  LOCATE_PROOF_PATH,
  base64urlFromBytes,
  locateOrigin,
  locateProofMessage,
  parseLocateProofResponse,
  rawPublicKeyFromWire,
  type ServerIdentity,
  isServerIdentity,
} from '@podium/protocol'

export type { ServerIdentity }
export { isServerIdentity }

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
/** The largest `/version` body the reader will parse. */
export const CONNECT_VERSION_MAX_BODY_BYTES = 32_768
/** One slow request must never stall a reconnect loop. */
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

// ── HTTP, bounded ──────────────────────────────────────────────────────────

interface BoundedResponse {
  status: number
  ok: boolean
  /** `undefined` when the body was larger than allowed or unreadable. */
  text: string | undefined
}

class TimeoutError extends Error {
  override name = 'TimeoutError'
}

/**
 * One request, its body read and capped, all inside ONE timeout. Built on a
 * timer race rather than `AbortSignal.timeout` because Hermes lacks the
 * latter; the controller still aborts the socket where it can.
 */
async function boundedFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxBytes: number,
): Promise<BoundedResponse> {
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort()
      reject(new TimeoutError(`timed out after ${timeoutMs} ms`))
    }, timeoutMs)
  })
  const run = async (): Promise<BoundedResponse> => {
    const res = await fetchImpl(url, {
      ...init,
      ...(controller ? { signal: controller.signal } : {}),
    })
    if (!res.ok) return { status: res.status, ok: false, text: undefined }
    return { status: res.status, ok: true, text: await readCappedText(res, maxBytes) }
  }
  try {
    return await Promise.race([run(), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
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

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** A failed request's reason, in words an operator reading a log can act on. */
function describeFetchError(error: unknown, timeoutMs: number): string {
  const e = error as { name?: string; code?: string; message?: string; cause?: { code?: string } }
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError')
    return `timed out after ${timeoutMs} ms`
  const code = e?.code ?? e?.cause?.code
  if (code === 'ENOTFOUND' || code === 'EAI_NONAME' || code === 'DNSException')
    return `name does not resolve (${code})`
  const message = e?.message ?? String(error)
  return code ? `${code}: ${message}` : message
}

/** ws(s) and http(s) spellings of one origin, as an http(s) origin. */
export function httpOriginOf(value: string): string | undefined {
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

// ── The Connect read ──────────────────────────────────────────────────────

export interface ResolveLocatorOptions {
  /** A bare origin, e.g. https://connect.podium.do. */
  baseUrl: string
  installationId: string
  fetch?: typeof fetch
  /** Milliseconds. */
  timeoutMs?: number
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
    const res = await boundedFetch(
      opts.fetch ?? fetch,
      `${base.origin}/v1/installations/${encodeURIComponent(opts.installationId)}`,
      { headers: { accept: 'application/json' } },
      opts.timeoutMs ?? CONNECT_LOCATOR_TIMEOUT_MS,
      CONNECT_LOCATOR_MAX_BODY_BYTES,
    )
    if (!res.ok) return undefined
    return sanitizeLocatorRecord(parseJson(res.text))
  } catch {
    return undefined
  }
}

// ── `/version`: what a server SAYS it is ───────────────────────────────────

export interface VersionIdentity {
  installationId: string
  installationPublicKey?: string
}

export interface FetchVersionIdentityOptions {
  /** The server's http(s) origin — or a ws(s) server URL, which is converted. */
  serverUrl: string
  fetch?: typeof fetch
  /** Milliseconds. */
  timeoutMs?: number
}

/**
 * What the server at `serverUrl` claims to be, read from its public
 * `/version`, keeping WHY it gave no identity. Self-reported: this proves
 * nothing about who holds the key. Callers use it to LEARN the identity of a
 * server they just authenticated to (rule 1), and — during the daemon's one
 * transition — to accept a server too old to answer the proof (§6).
 */
export async function readVersionIdentity(
  opts: FetchVersionIdentityOptions,
): Promise<{ identity: VersionIdentity } | { failure: string }> {
  const timeoutMs = opts.timeoutMs ?? CONNECT_LOCATOR_TIMEOUT_MS
  try {
    const origin = httpOriginOf(opts.serverUrl)
    if (!origin) return { failure: 'not an http(s) or ws(s) URL' }
    const res = await boundedFetch(
      opts.fetch ?? fetch,
      `${origin}/version`,
      { headers: { accept: 'application/json' } },
      timeoutMs,
      CONNECT_VERSION_MAX_BODY_BYTES,
    )
    if (!res.ok) return { failure: `/version answered HTTP ${res.status}` }
    if (res.text === undefined) return { failure: '/version body too large or unreadable' }
    const body = parseJson(res.text)
    if (body === undefined) return { failure: '/version is not JSON' }
    if (typeof body !== 'object' || body === null) return { failure: '/version is not an object' }
    const { installationId, installationPublicKey } = body as {
      installationId?: unknown
      installationPublicKey?: unknown
    }
    if (!isLocatorInstallationId(installationId))
      return { failure: '/version names no installation' }
    return {
      identity: isLocatorInstallationPublicKey(installationPublicKey)
        ? { installationId, installationPublicKey }
        : { installationId },
    }
  } catch (error) {
    return { failure: describeFetchError(error, timeoutMs) }
  }
}

/** {@link readVersionIdentity} without the reason. Never throws. */
export async function fetchVersionIdentity(
  opts: FetchVersionIdentityOptions,
): Promise<VersionIdentity | undefined> {
  const read = await readVersionIdentity(opts)
  return 'identity' in read ? read.identity : undefined
}

/** The full identity a server advertises, or `undefined` — for rule 1's capture. */
export async function fetchAdvertisedIdentity(
  opts: FetchVersionIdentityOptions,
): Promise<ServerIdentity | undefined> {
  const identity = await fetchVersionIdentity(opts)
  return identity && isServerIdentity(identity) ? identity : undefined
}

// ── The proof ─────────────────────────────────────────────────────────────

type Verify = (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) => boolean
let verifier: Promise<Verify> | undefined

/** Loaded on first use: keeps the curve library out of every startup bundle. */
function loadVerifier(): Promise<Verify> {
  verifier ??= import('@noble/curves/ed25519').then(({ ed25519 }) => {
    return (signature, message, publicKey) => {
      try {
        // Strict RFC 8032 verification — what node:crypto and WebCrypto do.
        return ed25519.verify(signature, message, publicKey, { zip215: false })
      } catch {
        return false
      }
    }
  })
  return verifier
}

function freshNonce(): Uint8Array {
  const nonce = new Uint8Array(LOCATE_NONCE_BYTES)
  globalThis.crypto.getRandomValues(nonce)
  return nonce
}

export type ProofResult = { ok: true } | { ok: false; reason: string; status?: number }

export interface ProveServerOptions {
  /** The candidate's https origin (a ws(s) URL is converted). */
  origin: string
  /** What the client STORED — the proof is checked against this key, never one the candidate offers. */
  identity: ServerIdentity
  fetch?: typeof fetch
  /** Milliseconds. */
  timeoutMs?: number
  /** For tests: the nonce to send. */
  nonce?: Uint8Array
}

/**
 * Ask `origin` to prove it holds the installation key (spec §4). Passes only
 * when: HTTP 200 within the timeout; the id is the stored id; the signed
 * `publicUrl` is `origin` itself; and the signature verifies under the
 * STORED key over this call's fresh nonce. Never throws.
 */
export async function proveServer(opts: ProveServerOptions): Promise<ProofResult> {
  const timeoutMs = opts.timeoutMs ?? CONNECT_LOCATOR_TIMEOUT_MS
  try {
    if (!isServerIdentity(opts.identity)) return { ok: false, reason: 'no stored identity' }
    const candidate = httpOriginOf(opts.origin)
    if (!candidate) return { ok: false, reason: 'not an http(s) origin' }
    const publicKey = rawPublicKeyFromWire(opts.identity.installationPublicKey)
    if (!publicKey) return { ok: false, reason: 'stored key is malformed' }
    const nonce = opts.nonce ?? freshNonce()
    let res: BoundedResponse
    try {
      res = await boundedFetch(
        opts.fetch ?? fetch,
        `${candidate}${LOCATE_PROOF_PATH}`,
        {
          method: 'POST',
          // text/plain keeps a cross-origin browser call a simple request: no preflight.
          headers: { 'content-type': 'text/plain' },
          body: JSON.stringify({ nonce: base64urlFromBytes(nonce) }),
          redirect: 'manual',
        },
        timeoutMs,
        LOCATE_PROOF_MAX_RESPONSE_BYTES,
      )
    } catch (error) {
      return { ok: false, reason: describeFetchError(error, timeoutMs) }
    }
    if (!res.ok) {
      return {
        ok: false,
        reason:
          res.status === 404
            ? 'answers no locate proof (HTTP 404)'
            : `locate proof answered HTTP ${res.status}`,
        status: res.status,
      }
    }
    const proof = parseLocateProofResponse(parseJson(res.text))
    if (!proof) return { ok: false, reason: 'malformed locate proof' }
    if (proof.installationId !== opts.identity.installationId) {
      return { ok: false, reason: `serves a different installation (${proof.installationId})` }
    }
    if (locateOrigin(proof.publicUrl) !== candidate) {
      return { ok: false, reason: `signs for a different address (${proof.publicUrl})` }
    }
    const signature = bytesFromBase64url(proof.signature)
    if (!signature) return { ok: false, reason: 'malformed locate proof' }
    const verify = await loadVerifier()
    if (!verify(signature, locateProofMessage(nonce, proof.publicUrl), publicKey)) {
      return { ok: false, reason: 'signature does not verify under the stored installation key' }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: describeFetchError(error, timeoutMs) }
  }
}

// ── Locating ──────────────────────────────────────────────────────────────

/** Why a locate adopted nothing. */
export type LocateMiss =
  /** Nothing stored to verify against: following is off. */
  | { kind: 'no-identity' }
  /** Connect gave no usable record: off, unreachable, unknown id, or malformed. */
  | { kind: 'no-record' }
  /** The record names only the address already failing — not republished yet. */
  | { kind: 'no-new-address' }
  /** A candidate was tried and refused. */
  | { kind: 'rejected'; url: string; reason: string }

export interface LocateServerOptions {
  identity: ServerIdentity | undefined
  /** The address already being dialled (any http(s)/ws(s) spelling): never "located" again. */
  currentOrigin: string
  connectBaseUrl: string
  fetch?: typeof fetch
  /** Milliseconds, per request. */
  timeoutMs?: number
  report?: (miss: LocateMiss) => void
  /**
   * THE DAEMON'S ONE TRANSITION (spec §6): a candidate whose proof route
   * answers 404 — a server older than the proof — may still be accepted by
   * the `/version` identity check. Only a daemon that has never verified a
   * proof from its server passes this. Delete with the fallback.
   */
  legacyVersionCheck?: boolean
}

async function legacyVersionAccepts(
  url: string,
  opts: LocateServerOptions & { identity: ServerIdentity },
): Promise<string | undefined> {
  const read = await readVersionIdentity({ serverUrl: url, fetch: opts.fetch, timeoutMs: opts.timeoutMs })
  if ('failure' in read) return read.failure
  if (read.identity.installationId !== opts.identity.installationId) {
    return `serves a different installation (${read.identity.installationId})`
  }
  if (
    read.identity.installationPublicKey !== undefined &&
    read.identity.installationPublicKey !== opts.identity.installationPublicKey
  ) {
    return 'serves this installation id with a different key'
  }
  return undefined
}

/**
 * Discovery plus proof in one call: read the Connect record, walk its
 * endpoints highest priority first, skip the current origin, and return the
 * first that proves it is this installation. `undefined` means "keep
 * retrying the address you have". Never throws.
 */
export async function locateServer(opts: LocateServerOptions): Promise<string | undefined> {
  try {
    const identity = opts.identity
    if (!identity || !isServerIdentity(identity)) {
      opts.report?.({ kind: 'no-identity' })
      return undefined
    }
    const record = await resolveLocatorRecord({
      baseUrl: opts.connectBaseUrl,
      installationId: identity.installationId,
      fetch: opts.fetch,
      timeoutMs: opts.timeoutMs,
    })
    if (!record) {
      opts.report?.({ kind: 'no-record' })
      return undefined
    }
    const current = httpOriginOf(opts.currentOrigin)
    let tried = 0
    for (const endpoint of record.endpoints) {
      if (current !== undefined && httpOriginOf(endpoint.url) === current) continue
      tried += 1
      const proof = await proveServer({
        origin: endpoint.url,
        identity,
        fetch: opts.fetch,
        timeoutMs: opts.timeoutMs,
      })
      if (proof.ok) return endpoint.url
      if (opts.legacyVersionCheck && proof.status === 404) {
        const refused = await legacyVersionAccepts(endpoint.url, { ...opts, identity })
        if (refused === undefined) return endpoint.url
        opts.report?.({ kind: 'rejected', url: endpoint.url, reason: refused })
        continue
      }
      opts.report?.({ kind: 'rejected', url: endpoint.url, reason: proof.reason })
    }
    if (tried === 0) opts.report?.({ kind: 'no-new-address' })
    return undefined
  } catch {
    return undefined
  }
}

// ── The schedule ──────────────────────────────────────────────────────────

/**
 * When to ask again during one outage (POD-4646, reshaped by POD-3274). The
 * first ask is immediate; the next three come after 2, 4 and 8 s; then every
 * `LOCATE_ASK_STEADY_MS` until the outage has lasted `LOCATE_FAST_WINDOW_MS`;
 * then every `LOCATE_ASK_MAX_MS`.
 *
 * FAST FIRST: a crashed or restarted tunnel publishes its new address a few
 * seconds after the drop (podium-tunnel holds it until the name resolves).
 *
 * STEADY THROUGH A REBOOT: a rebooting server publishes minutes into the
 * outage. A backoff that kept doubling found it one whole gap late — measured
 * on the lab, a 90 s reboot was followed 31 s after the address was out.
 * Asking every ~15 s for ten minutes bounds that lag to about one ask.
 *
 * THEN SLOW: a server that is simply off settles at one ask per five minutes.
 * Every wait is jittered ±50%, so a fleet stranded by the same outage does
 * not ask in lockstep when Connect or the server returns.
 */
const LOCATE_ASK_FIRST_MS = [2_000, 4_000, 8_000] as const
const LOCATE_ASK_STEADY_MS = 15_000
const LOCATE_FAST_WINDOW_MS = 10 * 60_000
const LOCATE_ASK_MAX_MS = 300_000

/**
 * The wait before the next ask, jittered ±50%. `asked` is how many asks this
 * outage has made; `outageMs` how long it has lasted by the caller's measure
 * (the daemon counts scheduled backoff, a {@link ServerFollower} its own waits).
 */
export function locateDelayMs(
  asked: number,
  outageMs: number,
  random: () => number = Math.random,
): number {
  const base =
    LOCATE_ASK_FIRST_MS[asked - 1] ??
    (outageMs < LOCATE_FAST_WINDOW_MS ? LOCATE_ASK_STEADY_MS : LOCATE_ASK_MAX_MS)
  return Math.round(base * (0.5 + random()))
}

// ── The follower ──────────────────────────────────────────────────────────

/** How a client moves: found through Connect (proven), or pushed by its live server. */
export type ServerMove =
  | { via: 'connect'; origin: string }
  | { via: 'transfer'; origin: string; transferId: string; claimToken?: string }

export type FollowEvent =
  | { kind: 'looking'; asked: number }
  | { kind: 'miss'; miss: LocateMiss }
  | { kind: 'found'; origin: string }
  | { kind: 'adopted'; move: ServerMove }
  | { kind: 'adopt-failed'; move: ServerMove; error: unknown }
  | { kind: 'waiting'; delayMs: number }

type TimerHandle = ReturnType<typeof setTimeout>

export interface ServerFollowerOptions {
  identity: () => ServerIdentity | undefined
  /** The origin this client dials now, any http(s)/ws(s) spelling. */
  currentOrigin: () => string
  connectBaseUrl: () => string
  /** The ONE way this client moves (spec rule 5). Throwing means "not moved". */
  adopt: (move: ServerMove) => Promise<void>
  /** Injectable for tests. */
  locate?: typeof locateServer
  fetch?: typeof fetch
  setTimeout?: (fn: () => void, ms: number) => TimerHandle
  clearTimeout?: (handle: TimerHandle) => void
  random?: () => number
  log?: (event: FollowEvent) => void
}

/**
 * One client's following, driven by its connection: `disconnected()` when it
 * cannot reach the server, `connected()` once it is authenticated again.
 *
 *  - One locate in flight at a time; `disconnected()` while already looking
 *    is a no-op.
 *  - `connected()` cancels the pending wait and discards the result of a
 *    locate still in flight.
 *  - A successful adopt ends the outage: the follower waits for the next
 *    `connected()` — or, if the new address fails too, a fresh
 *    `disconnected()`. An adopt that throws is logged and the schedule goes on.
 *  - It never adopts the current origin.
 *  - `pushed()` is a transfer frame from the live, authenticated server: it
 *    is adopted at once, with no proof (spec §7.0).
 */
export class ServerFollower {
  readonly #opts: ServerFollowerOptions
  readonly #setTimeout: (fn: () => void, ms: number) => TimerHandle
  readonly #clearTimeout: (handle: TimerHandle) => void
  #looking = false
  #asked = 0
  #outageMs = 0
  #timer: TimerHandle | undefined
  #inFlight = false
  /** Bumped by everything that makes an in-flight result stale. */
  #epoch = 0
  #disposed = false

  constructor(opts: ServerFollowerOptions) {
    this.#opts = opts
    this.#setTimeout = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this.#clearTimeout = opts.clearTimeout ?? ((handle) => clearTimeout(handle))
  }

  /** True while an outage is being worked: a locate in flight or a wait armed. */
  get looking(): boolean {
    return this.#looking
  }

  disconnected(): void {
    if (this.#disposed || this.#looking) return
    this.#looking = true
    this.#asked = 0
    this.#outageMs = 0
    this.#ask()
  }

  connected(): void {
    this.#stop()
  }

  pushed(move: ServerMove & { via: 'transfer' }): void {
    if (this.#disposed) return
    this.#stop()
    void this.#adopt(move)
  }

  dispose(): void {
    this.#disposed = true
    this.#stop()
  }

  #stop(): void {
    this.#epoch += 1
    this.#looking = false
    this.#asked = 0
    this.#outageMs = 0
    if (this.#timer !== undefined) {
      this.#clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }

  #log(event: FollowEvent): void {
    try {
      this.#opts.log?.(event)
    } catch {
      // A logger never breaks following.
    }
  }

  async #adopt(move: ServerMove): Promise<boolean> {
    try {
      await this.#opts.adopt(move)
      this.#log({ kind: 'adopted', move })
      return true
    } catch (error) {
      this.#log({ kind: 'adopt-failed', move, error })
      return false
    }
  }

  #ask(): void {
    if (this.#disposed || !this.#looking || this.#inFlight) return
    this.#timer = undefined
    this.#asked += 1
    this.#inFlight = true
    const epoch = this.#epoch
    this.#log({ kind: 'looking', asked: this.#asked })
    void this.#locateOnce()
      .then(async (found) => {
        this.#inFlight = false
        if (epoch !== this.#epoch || this.#disposed) {
          // Stale: connected (or re-disconnected) meanwhile. If a new outage
          // started while this was in flight, its first ask waited for us.
          if (this.#looking && this.#timer === undefined) this.#ask()
          return
        }
        if (found !== undefined) {
          this.#log({ kind: 'found', origin: found })
          const moved = await this.#adopt({ via: 'connect', origin: found })
          if (epoch !== this.#epoch || this.#disposed) return
          if (moved) {
            // The outage this answered is over; the next failure starts afresh.
            this.#looking = false
            this.#asked = 0
            this.#outageMs = 0
            return
          }
        }
        this.#schedule()
      })
      .catch(() => {
        this.#inFlight = false
        if (epoch === this.#epoch) this.#schedule()
      })
  }

  async #locateOnce(): Promise<string | undefined> {
    const locate = this.#opts.locate ?? locateServer
    let currentOrigin: string
    let connectBaseUrl: string
    let identity: ServerIdentity | undefined
    try {
      currentOrigin = this.#opts.currentOrigin()
      connectBaseUrl = this.#opts.connectBaseUrl()
      identity = this.#opts.identity()
    } catch {
      return undefined
    }
    const found = await locate({
      identity,
      currentOrigin,
      connectBaseUrl,
      ...(this.#opts.fetch ? { fetch: this.#opts.fetch } : {}),
      report: (miss) => this.#log({ kind: 'miss', miss }),
    })
    if (found === undefined) return undefined
    // Never "move" to where we already are.
    const current = httpOriginOf(currentOrigin)
    return current !== undefined && httpOriginOf(found) === current ? undefined : found
  }

  #schedule(): void {
    if (this.#disposed || !this.#looking) return
    const delayMs = locateDelayMs(this.#asked, this.#outageMs, this.#opts.random)
    this.#outageMs += delayMs
    this.#log({ kind: 'waiting', delayMs })
    this.#timer = this.#setTimeout(() => this.#ask(), delayMs)
  }
}
