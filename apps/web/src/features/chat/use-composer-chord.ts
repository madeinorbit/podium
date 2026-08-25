/**
 * THE FOCUS CHORD (POD-993) — ⌘/ (Ctrl+/ off Mac) puts the caret in the prompt.
 *
 * The composer advertises a chord in its top-right corner while it is unfocused
 * and empty, and a hint that names a chord the app does not implement is worse
 * than no hint, so the chord lives here rather than in the shell's menu wiring:
 * the thing that shows it and the thing that answers it are the same module.
 *
 * WHICH CHORD IT NAMES IS NOT THE SAME EVERYWHERE — see {@link chordLabel}. A
 * native shell has a `Focus Session Prompt` command of its own (⌘L / Ctrl+L),
 * so that is what the hint says there; ⌘/ is what it says in a browser tab,
 * where ⌘L belongs to the address bar.
 *
 * WHY A REGISTRY. A split workspace mounts more than one composer, and each of
 * them would otherwise bind its own window listener and fight over the same
 * keystroke — last-mounted wins, which is arbitrary. One listener serves all of
 * them and resolves the target the way a reader would expect: the composer in
 * the pane you are already in (the one whose subtree holds the focused element),
 * and otherwise the most recently mounted one, which is the pane you last opened.
 */
import { useEffect } from 'react'
import { chordHint, commandShortcutLabel, usesCommandKey } from '@/app/desktop-commands'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'

type Entry = { root: HTMLElement | null; focus: () => void }

const entries: Entry[] = []
let bound = false

/** `⌘/` on Apple hardware, `Ctrl+/` everywhere else — the chord this module
 *  answers itself, in every shell and every browser tab. */
function isChord(e: KeyboardEvent): boolean {
  if (e.key !== '/') return false
  return usesCommandKey() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

/**
 * What the composer's corner advertises — the chord the reader in FRONT of it
 * would actually press, which is not the same chord everywhere.
 *
 * In a NATIVE SHELL it is the `Focus Session Prompt` command: ⌘L on macOS,
 * where the View menu owns the accelerator, and Ctrl+L on Linux and Windows,
 * where `DesktopMenuHost` binds the same command from the keyboard (POD-1532 —
 * before that the command did not exist off macOS, which is why this hint used
 * to fall back to ⌘/ there). It is the chord that also appears in the menu and
 * in command search, so it is the one worth naming.
 *
 * A BROWSER TAB never gets ⌘L — the address bar takes it before the page does,
 * and it is not ours to advertise — so there the hint names the chord this
 * module implements itself. ⌘/ keeps working everywhere regardless; the label
 * just stops leading with it where something better exists.
 */
export function chordLabel(): string {
  if (nativeDesktopBridge()) return commandShortcutLabel('focus-session-prompt') ?? chordHint('/')
  return chordHint('/')
}

/**
 * Surfaces that own their own keyboard and must keep this keystroke.
 *
 * The terminal is the one that matters: Ctrl+/ is Ctrl+_ on the wire, which is
 * readline's undo, and a chord that yanks focus out of a shell mid-command is a
 * chord that loses work. A composer already has the caret when it is focused, so
 * claiming the key from inside another text field would be equally wrong.
 */
function ownsItsKeys(el: Element | null): boolean {
  if (!el) return false
  if (el.closest('.xterm, .term, [data-terminal]')) return true
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return el instanceof HTMLElement && el.isContentEditable
}

function resolve(): Entry | undefined {
  const active = document.activeElement
  // The composer whose subtree holds the focus wins outright — in a split
  // workspace that is the pane the reader is already in.
  const owner = active ? entries.find((entry) => entry.root?.contains(active)) : undefined
  if (owner) return owner
  // Otherwise the chord is only ours if nothing else is holding the keyboard.
  if (ownsItsKeys(active)) return undefined
  return entries[entries.length - 1]
}

function onKeyDown(e: KeyboardEvent): void {
  // Auto-repeat would re-focus (and re-scroll) once a frame while the key is
  // held; the first press has already done the whole job.
  if (e.repeat || !isChord(e)) return
  const target = resolve()
  if (!target) return
  e.preventDefault()
  target.focus()
}

function ensureListener(): void {
  if (bound || typeof window === 'undefined') return
  bound = true
  window.addEventListener('keydown', onKeyDown)
}

function releaseListener(): void {
  if (!bound || entries.length > 0 || typeof window === 'undefined') return
  bound = false
  window.removeEventListener('keydown', onKeyDown)
}

/** Register this composer as a chord target for as long as it is mounted. */
export function useComposerChord(root: HTMLElement | null, focus: () => void): void {
  useEffect(() => {
    ensureListener()
    const entry: Entry = { root, focus }
    entries.push(entry)
    return () => {
      const i = entries.indexOf(entry)
      if (i >= 0) entries.splice(i, 1)
      // The last composer to leave turns the light off: a window listener that
      // outlives every consumer is a leak, and in a shared jsdom window it is
      // one test reaching into the next.
      releaseListener()
    }
  }, [root, focus])
}
