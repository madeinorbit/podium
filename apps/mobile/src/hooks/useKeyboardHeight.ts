import { useEffect, useState } from 'react'
import { Dimensions, Keyboard, type KeyboardEvent, Platform } from 'react-native'

/**
 * The keyboard's current overlap with the window bottom, in pt — 0 when
 * hidden. For surfaces that must LIFT with the keyboard but live outside any
 * KeyboardAvoidingView reach: the bottom sheets render inside a Modal with
 * absolute geometry, so the avoiding view machinery never touches them
 * (2026-08-28 device feedback: the peek task's comment field stayed under the
 * keyboard).
 *
 * iOS uses `keyboardWillChangeFrame` so the lift starts with the keyboard's
 * own animation rather than after it; Android only reports did-show/did-hide.
 * Web returns 0 — the visual-viewport root owns keyboard geometry there.
 */
export function keyboardOverlap(windowHeight: number, event: KeyboardEvent): number {
  const { screenY, height } = event.endCoordinates
  // A dismissed keyboard reports a frame parked at (or below) the window
  // bottom; overlap is what actually intrudes.
  return Math.max(0, Math.min(height, windowHeight - screenY))
}

export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    if (Platform.OS === 'web') return
    const onFrame = (event: KeyboardEvent) => {
      setHeight(keyboardOverlap(Dimensions.get('window').height, event))
    }
    const subs =
      Platform.OS === 'ios'
        ? [Keyboard.addListener('keyboardWillChangeFrame', onFrame)]
        : [
            Keyboard.addListener('keyboardDidShow', onFrame),
            Keyboard.addListener('keyboardDidHide', () => setHeight(0)),
          ]
    return () => {
      for (const sub of subs) sub.remove()
    }
  }, [])
  return height
}
