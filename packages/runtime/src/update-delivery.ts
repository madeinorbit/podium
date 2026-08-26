/**
 * UPDATE DELIVERY: turn a resolved artifact reference into verified bytes.
 *
 * Authority (what to run) and delivery (how the artifact arrives) are separate
 * axes. The convergence planner has already selected the platform asset, so
 * this module never re-derives the running platform.
 *
 * ONE PATH FOR EVERY CHANNEL (spec §1). Dev, edge and stable all arrive as a
 * signed feed artifact; what differs between them is only WHICH KEY the
 * signature must be under, and that is a fact about the channel the target came
 * from — see {@link DeliveryDeps.trust}.
 */
import { createHash, verify as cryptoVerify } from 'node:crypto'
import {
  UPDATE_ARTIFACT_INTEGRITY_REFUSAL,
  UPDATE_ARTIFACT_REFUSAL_HEADER,
  type UpdateArtifact,
  type UpdateTrustRoot,
} from '@podium/protocol'

/** The baked Podium release key: the `release` trust root. */
export const PODIUM_UPDATE_PUBKEY = 'MCowBQYDK2VwAyEAG12/153QJI/SePyYeJQhBSbh1ZsFgkoMkwb823NiYOU='

type PlatformAsset = Extract<UpdateArtifact, { delivery: 'feed' }>['platforms'][string]

export interface DeliveryDeps {
  fetch: typeof fetch
  /** The baked release key — the `release` trust root. */
  pubkey: string
  /**
   * The Ed25519 key this daemon pinned when it paired with its server — the
   * `instance` trust root. Required whenever {@link trust} is `instance`.
   */
  pinnedPubkey?: string
  /**
   * WHICH KEY THIS TARGET'S SIGNATURE MUST BE UNDER.
   *
   * It used to be read off the DELIVERY KIND (`bundle` meant the pinned key,
   * anything else the baked one), which conflated "how the bytes travel" with
   * "who is allowed to have signed them" — and left no way at all to express a
   * dev artifact arriving as an ordinary feed download, which is what the dev
   * channel now is. The resolver stamps it on the target from the channel; this
   * is that stamp, carried down to the one place a key is chosen.
   *
   * Absent means `release`, the narrower reading: an instance-signed artifact
   * checked against the baked key simply fails.
   */
  trust?: UpdateTrustRoot
  /**
   * Digest checking is a separate integrity gate from the signature. Tests may
   * disable it when they use a deliberately symbolic digest fixture; production
   * callers leave it enabled (the default).
   */
  verifyDigest?: boolean
  /**
   * Hard deadline for the artifact download. Without one a stalled connection
   * left the daemon in `downloading` forever and the operator watching a row
   * that could never fail.
   */
  downloadTimeoutMs?: number
  /** Raised when a newer grant supersedes the one being delivered. */
  signal?: AbortSignal
  /**
   * Where delivery says how far it has got (POD-2101, spec §3.3). Called only
   * when {@link decideProgressReport} says the news is worth a frame, so the
   * caller can forward every call straight onto the wire.
   */
  onProgress?: (progress: DeliveryProgress) => void
  /** Injectable clock, so the report cadence is testable without waiting. */
  now?: () => number
}

/**
 * One progress report from a delivery in flight.
 *
 * `percent` is ABSENT rather than zero when the length is unknown: a server
 * with no `content-length` gives us bytes and nothing to divide them by, and a
 * fabricated denominator would be a progress bar that cannot say whether it is
 * moving — the thing this work exists to end.
 */
export interface DeliveryProgress {
  /** Short machine string: `downloading`, `git-fetch`, `git-checkout`, … */
  phase: string
  receivedBytes?: number
  totalBytes?: number
  /** Whole percent, 0–100, only when the total is known. */
  percent?: number
}

/** Long enough for a slow link, short enough that a hung socket still fails. */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 5 * 60_000

/** At most one report every two seconds… */
export const PROGRESS_REPORT_INTERVAL_MS = 2_000
/** …unless the download has moved five percentage points since the last one. */
export const PROGRESS_REPORT_PERCENT_STEP = 5

