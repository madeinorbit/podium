/**
 * UPDATE DELIVERY: turn a resolved artifact reference into verified bytes or
 * a converged development checkout.
 *
 * Authority (what to run) and delivery (how the artifact arrives) are separate
 * axes. The convergence planner has already selected the platform asset, so
 * this module never re-derives the running platform.
 */
import { createHash, verify as cryptoVerify } from 'node:crypto'
import type { UpdateArtifact } from '@podium/protocol'
import { convergeViaGit, type GitRun } from './update-delivery-git'

/** The production release key used by feed and bundle verification. */
export const PODIUM_UPDATE_PUBKEY = 'MCowBQYDK2VwAyEAG12/153QJI/SePyYeJQhBSbh1ZsFgkoMkwb823NiYOU='

type PlatformAsset = Extract<UpdateArtifact, { delivery: 'feed' }>['platforms'][string]
type GitArtifact = Extract<UpdateArtifact, { delivery: 'git' }>

export interface DeliveryDeps {
  fetch: typeof fetch
  pubkey: string
  /** Public key pinned by this daemon's server pairing. Required for bundles. */
  pinnedPubkey?: string
  /**
   * Digest checking is a separate integrity gate from the signature. Tests may
   * disable it when they use a deliberately symbolic digest fixture; production
   * callers leave it enabled (the default).
   */
  verifyDigest?: boolean
  /** Runner for the development checkout delivery path. */
  git?: { run: GitRun }
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

/**
 * Pure, testable Ed25519 verification of a downloaded artifact. A malformed
 * key, missing signature, or crypto failure is a rejection, never a pass.
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

export function fetchArtifact(
  asset: PlatformAsset,
  delivery: 'feed' | 'bundle',
  deps: DeliveryDeps,
): Promise<{ bytes: Uint8Array }>
export function fetchArtifact(
  artifact: GitArtifact,
  delivery: 'git',
  deps: DeliveryDeps,
): Promise<{ git: true }>
export function fetchArtifact(
  asset: PlatformAsset | GitArtifact,
  delivery: UpdateArtifact['delivery'],
  deps: DeliveryDeps,
): Promise<{ bytes: Uint8Array } | { git: true }>
export async function fetchArtifact(
  asset: PlatformAsset | GitArtifact,
  delivery: UpdateArtifact['delivery'],
  deps: DeliveryDeps,
): Promise<{ bytes: Uint8Array } | { git: true }> {
  if (delivery === 'git') {
    if (!('repo' in asset) || !('sha' in asset) || !deps.git) {
      throw new Error('git delivery requires a configured checkout runner')
    }
    const result = await convergeViaGit(
      { repo: asset.repo, sha: asset.sha },
      {
        ...deps.git,
        // A git convergence has no byte count to divide, so its liveness is the
        // sequence of steps it is working through — every one of them a fact
        // about work that has actually happened.
        ...(deps.onProgress ? { onPhase: (phase: string) => deps.onProgress?.({ phase }) } : {}),
      },
    )
    if (!result.ok) throw new Error('git delivery failed: ' + result.reason)
    return { git: true }
  }
  if (!('url' in asset)) throw new Error('platform delivery requires an artifact URL')

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
    if (!res.ok) throw new Error(`artifact download returned ${res.status}`)
    bytes = await readArtifact(res, deps)
  } catch (error) {
    if (deps.signal?.aborted) throw new Error('artifact download was superseded by a newer grant')
    if (abort.signal.aborted) {
      throw new Error(`artifact download timed out after ${Math.round(timeoutMs / 1000)}s`)
    }
    throw error
  } finally {
    clearTimeout(timer)
    deps.signal?.removeEventListener('abort', onCallerAbort)
  }

  if (deps.verifyDigest !== false && !matchesDigest(bytes, asset.digest)) {
    throw new Error('digest verification FAILED — refusing to install the artifact')
  }

  // SECURITY GATE, before anything touches disk. Fail closed for both feed and
  // bundle delivery; transport authentication is not a substitute.
  const trustedPubkey = delivery === 'bundle' ? deps.pinnedPubkey : deps.pubkey
  if (trustedPubkey === undefined) {
    throw new Error('bundle delivery requires the server update key pinned at pairing')
  }
  if (!verifyTarball(bytes, asset.signature, trustedPubkey)) {
    throw new Error(
      'signature verification FAILED — refusing to install. The artifact was not ' +
        'signed by the trusted key (tampered, corrupt, or wrong feed). No changes were made.',
    )
  }
  return { bytes }
}
