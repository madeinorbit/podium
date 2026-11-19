import { serviceWorkerContainer } from '@podium/client-core/service-worker'
import { INTERFACE_REPAIR_TARGET_KEY } from '@podium/client-core/ui-state'
import { createLogger } from '@podium/logger'
import { parseServerVersion, sourceDigest } from '@podium/protocol'
import { forceReload } from './force-reload'
import { isIterationMode } from './iteration-mode'
import { pageBuildDigest, pageBundleVersion } from './logging/build-version'
import { nativeDesktopBridge } from './nativeDesktop'
import { prepareForReload } from './reload-preparation'
import { servedWebsiteForPage } from './served-website'
import { readServedWorkerIdentity } from './sw-identity'
import { workspaceFetch } from './workspace-request'

const log = createLogger('web:boot-interface')
export const INTERFACE_REPAIR_KEY = INTERFACE_REPAIR_TARGET_KEY
export const INTERFACE_CHECK_MS = 3000

/** Installed before sign-in, so a newly activated worker can identify this page. */
export function installInterfaceIdentityResponder(): void {
  serviceWorkerContainer()?.addEventListener('message', (event) => {
    if (event.data?.type !== 'podium:interface-build' || !event.ports[0]) return
    const port = event.ports[0]
    const bundle = pageBundleVersion()
    void (async () => {
      try {
        if (bundle !== event.data.target) await prepareForReload()
        port.postMessage({ bundle, mayReload: true })
      } catch {
        port.postMessage({ bundle, mayReload: false })
      }
    })()
  })
}

let bootCheck: Promise<'ready' | 'reloading'> | undefined

/** One check per document, including React's repeated development mount. */
export function repairInterfaceOnBoot(httpOrigin: string): Promise<'ready' | 'reloading'> {
  bootCheck ??= checkInterface(httpOrigin)
  return bootCheck
}

/** A same-origin cached page must repair itself before choosing a sign-in form. */
async function checkInterface(httpOrigin: string): Promise<'ready' | 'reloading'> {
  if (isIterationMode() || nativeDesktopBridge() || !pageBundleVersion()) return 'ready'
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const check = async (): Promise<'ready' | 'reloading'> => {
    let server: ReturnType<typeof parseServerVersion>
    try {
      const response = await workspaceFetch(`${httpOrigin}/version`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!response.ok) return 'ready'
      server = parseServerVersion(await response.json())
    } catch {
      return 'ready'
    }
    const served = servedWebsiteForPage(server, httpOrigin)
    if (!served?.present || controller.signal.aborted) return 'ready'
    const page = pageBundleVersion()
    const digest = pageBuildDigest()
    const targetDigest = sourceDigest(served.digest ?? server.sourceDigest)
    const mismatch =
      (served.bundle !== undefined && page !== served.bundle) ||
      (digest !== undefined && targetDigest !== undefined && digest !== targetDigest)
    if (!mismatch) return 'ready'
    // Source alone cannot distinguish two bundles built with different flags.
    const target = `${served.bundle ?? '?'}/${targetDigest ?? '?'}`
    let previous: string | null
    try {
      previous = sessionStorage.getItem(INTERFACE_REPAIR_KEY)
      sessionStorage.setItem(INTERFACE_REPAIR_KEY, target)
    } catch {
      // Without a durable loop guard, leave an explicit error instead of looping.
      throw new Error('The interface update could not be saved. Please retry in a moment.')
    }
    if (previous === target)
      throw new Error('The current interface could not be loaded. Please retry in a moment.')
    // Identity is evidence only; a stalled worker fetch must not hold recovery up.
    void readServedWorkerIdentity(`${httpOrigin}/sw.js`, (url, init) =>
      workspaceFetch(url, { ...init, signal: controller.signal }),
    ).then((worker) => log.info('served worker during interface repair', { target, ...worker }))
    log.warn('repairing cached interface before sign-in', { page, digest, target })
    // The version check is bounded; the existing reload boundary separately bounds
    // storage cleanup and saves edits without deleting the replica or outbox.
    if (timeout !== undefined) clearTimeout(timeout)
    await forceReload('boot-interface-mismatch')
    return 'reloading'
  }
  try {
    return await Promise.race([
      check(),
      new Promise<'ready'>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort()
          resolve('ready')
        }, INTERFACE_CHECK_MS)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    controller.abort()
  }
}
