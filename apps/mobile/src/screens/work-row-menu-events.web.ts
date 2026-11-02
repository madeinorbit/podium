import type { KeyboardEvent, MouseEvent } from 'react'

/** The same menu is available to touch, pointer and keyboard users. */
export function workRowMenuEvents(open: () => void) {
  return {
    onContextMenu(event: MouseEvent) {
      event.preventDefault()
      open()
    },
    onKeyDown(event: KeyboardEvent) {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault()
        open()
      }
    },
  }
}
