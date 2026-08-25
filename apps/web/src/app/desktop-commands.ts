/**
 * ONE REGISTRY FOR THE SHELL'S COMMANDS (POD-1532).
 *
 * A shell command used to be written down in four places that could not see
 * each other: the accelerator in the macOS menu (`apps/desktop/src-tauri/src/main.rs`),
 * the global hook the menu evals, a keydown listener in whichever component
 * happened to own the action, and a glyph typed by hand into a hint. Only the
 * first of those knew all the commands, and it only exists on macOS — which is
 * exactly why Linux had four working chords out of nine and every hint on it
 * advertised a Command key the machine does not have.
 *
 * So the command list lives HERE, once, and everything else reads it:
 *
 *   · `installDesktopMenuHooks` (desktop-menu.ts) publishes the globals under
 *     the names in `hook`, which is what the macOS menu evals;
 *   · `DesktopMenuHost` binds every chord as a keydown wherever the shell has
 *     no menu bar to claim it (Linux, Windows, and macOS builds older than the
 *     rebuilt menu);
 *   · the command palette lists the same commands with the same labels, which
 *     is the only way any of them are discoverable off macOS;
 *   · hints call {@link commandShortcutLabel} / {@link chordHint} instead of
 *     typing ⌘ into JSX.
 *
 * IDS ARE THE MENU'S IDS. `about-podium`, `toggle-flight-deck` and the rest are
 * the strings `main.rs` builds its `MenuItemBuilder::with_id` items with and
 * matches in `on_menu_event`; `desktop-commands.rust.test.ts` reads that file
 * and fails if the two lists drift. One registry means one registry, across the
 * language boundary too.
 *
 * THE MODIFIER IS ⌘ ON APPLE AND CTRL EVERYWHERE ELSE — never Super. On a Linux
 * desktop the Super key belongs to the window manager (Hyprland here binds the
 * whole range), so a Super chord is one the app would advertise and never
 * receive. `event.metaKey` is therefore not merely unused off Apple, it is
 * REFUSED: a Super chord that leaks through is the compositor's, not ours.
 */

import { nativeDesktopBridge } from '@/lib/nativeDesktop'

/** Menu-item ids from `main.rs`, plus commands that never had a menu item. */
export type DesktopCommandId =
  | 'about-podium'
  | 'check-updates'
  | 'open-settings'
  | 'add-project'
  | 'new-agent'
  | 'close-tab'
  | 'focus-session-prompt'
  | 'toggle-session-view'
  | 'toggle-left-sidebar'
  | 'toggle-flight-deck'
  | 'toggle-right-sidebar'
  | 'command-palette'

/** A chord on top of the platform modifier (⌘ on Apple, Ctrl elsewhere). */
export interface DesktopChord {
  /** Matched against `event.key`, lower-cased — `'b'`, `','`, `'enter'`. */
  key: string
  shift?: boolean
  alt?: boolean
}

export interface DesktopCommand {
  id: DesktopCommandId
  /**
   * The global the macOS menu evals and every other shell calls directly.
   * `null` for a command whose owner answers the keystroke itself rather than
   * publishing a hook (the palette toggle, which is AppShell state).
   */
  hook: string | null
  /** Menu grammar — the same words the macOS menu item carries. */
  label: string
  /** Extra match terms for command search. */
  keywords: string[]
  chord: DesktopChord | null
  /** Offer it in the command palette. False where the palette already has a
   *  richer row for the same action, or where the row would be the palette. */
  palette: boolean
}

/**
 * Declared in menu order: the Podium menu, File, then View. The palette renders
 * them in this order too, so the reader who learned the menu on macOS finds the
 * same sequence in search on Linux.
 */
