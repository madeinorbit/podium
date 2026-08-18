import { describe, expect, it } from 'vitest'
import { composerKeyAction } from './composer-keys'

const TOUCH = false
const KEYBOARD = true

describe('composerKeyAction', () => {
  it('makes a newline on a touch keyboard — the release this fixes sent the message instead', () => {
    expect(composerKeyAction({ key: 'Enter' }, TOUCH)).toBe('newline')
  })

  it('still submits on a real keyboard, where a field that cannot be sent reads as broken', () => {
    expect(composerKeyAction({ key: 'Enter' }, KEYBOARD)).toBe('send')
  })

  it('keeps Shift+Enter a newline on a real keyboard, matching the desktop composer', () => {
    expect(composerKeyAction({ key: 'Enter', shiftKey: true }, KEYBOARD)).toBe('newline')
  })

  it('sends on the Cmd/Ctrl chord everywhere — the escape hatch a paired keyboard needs', () => {
    expect(composerKeyAction({ key: 'Enter', metaKey: true }, TOUCH)).toBe('send')
    expect(composerKeyAction({ key: 'Enter', ctrlKey: true }, TOUCH)).toBe('send')
  })

  it('lets the chord win over Shift rather than cancelling out', () => {
    expect(composerKeyAction({ key: 'Enter', metaKey: true, shiftKey: true }, TOUCH)).toBe('send')
  })

  it('treats Alt+Enter as a newline — it is the option-return paragraph break', () => {
    expect(composerKeyAction({ key: 'Enter', altKey: true }, KEYBOARD)).toBe('newline')
  })

  it('ignores every other key, so the field keeps its own handling', () => {
    expect(composerKeyAction({ key: 'a' }, KEYBOARD)).toBe('ignore')
    expect(composerKeyAction({ key: 'Backspace' }, TOUCH)).toBe('ignore')
  })
})
