import type { CrashReporter } from '@podium/client-core/logging'

/**
 * THE BROWSER'S TWO PRODUCERS, and the only part of client crash capture that
 * is web-specific [spec: 2026-08-11-logging-strategy-design, "Crash capture"].
 *
 * `window.onerror` catches a synchronous throw that escaped every frame;
 * `unhandledrejection` catches the one no error boundary and no `onerror` will
 * ever see — a promise that rejected with nobody attached. React Native's
 * `ErrorUtils.setGlobalHandler` is the same job in `apps/mobile`, which is why
 * the reporter these hand to knows about neither.
 */
export function installGlobalHandlers(target: Window, reporter: CrashReporter): () => void {
  const onError = (event: Event): void => {
    const errorEvent = event as ErrorEvent
    // `error` is absent for a cross-origin script error ("Script error."), where
    // the browser withholds the detail. Reporting the message alone is still
    // worth more than dropping it.
    reporter.report(errorEvent.error ?? new Error(errorEvent.message || 'uncaught error'), {
      source: 'window.onerror',
      ...(errorEvent.filename ? { filename: errorEvent.filename } : {}),
      ...(typeof errorEvent.lineno === 'number' ? { lineno: errorEvent.lineno } : {}),
    })
  }
  const onRejection = (event: Event): void => {
    const reason: unknown = (event as { reason?: unknown }).reason
    reporter.report(reason ?? new Error('unhandled rejection with no reason'), {
      source: 'unhandledrejection',
    })
  }
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}
