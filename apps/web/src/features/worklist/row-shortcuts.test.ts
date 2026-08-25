import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assignRowShortcuts,
  isCommandChord,
  MAX_ROW_SHORTCUTS,
  rowShortcutDigit,
} from './row-shortcuts'

const bridge = globalThis as { __PODIUM_DESKTOP__?: { platform: string } }

// The hold is ⌘ on macOS and Ctrl everywhere else (POD-1532), so which
// modifier these events carry depends on the shell they are pressed in.
beforeEach(() => {
  bridge.__PODIUM_DESKTOP__ = { platform: 'macos' }
})

afterEach(() => {
  delete bridge.__PODIUM_DESKTOP__
})

function chord(over: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: '1',
    code: 'Digit1',
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  } as KeyboardEvent
}

describe('isCommandChord', () => {
  it('is Command ALONE', () => {
    expect(isCommandChord(chord())).toBe(true)
    expect(isCommandChord(chord({ metaKey: false }))).toBe(false)
  })

  it('yields the chord to any other modifier riding along', () => {
    // ⇧⌘3/4/5 are macOS screenshots; ⌥⌘ and ⌃⌘ digits belong elsewhere too.
    expect(isCommandChord(chord({ shiftKey: true }))).toBe(false)
    expect(isCommandChord(chord({ altKey: true }))).toBe(false)
    expect(isCommandChord(chord({ ctrlKey: true }))).toBe(false)
  })

  // Off Apple the hold is Ctrl, and Super — which is what `metaKey` reports on
  // Linux — belongs to the window manager, so it is refused rather than
  // accepted as a second spelling of the same chord.
  it('is Ctrl ALONE on Linux, and never Super', () => {
    bridge.__PODIUM_DESKTOP__ = { platform: 'linux' }
    expect(isCommandChord(chord({ metaKey: false, ctrlKey: true }))).toBe(true)
    expect(isCommandChord(chord())).toBe(false)
    expect(isCommandChord(chord({ ctrlKey: true, shiftKey: true }))).toBe(false)
  })

  it('is Ctrl ALONE on Windows', () => {
    bridge.__PODIUM_DESKTOP__ = { platform: 'windows' }
    expect(isCommandChord(chord({ metaKey: false, ctrlKey: true }))).toBe(true)
    expect(isCommandChord(chord())).toBe(false)
  })
})

describe('rowShortcutDigit', () => {
  it('reads ⌘1…⌘9', () => {
    expect(rowShortcutDigit(chord({ key: '1', code: 'Digit1' }))).toBe(1)
    expect(rowShortcutDigit(chord({ key: '9', code: 'Digit9' }))).toBe(9)
  })

  it('reads the PHYSICAL key, so a non-US layout still numbers the rows', () => {
    // AZERTY types `(` on the unshifted 5 key: `key` is the layout's output and
    // only `code` still says which key the operator pressed.
    expect(rowShortcutDigit(chord({ key: '(', code: 'Digit5' }))).toBe(5)
  })

  it('reads the numeric keypad', () => {
    expect(rowShortcutDigit(chord({ key: '4', code: 'Numpad4' }))).toBe(4)
  })

  it('claims neither ⌘0 nor a non-digit nor a bare digit', () => {
    expect(rowShortcutDigit(chord({ key: '0', code: 'Digit0' }))).toBeNull()
    expect(rowShortcutDigit(chord({ key: 'k', code: 'KeyK' }))).toBeNull()
    expect(rowShortcutDigit(chord({ metaKey: false }))).toBeNull()
    expect(rowShortcutDigit(chord({ shiftKey: true }))).toBeNull()
  })
})

describe('assignRowShortcuts', () => {
  it('numbers rows from 1 in the order the column draws them', () => {
    expect([...assignRowShortcuts(['a', 'b', 'c'])]).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ])
  })

  it('stops at nine, leaving the rest of a long column unnumbered', () => {
    const ids = Array.from({ length: 14 }, (_, i) => `row-${i}`)
    const numbers = assignRowShortcuts(ids)
    expect(numbers.size).toBe(MAX_ROW_SHORTCUTS)
    expect(numbers.get('row-8')).toBe(9)
    expect(numbers.has('row-9')).toBe(false)
  })

  it('keeps the FIRST of a repeated id, where the keystroke would land', () => {
    expect(assignRowShortcuts(['a', 'b', 'a']).get('a')).toBe(1)
  })
})
