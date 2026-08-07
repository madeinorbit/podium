/**
 * The board's key map is ONE list (POD-591) — the handler switches on it and the
 * `?` sheet renders it. These assert the properties that make that safe.
 */
import { describe, expect, it } from 'vitest'
import { BOARD_SHORTCUTS, boardKeyAction, shortcutGlyph } from './board-shortcuts'

describe('BOARD_SHORTCUTS', () => {
  it('binds no key twice — a second owner would silently shadow the first', () => {
    const keys = BOARD_SHORTCUTS.flatMap((s) => s.keys)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('gives every binding a label, so nothing can appear on the sheet unexplained', () => {
    for (const shortcut of BOARD_SHORTCUTS) {
      expect(shortcut.keys.length, JSON.stringify(shortcut)).toBeGreaterThan(0)
      expect(shortcut.label.trim().length, JSON.stringify(shortcut)).toBeGreaterThan(0)
    }
  })

  it('still binds every accelerator the board shipped before the table existed', () => {
    // The pre-POD-591 switch, verbatim. A refactor that quietly dropped one of
    // these would be a regression no visual check would catch.
    for (const key of [
      'c',
      'Escape',
      'j',
      'ArrowDown',
      'k',
      'ArrowUp',
      'ArrowLeft',
      'ArrowRight',
      'Enter',
      'x',
      's',
      'p',
      'a',
      'l',
    ]) {
      expect(boardKeyAction(key), key).toBeDefined()
    }
  })

  it('marks the bindings that need a focused card', () => {
    for (const key of ['Enter', 'x', 's', 'p', 'a', 'l']) {
      expect(BOARD_SHORTCUTS.find((s) => s.keys.includes(key))?.needsFocus, key).toBe(true)
    }
    for (const key of ['c', 'j', 'ArrowDown', 'Escape', '?']) {
      expect(BOARD_SHORTCUTS.find((s) => s.keys.includes(key))?.needsFocus, key).toBeUndefined()
    }
  })

  it('routes the four property keys to the property menu named by the key itself', () => {
    for (const key of ['s', 'p', 'a', 'l']) {
      expect(boardKeyAction(key), key).toEqual({ kind: 'property' })
    }
  })

  it('owns no key it does not handle', () => {
    expect(boardKeyAction('q')).toBeUndefined()
    expect(boardKeyAction('Tab')).toBeUndefined()
    expect(boardKeyAction('')).toBeUndefined()
  })

  it('lists itself, so the sheet is reachable from the sheet', () => {
    expect(boardKeyAction('?')).toEqual({ kind: 'help' })
  })
})

describe('shortcutGlyph', () => {
  it('writes the arrows and Escape the way an operator looks for them', () => {
    expect(shortcutGlyph('ArrowLeft')).toBe('←')
    expect(shortcutGlyph('Enter')).toBe('↵')
    expect(shortcutGlyph('Escape')).toBe('esc')
  })

  it('passes a plain letter through', () => {
    expect(shortcutGlyph('j')).toBe('j')
  })
})
