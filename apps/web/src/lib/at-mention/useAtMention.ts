import type { KeyboardEvent, RefObject } from 'react'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { type AtOption, type AtTrigger, applyMention, readAtTrigger } from './at-mention'

/**
 * THE @-MENTION PICKER'S STATE (POD-412) — two hooks, mounted by every composer
 * that offers context.
 *
 * Headless on purpose: together they own the trigger, the highlighted row, the
 * keyboard and the edit, and know nothing about what is being mentioned. Each
 * composer supplies its own option sources and renders `AtMentionMenu`.
 *
 * ---------------------------------------------------------------------------
 * WHY TWO HOOKS AND NOT ONE
 * ---------------------------------------------------------------------------
 *
 * The options depend on the query, and the menu's keyboard depends on the
 * options — a single hook would have to return the query and receive the options
 * in the same call, so the options would always be one render stale and the menu
 * would lag a keystroke behind the typing. Split, the composer reads
 * `trigger.query`, builds its rows from it, and hands them straight back:
 *
 *     const trigger = useAtTrigger({ taRef, value, enabled })
 *     const options = […sources keyed on trigger.query…]
 *     const mention = useAtMenu({ trigger, taRef, value, onChange, options })
 *
 * ---------------------------------------------------------------------------
 * THE KEY HANDLER RETURNS A BOOLEAN, AND THAT IS THE WHOLE CONTRACT
 * ---------------------------------------------------------------------------
 *
 * A composer's `onKeyDown` is load-bearing before this hook exists: Enter sends,
 * Shift+Enter breaks a line, and an in-flight IME composition must reach neither.
 * So the hook never wraps that handler — it offers `onKeyDown(e)` which returns
 * TRUE when it consumed the key. The composer calls it first and returns early
 * on true; on false its own handling is untouched, character for character.
 *
 * The menu consumes a key only while it is genuinely open (a trigger AND rows to
 * pick from), and never while `isComposing`: an IME candidate list uses the same
 * arrows and the same Enter, and stealing them there would break the composition
 * rather than the menu.
 */
export interface AtTriggerState {
  /** What is typed after the `@`, or null when no mention is open. Feed it to
   *  the option sources; null means "do not search". */
  readonly query: string | null
  readonly trigger: AtTrigger | null
  /** Re-read the trigger from the textarea. Wire to `onChange` and to `onSelect`
   *  so clicking or arrowing out of a mention closes the menu too. */
  readonly sync: () => void
  /** Dismiss the mention under the caret until the caret leaves it. */
  readonly dismiss: () => void
  /** Close the menu without dismissing anything — the mention is resolved, not
   *  rejected, so a later `@` at the same spot must open normally. */
  readonly close: () => void
}

export interface AtMention {
  readonly open: boolean
  readonly options: readonly AtOption[]
  readonly activeIndex: number
  readonly setActiveIndex: (index: number) => void
  /** True when the key belonged to the menu and the composer must not act on it. */
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
  readonly choose: (option: AtOption) => void
}

/** Phase one: what mention, if any, is being typed. */
export function useAtTrigger({
  taRef,
  enabled = true,
}: {
  taRef: RefObject<HTMLTextAreaElement | null>
  /** False switches the picker off entirely (a disabled composer). */
  enabled?: boolean
}): AtTriggerState {
  const [trigger, setTrigger] = useState<AtTrigger | null>(null)
  // Escape dismisses ONE mention, identified by where its `@` sits. Keeping the
  // position (rather than a bare flag or the query text) is what makes the
  // dismissal survive further typing into the same word and end when the caret
  // leaves it — a flag cleared on the next keystroke never dismissed anything.
  const dismissedAt = useRef<number | null>(null)

  const sync = useCallback(() => {
    const ta = taRef.current
    const found =
      ta && enabled ? readAtTrigger(ta.value, ta.selectionStart ?? ta.value.length) : null
    const next = found && dismissedAt.current !== found.at ? found : null
    if (next) dismissedAt.current = null
    setTrigger(next)
  }, [taRef, enabled])

  const dismiss = useCallback(() => {
    setTrigger((current) => {
      dismissedAt.current = current?.at ?? null
      return null
    })
  }, [])

  const close = useCallback(() => setTrigger(null), [])

  return { query: trigger ? trigger.query : null, trigger, sync, dismiss, close }
}

/** Phase two: the menu over `options` — highlight, keyboard, insertion. */
export function useAtMenu({
  trigger,
  taRef,
  value,
  onChange,
  options,
}: {
  trigger: AtTriggerState
  taRef: RefObject<HTMLTextAreaElement | null>
  value: string
  onChange: (next: string) => void
  /** The rows to offer for the current query, already ranked by the caller. */
  options: readonly AtOption[]
}): AtMention {
  const [activeIndex, setActiveIndex] = useState(0)
  // Where the caret belongs after an insertion. React re-renders the textarea
  // from `value`, which would otherwise leave the caret wherever the DOM put it,
  // so the position is parked here and applied once the new value has painted.
  const pendingCaret = useRef<number | null>(null)

  // Reset the highlight when the QUERY changes, not on every caret nudge:
  // re-ranked rows under an unmoved highlight is how a picker inserts the wrong
  // thing.
  const query = trigger.query
  const lastQuery = useRef(query)
  if (lastQuery.current !== query) {
    lastQuery.current = query
    if (activeIndex !== 0) setActiveIndex(0)
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the render that paints the insertion; the ref is stable
  useLayoutEffect(() => {
    const ta = taRef.current
    const caret = pendingCaret.current
    if (!ta || caret === null) return
    pendingCaret.current = null
    ta.focus()
    ta.setSelectionRange(caret, caret)
    // `value` alone: the ref is stable, and this must run on the render that
    // paints the inserted text.
  }, [value])

  const open = trigger.trigger !== null && options.length > 0
  const active = Math.min(activeIndex, Math.max(0, options.length - 1))

  const choose = useCallback(
    (option: AtOption) => {
      const at = trigger.trigger
      if (!at) return
      const next = applyMention(taRef.current?.value ?? value, at, option.insert)
      pendingCaret.current = next.caret
      trigger.close()
      onChange(next.value)
    },
    [onChange, taRef, trigger, value],
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      // An IME candidate list owns these very keys while it is up. Yield to it
      // before anything else — including Escape, which cancels the candidate.
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false
      if (!open) return false
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault()
          setActiveIndex((i) => (i + 1) % options.length)
          return true
        case 'ArrowUp':
          event.preventDefault()
          setActiveIndex((i) => (i - 1 + options.length) % options.length)
          return true
        case 'Enter':
        case 'Tab': {
          // The menu takes the BARE key only. ⌘/Ctrl+Enter means send and
          // Shift+Enter means newline everywhere in this app, and an open menu
          // is no reason to make either of them unreachable — someone who wants
          // the highlighted row presses Enter or Tab.
          if (event.metaKey || event.ctrlKey || event.shiftKey) return false
          const pick = options[active]
          if (!pick) return false
          event.preventDefault()
          choose(pick)
          return true
        }
        case 'Escape':
          event.preventDefault()
          trigger.dismiss()
          return true
        default:
          return false
      }
    },
    [active, choose, open, options, trigger],
  )

  return { open, options, activeIndex: active, setActiveIndex, onKeyDown, choose }
}
