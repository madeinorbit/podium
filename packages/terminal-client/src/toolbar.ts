import type { SessionConnection } from './connection'
import { ctrlByte, ctrlSequence, keySequence, type SpecialKey } from './keys'

/** One key on the mobile accessory bar: its visible label and the bytes it sends. */
export interface ToolbarKey {
  label: string
  /** Terminal byte sequence written to the session on tap. */
  send: string
  /** Spelled-out description, used as the tooltip and accessible name. */
  title: string
}

const special = (key: SpecialKey, label: string, title: string): ToolbarKey => ({
  label,
  send: keySequence(key),
  title,
})

const ctrl = (letter: string, title: string): ToolbarKey => ({
  label: `^${letter.toUpperCase()}`,
  send: ctrlSequence(letter),
  title,
})

const literal = (ch: string, title: string): ToolbarKey => ({ label: ch, send: ch, title })

/**
 * Keys grouped by purpose; a divider renders between groups. The set is tuned for
 * driving coding agents (Claude Code, Codex) and shells from a phone — the keys a
 * soft keyboard hides or makes awkward — ordered most-used first so the highest
 * value keys stay visible before the row scrolls.
 */
export const TOOLBAR_GROUPS: ToolbarKey[][] = [
  [
    special('Escape', 'Esc', 'Escape — cancel or clear the agent prompt'),
    special('Tab', 'Tab', 'Tab — autocomplete'),
    special('ShiftTab', '⇧Tab', 'Shift+Tab — back-tab / cycle agent modes'),
  ],
  [
    ctrl('c', 'Ctrl-C — interrupt the running command'),
    ctrl('d', 'Ctrl-D — end of input / exit'),
    ctrl('r', 'Ctrl-R — reverse history search'),
    ctrl('l', 'Ctrl-L — clear the screen'),
    ctrl('z', 'Ctrl-Z — suspend to the background'),
  ],
  [
    special('ArrowUp', '↑', 'Up — previous command'),
    special('ArrowDown', '↓', 'Down — next command'),
    special('ArrowLeft', '←', 'Left'),
    special('ArrowRight', '→', 'Right'),
  ],
  [
    literal('~', 'Tilde — home directory'),
    literal('/', 'Slash'),
    literal('|', 'Pipe'),
    literal('-', 'Dash — flags'),
  ],
]

/** Apply a Ctrl modifier to a terminal input chunk (its first character). */
export function applyCtrl(data: string): string {
  const b = ctrlByte(data.charAt(0))
  return b === null ? data : b + data.slice(1)
}

/**
 * One-shot Ctrl modifier state, decoupled from the DOM so it is unit-testable.
 * `toggleCtrl` arms/disarms it; `apply` transforms the next input chunk and, when
 * armed, consumes the modifier (Ctrl applies to one keystroke, then releases).
 * `onChange` lets the toolbar reflect the armed state on its toggle button.
 */
export interface ModifierState {
  ctrlArmed(): boolean
  toggleCtrl(): boolean
  apply(data: string): string
}

export function createModifierState(onChange?: (armed: boolean) => void): ModifierState {
  let armed = false
  const set = (next: boolean) => {
    if (next === armed) return
    armed = next
    onChange?.(armed)
  }
  return {
    ctrlArmed: () => armed,
    toggleCtrl: () => {
      set(!armed)
      return armed
    },
    apply: (data) => {
      if (!armed) return data
      set(false)
      return applyCtrl(data)
    },
  }
}

export interface MountedToolbar {
  /** Transform terminal input through any armed modifier (e.g. Ctrl). */
  applyModifiers(data: string): string
  dispose(): void
}

export function mountKeyToolbar(el: HTMLElement, conn: SessionConnection): MountedToolbar {
  const doc = el.ownerDocument
  const nodes: Element[] = []

  // Keep the terminal focused on tap; otherwise the soft keyboard collapses on
  // every press. Suppressing the default pointerdown holds focus on the xterm
  // textarea while the click still fires. Listening on the container (not just
  // the buttons) covers the gaps, padding, and separators too — rapid tapping
  // often lands between keys, and a single unguarded tap there blurs the
  // terminal and drops the keyboard.
  const holdFocus = (e: Event) => e.preventDefault()
  el.addEventListener('pointerdown', holdFocus)
  // Safari synthesizes mousedown after pointerdown and moves focus on it
  // independently; guard both.
  el.addEventListener('mousedown', holdFocus)

  // The Ctrl toggle: tap to arm, then the next soft-keyboard letter is sent as
  // Ctrl+<letter> (Ctrl-A, Ctrl-W, …) — the combos the dedicated keys don't cover.
  const ctrlBtn = doc.createElement('button')
  ctrlBtn.type = 'button'
  ctrlBtn.className = 'key mod'
  ctrlBtn.textContent = 'Ctrl'
  ctrlBtn.title = 'Ctrl — arm for the next key (e.g. Ctrl-A, Ctrl-W)'
  ctrlBtn.setAttribute('aria-label', ctrlBtn.title)
  ctrlBtn.setAttribute('aria-pressed', 'false')
  ctrlBtn.dataset.key = 'Ctrl'

  const modifiers = createModifierState((armed) => {
    ctrlBtn.setAttribute('aria-pressed', String(armed))
    ctrlBtn.classList.toggle('armed', armed)
  })

  ctrlBtn.addEventListener('click', () => modifiers.toggleCtrl())
  el.appendChild(ctrlBtn)
  nodes.push(ctrlBtn)

  const addSep = () => {
    const sep = doc.createElement('span')
    sep.className = 'key-sep'
    sep.setAttribute('aria-hidden', 'true')
    el.appendChild(sep)
    nodes.push(sep)
  }

  const addKey = (key: ToolbarKey) => {
    const b = doc.createElement('button')
    b.type = 'button'
    b.className = 'key'
    b.textContent = key.label
    b.title = key.title
    b.setAttribute('aria-label', key.title)
    b.dataset.key = key.label
    b.addEventListener('click', () => conn.sendInput(modifiers.apply(key.send)))
    el.appendChild(b)
    nodes.push(b)
  }

  for (const group of TOOLBAR_GROUPS) {
    addSep()
    for (const key of group) addKey(key)
  }

  return {
    applyModifiers: (data) => modifiers.apply(data),
    dispose() {
      el.removeEventListener('pointerdown', holdFocus)
      el.removeEventListener('mousedown', holdFocus)
      for (const n of nodes) n.remove()
    },
  }
}
