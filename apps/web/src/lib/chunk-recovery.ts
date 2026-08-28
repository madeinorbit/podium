import { createLogger } from '@podium/logger'
import { looksLikeChunkLoadFailure } from '@/app/chunk-load-failure'
import { updateWasRunning } from './active-update'
import { askServedAssets, type ServedAssetsAnswer } from './served-assets'

const log = createLogger('web:chunk-recovery')

/**
 * ===========================================================================
 * A REFUSED CHUNK IS NOT A MISSING CHUNK (POD-2762)
 * ===========================================================================
 *
 * Opening Settings while an update was applying took the whole interface down
 * with `ERR_CONNECTION_REFUSED` on four chunks. POD-2721 had already taught the
 * error boundary to recognise a failed dynamic import and ask the server "have
 * you replaced the build under me?" — but during a handover the server does not
 * answer that question, because it is not running. The probe failed, the answer
 * came back `unknown`, and the honest crash page went up over an app that was
 * about to be fine again in two seconds.
 *
 * The two failures need OPPOSITE responses and the epic has already paid for
 * getting that wrong in both directions:
 *
 *   - The assets MOVED (a 404 from a server that is up). The URLs this page
 *     holds are gone for good. Offer a reload — POD-2721.
 *   - The connection was REFUSED (nothing answered). Nothing has moved. The
 *     server is restarting; wait for it and try again.
 *
 * Treating a refusal like a 404 shows a crash page for a hiccup. Treating a 404
 * like a refusal retries forever against a URL that will never exist — and
 * reloading on either one, blindly, is the loop POD-2608 shipped and could not
 * clear.
 *
 * ===========================================================================
 * WHY THE RETRY MUST CHANGE THE URL — MEASURED, NOT ASSUMED
 * ===========================================================================
 *
 * The obvious implementation is "call the same `import()` again", and it CANNOT
 * WORK. A module that fails to fetch is recorded as failed in the document's
 * module map, and every later import of that URL is answered from the record
 * without a request. Measured in Chromium against a server toggled off and back
 * on:
 *
 *   import('/chunk.js')            server down   -> TypeError (expected)
 *   import('/chunk.js')            server UP     -> TypeError, no request made
 *   import('/chunk.js?retry=1')    server UP     -> resolves
 *
 * So the retry re-imports the SAME BYTES UNDER A NEW URL, which is a fresh
 * module-map entry. Its own static imports are untouched specifiers, so they
 * resolve to the ordinary URLs and share the modules the page already has —
 * React, the store, the design system are not duplicated. Only the chunk that
 * failed is re-evaluated, and it had never evaluated in the first place.
 *
 * The same measurement fixes the boundary of what this can repair. If the
 * failure was a whole-server outage, the entry chunk is the only poisoned URL
 * and the retry succeeds. If one dependency 404'd while the server was up, that
 * dependency's URL is poisoned too, the cache-busted parent re-imports it by its
 * ordinary specifier, and the retry fails exactly as it should — that page's
 * assets really have moved, and it gets the reload offer instead. The mechanism
 * declines to paper over the case it must not paper over.
 *
 * ===========================================================================
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ===========================================================================
 *
 * It never reloads. Not on a chunk failure, not when the server comes back, not
 * ever — a reload is a thing the person does from a screen that explains itself
 * (`AppErrorPage`), and an automatic one is the single ingredient POD-2608's
 * unclearable loop required.
 *
 * It never swallows an error. Every path either resolves with the real module or
 * rejects with the ORIGINAL error, so a genuine bug in a lazy route still
 * reaches the boundary and still says what it was. A page that hides real
 * failures is worse than one that crashes honestly.
 */

/** How the recovery ended. Exported for the tests and for the log line. */
export type ChunkRecovery =
  | 'loaded'
  | 'recovered-after-restart'
  | 'server-serving-different-build'
  | 'failed'

export interface ChunkRecoveryDeps {
  /** Ask the server what it is serving. */
  askServer: () => Promise<ServedAssetsAnswer>
  /** Sleep. Injected so the test does not spend real seconds. */
  wait: (ms: number) => Promise<void>
  /** Milliseconds since some epoch; only differences are used. */
  now: () => number
  /** Import an arbitrary URL. Injected because a test cannot fetch one. */
  importUrl: (url: string) => Promise<unknown>
  /**
   * Re-request a stylesheet vite has given up on. Optional: a caller with no
   * document (a test, a worker) simply has no styles to repair.
   */
  loadStylesheet?: (href: string) => Promise<void>
  /** Was an update running when the server was last heard from? */
  updateRunning?: () => boolean
}

