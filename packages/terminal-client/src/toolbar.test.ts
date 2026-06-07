import { describe, expect, it } from 'vitest'
import { ctrlSequence, keySequence } from './keys'
import { applyCtrl, createModifierState, TOOLBAR_GROUPS, type ToolbarKey } from './toolbar'

const allKeys = (): ToolbarKey[] => TOOLBAR_GROUPS.flat()
const byLabel = (label: string): ToolbarKey | undefined => allKeys().find((k) => k.label === label)

describe('mobile key toolbar', () => {
  it('every key sends a non-empty sequence and has an accessible title', () => {
    for (const key of allKeys()) {
      expect(key.send.length).toBeGreaterThan(0)
      expect(key.title.trim().length).toBeGreaterThan(0)
    }
  })

  it('labels are unique so each tap is unambiguous', () => {
    const labels = allKeys().map((k) => k.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('carries the agent/terminal essentials', () => {
    // The keys a coding agent or shell needs that a soft keyboard hides.
    for (const label of ['Esc', '⇧Tab', '^C', '↑']) {
      expect(byLabel(label), `expected toolbar to include ${label}`).toBeDefined()
    }
  })

  it('maps named keys to the correct terminal sequences', () => {
    expect(byLabel('Esc')?.send).toBe(keySequence('Escape'))
    expect(byLabel('⇧Tab')?.send).toBe(keySequence('ShiftTab'))
    expect(byLabel('↑')?.send).toBe(keySequence('ArrowUp'))
  })

  it('maps control keys to C0 control codes', () => {
    expect(byLabel('^C')?.send).toBe(ctrlSequence('c'))
    expect(byLabel('^L')?.send).toBe(ctrlSequence('l'))
    expect(byLabel('^R')?.send).toBe(ctrlSequence('r'))
  })

  it('sends shell symbols as literal characters', () => {
    for (const ch of ['~', '/', '|', '-']) {
      expect(byLabel(ch)?.send).toBe(ch)
    }
  })
})

describe('sticky Ctrl modifier', () => {
  it('applyCtrl masks the first character to a control code', () => {
    expect(applyCtrl('a')).toBe('\x01')
    expect(applyCtrl('w')).toBe('\x17')
    // Only the first char is masked; the rest rides along untouched.
    expect(applyCtrl('cd')).toBe('\x03d')
    // Non-letters and escape sequences pass through unchanged.
    expect(applyCtrl('/')).toBe('/')
    expect(applyCtrl('\x1b[A')).toBe('\x1b[A')
    expect(applyCtrl('')).toBe('')
  })

  it('arming transforms exactly one keystroke, then releases', () => {
    const state = createModifierState()
    expect(state.ctrlArmed()).toBe(false)
    // Disarmed: input is untouched.
    expect(state.apply('c')).toBe('c')

    expect(state.toggleCtrl()).toBe(true)
    expect(state.ctrlArmed()).toBe(true)
    // First keystroke after arming is Ctrl-combined and consumes the modifier.
    expect(state.apply('c')).toBe('\x03')
    expect(state.ctrlArmed()).toBe(false)
    // Next keystroke is back to plain text.
    expect(state.apply('c')).toBe('c')
  })

  it('tapping Ctrl twice arms then disarms without consuming a key', () => {
    const state = createModifierState()
    expect(state.toggleCtrl()).toBe(true)
    expect(state.toggleCtrl()).toBe(false)
    expect(state.apply('c')).toBe('c')
  })

  it('notifies on every armed-state change', () => {
    const seen: boolean[] = []
    const state = createModifierState((armed) => seen.push(armed))
    state.toggleCtrl() // arm -> true
    state.apply('c') // consume -> false
    expect(seen).toEqual([true, false])
  })
})
