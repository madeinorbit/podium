import { type ReactElement, useCallback, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'

/**
 * The measured `keyboardVerticalOffset` for a `KeyboardAvoidingView` that does
 * not start at the window's top edge — which on this phone is every chat.
 *
 * WHY THE STOCK VIEW FAILS HERE (2026-08-28 device feedback: the keyboard
 * opened OVER the prompt box): `KeyboardAvoidingView` computes its overlap with
 * the keyboard as `frame.y + frame.height - keyboardY`, where `frame` comes
 * from its own `onLayout` — coordinates RELATIVE TO ITS PARENT — while
 * `keyboardY` is in WINDOW coordinates. The subtraction is only meaningful when
 * the view's coordinate space shares the window's origin. Every host of the
 * conversation puts chrome above it — the safe area, the Screen header, the
 * mission deck bar — so the computed padding fell short by exactly that
 * chrome's height (~100–150pt) and the composer stayed under the keyboard.
 *
 * `keyboardVerticalOffset` is the prop that closes the gap, but hard-coding a
 * per-screen sum of header heights is the kind of constant that rots. This hook
 * MEASURES it instead: render {@link anchor} as the avoiding view's first child
 * and put {@link onLayout} on the avoiding view itself; the anchor sits at the
 * view's top-left corner and reports where that corner is in the window. The
 * KAV's `frame.y` is 0 in every host (it is the sole flex child of its slot),
 * so the anchor's window-Y is exactly the offset the stock math is missing.
 *
 * Re-measures when the avoiding view's own frame changes (rotation, a header
 * that grows a subtitle); no-ops on web, where the visual-viewport root owns
 * keyboard geometry and `KeyboardAvoidingView` renders as a plain View.
 */
export function useKeyboardVerticalOffset(): {
  offset: number
  /** Render as the FIRST child of the KeyboardAvoidingView. */
  anchor: ReactElement
  /** Attach to the KeyboardAvoidingView so a frame change re-measures. */
  onLayout: () => void
} {
  const anchorRef = useRef<View>(null)
  const [offset, setOffset] = useState(0)
  const measure = useCallback(() => {
    anchorRef.current?.measureInWindow((_x, y) => {
      if (!Number.isFinite(y)) return
      const next = Math.max(0, Math.round(y))
      setOffset((previous) => (previous === next ? previous : next))
    })
  }, [])
  const anchor = (
    <View
      ref={anchorRef}
      testID="keyboard-offset-anchor"
      // A view with no content is collapsed out of the native tree, and a
      // collapsed view cannot be measured.
      collapsable={false}
      pointerEvents="none"
      onLayout={measure}
      style={styles.anchor}
    />
  )
  return { offset, anchor, onLayout: measure }
}

const styles = StyleSheet.create({
  /** Zero-footprint: pinned to the corner the measurement is ABOUT. */
  anchor: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 1,
    height: 1,
    opacity: 0,
  },
})
