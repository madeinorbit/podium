import { toast } from 'sonner'
import { reloadLog } from './logging/update-logs'
import { navigateReload } from './navigate'
import { hasReloadPreparation, withReloadPreparation } from './reload-preparation'

/**
 * A NEW BUILD TAKING CONTROL DOES NOT REPLACE THE SCREEN IN USE (POD-7539).
 *
 * The worker is built with `skipWaiting` and `clientsClaim`, so the browser's
 * own update check activates a new build over every open page. Two actors then
 * reloaded the page at once: vite-plugin-pwa's `controlling` listener
 * (`onNeedReload`) and the new worker's activation script, which navigates each
 * window whose build differs. During the dev.54 update that reload landed on a
 * desktop window with a loaded deck, and the replacement document cold-started
 * into the skeleton (POD-7531, fix 2).
 *
 * The old document keeps working under the new worker: it already runs against
 * a server that replaced its assets, and the version guard, the stale-assets
 * check and the lazy-chunk recovery are what cover that (POD-2721). So a page
 * that someone can see and that has a signed-in screen defers the reload:
 *
 *  - it reloads as soon as the document is hidden (another tab, a minimised or
 *    hidden window), when nobody can watch the screen go;
 *  - meanwhile the update panel says "Reload to finish", and its Reload is the
 *    user's own step (§6.2.3);
 *  - a hidden page, or one with no signed-in screen (sign-in, boot), reloads at
 *    once, as before.
 *
 * Every reload goes through {@link withReloadPreparation}, which saves composer
 * drafts and flushes local queue commits first, and refuses while an editor
 * holds unsaved text. A refusal leaves the deferral armed for the next hide.
 */
export type TakeoverSource =
  /** The library's `controlling` listener (`onNeedReload`). */
  | 'workbox-controlling'
  /** The activated worker's `podium:interface-build` question. */
  | 'interface-build'

interface PageVisibility {
  readonly visibilityState: DocumentVisibilityState
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

interface Deferral {
  readonly since: number
  readonly sources: Set<TakeoverSource>
  readonly stop: () => void
}

let deferral: Deferral | undefined
const listeners = new Set<() => void>()

function visiblePage(): PageVisibility | undefined {
  return typeof document === 'undefined' ? undefined : document
}

/** Someone can see this page, and it shows a signed-in screen with work in it. */
export function screenInUse(page: PageVisibility | undefined = visiblePage()): boolean {
  return page?.visibilityState === 'visible' && hasReloadPreparation()
}

/** Whether a new build is waiting for this page to be hidden. */
export function takeoverDeferred(): boolean {
  return deferral !== undefined
}

/** Called once when a reload is first deferred, so the panel can ask for one. */
export function onTakeoverDeferred(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Hold the reload a new build asks for while the screen is in use. Answers
 * `true` when it is held; the page then reloads itself once it is hidden.
 */
export function holdTakeoverWhileInUse(source: TakeoverSource): boolean {
  const page = visiblePage()
  if (!page || !screenInUse(page)) return false
  if (deferral) {
    deferral.sources.add(source)
    return true
  }
  const onVisibility = (): void => {
    if (page.visibilityState === 'hidden') reloadDeferred()
  }
  page.addEventListener('visibilitychange', onVisibility)
  deferral = {
    since: Date.now(),
    sources: new Set([source]),
    stop: () => page.removeEventListener('visibilitychange', onVisibility),
  }
  reloadLog.info('a new build took control; the reload waits until this page is hidden', {
    source,
  })
  for (const listener of listeners) {
    try {
      listener()
    } catch (err) {
      reloadLog.warn('a deferred-reload listener threw', { err })
    }
  }
  return true
}

/** A new worker controls this page: reload now, or once nobody is looking. */
export function followNewWorker(source: TakeoverSource): 'reloading' | 'deferred' {
  if (holdTakeoverWhileInUse(source)) return 'deferred'
  void reload(
    'a new worker took control of this page',
    {},
    visiblePage()?.visibilityState !== 'hidden',
  )
  return 'reloading'
}

function reloadDeferred(): void {
  const held = deferral
  if (!held) return
  void reload(
    'a new worker took control of this page',
    { deferredMs: Date.now() - held.since, sources: [...held.sources] },
    false,
  )
}

async function reload(
  reason: string,
  fields: Record<string, unknown>,
  visible: boolean,
): Promise<void> {
  try {
    await withReloadPreparation(() =>
      Object.keys(fields).length === 0
        ? navigateReload('workbox-controlling', reason)
        : navigateReload('workbox-controlling', reason, fields),
    )
  } catch (error) {
    reloadLog.warn('reload paused to preserve local changes', { err: error })
    // A hidden page says nothing now; the deferral, if armed, retries on the next hide.
    if (visible)
      toast.error(error instanceof Error ? error.message : 'Save your changes before reloading.')
  }
}

/** Tests only: forget a deferral and its listener. */
export function resetTakeoverForTests(): void {
  deferral?.stop()
  deferral = undefined
  listeners.clear()
}
