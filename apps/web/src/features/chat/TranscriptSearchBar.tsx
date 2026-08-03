import type { TranscriptSearchState } from '@podium/client-core/viewmodels'
import { ChevronDown, ChevronUp, ScrollText } from 'lucide-react'
import type { JSX } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * TRANSCRIPT SEARCH + tl;dr (POD-405) — the chat header, hidden in the narrow
 * dock (engraved-column.md §2.5: bar → feed → composer, no extra chrome).
 *
 * It renders a derived {@link TranscriptSearchState} and reports cursor moves.
 * It computes nothing: which blocks match, which row renders the active match,
 * and the 1-based position beside the count all come from the chat slice, so the
 * minimap, the scroll jump and this counter can never disagree about what "match
 * 3 of 7" means.
 */
export function TranscriptSearchBar({
  query,
  onQueryChange,
  search,
  onCursorMove,
  lastAnswerText,
  onTldr,
}: {
  query: string
  onQueryChange: (query: string) => void
  search: TranscriptSearchState
  /** Step the match cursor by ±1; the slice wraps it against the match count. */
  onCursorMove: (delta: number) => void
  /** The agent's latest prose — what tl;dr summarises, and the button's gate. */
  lastAnswerText: string
  onTldr: () => void
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5">
      <Input
        type="text"
        placeholder="Search transcript…"
        className="h-auto flex-1 rounded-md bg-background px-2.5 py-1 text-xs text-foreground"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />
      {query && (
        <span className="inline-flex items-center gap-0.5 whitespace-nowrap text-[11px] text-muted-foreground">
          {search.total === 0 ? '0' : `${search.position}/${search.total}`}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title="Previous match"
            className="size-auto rounded-none p-0.5 text-muted-foreground hover:bg-transparent hover:text-foreground"
            onClick={() => onCursorMove(-1)}
          >
            <ChevronUp size={13} aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title="Next match"
            className="size-auto rounded-none p-0.5 text-muted-foreground hover:bg-transparent hover:text-foreground"
            onClick={() => onCursorMove(1)}
          >
            <ChevronDown size={13} aria-hidden="true" />
          </Button>
        </span>
      )}
      {/* tl;dr — open this session's BTW superagent thread and ask for a concise
          summary of the agent's last answer (seeded with the answer + context). */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-auto flex-none gap-1 px-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground"
        title="tl;dr — summarize the last answer via the superagent"
        disabled={!lastAnswerText}
        onClick={onTldr}
      >
        <ScrollText size={13} aria-hidden="true" /> tl;dr
      </Button>
    </div>
  )
}
