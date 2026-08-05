import { TextInput } from 'react-native'

/**
 * Teach react-navigation's stack how to find the focused input on web [POD-402].
 *
 * The JS stack dismisses the keyboard when a page change starts and puts it back
 * if the gesture is cancelled (its `useKeyboardManager`). It asks for the input
 * via `TextInput.State.currentlyFocusedInput()` — a React Native API that
 * react-native-web does not implement. It implements the older
 * `currentlyFocusedField()` instead, which returns the DOM node.
 *
 * So on web the call threw, every push and every swipe:
 *
 *   TypeError: TextInput.State.currentlyFocusedInput is not a function
 *
 * Navigation survived it, which is exactly why it is worth fixing rather than
 * ignoring — what did NOT survive is dismissing the keyboard on the way out of a
 * screen. Type a comment, swipe back, and the keyboard stays up over the list
 * you just returned to.
 *
 * The shim is a rename and nothing more: both APIs return the focused input, the
 * stack only ever calls `.blur()` and `.focus()` on it, and a DOM node has both.
 */
type FocusTarget = { blur(): void; focus(): void }
type TextInputState = {
  currentlyFocusedField?: () => FocusTarget | null
  currentlyFocusedInput?: () => FocusTarget | null
}

export type BlurOnNavigateResult = 'installed' | 'already-supported' | 'unavailable'

export function installBlurOnNavigate(): BlurOnNavigateResult {
  const state = (TextInput as unknown as { State?: TextInputState }).State
  if (!state) return 'unavailable'
  // react-native-web growing its own implementation is the good outcome, and
  // ours must not shadow it.
  if (typeof state.currentlyFocusedInput === 'function') return 'already-supported'
  if (typeof state.currentlyFocusedField !== 'function') return 'unavailable'
  // Delegates on each call rather than capturing the function: RNW's method
  // reads `this._currentlyFocusedNode`, so it has to be invoked on `state`, and
  // a snapshot would go stale the moment anything replaced it.
  state.currentlyFocusedInput = () => state.currentlyFocusedField?.() ?? null
  return 'installed'
}