/**
 * HOW LONG TO WAIT FOR A SERVER THAT IS COMING BACK.
 *
 * Two budgets, because the page knows which situation it is in and the honest
 * answer differs. A handover has a server stopping, a new one starting and a
 * health check passing; the sandbox measures that in tens of seconds. An outage
 * with no update behind it is far more likely to be something that will not fix
 * itself, and making somebody watch a spinner for a minute to find that out is
 * its own kind of dishonesty.
 *
 * Neither is a retry count. The page waits for the server to ANSWER and only
 * then re-imports, so these bound how long it is willing to wait, never how many
 * times it is willing to guess.
 */
export const RESTART_PATIENCE_MS = 90_000
export const OUTAGE_PATIENCE_MS = 20_000

/** Backoff between probes: quick at first, because most handovers are seconds. */
const PROBE_DELAYS_MS = [250, 500, 1_000, 1_500, 2_000] as const

/**
 * WHAT EXACTLY FAILED — and it is not always the module.
 *
 * A lazy route is not one fetch. Vite compiles `import('./View')` into
 * `__vitePreload(() => import('./View.js'), ['./View.css', …])`, which links the
 * stylesheet FIRST and rejects with `Unable to preload CSS for …` before the
 * module import is ever attempted. That distinction was invisible until it was
 * measured: the first end-to-end run of this recovery failed on exactly that
 * message, because the extractor only understood absolute module URLs and a CSS
 * dep arrives as a root-relative path.
 *
 * The two need different repairs, and getting them the wrong way round fails
 * silently in opposite directions:
 *
 *   MODULE — the URL is poisoned in the module map for the life of the page, so
 *     the retry MUST use a different URL (see the measurement above).
 *   STYLESHEET — the module was never imported, so nothing is poisoned and the
 *     ordinary loader will work. What does need repairing is the dead `<link>`
 *     vite left in the head: its `seen` map means it will never re-add it, so
 *     the view would come back correct but UNSTYLED unless the link is asked
 *     for again by hand.
 */
export type ChunkFailure =
  | { kind: 'stylesheet'; href: string }
  | { kind: 'module'; url: string }
  /** A shape we do not recognise. Retrying the loader is still worth one go. */
  | { kind: 'unknown' }

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : ''

