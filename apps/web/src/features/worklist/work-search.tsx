/**
 * THE FILTER FIELD, ITS CHORD, AND THE TWO THINGS AN EMPTY RESULT HAS TO SAY
 * (POD-1078, the 3b sidebar).
 *
 * A 30px well between the new-task row and the list: search glyph, the field, and a
 * mono counter holding the right end. The counter is the whole affordance — it
 * reads `⌘F` while the field is empty, so the shortcut is advertised by the
 * thing it focuses rather than by a tooltip nobody opens, and it flips to
 * `hits/total` the moment there is a query, which is the one number you want
 * while typing.
 *
 * IT FILTERS, IT DOES NOT SEARCH. ⌘K already searches the product and takes the
 * screen to do it. This narrows the column you are looking at, in place, and
 * leaves the rest of the app alone — which is why it lives in the column's own
 * chrome instead of behind a modal.
 */

import type { UnifiedWorkRow } from '@podium/client-core/viewmodels'
import { Search, X } from 'lucide-react'
import type { JSX, ReactNode, RefObject } from 'react'
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { indexWorkRows, matchesIndexedWorkQuery, normalizeWorkQuery } from './work-filter'

export type WorkFilter = {
  /** The raw field value — what the input shows, untrimmed. */
  query: string
  setQuery: (query: string) => void
  /** The query used by counts and the row tree after React yields to it. */
  deferredQuery: string
  /** True once the query is more than whitespace: the list is being narrowed. */
  filtering: boolean
  /** Live rows in the column (pinned + every project group's open rows). */
  total: number
  /** How many of those survive the query. Equals `total` when not filtering. */
  hits: number
  inputRef: RefObject<HTMLInputElement | null>
}

/**
 * The filter's state, its counts, and the ⌘F chord.
 *
 * ⌘F IS TAKEN FROM THE BROWSER, deliberately and unconditionally — unlike ⌘N
 * (`new-task.ts`), which is gated on the native shell because a browser tab never
 * hands it over. ⌘F it does hand over, and find-in-page is close to useless
 * against this app anyway: the column is windowed and the panes are canvases, so
 * the browser's own find searches a fraction of what is on screen while this
 * searches every row the column holds.
 *
 * IT IS THE ONLY BINDING, and has to stay that way. The transcript's find bar
 * held ⌘F too until POD-1093; both listened on `window`, so a press did both
 * things and the bar — which focuses itself on mount — took the caret this field
 * had just been handed. Transcript find opens from the chat rail's button now.
 * Anything else that wants ⌘F takes it from here, it does not share it.
 *
 * The counts are taken from the PUBLISHED rows rather than from the animating
 * list, so a row on its way out cannot make the counter disagree with itself
 * mid-exit. For the ~0.7s of an exit the list can hold one row the count has
 * already dropped; the settled number is the honest one.
 */
export function useWorkFilter(rows: readonly UnifiedWorkRow[], now: number): WorkFilter {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 'f') return
      const input = inputRef.current
      if (!input) return
      event.preventDefault()
      input.focus()
      // Select rather than append: ⌘F on a field that already holds a query is
      // "search for something else", and typing should replace it.
      input.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const filtering = normalizeWorkQuery(query).length > 0
  const normalizedDeferredQuery = useMemo(() => normalizeWorkQuery(deferredQuery), [deferredQuery])
  const searchIndex = useMemo(() => indexWorkRows(rows, now), [rows, now])
  const hits = useMemo(
    () =>
      normalizedDeferredQuery
        ? rows.filter((row) => matchesIndexedWorkQuery(searchIndex, row, normalizedDeferredQuery))
            .length
        : rows.length,
    [normalizedDeferredQuery, rows, searchIndex],
  )
  return { query, setQuery, deferredQuery, filtering, total: rows.length, hits, inputRef }
}

/** The field itself. `flex-none`, above the scroller: filtering the list must
 *  never move the control you are filtering it with.
 *
 *  IT IS A LINE, NOT A FIELD (POD-1469). `trailing` puts `Add repository` on the
 *  same row: the field takes the slack (`min-w-0 flex-1`) and the button never
 *  does, so squeezing the column narrows the thing that degrades gracefully. */
export function WorkSearchField({
  filter,
  trailing,
}: {
  filter: WorkFilter
  trailing?: ReactNode
}): JSX.Element {
  const { query, setQuery, filtering, hits, total, inputRef } = filter
  return (
    <div className="mx-2.5 mt-2 mb-[9px] flex flex-none items-center gap-2">
      <div
        data-testid="work-search"
        className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[7px] border border-input bg-background px-[9px] focus-within:ring-2 focus-within:ring-ring/40"
      >
        <Search size={14} className="flex-none text-text-faint" aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Escape clears, and only clears: the field keeps focus so the next
            // query starts where the last one did. It stops here so the key does
            // not also reach whatever else on this screen listens for it.
            if (event.key === 'Escape' && query) {
              event.stopPropagation()
              setQuery('')
            }
          }}
          spellCheck={false}
          placeholder="Filter tasks"
          aria-label="Filter tasks"
          data-testid="work-search-input"
          className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-text-faint"
        />
        {filtering && (
          <button
            data-pressable
            type="button"
            aria-label="Clear filter"
            title="Clear filter"
            data-testid="work-search-clear"
            className="flex size-4 flex-none items-center justify-center rounded-sm text-text-faint hover:bg-accent hover:text-foreground"
            onClick={() => {
              setQuery('')
              inputRef.current?.focus()
            }}
          >
            <X size={10} aria-hidden="true" />
          </button>
        )}
        {/* The chord hint and the result count are ONE slot, because they are the
            same fact at two moments: what the field can do, then what it did. */}
        <span
          className="shell-type-micro mono-timer flex-none text-text-faint"
          data-testid="work-search-count"
        >
          {filtering ? `${hits}/${total}` : '⌘F'}
        </span>
      </div>
      {trailing}
    </div>
  )
}

/** Nothing matched. Two lines, centred, in the list's own voice — a mono label
 *  for the machine's answer and one plain sentence under it. */
export function WorkFilterEmpty(): JSX.Element {
  return (
    <div
      data-testid="work-filter-empty"
      className="flex flex-none flex-col items-center gap-1.5 px-5 py-[46px]"
    >
      <span className="font-mono text-[11px] text-text-faint">no matches</span>
      <span className="text-center text-[11.5px]/[1.5] text-muted-foreground">
        Nothing here matches that filter.
      </span>
    </div>
  )
}

/** The footnote under a filtered list: how big the haystack was. It answers the
 *  question a short list raises — "is that everything, or is this filtered?" —
 *  at the end of the list, where that question actually occurs. */
export function WorkFilterFootnote({ total }: { total: number }): JSX.Element {
  return (
    <div
      data-testid="work-filter-footnote"
      className="flex flex-none items-center gap-[9px] px-[13px] pt-4"
    >
      <span className="font-mono text-[10px] text-muted-foreground">
        searching {total} {total === 1 ? 'task' : 'tasks'}
      </span>
      <span className="h-px flex-1 bg-hairline-soft" aria-hidden="true" />
    </div>
  )
}