/**
 * Should this byte of news become a frame?
 *
 * Pure, and deliberately so: the cadence of a heartbeat is a rule, not a timer.
 * Every chunk that arrives asks this question, and the answer has to be cheap,
 * total, and testable in a table rather than by waiting two seconds.
 *
 * "Every 2 s OR every 5 percentage points, whichever comes first" — the time
 * bound keeps a slow link visibly alive, and the percentage bound keeps a fast
 * one from finishing between two ticks with nothing ever reported.
 */
export function decideProgressReport(
  lastSentAt: number | undefined,
  lastPercent: number | undefined,
  now: number,
  percent: number | undefined,
): boolean {
  // Nothing has been said yet: the fact that bytes are arriving is itself news.
  if (lastSentAt === undefined) return true
  if (now - lastSentAt >= PROGRESS_REPORT_INTERVAL_MS) return true
  if (percent === undefined) return false
  if (lastPercent === undefined) return true
  return percent - lastPercent >= PROGRESS_REPORT_PERCENT_STEP
}

function matchesDigest(bytes: Uint8Array, expected: string): boolean {
  // Release manifests encode digests as `sha256-<base64>`.
  if (!expected.startsWith('sha256-')) return false
  const actual = `sha256-${createHash('sha256').update(bytes).digest('base64')}`
  return actual === expected
}

function errorChainText(error: unknown): string {
  const messages: string[] = []
  const seen = new Set<unknown>()
  let current = error
  while (current && !seen.has(current) && messages.length < 6) {
    seen.add(current)
    if (current instanceof Error) {
      messages.push(current.message)
      const code = (current as Error & { code?: unknown }).code
      if (typeof code === 'string' && !current.message.includes(code)) messages.push(code)
      current = current.cause
    } else if (typeof current === 'object') {
      const value = current as { code?: unknown; message?: unknown; cause?: unknown }
      if (typeof value.code === 'string') messages.push(value.code)
      if (typeof value.message === 'string') messages.push(value.message)
      current = value.cause
    } else {
      messages.push(String(current))
      break
    }
  }
  return messages.join(' — ')
}

/** DNS absence and refused routes are properties of this published address, not a partial body. */
export function isArtifactAddressUnreachable(error: unknown): boolean {
  return /\b(?:ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH)\b|unable to connect|access the url/i.test(
    errorChainText(error),
  )
}

