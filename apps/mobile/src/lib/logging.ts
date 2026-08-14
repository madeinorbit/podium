/**
 * MOBILE LOG CAPTURE — the phone's half of the one pipeline
 * ([spec:2026-08-11-logging-strategy-design], chunk 5).
 *
 * The transport is NOT here, and the composition root is not either. Both live
 * in `@podium/client-core/logging` (`installClientLogging`), shared with
 * `apps/web`, which is what gives the phone the two properties a second
 * implementation would have got wrong: client-side clamping to the ingestion
 * contract's caps, so a record the server refuses cannot wedge a FIFO queue
 * forever, and a batch dropped after `maxAttempts` rather than retried for the
 * life of the process.
 *
 * What is HERE is only what React Native does differently:
 *
 *   - `ErrorUtils.setGlobalHandler` instead of `window.onerror`, chained rather
 *     than replaced.
 *   - Rejection capture that has to pick a surface at runtime, because a Hermes
 *     build has no `unhandledrejection` event at all.
 *   - A `fetch` transport rather than the app's tRPC client, because logging is
 *     installed before React mounts and the app's client does not exist yet.
 *     `logs.forward`/`logs.crash` take plain JSON and `makeMobileTrpc` uses no
 *     transformer, so this sends exactly the bytes the batch link would.
 *
 * A GENUINELY FATAL MOBILE CRASH MOSTLY SHIPS NOTHING, and that is accepted for
 * now rather than overlooked. `report()` starts an async `fetch` and the chained
 * handler then lets the platform kill the process, so the report only lands if
 * the request happens to get out first. The desktop shell solves this with an
 * on-disk pending queue replayed by the next launch; the phone has no equivalent
 * yet (POD-1918). What survives today is the non-fatal case — a caught-but-
 * reported error, a rejection, a JS error the app recovers from — plus whatever
 * a fatal manages to flush. Do not read an empty crash list as "no crashes".
 *
 * THE FORWARDING SINK PINS NO THRESHOLD, on either client. It follows the
 * namespace level, so `setLogLevel('debug')` raises the console and the
 * forwarded stream together — one knob rather than two that can disagree about
 * what a client is currently reporting. `warn` is the boot default and is set
 * below, not baked into a sink.
 */

import {
  type ClientLogging,
  installClientLogging,
  type LogTransport,
} from '@podium/client-core/logging'
import { createLogger, type LogLevel } from '@podium/logger'
import { PRODUCT_VERSION_META } from '@podium/protocol'

/**
 * WHICH BUILD OF THE PHONE IS RUNNING — read off the page first, the environment
 * second.
 *
 * `EXPO_PUBLIC_APP_VERSION` was the only source, and NOTHING IN THIS REPOSITORY
 * EVER SET IT: not `build:web`, not the redeploy path, not CI. So every phone
 * build reported `dev` — on the Pulse build stamp and in the `v` field of every
 * forwarded log record — while the artefact it was running knew perfectly well
 * what it was. `build:web` ends in `write-web-build-stamp.ts`, which injects
 * `<meta name="podium-version">` into index.html exactly so a running page can
 * answer this synchronously. Ask that first, the same way `apps/web` does
 * (`pageBuildVersion`).
 *
 * THE ENV VAR IS STILL THE FALLBACK and still matters: a NATIVE build has no
 * index.html to carry a meta tag, so there the inline is the only channel, and
 * an unset one honestly reports `dev` rather than claiming a version it cannot
 * substantiate.
 */
declare const process: { env?: Record<string, string | undefined> } | undefined

export function appVersion(
  doc: Pick<Document, 'querySelector'> | undefined = typeof document === 'undefined'
    ? undefined
    : document,
  declared: string | undefined = typeof process === 'undefined'
    ? undefined
    : process.env?.EXPO_PUBLIC_APP_VERSION,
): string {
  const stamped = doc
    ?.querySelector(`meta[name="${PRODUCT_VERSION_META}"]`)
    ?.getAttribute('content')
    ?.trim()
  if (stamped) return stamped
  return declared?.trim() || 'dev'
}

