/**
 * THE BOARD'S KEY MAP — and the only list of it (POD-591).
 *
 * The bindings were a `switch (event.key)` inside `IssuesView` and nothing else:
 * genuinely good accelerators — j/k, arrows across columns, `x` to select,
 * Enter to open, `c` to create, and four property menus — that NOTHING on screen
 * ever mentioned. An operator discovered them by reading the source or not at
 * all, which is the difference between a power feature and a secret.
 *
 * So they are data now, and TWO things read this file: the view's key handler
 * and the `?` sheet. A binding cannot drift out of the sheet, because the sheet
 * is not a second list of what the handler does — it is the same list.
 *
 * ORDER IS THE SHEET'S ORDER: move, act, then get out. `?` is last because it is
 * the one you already found.
 */
import type { IssuesKeyAction } from './issues-keys'

/** What a board key asks for. `property` opens the anchored menu named by the
 *  key itself (s = status, p = priority, a = assignee, l = labels), which is why
 *  it carries no payload — the handler already has the key. */
export type BoardKeyAction =
  | { kind: 'nav'; action: IssuesKeyAction }
  | { kind: 'create' }
  | { kind: 'open' }
  | { kind: 'property' }
  | { kind: 'help' }

export interface BoardShortcut {
  /** Literal `event.key` values that fire this, in the order the sheet shows. */
  keys: string[]
  label: string
  /** Only meaningful with a card focused; the handler no-ops without one, and
   *  the sheet says so rather than letting the key look broken. */
  needsFocus?: boolean
  action: BoardKeyAction
}

export const BOARD_SHORTCUTS: readonly BoardShortcut[] = [
  {
    keys: ['j', 'ArrowDown'],
    label: 'Next task',
    action: { kind: 'nav', action: { kind: 'next' } },
  },
  {
    keys: ['k', 'ArrowUp'],
    label: 'Previous task',
    action: { kind: 'nav', action: { kind: 'prev' } },
  },
  {
    keys: ['ArrowLeft'],
    label: 'Previous column',
    action: { kind: 'nav', action: { kind: 'left' } },
  },
  {
    keys: ['ArrowRight'],
    label: 'Next column',
    action: { kind: 'nav', action: { kind: 'right' } },
  },
  { keys: ['Enter'], label: 'Open the focused task', needsFocus: true, action: { kind: 'open' } },
  {
    keys: ['x'],
    label: 'Select, then act on the selection in the bulk bar',
    needsFocus: true,
    action: { kind: 'nav', action: { kind: 'toggleSelect' } },
  },
  { keys: ['c'], label: 'New task', action: { kind: 'create' } },
  { keys: ['s'], label: 'Set status', needsFocus: true, action: { kind: 'property' } },
  { keys: ['p'], label: 'Set priority', needsFocus: true, action: { kind: 'property' } },
  { keys: ['a'], label: 'Set assignee', needsFocus: true, action: { kind: 'property' } },
  { keys: ['l'], label: 'Add or remove a label', needsFocus: true, action: { kind: 'property' } },
  {
    keys: ['Escape'],
    label: 'Clear the selection, then the focus',
    action: { kind: 'nav', action: { kind: 'clear' } },
  },
  { keys: ['?'], label: 'Show this list', action: { kind: 'help' } },
]

/** The action a key fires on the board, or undefined for a key the board does
 *  not own — which is how the handler knows to let the event through. */
export function boardKeyAction(key: string): BoardKeyAction | undefined {
  return BOARD_SHORTCUTS.find((shortcut) => shortcut.keys.includes(key))?.action
}

/** How a key is written on the sheet. The literal `event.key` names are correct
 *  and unreadable; an operator looking for "the arrow keys" is not looking for
 *  `ArrowLeft`. */
const KEY_GLYPH: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: '↵',
  Escape: 'esc',
}

export function shortcutGlyph(key: string): string {
  return KEY_GLYPH[key] ?? key
}
