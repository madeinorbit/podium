import { useEffect } from 'react'

/** Browsers get the same settings shortcut as the desktop menu. */
export function useSettingsShortcut(openSettings: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key !== ','
      )
        return
      event.preventDefault()
      openSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openSettings])
}