/** The subset of React Native's `ErrorUtils` this module uses. */
export interface ErrorUtilsLike {
  setGlobalHandler(handler: (error: unknown, isFatal?: boolean) => void): void
  getGlobalHandler?(): ((error: unknown, isFatal?: boolean) => void) | undefined
}

/** The globals this module reaches for, named so a test can supply them. */
export interface CaptureScope {
  ErrorUtils?: ErrorUtilsLike
  HermesInternal?: {
    enablePromiseRejectionTracker?(options: {
      allRejections: boolean
      onUnhandled(id: number, rejection: unknown): void
      onHandled?(id: number): void
    }): void
  }
  addEventListener?(type: string, listener: (event: unknown) => void): void
  removeEventListener?(type: string, listener: (event: unknown) => void): void
}

export interface CaptureHandlers {
  /** A thrown error that nothing caught. `isFatal` is React Native's own bit. */
  onUncaught(error: unknown, isFatal: boolean): void
  /** A promise rejection nothing handled. */
  onUnhandledRejection(reason: unknown): void
}

/**
 * Which rejection surface was actually installed. Returned rather than assumed,
 * because the answer differs per platform and "we installed nothing" is a state
 * a reader of the logs has to be able to tell apart from "nothing rejected".
 */
export type RejectionCapture = 'event-target' | 'hermes' | 'none'

export interface InstalledCapture {
  rejection: RejectionCapture
  uncaught: boolean
  uninstall(): void
}

/**
 * Install both global error surfaces, CHAINING whatever was there.
 *
 * Chaining matters more than it looks: React Native's default handler is what
 * shows the red box in development and what reports a fatal to the platform in
 * production. A logger that replaced it would trade a visible crash for a
 * logged one, which is a worse app that produces better logs.
 */
/**
 * How long a Hermes rejection is held before it is reported as a crash. Long
 * enough to cover "awaited a tick or two later", short enough that a real
 * unhandled rejection is still reported inside the same user interaction.
 */
export const DEFAULT_REJECTION_GRACE_MS = 2000

export interface CaptureOptions {
  /** Overridden only by tests, which drive the grace period with fake timers. */
  rejectionGraceMs?: number
}