export const DESKTOP_COMMANDS: readonly DesktopCommand[] = [
  {
    id: 'about-podium',
    hook: '__PODIUM_ABOUT__',
    label: 'About Podium ADE',
    keywords: ['version', 'build', 'credits'],
    chord: null,
    palette: true,
  },
  {
    id: 'check-updates',
    hook: '__PODIUM_CHECK_UPDATES__',
    label: 'Check for Updates…',
    keywords: ['update', 'upgrade', 'release', 'version'],
    chord: null,
    palette: true,
  },
  {
    id: 'open-settings',
    hook: '__PODIUM_SETTINGS__',
    label: 'Settings…',
    keywords: ['preferences', 'config'],
    chord: { key: ',' },
    // `Go to Settings` already sits in the palette's action group and lands in
    // the same place; it carries this chord as its hint instead.
    palette: false,
  },
  {
    id: 'add-project',
    hook: '__PODIUM_ADD_PROJECT__',
    label: 'Add Project…',
    keywords: ['repo', 'repository', 'scan', 'clone', 'folder'],
    chord: null,
    // `Add repo…` is the palette's own row for this.
    palette: false,
  },
  {
    id: 'new-agent',
    hook: '__PODIUM_NEW_AGENT__',
    label: 'New Agent',
    keywords: ['task', 'session', 'spawn', 'start'],
    chord: { key: 'n' },
    // The palette offers a spawn per worktree, which is the better row.
    palette: false,
  },
  {
    id: 'close-tab',
    hook: '__PODIUM_CLOSE_TAB__',
    label: 'Close Tab',
    keywords: ['shut', 'dismiss', 'pane', 'workspace'],
    chord: { key: 'w' },
    palette: true,
  },
  {
    id: 'focus-session-prompt',
    hook: '__PODIUM_FOCUS_SESSION_PROMPT__',
    label: 'Focus Session Prompt',
    keywords: ['composer', 'input', 'caret', 'type'],
    chord: { key: 'l' },
    palette: true,
  },
  {
    id: 'toggle-session-view',
    hook: '__PODIUM_TOGGLE_SESSION_VIEW__',
    label: 'Toggle Chat / Native View',
    keywords: ['terminal', 'transcript', 'switch', 'mode'],
    chord: { key: 'l', shift: true },
    palette: true,
  },
  {
    id: 'toggle-left-sidebar',
    hook: '__PODIUM_TOGGLE_LEFT_SIDEBAR__',
    label: 'Toggle Left Sidebar',
    keywords: ['work list', 'column', 'collapse', 'rail'],
    chord: { key: 'b', shift: true },
    palette: true,
  },
  {
    id: 'toggle-flight-deck',
    hook: '__PODIUM_TOGGLE_FLIGHT_DECK__',
    label: 'Toggle Flight Deck',
    keywords: ['deck', 'missions', 'tree'],
    chord: { key: 'f', alt: true },
    palette: true,
  },
  {
    id: 'toggle-right-sidebar',
    hook: '__PODIUM_TOGGLE_RIGHT_SIDEBAR__',
    label: 'Toggle Right Sidebar',
    keywords: ['dock', 'panel', 'inspector'],
    chord: { key: 'b' },
    palette: true,
  },
  {
    id: 'command-palette',
    hook: null,
    label: 'Command Palette',
    keywords: ['search', 'commands'],
    chord: { key: 'k' },
    // Listing the palette inside the palette is a row that cannot help anyone.
    palette: false,
  },
]

const BY_ID = new Map(DESKTOP_COMMANDS.map((command) => [command.id, command]))

export function desktopCommand(id: DesktopCommandId): DesktopCommand {
  const command = BY_ID.get(id)
  // The map is built from the literal above, so this is unreachable — it exists
  // so callers get a `DesktopCommand`, not `DesktopCommand | undefined`.
  if (!command) throw new Error(`unknown desktop command: ${id}`)
  return command
}

/** Apple hardware by the browser's own reckoning (no shell involved). */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

/**
 * Does this machine spell the modifier ⌘ or Ctrl?
 *
 * The SHELL's platform wins wherever there is one, because that is the keyboard
 * the shell's own menu was built for — a Linux build never has a Command key to
 * offer no matter what the webview's UA string says. A browser tab falls back
 * to the UA, which is the only evidence there.
 */
export function usesCommandKey(): boolean {
  const bridge = nativeDesktopBridge()
  if (bridge) return bridge.platform === 'macos'
  return isApplePlatform()
}

/** `⌘` or `Ctrl`, for a hint that has to name the modifier on its own. */
export function modLabel(): string {
  return usesCommandKey() ? '⌘' : 'Ctrl'
}

const KEY_GLYPHS: Record<string, string> = {
  enter: '↵',
  escape: 'Esc',
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
}

function keyLabel(key: string): string {
  const glyph = KEY_GLYPHS[key.toLowerCase()]
  if (glyph) return glyph
  return key.length === 1 ? key.toUpperCase() : key
}

/**
 * Render a chord the way the platform writes it.
 *
 * Apple stacks glyphs in the system's own order (⌃⌥⇧⌘) with no separators —
 * `⇧⌘B`, `⌥⌘F`. Everywhere else the words are spelled out and joined with `+`,
 * which is what GTK, Qt and every Linux menu do: `Ctrl+Shift+B`, `Ctrl+Alt+F`.
 *
 * `mod: false` renders a chord that does not use the platform modifier at all
 * (⌥S / Alt+S), which is still a hint that has to change wording per platform.
 */
export function formatChord(chord: DesktopChord & { mod?: boolean }): string {
  const withMod = chord.mod !== false
  if (usesCommandKey()) {
    return `${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${withMod ? '⌘' : ''}${keyLabel(chord.key)}`
  }
  const parts: string[] = []
  if (withMod) parts.push('Ctrl')
  if (chord.alt) parts.push('Alt')
  if (chord.shift) parts.push('Shift')
  parts.push(keyLabel(chord.key))
  return parts.join('+')
}

