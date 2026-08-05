import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
const { redirectGestureHandler } = require_('./metro-gesture-handler-web.js') as {
  redirectGestureHandler: (filePath: string, platform: string | null) => string | null
}

/**
 * The metro rule that gives the web build a working back-swipe [POD-402].
 *
 * Worth a test because of HOW it fails: a rule that stops matching — because
 * expo-router moved the file, or renamed a directory on the way to it — costs
 * nothing at build time and silently returns web to a stubbed gesture handler,
 * where `gestureEnabled` is accepted and does nothing. These assertions run
 * against the real installed expo-router, so an upgrade that invalidates the
 * rule fails here instead of on someone's phone.
 */
const stub = require_.resolve(
  'expo-router/build/react-navigation/stack/views/GestureHandler.js',
)

describe('the web GestureHandler redirect', () => {
  it('still has a stub to redirect away from, and it is still a stub', () => {
    // If expo-router ever ships a real web implementation, this rule becomes
    // dead weight and should be deleted rather than left to shadow theirs.
    const source = require_('node:fs').readFileSync(stub, 'utf8')
    expect(source).toContain('PanGestureHandler = Dummy')
  })

  it('sends the web build to the real implementation', () => {
    const real = redirectGestureHandler(stub, 'web')
    expect(real).toBe(stub.replace(/GestureHandler\.js$/, 'GestureHandlerNative.js'))
    // Read rather than import: pulling RNGH's module graph through vitest tests
    // vitest's resolver, and metro is the one that has to resolve this.
    const source = require_('node:fs').readFileSync(real as string, 'utf8')
    expect(source).toContain('react-native-gesture-handler')
    expect(source).toContain('exports.PanGestureHandler = PanGestureHandler')
  })

  it('has react-native-gesture-handler installed for it to reach', () => {
    // It is a direct dependency of this app precisely so the redirect resolves;
    // nothing in app code imports the package by name except the root view.
    expect(require_.resolve('react-native-gesture-handler')).toContain(
      'react-native-gesture-handler',
    )
  })

  it('leaves the native platforms alone', () => {
    // ios/android resolve their own GestureHandler.ios.js / .android.js, and
    // rewriting anything there would be us breaking what already works.
    expect(redirectGestureHandler(stub, 'ios')).toBeNull()
    expect(redirectGestureHandler(stub, 'android')).toBeNull()
    expect(redirectGestureHandler(stub, null)).toBeNull()
  })

  it('does not match a same-named file from anywhere else', () => {
    // The suffix carries `react-navigation/stack/views/` for this reason: a
    // bare `GestureHandler.js` match would rewrite RNGH's own modules.
    expect(redirectGestureHandler('/x/react-native-gesture-handler/GestureHandler.js', 'web')).toBe(
      null,
    )
    expect(redirectGestureHandler('/x/stack/views/GestureHandlerNative.js', 'web')).toBeNull()
  })
})
