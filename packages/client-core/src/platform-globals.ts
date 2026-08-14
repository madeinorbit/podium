/**
 * WHAT THE AMBIENT GLOBALS ACTUALLY ARE, per platform (POD-2055 F4).
 *
 * `typeof window === 'undefined'` is the browser-or-not test the client grew up
 * with, and on React Native it answers the wrong question: RN sets
 * `global.window = global`, so `window` is a real object on a phone — it simply
 * has no DOM behind it. Every probe written as "window exists ⇒ I can call
 * `addEventListener`" therefore reads as TRUE on device and throws on the next
 * line, which no test caught because the mobile lane runs react-native-web under
 * happy-dom and hands those tests a browser.
 *
 * So the guard names the CAPABILITY it is about to use rather than the platform
 * it expects to be on.
 */

/** A window with DOM event listeners on it — i.e. a browser, not RN's `global`. */
export function hasDomWindow(): boolean {
  return (
    typeof window !== 'undefined' &&
    window !== null &&
    typeof window.addEventListener === 'function' &&
    typeof window.removeEventListener === 'function'
  )
}

/**
 * A host that can post a message to itself — i.e. one with a macrotask that is
 * NOT a timer (POD-2058).
 *
 * The distinction matters because a hidden browser tab clamps `setTimeout` to
 * ≥1 s, and `postMessage` is not clamped. Named for the capability rather than
 * the platform, same as {@link hasDomWindow}: React Native and bare Node differ
 * on whether they carry `MessageChannel`, and neither answer is derivable from
 * "is this a browser".
 */
export function hasMessageChannel(): boolean {
  return typeof MessageChannel === 'function'
}
