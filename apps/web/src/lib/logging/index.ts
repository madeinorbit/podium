import { createLogger } from '@podium/logger'
import { installWebLogging } from './install'
import { pageLogTransport } from './transport'

export { pageBuildVersion } from './build-version'
export { installGlobalHandlers } from './global-handlers'
export { installWebLogging, type LogTransport, type WebLoggingOptions } from './install'
export { pageLogTransport, trpcLogTransport } from './transport'

/**
 * Start client logging for the real page. Called from `main.tsx` BEFORE React
 * mounts, so a throw during the first render is caught by the global handlers
 * rather than lost to the console of a user who is not looking at it.
 *
 * The product version is resolved synchronously inside `installWebLogging`,
 * from the stamp's `<meta name="podium-version">` or the dest-server define,
 * so the first record already carries the same `v` as About and Update.
 */
export function startWebLogging(): () => void {
  const dispose = installWebLogging({ transport: pageLogTransport() })
  // THE FIRST LINE OF THE FLIGHT RECORDER (POD-1935). `info`, so it is ring
  // buffer context rather than forwarded traffic: a crash five minutes from now
  // ships a buffer that begins by saying which page this was and when it
  // started, which is what tells a reader whether the run-up is even complete.
  createLogger('web:boot').info('web client booted', {
    path: window.location.pathname,
    ...(document.referrer ? { referrer: document.referrer } : {}),
  })
  return dispose
}
