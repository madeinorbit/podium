import { useEffect, useState } from 'react'
import { Dimensions, Keyboard, type KeyboardEvent, Platform } from 'react-native'

/**
 * The keyboard's current overlap with the window bottom, in pt — 0 when hidden.
 * The app's ONE answer to "how much of the bottom edge is the keyboard": bottom
 * sheets lift by it, and so does every screen that pins a composer.
 *
 * WHY NOT `KeyboardAvoidingView` (2026-08-29). The stock view computes its own
 * overlap from an `onLayout` frame in PARENT coordinates against a keyboard
 * frame in WINDOW coordinates, so any chrome above it (a header, the safe area)
 * has to be handed back through `keyboardVerticalOffset` — and measuring that
 * offset from a view the avoider itself moves is a feedback loop. It came apart
 * exactly where a phone spends its time: switch away with the keyboard up, come
 * back, and the view collapsed to a sliver with the composer stranded at the top
 * of a black screen (reproduced on the 26.3 simulator, from the operator's own
 * screenshot). The keyboard frame is absolute and arrives with every change;
 * reading it directly has no initial-frame state to get wrong and no loop.
 *
 * THE CALLER'S BOTTOM EDGE IS ASSUMED TO BE THE WINDOW'S. That holds for a
 * full-height screen — including a tab screen, whose bar floats over the content
 * — and it is the only shape this is used in. A view inset from the bottom by
 * real chrome would need that chrome subtracted.
 *
 * iOS uses `keyboardWillChangeFrame` so the lift starts with the keyboard's own
 * animation rather than after it; Android only reports did-show/did-hide, and
 * its window is resized by the system anyway, so callers there generally want 0.
 * Web returns 0 — the visual-viewport root owns keyboard geometry.
 */
export function keyboardOverlap(windowHeight: number, event: KeyboardEvent): number {
  const { screenY, height } = event.endCoordinates
  // A dismissed keyboard reports a frame parked at (or below) the window
  // bottom; overlap is what actually intrudes.
  return Math.max(0, Math.min(height, windowHeight - screenY))
}

/**
 * How far a pinned surface must rise to clear the keyboard: the overlap on iOS,
 * and nothing anywhere else. Android's window is resized by the system and web's
 * visual viewport does the same job, so lifting there would double-count.
 */
export function useKeyboardLift(): number {
  const height = useKeyboardHeight()
  return Platform.OS === 'ios' ? height : 0
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
