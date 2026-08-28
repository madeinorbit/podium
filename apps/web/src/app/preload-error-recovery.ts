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
 * Reload a built app once for one failed native module URL. Vite dispatches this
 * cancelable event when its production dynamic-import wrapper cannot load a
 * chunk. A reload creates a new browser module map, unlike retrying import() in
 * the current page.
 *
 * Stable module URLs are tried once. URL-less browser errors may represent
 * different chunks, so they share only a short per-build reload budget. The
 * budget stops a persistent failure even when browser wording changes, then
 * expires so a later transient failure can recover. Returning without
 * preventDefault is deliberate: the rejected import still reaches the terminal
 * or injected loader's in-page retry path.
 */
export function recoverFromVitePreloadError(
  event: VitePreloadErrorEvent,
  { build, storage, reload, now = Date.now() }: PreloadErrorRecoveryOptions,
): boolean {
  const failure = moduleUrlFrom(event.payload, build)
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

/** Install the production-only listener before the app starts any lazy imports. */
export function installVitePreloadErrorRecovery(): void {
  if (!import.meta.env.PROD) return

  window.addEventListener('vite:preloadError', (event) => {
    recoverFromVitePreloadError(event, {
      build: import.meta.url,
      storage: {
        getItem: (key) => window.sessionStorage.getItem(key),
        setItem: (key, value) => window.sessionStorage.setItem(key, value),
      },
      reload: () => window.location.reload(),
      now: Date.now(),
    })
  })
}
