const PRELOAD_RELOAD_GUARD_KEY = 'podium.vite-preload-reloads'

interface PreloadReloadGuard {
  build: string
  failures: string[]
}

interface PreloadErrorRecoveryOptions {
  build: string
  storage: Pick<Storage, 'getItem' | 'setItem'>
  reload: () => void
}

function readGuard(storage: PreloadErrorRecoveryOptions['storage']): PreloadReloadGuard | null {
  const raw = storage.getItem(PRELOAD_RELOAD_GUARD_KEY)
  if (!raw) return null

  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) return null
  const { build, failures } = parsed as { build?: unknown; failures?: unknown }
  if (typeof build !== 'string' || !Array.isArray(failures)) return null
  if (!failures.every((failure) => typeof failure === 'string')) return null
  return { build, failures }
}

function failureKey(error: Error): string {
  return `${error.name}: ${error.message}`
}

/**
 * Reload a built app once for one failed native module URL. Vite dispatches this
 * cancelable event when its production dynamic-import wrapper cannot load a
 * chunk. A reload creates a new browser module map, unlike retrying import() in
 * the current page.
 *
 * The stored build and failure pair prevents a missing asset from reloading the
 * tab forever. Returning without preventDefault is deliberate: the rejected
 * import still reaches the terminal or injected loader's in-page retry path.
 */
export function recoverFromVitePreloadError(
  event: VitePreloadErrorEvent,
  { build, storage, reload }: PreloadErrorRecoveryOptions,
): boolean {
  const failure = failureKey(event.payload)
  let guard: PreloadReloadGuard | null

  try {
    guard = readGuard(storage)
    if (guard?.build === build && guard.failures.includes(failure)) return false

    const failures = guard?.build === build ? [...guard.failures, failure] : [failure]
    storage.setItem(PRELOAD_RELOAD_GUARD_KEY, JSON.stringify({ build, failures }))
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
    })
  })
}
