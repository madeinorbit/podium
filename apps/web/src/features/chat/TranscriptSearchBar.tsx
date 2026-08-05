import type { TranscriptSearchState } from '@podium/client-core/viewmodels'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'

/**
 * FIND IN TRANSCRIPT (POD-413) — the same search, no longer a permanent row.
 *
 * This control used to own a full-width strip above EVERY conversation, for a
 * thing most sessions never do. Nothing about the search itself was wrong: the
 * match cursor, the honest n/m over a still-deepening window, and the map marks
 * are ahead of every product we compared. What was wrong was the rent. So this
 * is a RE-HOUSING, not a removal — ⌘F / Ctrl-F opens it, Esc closes it, and it
 * floats over the top of the feed the way find has worked in every browser and
 * editor for twenty years.
 *
 * It still renders a derived {@link TranscriptSearchState} and reports cursor
 * moves. It computes nothing: which blocks match, which row renders the active
 * match, and the 1-based position beside the count all come from the chat slice,
 * so the map, the scroll jump and this counter can never disagree about what
 * "match 3 of 7" means.
 */
export function TranscriptSearchBar({
  query,
  onQueryChange,
  search,
  onCursorMove,
  deepeningSearch = false,
  onClose,
}: {
  query: string
  onQueryChange: (query: string) => void
  search: TranscriptSearchState
  /** Step the match cursor by ±1; the slice wraps it against the match count. */
  onCursorMove: (delta: number) => void
  /** The loaded window is still being deepened for this query, so the count is a
   *  floor rather than the final answer — shown as a trailing ellipsis. */
  deepeningSearch?: boolean
  /** Esc, the ✕, or a second ⌘F on an empty query. Clearing is the host's job. */
  onClose: () => void
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Opening the bar IS the request to type in it. A re-open over a surviving
  // query selects it, so the next keystroke replaces rather than appends.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [])

  return (
    <div className="chat-find">
      <input
        ref={inputRef}
        type="text"
        placeholder="Find in transcript…"
        aria-label="Find in transcript"
        className="chat-find-input"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          // Enter walks the matches (Shift walks back) and Esc gives the
          // transcript back — the two keys a reader already has in muscle memory.
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          } else if (e.key === 'Enter') {
            e.preventDefault()
            onCursorMove(e.shiftKey ? -1 : 1)
          }
        }}
      />
      <span
        className="chat-find-count"
        title={
          deepeningSearch ? 'Still loading earlier messages — more matches may appear' : undefined
        }
      >
        {/* Matching is scoped to the LOADED transcript, so while the window is
            still deepening the count is a floor. The ellipsis says so without
            stealing the counter's width. */}
        {query === '' ? '' : search.total === 0 ? 'none' : `${search.position}/${search.total}`}
        {query !== '' && deepeningSearch && <span aria-hidden="true">…</span>}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        title="Previous match (Shift+Enter)"
        className="chat-find-step"
        disabled={search.total === 0}
        onClick={() => onCursorMove(-1)}
      >
        <ChevronUp size={13} aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        title="Next match (Enter)"
        className="chat-find-step"
        disabled={search.total === 0}
        onClick={() => onCursorMove(1)}
      >
        <ChevronDown size={13} aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        title="Close find (Esc)"
        className="chat-find-step"
        onClick={onClose}
      >
        <X size={13} aria-hidden="true" />
      </Button>
    </div>
  )
}
