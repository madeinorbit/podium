import type { JSX } from 'react'
import { useSyncExternalStore } from 'react'
import { useRuntimeSelector } from '@/app/store'
import { type TipCard, useTipMoment } from '@/features/tips'
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
 * outlives it here. Kept for the page's lifetime: a reload before the tip had
 * its quiet beat loses it, which costs one tip and never shows a wrong one.
 */
let firstSendIssueId: string | null = null
const listeners = new Set<() => void>()

export function noteFirstSend(issueId: string): void {
  if (firstSendIssueId === issueId) return
  firstSendIssueId = issueId
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const readFirstSend = (): string | null => firstSendIssueId

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
export function FirstSendTip(): null {
  const issueId = useSyncExternalStore(subscribe, readFirstSend, readFirstSend)
  const selectedId = useRuntimeSelector((s) => s.selectedIssueId)
  // A replay from the guide points at whichever task is open now.
  const rowId = issueId ?? selectedId
  useTipMoment('first-send', {
    active: issueId !== null && selectedId === issueId,
    cards: rowId ? firstSendCards(rowId) : [],
  })
  return null
}
