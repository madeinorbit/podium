import type { ChatRow } from '@podium/client-core/viewmodels'
import { ScrollText, Search } from 'lucide-react'
import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import { Minimap } from './Minimap'
import { type TodoProgress, TodoRailChip } from './TodoBridge'

/**
 * THE READING RAIL (POD-413) — the chat's chrome, moved out of the reading line.
 *
 * WHAT THIS REPLACES. A full-width row sat above every conversation carrying a
 * search field, a density strip and a tl;dr button. The charge against it was
 * the search field's rent, but the row itself was the cost: a permanent
 * horizontal band is subtracted from the transcript on every session, forever,
 * whether or not anything in it is wanted. The obvious fix — a SMALLER
 * permanent row — is the same mistake in a thinner box.
 *
 * So the row is gone and its contents moved into the column that was already
 * there. The minimap's gutter is permanent, full-height, and until now spent
 * entirely on an unlabelled barcode; widening it from 14px to 24px buys back a
 * whole row of vertical space and gives the column a reason to exist. This is
 * the "spend the column on something that earns it" outcome the brief allows —
 * except the map earns its place too now (see Minimap.tsx), so we keep both.
 *
 * WHAT IS ALLOWED IN HERE. Orientation and reading, nothing else:
 *
 *   find     the only way into transcript search now that ⌘F filters the
 *            sidebar (POD-1093), which is why it leads the column
 *   tl;dr    summarise the last answer through the superagent
 *   the map  where you are, what is around you, and where the matches are
 *
 * Everything above the map is `flex-none` and the map takes the remainder, so a
 * short pane loses map, not controls. Absent entirely in the narrow superagent
 * dock, where the rail has nowhere to stand (engraved-column.md §2.5).
 */
export function ChatRail({
  rows,
  scrollerRef,
  matches,
  activeMatch,
  todos,
  onFind,
  findOpen,
  lastAnswerText,
  onTldr,
}: {
  rows: ChatRow[]
  scrollerRef: React.RefObject<HTMLDivElement | null>
  matches: readonly number[]
  activeMatch: number | undefined
  /** Null when this session has no issue or the issue published no todos. */
  todos: TodoProgress | null
  onFind: () => void
  findOpen: boolean
  /** The agent's latest prose — what tl;dr summarises, and the button's gate. */
  lastAnswerText: string
  onTldr: () => void
}): JSX.Element {
  return (
    <div className="chat-rail">
      <div className="chat-rail-head">
        <button
          data-pressable
          type="button"
          className={cn('chat-rail-btn', findOpen && 'chat-rail-btn--on')}
          title="Find in transcript"
          aria-label="Find in transcript"
          aria-pressed={findOpen}
          onClick={onFind}
        >
          <Search size={12} aria-hidden="true" />
        </button>
        {/* tl;dr — open this session's BTW superagent thread and ask for a concise
            summary of the agent's last answer (seeded with the answer + context). */}
        <button
          data-pressable
          type="button"
          className="chat-rail-btn"
          title="tl;dr — summarize the last answer via the superagent"
          aria-label="Summarize the last answer"
          disabled={!lastAnswerText}
          onClick={onTldr}
        >
          <ScrollText size={12} aria-hidden="true" />
        </button>
      </div>
      <Minimap rows={rows} scrollerRef={scrollerRef} matches={matches} activeMatch={activeMatch} />
    </div>
  )
}