export function installGlobalErrorCapture(
  scope: CaptureScope,
  handlers: CaptureHandlers,
  options: CaptureOptions = {},
): InstalledCapture {
  const undo: Array<() => void> = []
  let uncaught = false

  const errorUtils = scope.ErrorUtils
  if (errorUtils && typeof errorUtils.setGlobalHandler === 'function') {
    const previous = errorUtils.getGlobalHandler?.()
    errorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
      // The record is taken FIRST. If the previous handler is the one that ends
      // the process, anything after it never runs.
      try {
        handlers.onUncaught(error, isFatal === true)
      } catch {
        // A crash reporter that throws inside the crash handler replaces the
        // app's error with its own. Never.
      }
      previous?.(error, isFatal)
    })
    uncaught = true
    undo.push(() => {
      if (previous) errorUtils.setGlobalHandler(previous)
    })
  }

  let rejection: RejectionCapture = 'none'
  // HERMES IS ASKED FIRST, and the presence of an `addEventListener` is NOT
  // taken as proof that `unhandledrejection` is dispatched. Any dependency can
  // install an event-target polyfill; on a Hermes build that polyfill accepts
  // the listener and then never fires it, so the branch order used to decide
  // whether rejections were captured at all — while the boot line reported
  // `event-target` and looked healthy. The engine's own tracker is the surface
  // that actually exists on a released build, so it wins when it is there.
  if (typeof scope.HermesInternal?.enablePromiseRejectionTracker === 'function') {
    // Bare Hermes has no `unhandledrejection` event at all; this tracker is the
    // engine's own equivalent and is what React Native's LogBox uses.
    //
    // `allRejections: true` MEANS "tell me about every rejection, including ones
    // handled later" — the tracker's whole point being that it cannot know the
    // future. Reporting on `onUnhandled` alone therefore files a crash for the
    // ordinary `const p = doWork(); …; await p` pattern, and there is no way to
    // retract one that has already been posted: ten of those exhaust the crash
    // reporter's per-session budget on non-crashes. So a rejection is held for a
    // grace period and only reported if `onHandled` has not arrived by then.
    const graceMs = options.rejectionGraceMs ?? DEFAULT_REJECTION_GRACE_MS
    const held = new Map<number, ReturnType<typeof setTimeout>>()
    scope.HermesInternal.enablePromiseRejectionTracker({
      allRejections: true,
      onUnhandled: (id: number, reason: unknown) => {
        const timer = setTimeout(() => {
          held.delete(id)
          handlers.onUnhandledRejection(reason)
        }, graceMs)
        // A held report must not keep a background app awake for the timer.
        ;(timer as { unref?: () => void }).unref?.()
        held.set(id, timer)
      },
      onHandled: (id: number) => {
        const timer = held.get(id)
        if (timer === undefined) return
        clearTimeout(timer)
        held.delete(id)
      },
    })
    rejection = 'hermes'
    // The TRACKER has no removal API — saying so is better than a no-op disposer
    // that implies otherwise — but the timers it left behind are ours to drop.
    undo.push(() => {
      for (const timer of held.values()) clearTimeout(timer)
      held.clear()
    })
  } else if (typeof scope.addEventListener === 'function') {
    // React Native Web, and any build carrying a REAL DOM event target: the same
    // surface `apps/web` uses, so the two clients behave identically here. No
    // grace period is needed — the DOM event fires only for a rejection that
    // went unhandled through a full turn, and `rejectionhandled` exists for the
    // late case precisely because this event does not fire early.
    const listener = (event: unknown): void => {
      const reason = (event as { reason?: unknown } | undefined)?.reason
      handlers.onUnhandledRejection(reason ?? event)
    }
    scope.addEventListener('unhandledrejection', listener)
    rejection = 'event-target'
    undo.push(() => scope.removeEventListener?.('unhandledrejection', listener))
  }

  return {
    rejection,
    uncaught,
    uninstall() {
      for (const step of undo.splice(0)) step()
    },
  }
}

export interface FetchTransportOptions {
  /** Resolves the paired server's HTTP origin; may return undefined before one
   *  is known, in which case a send fails and the sink retries later. */
  httpOrigin(): string | undefined
  /** Native paired-session credential. Web leaves this absent and uses cookies. */
  bearer?: () => string | null
  /** Web uses its HttpOnly cookie; native must never consult an ambient cookie jar. */
  credentials?: RequestCredentials
  fetchImpl?: typeof fetch
}

/**
 * The two ingestion calls over plain `fetch`.
 *
 * REJECTS ON A NON-2xx, deliberately: the forwarding sink treats a rejection as
 * "keep the records and retry with backoff", and a 401 during a login flow or a
 * 503 during a server restart is exactly the case where the records should
 * survive rather than be acknowledged into a void. A refusal that never clears
 * is not a wedge either — the sink drops that batch after `maxAttempts`.
 */
export function createFetchLogTransport(options: FetchTransportOptions): LogTransport {
  const send = async (procedure: string, input: unknown): Promise<void> => {
    const origin = options.httpOrigin()
    if (origin === undefined || origin.length === 0) {
      throw new Error('no server origin yet')
    }
    const doFetch = options.fetchImpl ?? fetch
    const bearer = options.bearer?.()
    const response = await doFetch(`${origin}/trpc/${procedure}`, {
      method: 'POST',
      credentials: options.credentials ?? 'include',
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(input),
    })
    if (!response.ok) throw new Error(`${procedure} failed: ${response.status}`)
  }
  return {
    forward: (input) => send('logs.forward', input),
    crash: (input) => send('logs.crash', input),
  }
}