export function classifyChunkFailure(error: unknown): ChunkFailure {
  const message = messageOf(error)
  const css = /unable to preload css for\s+(\S+)/i.exec(message)
  if (css?.[1]) return { kind: 'stylesheet', href: css[1].replace(/[)"'.]+$/, '') }
  // Absolute first, then root-relative: browsers use the absolute form for a
  // failed module and vite uses whatever `base` produced for a dep.
  const url = /\bhttps?:\/\/[^\s"')]+|(?<![\w:])\/[^\s"')]+\.[a-z]+/i.exec(message)
  return url?.[0] ? { kind: 'module', url: url[0] } : { kind: 'unknown' }
}

/**
 * The URL a failed dynamic import was for, when there is one.
 *
 * Every engine puts it in the message and none of them puts it anywhere else —
 * there is no property to read, which is why this is a regex over prose. If the
 * message does not carry one, the answer is `undefined` and the caller falls
 * back to retrying the loader rather than inventing a URL to fetch.
 */
export function chunkUrlFromError(error: unknown): string | undefined {
  const failure = classifyChunkFailure(error)
  return failure.kind === 'module' ? failure.url : undefined
}

/** Add a cache-busting parameter, preserving any the URL already has. */
export function retryUrl(url: string, attempt: number): string {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}podium-retry=${attempt}`
}

/**
 * ---------------------------------------------------------------------------
 * THE WAITING STATE, AS SOMETHING A FALLBACK CAN RENDER
 * ---------------------------------------------------------------------------
 *
 * While this is waiting, React is showing the Suspense fallback for whatever the
 * user clicked — by default an empty box, which reads as "nothing happened" at
 * exactly the moment something is happening. A module-level counter lets that
 * fallback say "the server is restarting" instead, without any of the surfaces
 * knowing this mechanism exists.
 *
 * A COUNTER rather than a boolean: two lazy surfaces can be waiting at once (the
 * incident had four chunks fail together), and the first one to recover must not
 * clear the notice for the others.
 */
let waiting = 0
const waitingListeners = new Set<() => void>()

function publishWaiting(next: number): void {
  waiting = next
  for (const listener of waitingListeners) listener()
}

/** Is at least one lazy surface currently waiting for the server to come back? */
export function isWaitingForServer(): boolean {
  return waiting > 0
}

export function subscribeWaitingForServer(listener: () => void): () => void {
  waitingListeners.add(listener)
  return () => {
    waitingListeners.delete(listener)
  }
}

/** Test-only reset; module state outlives a test file's cases. */
export function resetChunkRecovery(): void {
  waiting = 0
  waitingListeners.clear()
}

/**
 * WAIT FOR THE SERVER TO SAY SOMETHING — ANYTHING.
 *
 * Answers with the server's verdict the moment it has one, or `gave-up` when
 * the budget runs out. `unreachable` is the ONLY answer worth waiting through:
 * every other one is a server with an opinion, and the caller is entitled to it
 * immediately.
 *
 * This is where "wait for the socket" is actually cashed in. It polls `/version`
 * rather than watching the connection hub, and the difference matters: the hub
 * says the WebSocket is back, while this says the HTTP route that serves assets
 * is back — and it is the second fact the page is about to depend on. The two
 * are usually simultaneous and, when they are not, the one being tested here is
 * the one that decides whether the retry can work.
 *
 * The publisher runs around the WHOLE wait, so a Suspense fallback can say the
 * server is restarting for as long as that is true, and stop the instant it is
 * not — including when the answer is bad news.
 */
export async function waitForServerAnswer(
  deps: ChunkRecoveryDeps,
  budgetMs: number,
): Promise<ServedAssetsAnswer | 'gave-up'> {
  const startedAt = deps.now()
  publishWaiting(waiting + 1)
  try {
    for (let attempt = 1; deps.now() - startedAt < budgetMs; attempt += 1) {
      await deps.wait(PROBE_DELAYS_MS[Math.min(attempt - 1, PROBE_DELAYS_MS.length - 1)] as number)
      const answer = await deps.askServer()
      if (answer !== 'unreachable') return answer
    }
    return 'gave-up'
  } finally {
    publishWaiting(waiting - 1)
  }
}

/**
 * How patient to be about THIS outage.
 *
 * A handover has a server stopping, a new one starting and a health check
 * passing, and the page was told an update was running seconds ago — so it can
 * afford to wait properly. An outage with nothing behind it is far more likely
 * to be something that will not fix itself, and making somebody watch a spinner
 * for a minute and a half to find that out is its own kind of dishonesty.
 */
export function patienceFor(deps: Pick<ChunkRecoveryDeps, 'updateRunning'>): number {
  const running = deps.updateRunning?.() ?? updateWasRunning()
  return running ? RESTART_PATIENCE_MS : OUTAGE_PATIENCE_MS
}

/**
 * Wait for the server to answer, then repair whatever actually broke.
 *
 * Resolves with the module namespace if the retry works. The caller rejects with
 * the ORIGINAL error otherwise, so the boundary reports the failure the user
 * actually hit rather than the artefact of our retry.
 */
async function recoverFromRestart<T>(
  error: unknown,
  load: () => Promise<T>,
  deps: ChunkRecoveryDeps,
): Promise<{ outcome: ChunkRecovery; module?: unknown }> {
  const failure = classifyChunkFailure(error)
  const budget = patienceFor(deps)
  log.info('a chunk was refused by an unreachable server; waiting for it to come back', {
    failure: failure.kind,
    budgetMs: budget,
  })

  const answer = await waitForServerAnswer(deps, budget)
  if (answer === 'gave-up') {
    log.warn('gave up waiting for the server to come back', { budgetMs: budget })
    return { outcome: 'failed' }
  }
  if (answer === 'replaced') {
    // It came back as a DIFFERENT build. The file this page wants is gone for
    // good, and retrying it would be the forever-loop. Hand it to the boundary,
    // which has the right screen for exactly this.
    log.info('server came back serving a different build; the assets really did move')
    return { outcome: 'server-serving-different-build' }
  }

  try {
    if (failure.kind === 'stylesheet') {
      // Ask for the stylesheet again OURSELVES. Vite will not: its `seen` map
      // records the dep as handled the moment it first appends the link, so the
      // retried loader skips it and the view would come back unstyled.
      // Best-effort — a view with its styles missing is still far better than a
      // view that is not there, so a second failure here does not stop the load.
      await deps.loadStylesheet?.(failure.href).catch(() => {})
    }
    // The ordinary loader FIRST, and it is the right first move for both shapes.
    // A stylesheet failure never got as far as importing the module, so nothing
    // is poisoned and this simply works. A module failure will fail again — the
    // module map answers from its record without a request — which costs one
    // microtask and is what the cache-busted URL below is for.
    const module = await load().catch(async (again: unknown) => {
      if (failure.kind !== 'module') throw again
      return deps.importUrl(retryUrl(failure.url, 1))
    })
    log.info('chunk loaded after the server came back', { failure: failure.kind })
    return { outcome: 'recovered-after-restart', module }
  } catch (retryError) {
    // The server is up and still cannot serve it. That is not a restart any
    // more; it is a page whose assets are genuinely not there.
    log.warn('server answered but the chunk still would not load', {
      failure: failure.kind,
      err: retryError,
    })
    return { outcome: 'failed' }
  }
}

/**
 * Wrap a lazy import so a server restart underneath it is survivable.
 *
 * Everything that is NOT a refused chunk passes straight through, unchanged and
 * un-delayed: a component that throws while evaluating, a 404 from a live
 * server, a typo in an import path. Those reach the boundary exactly as they do
 * today.
 */
export async function importThroughRestarts<T>(
  load: () => Promise<T>,
  deps: ChunkRecoveryDeps,
): Promise<T> {
  try {
    return await load()
  } catch (error) {
    if (!looksLikeChunkLoadFailure(error instanceof Error ? error.message : String(error))) {
      throw error
    }
    // ONE QUESTION FIRST, and it is the whole decision: is the server there?
    // Only `unreachable` earns any patience at all — everything else is a server
    // with an opinion, and its opinion is the boundary's business.
    const answer = await deps.askServer().catch(() => 'unreachable' as const)
    if (answer !== 'unreachable') throw error
    const { outcome, module } = await recoverFromRestart(error, load, deps)
    if (outcome === 'recovered-after-restart') return module as T
    throw error
  }
}

/**
 * ---------------------------------------------------------------------------
 * THE PRODUCTION WIRING
 * ---------------------------------------------------------------------------
 *
 * The origin is read from `window.location` at CALL time rather than captured
 * at module scope, because this module is in the eager graph and evaluates
 * before the shell has decided anything.
 *
 * The retry import carries a `@vite-ignore` annotation so the bundler leaves it
 * alone, which is correct here and nowhere else: the URL is not a specifier the
 * build could resolve, it is a runtime string read out of the error message —
 * and it is a same-origin asset path this page was already asking for.
 */
function browserDeps(): ChunkRecoveryDeps {
  return {
    askServer: async () => (await askServedAssets(window.location.origin)).answer,
    wait: (ms) => new Promise((resolve) => void window.setTimeout(resolve, ms)),
    now: () => Date.now(),
    importUrl: (url) => import(/* @vite-ignore */ url),
    loadStylesheet: (href) =>
      new Promise((resolve, reject) => {
        // The dead one goes first, or the page keeps a broken link beside the
        // working one and any later reader of the DOM sees both.
        for (const link of document.querySelectorAll(`link[rel="stylesheet"][href="${href}"]`)) {
          link.remove()
        }
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = href
        link.addEventListener('load', () => resolve())
        link.addEventListener('error', () => reject(new Error(`stylesheet failed: ${href}`)))
        document.head.appendChild(link)
      }),
  }
}

/**
 * The one wrapper the `lazy()` call sites use.
 *
 * Deliberately shaped to disappear into the existing idiom — a call site becomes
 * `lazy(() => throughRestarts(() => import('…')).then(pick))` and reads the same
 * as before. That matters because the fix is only worth having if it is applied
 * to every lazy surface rather than to the one that happened to crash: the
 * incident took down Settings, but nothing about it was specific to Settings.
 */
export function throughRestarts<T>(load: () => Promise<T>): Promise<T> {
  return importThroughRestarts(load, browserDeps())
}
