/**
 * Native counterpart of ./blur-on-navigate.web.ts — deliberately nothing.
 *
 * React Native implements `TextInput.State.currentlyFocusedInput` itself, so the
 * stack's keyboard manager already works on iOS and Android. Only the web build
 * needs the shim; this file exists so the import resolves on every platform.
 */
export type BlurOnNavigateResult = 'installed' | 'already-supported' | 'unavailable'

export function installBlurOnNavigate(): BlurOnNavigateResult {
  return 'already-supported'
}
