import type { SessionModel } from '@podium/client-graph/models'
import type { SessionView } from '@podium/client-core/session-values'
import {
  type FlightDeckFoldMap,
  type FlightDeckFoldState,
  type FlightDeckRow,
  flightDeckRowDefaultFolded,
  flightDeckRowHasPayload,
  flightDeckRowIsFolded,
  type IssueNote,
  issueOwnContentUnread,
  nativeSubagentRows,
  type PresenceNote,
  readFlightDeckFolds,
  sessionUnreadEmphasized,
  subtreeUnread,
  writeFlightDeckFolds,
} from '@podium/client-core/values'
import type { JSX, ReactNode, RefObject } from 'react'
import { useLayoutEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { sessionDisplayName } from '@/lib/WorkerLabel'
import {
  type DeckWindowRow,
  DeckRowPlaceholder,
  useFlightDeckWindow,
} from './flight-deck-window'

const SPINE_PAD = 8
export const DEPTH_STEP = 16
/** Where a nesting level's rail sits inside its own step. Also the inset of a
 *  task's agent rail inside its own band, because they are the same line. */
export const RAIL_INSET = 8
/** Where a depth-1 strip's band begins — the left edge everything in the column
 *  that is not the spine itself aligns to, so the rail runs in a clear gutter. */
export const GUTTER = SPINE_PAD + DEPTH_STEP
/**
 * The trailing column every row parks its state in, so the whole mission scans
 * as one vertical read. Task strips take its fixed 80px measure. Agent rows use
 * that as a minimum and let a longer obligation size itself, because a complete
 * `Needs you · 30m ago` is more valuable than false column rigidity.
 *
 * The width lives in CSS (`--deck-state-col` / `.deck-state-col`), where the
 * agent grid can reinterpret it at its narrow composition. `DECK_LABEL` has two
 * eleven-character values (`Standing by`, `Not started`) and 70 held neither;
 * the departure ticks were already 80 (70px of text plus a 5px dot and its
 * gap), so the shared floor stays 80.
 */
export const STATE_COL = 'deck-state-col'

/**
 * THE FOLD IS THREE-VALUED (POD-710).
 *
 * A single `collapsed` set could only say "the operator folded this"; everything
 * else was open, which is the wrong default for the commonest strip in the
 * column — a task carrying exactly one agent and nothing else. Its fold buys the
 * operator nothing (the strip already names the one session under it) and costs
 * a row of the spine, so it wants to arrive closed. A task with real structure
 * under it wants to arrive open.
 *
 * Neither of those is a decision the operator made, so neither may be stored as
 * one: the map holds only EXPLICIT folds, and a task the operator never touched
 * falls through to {@link defaultFolded}. That is what lets the rule change later
 * without rewriting everyone's saved state, and what stops "fold everything" and
 * "I closed this one" from being the same fact.
 */
export type FoldState = FlightDeckFoldState
export type FoldMap = FlightDeckFoldMap
export const readFolds = readFlightDeckFolds
export const writeFolds = writeFlightDeckFolds
/** Whether a task has anything to fold at all. A payload-less strip draws no
 *  chevron and never enters the fold map. */
export function hasPayload(row: Pick<FlightDeckRow, 'descendantIds' | 'sessions'>): boolean {
  return flightDeckRowHasPayload(row)
}

/**
 * The default when the operator has said nothing: a task whose ENTIRE payload is
 * one session and no sub-tasks arrives closed, everything else with a payload
 * arrives open. Folding the one-session task hides a row that only restates the
 * strip; folding a branch hides work.
 */
export function defaultFolded(row: Pick<FlightDeckRow, 'descendantIds' | 'sessions'>): boolean {
  return flightDeckRowDefaultFolded(row)
}

/** The effective fold: an explicit value wins, else the default rule. */
export const isFolded = flightDeckRowIsFolded

/**
 * Unread for a task strip. Working agents suppress the mark (the spinner
 * already says "live"). A collapsed strip — including the default one-agent
 * fold — rolls up hidden sessions and descendant issues against THIS issue's
 * readAt. An expanded strip only marks issue-level activity; sessions and
 * children speak for themselves.
 */
export function deckTaskUnread(
  row: Pick<FlightDeckRow, 'issue' | 'workingAgentCount' | 'descendantIds' | 'collapsedSummary'>,
  collapsed: boolean,
  descendants: ReadonlyMap<string, { updatedAt: string }> | string,
): boolean {
  if (row.workingAgentCount > 0) return false
  if (!collapsed) return issueOwnContentUnread(row.issue)
  return subtreeUnread({
    readAt: row.issue.readAt,
    updatedAt: row.issue.updatedAt,
    descendantUpdatedAts: typeof descendants === 'string' ? [descendants] : row.descendantIds.flatMap(id => { const child = descendants.get(id); return child ? [child.updatedAt] : [] }),
    sessions: row.collapsedSummary.crew,
  })
}

export function sessionSearchText(session: SessionView): string {
  const facts = session as SessionModel
  const retired = !facts.open
  const needs = !retired && facts.attention
  return [
    session.handoffTarget ? `Handing over → ${session.handoffTarget}` : sessionDisplayName(session),
    session.displayRef,
    sessionUnreadEmphasized(session) ? 'unread' : null,
    retired ? 'Retired' : needs ? 'Needs you' : null,
    session.status === 'starting' || session.status === 'reconnecting' ? 'Starting' : null,
    ...nativeSubagentRows(session).map((agent) =>
      [
        agent.type,
        agent.anonymous ? null : agent.id.slice(0, 8),
        'native',
        agent.working ? 'working' : 'waiting',
      ]
        .filter(Boolean)
        .join(' '),
    ),
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * ONE fact about the ISSUE, in the issue's own visual area (round 3 §5, §6).
 *
 * The operator's complaint was positional, not informational: "Discovered from
 * POD-516" hanging under the agent rows read as another agent. On the strip it
 * reads as what it is — a property of the task, beside the task's own name. It
 * prints the REF (the thing you can go and act on) and keeps the sentence on the
 * hover title, which is the only way it fits at the column's narrowest.
 */
export function IssueNoteChip({ note }: { note: IssueNote }): JSX.Element {
  // BLOCKED AND WAITING TAKE THE ATTENTION INK AND A WARM RIM; provenance stays
  // neutral. Those two are the ones that STOP work — they are the reason the
  // operator is looking — where "discovered from" and "continued in" are facts
  // about the task's shape that nothing hangs on.
  const stopping = note.kind === 'blocked' || note.kind === 'waiting'
  return (
    <span
      className={cn(
        // WRITTEN OUT, NOT DRAWN. The chip used to be a glyph and a ref, and a
        // `↳` cannot say *spun off from*: the difference between "this came
        // from POD-775", "this is blocked by POD-869" and "this continued in
        // POD-1037" is exactly what the operator needs off one glance. So the
        // relation prints in 8px mono caps and the ref follows in the row's own
        // micro mono, with the whole sentence still on the hover title.
        //
        // RIGID, WITH A CEILING. The title is the only shrinker on a strip, so
        // the chip never gives ground to it — it either fits or it DROPS whole
        // (`.deck-drop-relation`, at the strip's own 370px rung). The ceiling is
        // what keeps a long relation from eating the title before that: past
        // 168px the ref inside truncates rather than the chip growing.
        'deck-drop-relation flex h-[17px] max-w-[10.5rem] flex-none items-center gap-1.5 rounded-[4px] border px-1.5',
        stopping ? 'border-attention/40 text-attention' : 'border-hairline-bar text-text-dim',
      )}
      data-testid="flight-issue-note"
      data-note={note.kind}
      title={note.full}
      role="img"
      aria-label={note.full}
    >
      {note.label && (
        <span
          className={cn(
            'flex-none font-mono text-[8px] leading-none font-semibold tracking-[0.11em] uppercase',
            stopping ? 'text-attention' : 'text-text-faint',
          )}
        >
          {note.label}
        </span>
      )}
      <span className="shell-type-micro min-w-0 truncate font-mono">{note.short}</span>
    </span>
  )
}

/**
 * THE EMPTY SEAT — a dotted chip in the strip's own chip slot (POD-758).
 *
 * It used to be a full row hung under the task, holding exactly the space a
 * session would occupy. That space taught where you would click, and cost a row
 * of the spine on every unstaffed task to teach it. The seat is a chip now, in
 * the slot where a staffed task shows its crew: "nobody is here" is read
 * exactly where somebody would be, which is the same lesson in no rows at all.
 *
 * DOTTED, NEVER DASHED. One rim style, reserved for one meaning across the
 * whole spine — a session belongs here and there is not one. Dashed is used
 * nowhere in this column, so the two can never be confused.
 *
 * Only the two arms that are genuinely a held seat get one. `done` and `review`
 * are settled, `moved` and `blocked` already name themselves on the strip, and
 * a proposal holds no seat at all — nobody has accepted it, so there is nothing
 * yet to hold space for.
 */
export function SeatChip({ note }: { note: PresenceNote }): JSX.Element {
  return (
    <span
      className={cn(
        'shell-type-micro flex flex-none items-center gap-1 border border-dotted px-1.5 py-px font-mono',
        note.attention
          ? 'border-attention/60 font-semibold text-attention'
          : 'border-border-strong text-text-faint',
      )}
      data-presence={note.kind}
      data-testid="flight-reserved-slot"
      title={note.text}
    >
      {note.attention ? 'no agent' : 'seat open'}
    </span>
  )
}

/** Which presence notes are a HELD SEAT rather than a settled fact. Everything
 *  else the strip already says in its state column or its relation chip, and
 *  saying it twice is what made the old seat read as an agent. */
export const seatFor = (note: PresenceNote | null): PresenceNote | null =>
  note && (note.kind === 'ready' || note.kind === 'attention') ? note : null

/** Flat tails use the same measured window as the spine. An unbounded proposal
 * or archived tail would defeat the mount budget even while it is offscreen. */
export function DeckFlatRows({
  rows,
  scrollRef,
  scope,
  className,
  gap,
  revealSessionId,
  children,
}: {
  rows: DeckWindowRow[]
  scrollRef: RefObject<HTMLElement | null>
  scope: string
  className: string
  gap: number
  revealSessionId?: string | null
  children: (index: number) => ReactNode
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const window = useFlightDeckWindow(rows, scrollRef, ref, scope)
  useLayoutEffect(() => {
    if (!revealSessionId || !window.enabled) return
    const target = rows.find((row) => row.key.endsWith(`:${revealSessionId}`))
    if (target && !window.contains(target.key)) window.reveal(target.key)
  }, [revealSessionId, rows, window])
  return (
    <div ref={ref} className={className} style={window.enabled ? { gap: 0 } : undefined}>
      {rows.map((row, index) =>
        window.enabled ? (
          window.contains(row.key) ? (
            <div key={row.key} ref={window.measure(row.key)} style={{ paddingBottom: gap }}>
              {children(index)}
            </div>
          ) : (
            <DeckRowPlaceholder key={row.key} row={row} window={window} />
          )
        ) : (
          children(index)
        ),
      )}
    </div>
  )
}