function publicArtifactAddress(raw: string): string {
  try {
    const url = new URL(raw)
    // Signed query parameters are credentials, not useful operator context.
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return raw.split(/[?#]/u, 1)[0] ?? raw
  }
}

/**
 * THE signature check, for every path that takes bytes off a wire: this
 * module's own delivery and `podium update`'s self-update, which imports it
 * (POD-2106). It used to be two byte-identical copies, and a security
 * primitive with two homes is one that can be fixed in one of them.
 *
 * Returns true iff `signatureB64` is a valid Ed25519 signature over `bytes`
 * under the base64 SPKI/DER public key `pubkeyB64`. A missing or empty
 * signature, a malformed key, or any crypto error returns false and never
 * throws, so every caller fails CLOSED without needing a try block of its own.
 */
export function verifyTarball(
  bytes: Uint8Array,
  signatureB64: string,
  pubkeyB64: string = PODIUM_UPDATE_PUBKEY,
): boolean {
  if (!signatureB64) return false
  try {
    const key = {
      key: Buffer.from(pubkeyB64, 'base64'),
      format: 'der' as const,
      type: 'spki' as const,
    }
    return cryptoVerify(null, bytes, key, Buffer.from(signatureB64, 'base64'))
  } catch {
    return false
  }
}

/** The declared length, or undefined when the server did not declare a usable one. */
function declaredLength(res: {
  headers?: { get(name: string): string | null }
}): number | undefined {
  const raw = res.headers?.get('content-length')
  if (raw === null || raw === undefined) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Read the artifact, saying how far it has got while it does.
 *
 * A NINE-MINUTE DOWNLOAD USED TO BE ONE FRAME AND THEN SILENCE (spec §1.3):
 * `arrayBuffer()` hands back the whole body at the end, so the only two facts
 * the fleet ever had were "started" and "finished". Streaming the body is what
 * makes the middle observable.
 *
 * With no reporter attached — the CLI's self-update, every existing test — this
 * takes the same one-shot path it always did. Progress reporting costs the
 * chunk loop only where someone is listening.
 */
async function readArtifact(res: Response, deps: DeliveryDeps): Promise<Uint8Array> {
  const body = res.body
  if (!deps.onProgress || !body) return new Uint8Array(await res.arrayBuffer())

  const onProgress = deps.onProgress
  const now = deps.now ?? Date.now
  const totalBytes = declaredLength(res)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let receivedBytes = 0
  let lastSentAt: number | undefined
  let lastPercent: number | undefined

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    receivedBytes += value.byteLength
    // Clamped: a body longer than its own declared length is a server bug, not
    // a reason to report 104%.
    const percent =
      totalBytes === undefined
        ? undefined
        : Math.min(100, Math.floor((receivedBytes / totalBytes) * 100))
    const at = now()
    if (!decideProgressReport(lastSentAt, lastPercent, at, percent)) continue
    lastSentAt = at
    lastPercent = percent
    onProgress({
      phase: 'downloading',
      receivedBytes,
      ...(totalBytes !== undefined ? { totalBytes } : {}),
      ...(percent !== undefined ? { percent } : {}),
    })
  }

  const bytes = new Uint8Array(receivedBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function fetchArtifact(
  asset: PlatformAsset,
  deps: DeliveryDeps,
): Promise<{ bytes: Uint8Array }> {
  if (!asset.url) throw new Error('feed delivery requires an artifact URL')

  // WHICH KEY, DECIDED BEFORE THE DOWNLOAD RATHER THAN AFTER IT.
  //
  // The verification itself has to happen at the end — it is over the bytes —
  // but the question "do I even HAVE the key this target names?" is answerable
  // now, and a quarter-gigabyte download that was always going to end in
  // "requires the server update key pinned at pairing" is minutes of a fleet
  // machine's time spent proving something knowable in a nanosecond.
  const trustedPubkey = deps.trust === 'instance' ? deps.pinnedPubkey : deps.pubkey
  if (trustedPubkey === undefined) {
    throw new Error('this target requires the server update key pinned at pairing')
  }

  const timeoutMs = deps.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS
  const abort = new AbortController()
  // Either bound ends the download: the deadline, or a superseding grant.
  const onCallerAbort = (): void => abort.abort()
  deps.signal?.addEventListener('abort', onCallerAbort, { once: true })
  if (deps.signal?.aborted) abort.abort()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  ;(timer as { unref?: () => void }).unref?.()
  let bytes: Uint8Array
  try {
    const res = await deps.fetch(asset.url, { signal: abort.signal })
    if (!res.ok) {
      const refusal = res.headers?.get(UPDATE_ARTIFACT_REFUSAL_HEADER)
      if (res.status === 404 && refusal === UPDATE_ARTIFACT_INTEGRITY_REFUSAL) {
        throw new Error(
          'published artifact digest verification FAILED — refusing to install because the ' +
            'stored bytes changed after publication',
        )
      }
      throw new Error(`artifact download returned ${res.status}`)
    }
    bytes = await readArtifact(res, deps)
  } catch (error) {
    if (deps.signal?.aborted) throw new Error('artifact download was superseded by a newer grant')
    if (abort.signal.aborted) {
      throw new Error(`artifact download timed out after ${Math.round(timeoutMs / 1000)}s`)
    }
    if (isArtifactAddressUnreachable(error)) {
      throw new Error(
        `artifact address unreachable: ${publicArtifactAddress(asset.url)} — ${errorChainText(error)}`,
      )
    }
    throw error
  } finally {
    clearTimeout(timer)
    deps.signal?.removeEventListener('abort', onCallerAbort)
  }

  if (deps.verifyDigest !== false && !matchesDigest(bytes, asset.digest)) {
    throw new Error('digest verification FAILED — refusing to install the artifact')
  }

  // SECURITY GATE, before anything touches disk. Fail closed on every channel;
  // transport authentication is not a substitute. The dev feed is fetched with
  // machine credentials AND signature-verified, because being allowed to ask
  // for bytes says nothing about who made them.
  if (!verifyTarball(bytes, asset.signature, trustedPubkey)) {
    throw new Error(
      'signature verification FAILED — refusing to install. The artifact was not ' +
        'signed by the trusted key (tampered, corrupt, or wrong feed). No changes were made.',
    )
  }
  return { bytes }
}
