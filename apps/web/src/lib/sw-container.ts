/**
 * `navigator.serviceWorker`, WITHOUT TRUSTING THE GETTER (POD-3224 review).
 *
 * `typeof navigator === 'undefined' ? undefined : navigator.serviceWorker`
 * guards the wrong thing. `navigator` is always there in a document; what is not
 * always there is a getter that RETURNS. On an opaque origin — a sandboxed
 * iframe, a `data:` document, some embedded webviews — reading the property
 * throws `SecurityError` rather than answering `undefined`.
 *
 * That distinction is load-bearing here because the first read happens at
 * `main.tsx` module scope, before React and before the error boundary: a throw
 * there is a blank page and no crash report, which is the one failure the
 * logging this issue added exists to prevent. vite-plugin-pwa itself uses the
 * `in` form for the same reason.
 *
 * The `in` check answers whether the property EXISTS; the try/catch covers the
 * getter throwing anyway. `undefined` from here therefore means one of three
 * things — no navigator, no such property, or a property that refused — and
 * {@link serviceWorkerAvailability} says which, so a silent `web:sw` namespace
 * has an explanation rather than an absence.
 */

export type ServiceWorkerAvailability = 'available' | 'no-navigator' | 'unsupported' | 'refused'

/** The container, or `undefined` when it is absent OR refused. Never throws. */
export function serviceWorkerContainer(): ServiceWorkerContainer | undefined {
  try {
    if (typeof navigator === 'undefined') return undefined
    if (!('serviceWorker' in navigator)) return undefined
    return navigator.serviceWorker
  } catch {
    return undefined
  }
}

/** WHY there is no container, for the boot record. Never throws. */
export function serviceWorkerAvailability(): ServiceWorkerAvailability {
  try {
    if (typeof navigator === 'undefined') return 'no-navigator'
    if (!('serviceWorker' in navigator)) return 'unsupported'
    return navigator.serviceWorker === undefined ? 'unsupported' : 'available'
  } catch {
    // The property exists and reading it threw — an opaque origin, almost always.
    return 'refused'
  }
}
