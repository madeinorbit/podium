import type { ChatRow, ChatVerbosity } from '@podium/client-core/viewmodels'
import { CHAT_VERBOSITIES, chatVerbosityHint } from '@podium/client-core/viewmodels'
import { ScrollText, Search } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Minimap } from './Minimap'
import { type TodoProgress, TodoRailChip } from './TodoBridge'
import { VerbosityControl } from './VerbosityControl'

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
 *   todos    a live `4/7` — present ONLY while the issue has a plan, and the
 *            single most useful thing a reader can learn about a running session
 *   find     ⌘F's affordance, so the shortcut is discoverable without a field
 *   density  summary / normal / verbose, at rest as three bars you can read
 *            without opening anything
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
  verbosity,
  onVerbosityChange,
  verbosityOverridden,
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
  verbosity: ChatVerbosity
  onVerbosityChange: (v: ChatVerbosity) => void
  /** A query is overriding a `summary` setting — the rail says so at rest. */
  verbosityOverridden: boolean
  /** Null when this session has no issue or the issue published no todos. */
  todos: TodoProgress | null
  onFind: () => void
  findOpen: boolean
  /** The agent's latest prose — what tl;dr summarises, and the button's gate. */
  lastAnswerText: string
  onTldr: () => void
}): JSX.Element {
  const [densityOpen, setDensityOpen] = useState(false)
  const densityRef = useRef<HTMLDivElement | null>(null)

  // Close on Esc or on a click anywhere else. A weekly control does not deserve
  // a modal, and it must never be the reason a click into the transcript is lost
  // (pointerdown listens in the CAPTURE phase but does not swallow the event).
  useEffect(() => {
    if (!densityOpen) return
    const onDown = (e: PointerEvent): void => {
      if (!densityRef.current?.contains(e.target as Node)) setDensityOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDensityOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [densityOpen])

  const level = CHAT_VERBOSITIES.indexOf(verbosity)

  return (
    <div className="chat-rail">
      <div className="chat-rail-head">
        {todos && <TodoRailChip todos={todos} />}
        <button
          data-pressable
          type="button"
          className={cn('chat-rail-btn', findOpen && 'chat-rail-btn--on')}
          title="Find in transcript (⌘F)"
          aria-label="Find in transcript"
          aria-pressed={findOpen}
          onClick={onFind}
        >
          <Search size={12} aria-hidden="true" />
        </button>
        {/* Density at rest is three bars, filled to the current level — the same
            "ordering IS the affordance" idea as the strip inside, drawn small
            enough to live in a 24px column. The words are one click away. */}
        <div className="chat-rail-density" ref={densityRef}>
          <button
            data-pressable
            type="button"
            className={cn('chat-rail-btn', densityOpen && 'chat-rail-btn--on')}
            data-overridden={verbosityOverridden ? 'true' : undefined}
            aria-haspopup="true"
            aria-expanded={densityOpen}
            aria-label={`Transcript detail: ${verbosity}`}
            title={
              verbosityOverridden
                ? 'Showing everything while you search — your Summary setting resumes when you clear the query'
                : `Transcript detail — ${chatVerbosityHint(verbosity)}`
            }
            onClick={() => setDensityOpen((o) => !o)}
          >
            <span className="chat-rail-bars" aria-hidden="true">
              {CHAT_VERBOSITIES.map((v, i) => (
                <span key={v} className={cn('chat-rail-bar', i <= level && 'chat-rail-bar--on')} />
              ))}
            </span>
          </button>
          {densityOpen && (
            <div className="chat-rail-pop">
              <span className="chat-rail-pop-title">Transcript detail</span>
              <VerbosityControl
                value={verbosity}
                onChange={(v) => {
                  onVerbosityChange(v)
                  setDensityOpen(false)
                }}
                overridden={verbosityOverridden}
              />
              <span className="chat-rail-pop-hint">{chatVerbosityHint(verbosity)}</span>
            </div>
          )}
        </div>
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
