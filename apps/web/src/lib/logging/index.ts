import { setProcessContext } from '@podium/logger'
import { serverConfig } from '@/app/trpc'
import { installWebLogging } from './install'
import { pageLogTransport } from './transport'

export { type CrashPayload, createCrashReporter } from './crash'
export { createForwardingSink } from './forward-sink'
export { installWebLogging, type LogTransport, type WebLoggingOptions } from './install'
export { reportCrash, setActiveCrashReporter } from './runtime'
export { pageLogTransport, trpcLogTransport } from './transport'

/** The build stamp `apps/web`'s build writes beside the bundle. */
const BUILD_STAMP_FILE = 'podium-build.json'

/**
 * Start client logging for the real page. Called from `main.tsx` BEFORE React
 * mounts, so a throw during the first render is caught by the global handlers
 * rather than lost to the console of a user who is not looking at it.
 *
 * The version is filled in asynchronously. Blocking boot on a build-stamp fetch
 * to tag records with `v` would trade the crashes worth having — the ones during
 * boot — for a nicer field on the ones that come later.
 */
export function startWebLogging(): () => void {
  const dispose = installWebLogging({ transport: pageLogTransport() })
  void resolveBuildVersion()
  return dispose
}

async function resolveBuildVersion(): Promise<void> {
  try {
    const { httpOrigin } = serverConfig(window.location)
    const response = await fetch(`${httpOrigin}/${BUILD_STAMP_FILE}`)
    if (!response.ok) return
    const raw: unknown = await response.json()
    const version = (raw as { appVersion?: unknown } | null)?.appVersion
    if (typeof version === 'string') setProcessContext({ v: version })
  } catch {
    // An untagged record is worth more than a logging path that throws at boot.
  }
}
