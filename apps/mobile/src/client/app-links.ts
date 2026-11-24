import { requireOptionalNativeModule } from 'expo-modules-core'
import { Linking, Platform } from 'react-native'

/**
 * THE APP URL THE OS HANDED US, FROM EITHER NATIVE CHANNEL (POD-2364).
 *
 * Under the UIScene life cycle (plugins/with-scene-lifecycle.js) iOS delivers
 * links to the scene, and `ExpoAppSceneDelegate` re-feeds them to the app
 * delegate. That re-feed reliably reaches expo-linking's app-delegate
 * subscriber, which is what expo-router reads, but React Native's own
 * `Linking` was observed to receive neither the cold launch URL nor warm
 * links: pairing links opened the router's Unmatched Route cold and did
 * nothing warm, while QR scanning, which never touches URL delivery, worked.
 *
 * So the profile gate listens on both: React Native `Linking` (Android, and
 * iOS when it works) and the `ExpoLinking` native module. A link that arrives
 * on both is reported once.
 */

interface ExpoLinkingModule {
  getLinkingURL(): string | null | undefined
  clearInitialURL?(): void
  addListener(
    event: 'onURLReceived',
    listener: (event: { url: string }) => void,
  ): {
    remove(): void
  }
}

/** Both channels deliver the same open within one native call; a repeat later is a new open. */
const DUPLICATE_WINDOW_MS = 2_000

function expoLinking(): ExpoLinkingModule | null {
  if (Platform.OS === 'web') return null
  try {
    return requireOptionalNativeModule<ExpoLinkingModule>('ExpoLinking')
  } catch {
    return null
  }
}

/**
 * The URL that launched the app. React Native's answer wins; on iOS the
 * expo-linking registry fills in when React Native has none.
 */
export async function readInitialAppUrl(): Promise<string | null> {
  const fromReactNative = await Linking.getInitialURL().catch(() => null)
  if (fromReactNative) return fromReactNative
  try {
    return expoLinking()?.getLinkingURL() ?? null
  } catch {
    return null
  }
}

/**
 * Forget the launch URL expo-linking keeps, so a credential-bearing link is
 * not handed out again (a JS reload, or a later `getLinkingURL` caller).
 */
export function clearInitialAppUrl(): void {
  try {
    expoLinking()?.clearInitialURL?.()
  } catch {
    // Older native module without clearInitialURL: nothing to clear.
  }
}

/** Subscribe to warm links from every channel, reporting each open once. */
export function subscribeAppUrls(
  listener: (url: string) => void,
  now: () => number = Date.now,
): { remove(): void } {
  let last: { url: string; at: number } | null = null
  const deliver = (url: string | null | undefined) => {
    if (!url) return
    const at = now()
    if (last && last.url === url && at - last.at < DUPLICATE_WINDOW_MS) return
    last = { url, at }
    listener(url)
  }
  const subscriptions: Array<{ remove(): void }> = [
    Linking.addEventListener('url', ({ url }) => deliver(url)),
  ]
  const native = expoLinking()
  if (native) {
    try {
      subscriptions.push(native.addListener('onURLReceived', ({ url }) => deliver(url)))
    } catch {
      // React Native Linking still delivers; the native module is the fallback.
    }
  }
  return {
    remove() {
      for (const subscription of subscriptions) subscription.remove()
    },
  }
}
