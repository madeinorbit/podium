import { type RoutedUiState, UI_STATE_KEYS } from '@podium/client-core/ui-state'
import { observer } from 'mobx-react-lite'
import type { JSX } from 'react'
import { useContext, useEffect } from 'react'
import { useRuntimeSelector } from '@/app/store'
import {
  type TipCard,
  useTipAnchorElement,
  useTipAnchorVisible,
  useTipMoment,
} from '@/features/tips'
import { TipContext } from '@/features/tips/tip-context'
import { usePersistedUiState } from '@/lib/use-persisted-ui-state'
import type { RowTone } from './pool-row-data'
import { RowStatusMark, rowToneInk } from './WorkRowShell'

/** A task's sidebar row: WorkRowShell stamps `task-row:<issueId>`, shared with first-offer. */
export const taskRowAnchor = (issueId: string): string => `task-row:${issueId}`
/** The Flight Deck column, or its folded strip: only one is ever mounted. */
export const FLIGHT_DECK_ANCHOR = 'flight-deck'

/**
 * THE TASK THE FIRST COLD-START LAUNCH OPENED (First Flights, moment 2).
 *
 * The composer that launched it unmounts as the task opens, so the trigger
 * outlives it in the account's UI state: a reload or a closed tab before the
 * tip had its quiet beat still delivers it. Cleared once the moment is seen.
 */
export function noteFirstSend(ui: Pick<RoutedUiState, 'set'>, issueId: string): void {
  ui.set(UI_STATE_KEYS.tipsFirstSend, issueId)
}

const parseIssueId = (raw: string | null): string | null => raw || null
const serializeIssueId = (issueId: string | null): string | null => issueId

/** Line 2's real voice for each state the legend names. */
const LEGEND: readonly { tone: RowTone; word: string; weight: string }[] = [
  { tone: 'needs', word: 'Waiting on you', weight: 'font-semibold' },
  { tone: 'working', word: 'Working', weight: 'font-medium' },
  { tone: 'done', word: 'Done', weight: 'font-normal' },
]

function StateWordLegend(): JSX.Element {
  return (
    <ul className="flex flex-col gap-1.5" aria-label="State words">
      {LEGEND.map(({ tone, word, weight }) => (
        <li key={tone} className="shell-work-row-status flex items-center gap-[7px]">
          <RowStatusMark tone={tone} />
          <span className={weight} style={{ color: rowToneInk(tone) }}>
            {word}
          </span>
        </li>
      ))}
    </ul>
  )
}

export const firstSendCards = (issueId: string): readonly TipCard[] => [
  {
    anchor: taskRowAnchor(issueId),
    title: 'Your list.',
    body: 'Every task you start lands here. Drag to sort. The colored words show what needs you.',
    extra: <StateWordLegend />,
  },
  {
    anchor: FLIGHT_DECK_ANCHOR,
    title: 'The flight deck.',
    body: 'Watch your agents work. One agent for small tasks, the whole plan for big ones.',
  },
]

/** Registers the moment for the shell's lifetime so the guide can replay it. */
export const FirstSendTip = observer(function FirstSendTip(): null {
  const [issueId, setIssueId] = usePersistedUiState(
    UI_STATE_KEYS.tipsFirstSend,
    parseIssueId,
    serializeIssueId,
  )
  const selectedId = useRuntimeSelector((s) => s.selectedIssueId)
  const log = useContext(TipContext)?.log
  const seen = log?.ready === true && log.isSeen('first-send')
  // Finished, dismissed or skipped: nothing is left to deliver.
  useEffect(() => {
    if (seen && issueId !== null) setIssueId(null)
  }, [seen, issueId, setIssueId])
  // The launch can open the task before its sidebar row is drawn or on screen,
  // and the engine skips a missing anchor. Waiting for the row makes its
  // arrival the activation, however late it comes.
  const launched = issueId !== null && selectedId === issueId && !seen
  const row = useTipAnchorElement(launched ? taskRowAnchor(issueId) : null)
  const rowVisible = useTipAnchorVisible(row)
  // A replay from the guide points at whichever task is open now.
  const rowId = issueId ?? selectedId
  useTipMoment('first-send', {
    active: launched && rowVisible,
    cards: rowId ? firstSendCards(rowId) : [],
  })
  return null
})
