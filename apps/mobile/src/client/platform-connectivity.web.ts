import type { NativeConnectivity } from './native-connectivity'

/**
 * NOTHING, on web (POD-2055 WP-C2).
 *
 * The Expo app also builds as react-native-web, and there the browser answers
 * are the right ones: `document` really does know whether the tab is visible,
 * `window` really does fire `online`, `navigator.onLine` really is a probe. The
 * shared client already reaches for all three by default, so the correct native
 * wiring here is none — supplying an AppState/NetInfo shim over the same DOM
 * events would be a second answer to a question that already has one.
 */
export function createPlatformConnectivity(): NativeConnectivity | undefined {
  return undefined
}
