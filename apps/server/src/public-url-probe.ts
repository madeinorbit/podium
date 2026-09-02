import { createLogger } from '@podium/logger'

const defaultLog = createLogger('server:public-url-probe')

/**
 * Retry schedule after a failed check, in ms. The LAST entry repeats forever: a
 * public URL that is not reachable yet is usually waiting on DNS, a certificate,
 * or a proxy nobody has pointed here — all things a human fixes minutes or hours
 * later, and the instance should notice without being restarted.
 */
export const PUBLIC_URL_PROBE_BACKOFF_MS = [2_000, 5_000, 15_000, 60_000, 300_000] as const

const TIMEOUT_MS = 5_000

export interface PublicUrlVerification {
  ok: boolean
  checkedAt: string
  error?: string
}

export interface PublicUrlProbe {
  /** The latest result, or `undefined` before the first check has completed. */
  state(): PublicUrlVerification | undefined
  stop(): void
}

/** Loopback needs no probe: the front door and the back door are the same door,
 *  with no certificate, DNS record or proxy in between to get wrong. */
function isLoopback(url: URL): boolean {
  return (
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '::1' ||
    url.hostname === '[::1]' ||
    url.hostname.endsWith('.localhost')
  )
}

/**
 * CAN THIS INSTANCE REACH ITSELF THROUGH ITS OWN FRONT DOOR? (PDM-26)
 *
 * The public URL is the one value this server hands out as a PROMISE: it is
 * embedded in every machine join token and every mobile pairing payload, and a
 * device that takes a wrong one has no way back. Nothing checked it before, so a
 * typo, a proxy pointed at the wrong port, or a DNS record that had not
 * propagated produced machines that enrolled and then never connected — which
 * looks like a broken daemon from every side it can be looked at from.
 *
 * IT NEVER BLOCKS SERVING. Some self-hosted networks hairpin badly, and a box
 * that cannot reach its own public address is still perfectly able to serve the
 * operator sitting in front of it. What the result gates is narrower and exact:
 * the two flows that MINT one of those promises.
 *
 * It compares `instanceId` rather than settling for a 200, because "something
 * answers on that URL" is not the question being asked — a second instance, a
 * stale proxy, and an unrelated service all answer.
 */
export function startPublicUrlProbe(opts: {
  publicUrl: string | undefined
  instanceId: string
  fetch?: typeof globalThis.fetch
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  log?: { warn(msg: string, meta?: object): void; info(msg: string, meta?: object): void }
}): PublicUrlProbe {
  const log = opts.log ?? defaultLog
  const doFetch = opts.fetch ?? globalThis.fetch
  const schedule = opts.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const cancel = opts.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as never))
  const now = opts.now ?? Date.now
  const stamp = (): string => new Date(now()).toISOString()

  let verification: PublicUrlVerification | undefined
  let handle: unknown
  let attempt = 0
  let stopped = false

  if (!opts.publicUrl) return { state: () => undefined, stop: () => {} }

  let url: URL
  try {
    url = new URL(opts.publicUrl)
  } catch {
    verification = { ok: false, checkedAt: stamp(), error: 'public URL is not a valid URL' }
    return { state: () => verification, stop: () => {} }
  }

  if (isLoopback(url)) {
    verification = { ok: true, checkedAt: stamp() }
    return { state: () => verification, stop: () => {} }
  }

  const probeUrl = `${url.origin}/readiness`

  const settle = (next: PublicUrlVerification): void => {
    // WARN ONCE PER STATE CHANGE. A five-minute retry loop that logs every
    // attempt is a log nobody is still reading by the time it matters.
    const changed = verification?.ok !== next.ok || verification?.error !== next.error
    verification = next
    if (!changed) return
    if (next.ok) log.info('public URL is reachable', { url: url.origin })
    else
      log.warn('public URL is not reachable from this instance', {
        url: url.origin,
        error: next.error,
      })
  }

  const check = async (): Promise<void> => {
    if (stopped) return
    try {
      const res = await doFetch(probeUrl, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'follow',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { instanceId?: unknown }
      if (typeof body.instanceId !== 'string' || body.instanceId.length === 0) {
        throw new Error('response did not identify a Podium instance')
      }
      if (body.instanceId !== opts.instanceId) throw new Error('another instance answers on that URL')
      settle({ ok: true, checkedAt: stamp() })
      return
    } catch (e) {
      settle({ ok: false, checkedAt: stamp(), error: (e as Error).message })
    }
    if (stopped) return
    const index = Math.min(attempt, PUBLIC_URL_PROBE_BACKOFF_MS.length - 1)
    attempt += 1
    handle = schedule(() => void check(), PUBLIC_URL_PROBE_BACKOFF_MS[index] as number)
  }

  void check()

  return {
    state: () => verification,
    stop: () => {
      stopped = true
      if (handle !== undefined) cancel(handle)
    },
  }
}

/**
 * THE PROCESS'S PROBE, for the two call sites that cannot be handed it.
 *
 * `router.ts` builds its fleet ports at MODULE LOAD, before any server exists,
 * and already reads `loadConfig()` process-globally for exactly that reason.
 * Rather than invent a second injection path for one boolean, the probe
 * publishes itself here and those sites read it the same way they read the
 * config. `startServer` sets it; `stop()` clears it, so a test that starts and
 * stops a server leaves nothing behind.
 */
let processProbe: PublicUrlProbe | undefined

export function setProcessPublicUrlProbe(probe: PublicUrlProbe | undefined): void {
  processProbe = probe
}

/** The process's latest verification, or `null` when there is no probe or the
 *  first check has not completed. `null` never refuses anything — only a known
 *  failure does. */
export function processPublicUrlVerification(): PublicUrlVerification | null {
  return processProbe?.state() ?? null
}
