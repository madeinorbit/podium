import type { FullDeck, FullDeckFilter } from '@podium/client-graph/mission-full-deck'
import { observer } from '@podium/client-graph/react'
import { ChevronsDownUp, ChevronsUpDown, Eye, EyeOff, Search, X } from 'lucide-react'
import { useId } from 'react'

const FILTERS: readonly { id: FullDeckFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'needs-you', label: 'Needs you' },
  { id: 'active', label: 'Active' },
  { id: 'up-next', label: 'Up next' },
]

/** Full task filters are independent of the stored spine/Waterfall/Timeline
 * view. Membership, totals, tones and every state transition belong to Full. */
export const FlightDeckFullControls = observer(function FlightDeckFullControls({
  full,
}: {
  full: FullDeck
}) {
  const searchId = useId()
  const ready = full.ready
  const screen = full.screen
  const counts = ready ? full.counts : null
  const folded = ready && full.allFolded
  return (
    <div className="flight-full-controls">
      <div className="flight-full-filter-bar" aria-busy={!ready}>
        <div className="flight-full-filters" role="group" aria-label="Task filters">
          {FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              data-pressable
              className="flight-full-filter"
              aria-pressed={full.filter === id}
              disabled={!ready}
              onClick={() => full.setFilter(id)}
            >
              {label}
              <span
                className="flight-full-filter-count"
                data-tone={id === 'needs-you' && ready ? full.needsYouTone : undefined}
              >
                {counts ? counts[id] : '…'}
              </span>
            </button>
          ))}
        </div>
        <div className="flight-full-tools">
          <button
            type="button"
            data-pressable
            className="flight-full-done-toggle"
            aria-pressed={full.showDone}
            title={full.showDone ? 'Hide done tasks' : 'Show done tasks'}
            disabled={!ready}
            onClick={() => full.toggleShowDone()}
          >
            {full.showDone ? <Eye size={12} aria-hidden /> : <EyeOff size={12} aria-hidden />}
            Done <span className="flight-full-filter-count">{counts ? counts.done : '…'}</span>
          </button>
          <button
            type="button"
            data-pressable
            className="flight-full-tool"
            aria-label="Search this mission"
            title="Search this mission"
            aria-expanded={screen.searchOpen}
            aria-controls={searchId}
            onClick={() => screen.toggleSearch()}
          >
            <Search size={13} aria-hidden />
          </button>
          <button
            type="button"
            data-pressable
            className="flight-full-tool"
            aria-label={folded ? 'Expand every branch' : 'Fold every branch'}
            title={folded ? 'Expand every branch' : 'Fold every branch'}
            disabled={!ready || full.foldableIds.length === 0}
            onClick={() => full.foldAll()}
          >
            {folded ? <ChevronsUpDown size={13} aria-hidden /> : <ChevronsDownUp size={13} aria-hidden />}
          </button>
        </div>
      </div>
      <div id={searchId} hidden={!screen.searchOpen} className="flight-full-search">
        {screen.searchOpen && (
          <>
            <Search size={13} aria-hidden />
            <input
              // biome-ignore lint/a11y/noAutofocus: the field exists only while searching
              autoFocus
              type="text"
              value={screen.query}
              placeholder="Task, session, agent or ref"
              aria-label="Search this mission"
              onChange={(event) => screen.setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  screen.closeSearch()
                }
              }}
            />
            {screen.query && (
              <button
                type="button"
                data-pressable
                className="flight-full-tool"
                aria-label="Clear search"
                onClick={() => screen.setQuery('')}
              >
                <X size={11} aria-hidden />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
})