/** Shorthand for the one-off hints that are not registry commands (⌘↵, ⌘S). */
export function chordHint(
  key: string,
  mods: { shift?: boolean; alt?: boolean; mod?: boolean } = {},
): string {
  return formatChord({ key, ...mods })
}

/** What this command's shortcut is CALLED here, or null if it has no chord. */
export function commandShortcutLabel(id: DesktopCommandId): string | null {
  const { chord } = desktopCommand(id)
  return chord ? formatChord(chord) : null
}

type ChordEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> & {
  code?: string
}

/**
 * The physical key this event names, independent of what the layout printed.
 *
 * `key` is tried first so the chord follows the letters the operator sees, and
 * `code` is the fallback for the two cases where `key` stops being a letter at
 * all: Option on macOS substitutes the key entirely (⌥F arrives as `ƒ`), and a
 * non-US layout moves the punctuation (`,` is Shift+; on some, and AZERTY types
 * `;` where QWERTY types `,`).
 */
function chordKeys(event: ChordEvent): string[] {
  const keys = [event.key.toLowerCase()]
  const code = event.code ?? ''
  const letter = /^Key([A-Z])$/.exec(code)?.[1]
  if (letter) keys.push(letter.toLowerCase())
  else if (code === 'Comma') keys.push(',')
  return keys
}

/**
 * The command this keystroke asks for, or null.
 *
 * Off Apple a Super chord is refused outright (`!metaKey`): Hyprland owns that
 * modifier, and answering the odd Super press that does leak into the webview
 * would be the app taking a keystroke the compositor believes it handled.
 */
export function desktopCommandForEvent(event: ChordEvent): DesktopCommand | null {
  const apple = usesCommandKey()
  const mod = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!mod) return null
  const keys = chordKeys(event)
  for (const command of DESKTOP_COMMANDS) {
    const chord = command.chord
    if (!chord) continue
    if (!keys.includes(chord.key)) continue
    if (!!chord.shift !== event.shiftKey) continue
    if (!!chord.alt !== event.altKey) continue
    return command
  }
  return null
}

/**
 * A terminal has the keyboard and every control byte in it.
 *
 * This only ever bites where the modifier is Ctrl. On Apple the shell's chords
 * are ⌘-based and a terminal never wanted them; on Linux the SAME chords are
 * Ctrl+B (tmux's prefix), Ctrl+W (kill word), Ctrl+L (clear screen), Ctrl+K
 * (kill line) — keystrokes an operator inside a shell is pressing on purpose.
 *
 * And we cannot have it both ways: xterm writes the byte to the pty from its
 * own keydown listener on the helper textarea, which runs before this one on
 * `window` sees the event, so calling `preventDefault` here cannot un-send it.
 * A chord claimed over a focused terminal would fire the command AND type the
 * control code. The terminal keeps them.
 */
export function terminalOwnsChord(target: EventTarget | null): boolean {
  if (usesCommandKey()) return false
  const node = target instanceof Element ? target : safeActiveElement()
  return !!node?.closest('.xterm, .term, [data-terminal]')
}

function safeActiveElement(): Element | null {
  if (typeof document === 'undefined') return null
  return document.activeElement
}

/**
 * Publish one command's handler and return the uninstall.
 *
 * The uninstall is IDENTITY-CHECKED: a surface that remounts (an expand swaps
 * the sidebar's rail for its column, and React mounts the arriving one before
 * unmounting the leaving one) would otherwise have the departing copy delete
 * the arriving copy's hook and leave the command dead.
 *
 * `installDesktopMenuHooks` is the multi-command form of this, kept separate
 * because its callers hand over a whole set at once.
 */
export function installDesktopCommandHook(
  id: DesktopCommandId,
  handler: () => void | boolean,
): () => void {
  const { hook } = desktopCommand(id)
  if (!hook) return () => {}
  const globals = globalThis as Record<string, unknown>
  globals[hook] = handler
  return () => {
    if (globals[hook] === handler) delete globals[hook]
  }
}

/** Is anything currently answering this command? */
export function desktopCommandBound(id: DesktopCommandId): boolean {
  const { hook } = desktopCommand(id)
  if (!hook) return false
  return typeof (globalThis as Record<string, unknown>)[hook] === 'function'
}

/**
 * Invoke a command through the same global the macOS menu evals, and report
 * whether it was actually answered. One dispatch path for the menu, the
 * keyboard and the palette — a command with no owner mounted is a no-op rather
 * than a second, divergent implementation.
 *
 * A hook may DECLINE by returning false, which `Close Tab` does when there is
 * no tab to close. That is not the same as being unbound, and both answers
 * matter to the caller: neither one should swallow the keystroke.
 */
export function runDesktopCommand(id: DesktopCommandId): boolean {
  const { hook } = desktopCommand(id)
  if (!hook) return false
  const handler = (globalThis as Record<string, unknown>)[hook]
  if (typeof handler !== 'function') return false
  return (handler as () => unknown)() !== false
}
