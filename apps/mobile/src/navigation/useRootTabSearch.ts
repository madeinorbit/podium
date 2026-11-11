import { useCallback, useEffect, useRef, useState } from 'react'
import type { SearchBarCommands } from 'react-native-screens'

/** Mount the native search controller only after the title-row action is tapped. */
export function useRootTabSearch(text: string) {
  const searchRef = useRef<SearchBarCommands | null>(null)
  const [visible, setVisible] = useState(false)
  const currentText = useRef(text)
  currentText.current = text

  useEffect(() => {
    if (!visible) return
    let frame = 0
    let attempts = 0
    const focus = () => {
      // Stack.SearchBar installs its native ref through navigation options,
      // after this component commits. Wait for that mount, not a fixed delay.
      if (!searchRef.current) {
        if (attempts++ < 60) frame = requestAnimationFrame(focus)
        return
      }
      searchRef.current.setText(currentText.current)
      searchRef.current.focus()
    }
    frame = requestAnimationFrame(focus)
    return () => cancelAnimationFrame(frame)
  }, [visible])

  const open = useCallback(() => {
    if (visible) searchRef.current?.focus()
    else setVisible(true)
  }, [visible])
  const close = useCallback(() => setVisible(false), [])
  return { searchRef, visible, open, close }
}
