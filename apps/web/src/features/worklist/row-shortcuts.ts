/**
 * ⌘-hold row shortcuts for the work sidebar (POD-790).
 *
 * Hold Command and every task in the column wears the digit that jumps to it;
 * ⌘5 selects the fifth. The numbers are POSITIONAL and momentary on purpose —
 * they are a reading of the list you are already looking at, not an identifier
 * the operator has to learn and not a second name competing with the ID square
 * underneath (which is exactly what the badge covers while it is up).
 *
 * macOS shell only (`isMacNativeShell`). In a browser tab ⌘1…⌘9 belong to the
 * browser's own tab strip and never reach the page, so the hint would promise
 * something the page cannot deliver.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { isMacNativeShell } from '@/lib/nativeDesktop'

/** ⌘1…⌘9. ⌘0 is deliberately absent: it reads as "the tenth" to nobody, and on
 *  macOS the 0 of a ⌘-digit run is conventionally "the last one" — a meaning a
 *  list whose length changes under you cannot honour. */
export const MAX_ROW_SHORTCUTS = 9

type ModifierState = Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

/**
 * Command alone — no Shift, Option or Control riding along.
 *
 * The bare chord is the only one we claim. ⇧⌘, ⌥⌘ and ⌃⌘ digits are the system's
 * and other apps' (⇧⌘3/4/5 are screenshots), and a hint that lit up for them
 * would be inviting the operator to press something we then refuse to handle.
 */
export function isCommandChord(event: ModifierState): boolean {
  return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
}

/**
 * The 1-based row this keystroke asks for, or null.
 *
 * `code` before `key`, because `key` is what the LAYOUT produced: on AZERTY the
 * unshifted digit row types `&é"'(`, so ⌘5 arrives as key `(` and only
 * `code: 'Digit5'` still says which key the operator actually pressed. `key` is
 * kept as the fallback for the numeric keypad, whose codes are `Numpad5`.
 */
export function rowShortcutDigit(
  event: ModifierState & Pick<KeyboardEvent, 'key' | 'code'>,
): number | null {
  if (!isCommandChord(event)) return null
  const fromCode = /^(?:Digit|Numpad)([1-9])$/.exec(event.code)?.[1]
  const digit = Number(fromCode ?? (/^[1-9]$/.test(event.key) ? event.key : Number.NaN))
  return Number.isInteger(digit) ? digit : null
}

/** The digit each row wears, in the order the column renders them. Rows past the
 *  ninth get none — nine is where a positional shortcut stops being faster than
 *  reading the list. */
export function assignRowShortcuts(ids: readonly string[]): ReadonlyMap<string, number> {
  const numbers = new Map<string, number>()
  for (const [index, id] of ids.slice(0, MAX_ROW_SHORTCUTS).entries()) {
    // First occurrence wins: a duplicated id would otherwise move its own badge
    // to the later row while ⌘n still activates the earlier one.
    if (!numbers.has(id)) numbers.set(id, index + 1)
  }
  return numbers
}

const NO_SHORTCUTS: ReadonlyMap<string, number> = new Map()

export interface RowShortcutTarget {
  /** Row identity, only used to hang the badge on the right row. */
  id: string
  /** What ⌘n does — the same thing clicking the row does. */
  activate: () => void
}

/**
 * Register the ⌘-hold behaviour for one ordered list of rows.
 *
 * Exactly one work column is mounted at a time (the wide sidebar or the
 * collapsed rail), so each may call this with its own order without the two
 * ever racing for the same keystroke.
 */
export function useRowShortcuts(targets: readonly RowShortcutTarget[]): {
  /** Row id → digit, and EMPTY unless Command is actually down: a row should
   *  not pay a prop change for a shortcut nobody is looking at. */
  numbers: ReadonlyMap<string, number>
  holding: boolean
} {
  const enabled = isMacNativeShell()
  const [holding, setHolding] = useState(false)
  // The listener is registered once and reads the CURRENT order through a ref.
  // Re-subscribing on every render of a list that re-renders on every clock tick
  // would drop keystrokes in the gap.
  const targetsRef = useRef(targets)
  targetsRef.current = targets

  const release = useCallback(() => setHolding(false), [])

  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent): void => {
      setHolding(isCommandChord(event))
      const digit = rowShortcutDigit(event)
      if (digit === null) return
      const target = targetsRef.current[digit - 1]
      if (!target) return
      // Claimed only when there IS a row to go to. A ⌘7 against six rows stays
      // the system's keystroke rather than being silently swallowed.
      event.preventDefault()
      target.activate()
    }
    // Command's own keyup reports metaKey false, which ends the hold. Releasing
    // a Shift that was riding along reports it true, which restores it — so the
    // badges come back rather than staying dark until Command is re-pressed.
    const onKeyUp = (event: KeyboardEvent): void => setHolding(isCommandChord(event))
    // ⌘Tab away and the keyup lands in the other app: without these the column
    // would still be wearing its digits when the operator comes back.
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', release)
    document.addEventListener('visibilitychange', release)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', release)
      document.removeEventListener('visibilitychange', release)
    }
  }, [enabled, release])

  return {
    numbers: holding ? assignRowShortcuts(targets.map((target) => target.id)) : NO_SHORTCUTS,
    holding,
  }
}