export interface MobileLoggingOptions {
  transport: LogTransport
  scope?: CaptureScope
  /** App version. Defaults to the build-time inline, else `dev`. */
  version?: string
  /** `ios` | `android` | `web`. */
  platform?: string
  /** Client default. Spec: `warn`. */
  level?: LogLevel
  ringCapacity?: number
  /** Off in tests, where a captured record is the assertion. */
  console?: boolean
  batchSize?: number
  flushIntervalMs?: number
}

export interface MobileLogging extends ClientLogging {
  /** Which global surfaces were actually wired on this build. */
  capture: InstalledCapture
}

let installed: MobileLogging | undefined

/** The live installation, or `undefined` before {@link installMobileLogging}. */
export function mobileLogging(): MobileLogging | undefined {
  return installed
}

/**
 * Wire the phone into the pipeline: three sinks that disagree on purpose (the
 * console and the forwarder follow config at `warn`, the ring buffer takes
 * everything at `trace`), a crash reporter over the ring, and React Native's
 * global error surfaces feeding it.
 *
 * Idempotent: a second call returns the first installation rather than stacking
 * a second set of sinks and a second global handler onto the same app.
 */
export function installMobileLogging(options: MobileLoggingOptions): MobileLogging {
  if (installed !== undefined) return installed
  const scope = options.scope ?? (globalThis as unknown as CaptureScope)

  // The sinks, the boot level, the process context and the crash reporter are
  // all the SHARED composition root's — same three sinks the browser gets,
  // same thresholds, same one-knob level policy. This file supplies only the
  // two answers that are genuinely the phone's: which role it is, and which
  // globals deliver its errors.
  const logging = installClientLogging({
    transport: options.transport,
    role: 'mobile',
    version: options.version ?? appVersion(),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.level === undefined ? {} : { level: options.level }),
    ...(options.ringCapacity === undefined ? {} : { ringCapacity: options.ringCapacity }),
    ...(options.console === undefined ? {} : { console: options.console }),
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    ...(options.flushIntervalMs === undefined ? {} : { flushIntervalMs: options.flushIntervalMs }),
  })

  const capture = installGlobalErrorCapture(scope, {
    onUncaught: (error, isFatal) =>
      logging.reporter.report(error, { source: 'ErrorUtils', isFatal }),
    onUnhandledRejection: (reason) =>
      logging.reporter.report(reason ?? new Error('unhandled rejection with no reason'), {
        source: 'unhandledrejection',
      }),
  })
  // Which surfaces exist is a property of the BUILD, and a crash that never
  // arrived is indistinguishable from a handler that was never installed unless
  // this line is in the log.
  //
  // `info` UNDER A `warn` DEFAULT MEANS RING-ONLY, BY DESIGN. At the boot level
  // this record reaches neither the console nor the server on its own — it lives
  // in the flight recorder, so it rides along in every crash snapshot, which is
  // the moment the question "was capture even installed?" gets asked. Raising it
  // to `warn` would forward a healthy-boot line from every launch of every phone
  // to buy nothing at the moment of the crash. (`level: 'info'` in the test that
  // asserts it is therefore reading the ring at a raised level, not propping up
  // a record that would otherwise be missing.)
  createLogger('mobile:boot').info('log capture installed', {
    rejectionCapture: capture.rejection,
    uncaughtCapture: capture.uncaught,
  })

  installed = {
    ...logging,
    capture,
    dispose() {
      capture.uninstall()
      logging.dispose()
      installed = undefined
    },
  }
  return installed
}

/**
 * Start logging for the real app, over the paired server's origin.
 *
 * Called at module scope in `app/_layout.tsx`, BEFORE React — an error thrown
 * while the first screen mounts is exactly the error this exists to catch, and
 * a handler installed in an effect is installed too late to see it.
 */
export function startMobileLogging(
  httpOrigin: () => string | undefined,
  platform?: string,
  bearer?: () => string | null,
): MobileLogging {
  return installMobileLogging({
    transport: createFetchLogTransport({
      httpOrigin,
      credentials: platform === 'web' ? 'include' : 'omit',
      ...(bearer ? { bearer } : {}),
    }),
    ...(platform === undefined ? {} : { platform }),
  })
}
