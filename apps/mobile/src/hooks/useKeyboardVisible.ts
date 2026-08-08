import { useEffect, useState } from 'react'
import { Keyboard, Platform } from 'react-native'

/**
 * Whether the software keyboard is up [POD-502].
 *
 * The floating composer pays the bottom safe area itself, and that inset is
 * wrong the moment the keyboard covers it: the home indicator is behind the
 * keyboard, so keeping its 34pt would float the composer in a gap. Callers use
 * this to drop the inset while the keyboard owns the bottom edge.
 *
 * iOS gets the `Will` events so the inset changes on the same frame as the
 * keyboard's own animation rather than after it lands; Android only reports
 * `Did`.
 */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const ios = Platform.OS === 'ios'
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', () =>
      setVisible(true),
    )
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () =>
      setVisible(false),
    )
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])

  return visible
}
