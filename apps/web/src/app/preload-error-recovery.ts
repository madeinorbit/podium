import { navigateReload } from '@/lib/navigate'

const PRELOAD_RELOAD_GUARD_KEY = 'podium.vite-preload-reloads'
const MAX_RELOADS_PER_BUILD = 2
const RELOAD_GUARD_TTL_MS = 5 * 60_000

interface PreloadReloadGuard {
  build: string
  failures: string[]
  reloads: number
  expiresAt: number
}

interface PreloadErrorRecoveryOptions {
  build: string
  storage: Pick<Storage, 'getItem' | 'setItem'>
  reload: () => void
  now?: number
  isOnline?: () => boolean
  probe?: (url: string) => Promise<{ status: number }>
}

function readGuard(storage: PreloadErrorRecoveryOptions['storage']): PreloadReloadGuard | null {
  const raw = storage.getItem(PRELOAD_RELOAD_GUARD_KEY)
  if (!raw) return null

  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) return null
  const { build, failures, reloads, expiresAt } = parsed as {
    build?: unknown
    failures?: unknown
    reloads?: unknown
    expiresAt?: unknown
  }
  if (typeof build !== 'string' || !Array.isArray(failures)) return null
  if (!failures.every((failure) => typeof failure === 'string')) return null
  if (typeof reloads !== 'number' || !Number.isInteger(reloads) || reloads < 0) return null
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null
  return { build, failures, reloads, expiresAt }
}

function moduleUrlFrom(error: Error, build: string): string | null {
  const candidate = error.message.match(/(?:https?:\/\/|\/|\.\.?\/)[^\s'"<>]+/)?.[0]
  if (!candidate) return null

  try {
    return new URL(candidate.replace(/[),.;]+$/, ''), build).href
  } catch {
    return null
  }
}

/**
 * Reload a built app once for one missing native module URL. Vite dispatches this
 * cancelable event when its production dynamic-import wrapper cannot load a
 * chunk. A reload creates a new browser module map, unlike retrying import() in
 * the current page.
 *
 * A browser's import error does not distinguish an outage from a deleted file.
 * Only a confirmed 404/410 while online earns a reload. Unknown and network
 * failures reject into the surface's in-page recovery without spending the guard.
 * Stable module URLs are tried once, with a short per-build reload budget. The
 * budget stops a persistent failure even when browser wording changes, then
 * expires so a later transient failure can recover. Returning without
 * preventDefault is deliberate: the rejected import still reaches the terminal
 * or injected loader's in-page retry path.
 */
export async function recoverFromVitePreloadError(
  event: VitePreloadErrorEvent,
  {
    build,
    storage,
    reload,
    now = Date.now(),
    isOnline = () => navigator.onLine,
    probe = (url) => fetch(url, { method: 'HEAD', cache: 'no-store' }),
  }: PreloadErrorRecoveryOptions,
): Promise<boolean> {
  if (!isOnline()) return false
  const failure = moduleUrlFrom(event.payload, build)
  if (!failure) return false
  try {
    const response = await probe(failure)
    if (!isOnline() || (response.status !== 404 && response.status !== 410)) return false
  } catch {
    return false
  }
  let guard: PreloadReloadGuard | null

  try {
    guard = readGuard(storage)
    const active = guard?.build === build && guard.expiresAt > now ? guard : null
    if (active && active.reloads >= MAX_RELOADS_PER_BUILD) return false
    if (failure && active?.failures.includes(failure)) return false

    const failures = failure ? [...(active?.failures ?? []), failure] : (active?.failures ?? [])
    storage.setItem(
      PRELOAD_RELOAD_GUARD_KEY,
      JSON.stringify({
        build,
        failures,
        reloads: (active?.reloads ?? 0) + 1,
        expiresAt: active?.expiresAt ?? now + RELOAD_GUARD_TTL_MS,
      } satisfies PreloadReloadGuard),
    )
  } catch {
    // Without a persistent guard, reloading could loop. Leave the event alone
    // so the dynamic import rejects into its ordinary in-page recovery path.
    return false
  }

  event.preventDefault()
  reload()
  return true
}

/** One reconnect attempt per failed surface; unmounting cancels the listener. */
export function retryOnOnline(retry: () => void, target: EventTarget = window): () => void {
  target.addEventListener('online', retry, { once: true })
  return () => target.removeEventListener('online', retry)
}

/** Install the production-only listener before the app starts any lazy imports. */
export function installVitePreloadErrorRecovery(): void {
  if (!import.meta.env.PROD) return

  window.addEventListener('vite:preloadError', (event) => {
    void recoverFromVitePreloadError(event, {
      build: import.meta.url,
      storage: {
        getItem: (key) => window.sessionStorage.getItem(key),
        setItem: (key, value) => window.sessionStorage.setItem(key, value),
      },
      reload: () => navigateReload('preload-recovery', 'lazy-chunk-unreachable'),
      now: Date.now(),
    })
  })
}
