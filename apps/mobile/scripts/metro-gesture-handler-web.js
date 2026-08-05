const fs = require('node:fs')
const path = require('node:path')

/*
 * Give the web build a real back-swipe [POD-402].
 *
 * expo-router vendors @react-navigation/stack, whose card gestures come from
 * `views/GestureHandler`. That module resolves by platform suffix, and the
 * unsuffixed file — the one web gets — is a stub: its `PanGestureHandler` is a
 * Fragment that renders its children and listens to nothing. So on web
 * `gestureEnabled` is accepted, does nothing, and reports no error. The real
 * implementation sits right next to it in `GestureHandlerNative`, and
 * react-native-gesture-handler has had a web backend for years.
 *
 * A standalone iOS PWA has no browser back gesture of its own, so without this
 * the only way out of a pushed screen is the header chevron.
 *
 * Redirecting a file inside someone else's package is a liberty, so it lives
 * here with a test over it (./metro-gesture-handler-web.test.ts) rather than in
 * an anonymous closure that could quietly stop matching after an expo-router
 * upgrade — the failure that costs nothing at build time and everything at
 * runtime.
 */
const STUB_SUFFIX = path.join('react-navigation', 'stack', 'views', 'GestureHandler.js')

/**
 * The rewrite, alone: given a path metro resolved, what should it load instead?
 * Returns null when the rule does not apply.
 *
 * @param {string} filePath
 * @param {string | null} platform
 * @returns {string | null}
 */
function redirectGestureHandler(filePath, platform) {
  if (platform !== 'web' || !filePath.endsWith(STUB_SUFFIX)) return null
  const real = filePath.replace(/GestureHandler\.js$/, 'GestureHandlerNative.js')
  if (!fs.existsSync(real))
    throw new Error(
      `expected ${real} next to expo-router's web GestureHandler stub.\n` +
        'expo-router probably restructured its vendored stack. Re-point or drop this rule —\n' +
        'leaving it unmatched silently costs the web build its swipe-back gesture (POD-402).',
    )
  return real
}

module.exports = { STUB_SUFFIX, redirectGestureHandler }
