/**
 * THE GLOBALS A REAL PHONE HAS (POD-2055 F4 / WP-C7).
 *
 * This lane runs react-native-web under happy-dom (see `vitest.config.ts`), so
 * every test in it is handed a browser: `document`, a `window` with DOM event
 * listeners, a `navigator` with `onLine`. That is the right harness for
 * rendering a component, and it is exactly the wrong harness for asking whether
 * shared client code survives on device — the two paths that would have thrown
 * on a real build (`platformOnlineEvents`, `readServerConfig`) passed this lane
 * for a year while being unrunnable on iOS.
 *
 * So this installs React Native's globals over the top:
 *
 *   `window` EXISTS. RN sets `global.window = global`, so `typeof window` is
 *     `'object'` on a phone — it just carries no DOM. It is modelled here as a
 *     plain object rather than `globalThis` itself, so a probe cannot
 *     accidentally reach a Node global and read as browser-shaped.
 *   `window.location` is ABSENT — the single most common crash shape.
 *   `navigator` has no `onLine`; RN marks itself with `product: 'ReactNative'`.
 *   `document` is GONE.
 *
 * Use it with `// @vitest-environment node` at the top of the test file: happy-dom
 * installs its DOM on the same globals, and a test that only overwrote them
 * would still be running inside a document.
 */

interface Slot {
  readonly key: string
  readonly descriptor: PropertyDescriptor | undefined
}

export interface NativeGlobals {
  /** The object RN's `window` is: present, DOM-free. Mutate it to model a variant. */
  readonly window: Record<string, unknown>
  restore(): void
}

const NATIVE_KEYS = ['window', 'document', 'navigator'] as const

/**
 * Install React Native's globals for the duration of a test. Always pair with
 * `restore()` in an `afterEach` — the globals are process-wide, and a leaked
 * `window` would silently re-shape every later file in the same worker.
 */
export function installNativeGlobals(
  overrides: { window?: Record<string, unknown>; navigator?: Record<string, unknown> } = {},
): NativeGlobals {
  const holder = globalThis as unknown as Record<string, unknown>
  const saved: Slot[] = NATIVE_KEYS.map((key) => ({
    key,
    descriptor: Object.getOwnPropertyDescriptor(holder, key),
  }))
  const navigator = overrides.navigator ?? { product: 'ReactNative' }
  // RN's window is its global object: it answers `typeof`, and it has neither
  // `location` nor `addEventListener`.
  const window: Record<string, unknown> = { navigator, ...overrides.window }
  Object.defineProperties(holder, {
    window: { configurable: true, enumerable: true, value: window, writable: true },
    navigator: { configurable: true, enumerable: true, value: navigator, writable: true },
  })
  delete holder.document
  return {
    window,
    restore: () => {
      for (const slot of saved) {
        if (slot.descriptor) Object.defineProperty(holder, slot.key, slot.descriptor)
        else delete holder[slot.key]
      }
    },
  }
}
