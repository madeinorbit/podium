/**
 * THE FOCUS CHORD (POD-993) — ⌘/ (Ctrl+/ off Mac) puts the caret in the prompt.
 *
 * The composer advertises this in its top-right corner while it is unfocused and
 * empty, and a hint that names a chord the app does not implement is worse than
 * no hint, so the chord lives here rather than in the shell's menu wiring: the
 * thing that shows it and the thing that answers it are the same module.
 *
 * WHY A REGISTRY. A split workspace mounts more than one composer, and each of
 * them would otherwise bind its own window listener and fight over the same
 * keystroke — last-mounted wins, which is arbitrary. One listener serves all of
 * them and resolves the target the way a reader would expect: the composer in
 * the pane you are already in (the one whose subtree holds the focused element),
 * and otherwise the most recently mounted one, which is the pane you last opened.
 */
import { useEffect } from 'react'

type Entry = { root: HTMLElement | null; focus: () => void }

const entries: Entry[] = []
let bound = false

/** `⌘/` on Apple hardware, `Ctrl+/` everywhere else — matched on the event, and
 *  rendered by {@link chordLabel} so the two can never drift apart. */
function isChord(e: KeyboardEvent): boolean {
  if (e.key !== '/') return false
  return isApple() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

function isApple(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

export function chordLabel(): string {
  return isApple() ? '⌘/' : 'Ctrl /'
}

function resolve(): Entry | undefined {
  if (entries.length <= 1) return entries[0]
  const active = document.activeElement
  const owner = active
    ? entries.find((entry) => entry.root && entry.root.contains(active))
    : undefined
  return owner ?? entries[entries.length - 1]
}

function ensureListener(): void {
  if (bound || typeof window === 'undefined') return
  bound = true
  window.addEventListener('keydown', (e) => {
    if (!isChord(e)) return
    const target = resolve()
    if (!target) return
    e.preventDefault()
    target.focus()
  })
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
    }
  }, [root, focus])
}
