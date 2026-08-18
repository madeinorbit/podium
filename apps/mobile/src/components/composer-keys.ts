import { Platform } from 'react-native'

/**
 * WHAT ENTER DOES IN THE PROMPT.
 *
 * On a phone it makes a NEW LINE. This app spent a release doing the opposite:
 * the field submitted on Enter for everyone, because the composer had been
 * written against a desktop keyboard where that is the convention. On a soft
 * keyboard it is not a convention, it is a trap — the return key sits under the
 * thumb, there is no Shift chord to reach for mid-sentence, and every attempt to
 * start a second paragraph fires the message half-written. Every touch keyboard
 * on the platform (Messages, Mail, WhatsApp) makes a newline; the send control
 * is a button you aim at.
 *
 * A HARDWARE KEYBOARD IS A DIFFERENT MACHINE, though — the same bundle runs in a
 * desktop browser, where a field that cannot be submitted from the keyboard
 * reads as broken. So plain Enter still sends THERE, and Shift+Enter still makes
 * a newline, matching the desktop composer exactly.
 *
 * Cmd/Ctrl+Enter sends everywhere. It costs nothing, it is what every reference
 * composer accepts, and it is the escape hatch for a paired Bluetooth keyboard
 * that the pointer heuristic below cannot see.
 */

export interface ComposerKeyPress {
  key: string
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}

export type ComposerKeyAction = 'send' | 'newline' | 'ignore'

export function composerKeyAction(
  event: ComposerKeyPress,
  hardwareKeyboard: boolean,
): ComposerKeyAction {
  if (event.key !== 'Enter') return 'ignore'
  if (event.metaKey || event.ctrlKey) return 'send'
  if (event.shiftKey || event.altKey) return 'newline'
  return hardwareKeyboard ? 'send' : 'newline'
}

/**
 * Is a physical keyboard driving this field?
 *
 * There is no direct answer available to a web page, so this asks the closest
 * honest question: does this pointer behave like a mouse? `hover: hover` plus
 * `pointer: fine` is true for a desktop browser and false for every touch
 * device, including a tablet with a keyboard case attached — which is why
 * Cmd+Enter exists above rather than this heuristic being asked to carry the
 * whole decision. Native is never a desktop browser.
 */
export function hasHardwareKeyboard(): boolean {
  if (Platform.OS !== 'web') return false
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches
  } catch {
    return false
  }
}
