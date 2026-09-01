/**
 * WHAT THIS TASK COST — the section body, shared by the explorer's task detail
 * panel and the task detail page (POD-1859, reused by POD-1860).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS SECTION EXISTS AT ALL
 * ─────────────────────────────────────────────────────────────────────────────
 * The roster above it lists OPEN sessions, by design — it answers "who is on
 * this now". On a finished task that is nobody, and on a long one it is two
 * agents out of ten. This section is not a summary of that list. It is the
 * accounting for the sessions that list will never show, and its disclosure is
 * the only place in the app that names every session that ever ran on a task.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FOUR STATES, AND ONLY ONE OF THEM IS A NUMBER
 * ─────────────────────────────────────────────────────────────────────────────
 * `no-sessions` and `not-recorded` are WORDS, because they are facts about the
 * work and about the transcripts respectively — neither is a fact about money,
 * and both collapse to a confident `$0.00` if you let them. That zero is the
 * sharpest way this feature can lie: POD-1608 changed 126 files and truthfully
 * cost this task nothing, because the agent that did the work was bound
 * elsewhere.
 *
 * `pending` IS NOT A LOADING STATE and must never be given motion. Half the
 * tasks on this machine are pending right now, because their transcripts predate
 * the harvest window, and a chunked backfill for them is still awaiting
 * promotion — so a spinner here would spin for the life of the surface and
 * promise an arrival that is not coming. It draws the layout with {@link
 * Unfilled}, the sheet's own treatment for a reading that has not come in: a
 * rule on the baseline the digits will sit on, no block, no dash, no zero.
 *
 * The same treatment covers a genuinely cold first paint (`view === null`), and
 * that is deliberate: from the reader's side "not harvested yet" and "not
 * fetched yet" are one fact — there is no figure — and drawing them two ways
 * would be inventing a distinction to look busy.
 */

import {
  COST_HEDGE,
  type CostAmount,
  type SessionCostView,
  type TaskCostView,
} from '@podium/client-core/viewmodels'
import type { CostHarness } from '@podium/model/browser'
import type { JSX } from 'react'
import { useState } from 'react'
import { WorkingMark } from '@/lib/motion/WorkingMark'
import { cn } from '@/lib/utils'
import { DOCK_BODY, DOCK_ROW, DOCK_STAMP } from '../issues/IssueCompactControls'
import { Unfilled } from '../usage/Unfilled'
import { approxUsd, exactUsd, floorLabel, rateLabel } from './cost-format'

/**
 * VERBATIM, AND IT IS NOT A DISCLAIMER.
 *
 * Every figure in this feature is priced from public per-model list price
 * against the tokens a transcript records. That is not a bill: it ignores
 * subscription plans, negotiated rates and the free tier, and on this machine it
 * is routinely several times what was actually paid. The sentence says which of
 * the two numbers is on screen, once, under the headline — which is the only
 * place a reader who is about to quote the figure will see it.
 */
// Re-exported, not re-declared: the canonical wording lives in the viewmodel
// beside the one price table, and the deck's chip imports it from there. Two
// copies of the one sentence this feature singled out as single-source would
// drift on the first edit to either.
export { COST_HEDGE }

/**
 * The Cost section's own meta: the TENSE of the figure below it.
 *
 * One word carries it for every row at once, which is why no session row hedges
 * its own figure and no headline grows a second adverb. Absent when nothing is
 * running, because "so far" on a finished task states a change that will not
 * come.
 */
export function costSectionMeta(view: TaskCostView | null): string | undefined {
  return view?.provisional === true ? 'so far' : undefined
}

/** A kv line: label at the left, machine-voice figure parked at the right. */
function CostRow({
  label,
  children,
  faint = false,
}: {
  label: string
  children: JSX.Element | string
  faint?: boolean
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2.5 py-[3px]',
        'text-[11.5px] leading-[1.4] tabular-nums',
        faint ? 'text-text-faint' : 'text-text-dim',
      )}
      data-testid="cost-row"
    >
      <span className="min-w-0 truncate">{label}</span>
      <span
        className={cn(
          'flex-none font-mono text-[11px] tabular-nums',
          faint ? 'text-text-faint' : 'text-text-strong',
        )}
      >
        {children}
      </span>
    </div>
  )
}

/** The seam between the section's tiers — softer than a DockPart's own rule,
 *  because these are bands of one reading rather than separate sections. */
function Seam(): JSX.Element {
  return <div className="my-[11px] h-px bg-hairline-soft" aria-hidden="true" />
}

/**
 * ONE BAR, TWO SEGMENTS, BOTH LABELLED WITH THEIR FIGURE.
 *
 * The headline is always the rollup, because that is the honest answer to "what
 * did this cost" — but a bare total hides which way the money went, and the
 * three real shapes on this machine are different objects: a task that outspent
 * all 32 of its children, and one with no sessions of its own whose entire
 * figure is its 33 descendants'. Showing own cost as the headline would render
 * that second one free.
 *
 * A TASK WITH NO CHILDREN DRAWS NO BAR — the caller decides that, and the rule
 * is that a two-segment bar with one empty segment is a question the reader has
 * to answer before they can read the number. (The design's mocks draw a
 * single-segment bar in that case; it repeats the headline and says nothing the
 * headline did not, so this follows the brief and draws nothing.)
 *
 * Ink steps, never hue: the two segments are one colour at two strengths, which
 * is what makes "more of it is this one" legible without claiming that either
 * half is good or bad.
 */
function SplitBar({
  own,
  rollup,
  descendantCount,
}: {
  own: CostAmount
  rollup: CostAmount
  descendantCount: number
}): JSX.Element {
  const kidsUsd = Math.max(0, rollup.estCostUsd - own.estCostUsd)
  // A rollup of nothing still draws: `descendantCount` says the children exist,
  // and "this task $0 · 3 sub-tasks $0" is a truthful shape. Own takes the whole
  // rail rather than dividing by zero.
  const ownShare =
    rollup.estCostUsd > 0
      ? Math.min(100, Math.max(0, (own.estCostUsd / rollup.estCostUsd) * 100))
      : 100
  const kidLabel = `${descendantCount} sub-task${descendantCount === 1 ? '' : 's'}`
  return (
    <div data-testid="cost-split">
      {/* EITHER SEGMENT MAY BE ZERO-WIDTH, and both cases are live right now.
          An empty segment is not rendered at all rather than given a 0% width:
          the rail sets a 1.5px gap between segments, and a zero-width sibling
          still claims that gap — a stray sliver of track at one end that reads
          as a rendering fault rather than as "none of it went here".

          Both ends really happen. A parent with no sessions of its own is all
          descendants (POD-1839), and a task whose descendants all sit outside
          the harvest window reads own == rollup WITH children present — which
          is why the caller keys this bar on `descendantCount`, never on the two
          figures differing. POD-1867's backfill will make those diverge, so
          neither shape is a temporary quirk to tune against. */}
      <div className="cost-split" aria-hidden="true">
        {ownShare > 0 && <i className="cost-split-own" style={{ width: `${ownShare}%` }} />}
        {ownShare < 100 && <i className="cost-split-kid" style={{ width: `${100 - ownShare}%` }} />}
      </div>
      <div className="cost-splitkey">
        <span>
          <i className="cost-swatch cost-swatch-own" aria-hidden="true" />
          This task <b>{exactUsd(own.estCostUsd)}</b>
        </span>
        <span>
          <i className="cost-swatch cost-swatch-kid" aria-hidden="true" />
          {kidLabel} <b>{exactUsd(kidsUsd)}</b>
        </span>
      </div>
    </div>
  )
}

/**
 * One session that ever ran on this task — the row the roster cannot draw
 * because the session is gone.
 *
 * Inside a section headed Cost, sorted by cost, a figure is what the row is
 * FOR, so a live session shows its cost like any other and keeps its working
 * mark beside it. The "so far" in the section meta carries the tense for all of
 * them at once rather than hedging each row, which is what stops a ten-row list
 * from repeating the same caveat ten times.
 */
/**
 * One harness, named for a ROW rather than for the attribution sentence.
 *
 * Not `costHarnessLabel`, deliberately: that renders a SET as a claim about a
 * figure's completeness ("all Codex", "Codex + Grok") and is the binding wording
 * for the attribution line. This is a single harness naming a single session,
 * where "all Codex" would be nonsense.
 */
const HARNESS_WORD: Record<CostHarness, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  grok: 'Grok',
}

/**
 * WHAT AN UNNAMED SESSION IS CALLED — its harness and the day it ran.
 *
 * `title` is null when no session row survives for a transcript that did: the
 * work happened, and what somebody called it is not recoverable. "Unnamed
 * session" is the wrong answer to that, because it describes the GAP rather than
 * the session, and in a list where every other row is legible it reads as
 * missing data.
 *
 * Harness plus date is addressable instead: it is enough to find the transcript
 * with, it distinguishes two nameless rows from each other, and it says the one
 * true thing left about the row — some Codex agent worked here on the 12th.
 */
function unnamedSessionLabel(session: SessionCostView): string {
  const harness = HARNESS_WORD[session.harness]
  if (session.firstTsMs <= 0) return `${harness} session`
  const day = new Date(session.firstTsMs).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  })
  return `${harness} session · ${day}`
}

function SessionCostRow({ session }: { session: SessionCostView }): JSX.Element {
  const unnamed = session.title === null
  return (
    <div
      className="flex min-h-[28px] items-center gap-2 border-hairline-soft border-b px-1 last:border-b-0"
      data-testid="cost-session-row"
    >
      <span
        className={cn(
          DOCK_ROW,
          'min-w-0 flex-1 truncate',
          // Held one ink step down: the row is legible and addressable, but what
          // it says is derived rather than something a person chose to call it.
          unnamed ? 'text-text-dim' : 'text-foreground/90',
        )}
      >
        {session.title ?? unnamedSessionLabel(session)}
      </span>
      <span className={cn(DOCK_STAMP, 'flex-none tabular-nums text-text-dim')}>
        {approxUsd(session.estCostUsd)}
      </span>
      {session.running && <WorkingMark size={11} className="flex-none" />}
    </div>
  )
}

/** The section's one line of copy that is a sentence rather than a reading. */
function Hedge(): JSX.Element {
  return (
    <p className="mt-[5px] text-[11.5px] text-text-faint leading-[1.45]" data-testid="cost-hedge">
      {COST_HEDGE}
    </p>
  )
}

/**
 * A state that is a WORD. `no-sessions` says nobody ever worked here;
 * `not-recorded` says they did and no transcript survives to price. Neither
 * carries the hedge line, which is about how a figure was arrived at, and there
 * is no figure.
 */
function CostWord({ children }: { children: string }): JSX.Element {
  return (
    <div className={cn(DOCK_BODY, 'py-0.5 text-text-faint')} data-testid="cost-word">
      {children}
    </div>
  )
}

export function TaskCostSection({ view }: { view: TaskCostView | null }): JSX.Element {
  const [open, setOpen] = useState(false)

  if (view === null || view.state === 'pending') {
    // The layout, drawn, with the reading absent — see this file's header for
    // why `pending` is here and why neither arm is allowed to move.
    //
    // NO HEDGE. The sentence disclaims how a FIGURE was arrived at, and there is
    // no figure to disclaim; printing it here says "that number you cannot see
    // is at list price". It belongs only where a figure is shown, which is why
    // the two word states below have never carried it either.
    return (
      <div data-testid="cost-section" data-state={view?.state ?? 'cold'}>
        <div className="cost-figure">
          {/* The width the FIGURE would occupy, not a token dash. At five it
              read as a stray hyphen rather than a held place; a rounded rollup
              is "≈$226" and the slot has to look like somewhere that lands. */}
          <Unfilled ch={8} />
        </div>
      </div>
    )
  }

  if (view.state === 'no-sessions') {
    return (
      <div data-testid="cost-section" data-state="no-sessions">
        <CostWord>No sessions</CostWord>
      </div>
    )
  }

  if (view.state === 'not-recorded') {
    return (
      <div data-testid="cost-section" data-state="not-recorded">
        <CostWord>Not recorded</CostWord>
      </div>
    )
  }

  const { own, rollup, sessions } = view
  // ROLLUP models, not own: the headline, the rate and these rows then all
  // describe the same money. The split bar is the one place the own/descendant
  // distinction is drawn, which is exactly what it is there for — a column that
  // silently changed scope halfway down would need a second bar to explain it.
  const models = rollup.models
  // "N SESSIONS THAT EVER RAN" — the coordinator's wording, and it lives here
  // ONCE because the dock and the task detail page share this component and a
  // string in two files is a string that diverges.
  //
  // "That ever ran" is doing precise work. The panel used to print "≈$226 over
  // 10" directly above a fold reading "6 sessions", two numbers a reader could
  // only reconcile by knowing the schema. The cause is not a scope mistake in
  // either count: the roster and the page rail count sessions that still EXIST
  // as replica rows, and this block counts transcripts of sessions that RAN. A
  // task with ten transcripts and two surviving rows legitimately shows both,
  // and this phrase is what makes the larger number make sense beside them.
  //
  // The COUNT is `own.sessionCount` — every session that ran on this task — not
  // the length of the list, which holds only the ones with a figure to sort by.
  // The difference is stated inside the fold rather than left as a silent gap,
  // which is also why the count and the list are allowed to disagree.
  const unpriced = Math.max(0, own.sessionCount - sessions.length)
  const ran = Math.max(own.sessionCount, sessions.length)
  const label = `${ran} session${ran === 1 ? '' : 's'} that ever ran${
    // At one row "most expensive first" claims an ordering over nothing.
    ran === 1 ? '' : ', most expensive first'
  }`

  return (
    <div data-testid="cost-section" data-state="costed">
      <div className="cost-figure" data-testid="cost-figure">
        {approxUsd(rollup.estCostUsd)}
      </div>
      <Hedge />

      {view.descendantCount > 0 && (
        <div className="mt-[11px]">
          <SplitBar own={own} rollup={rollup} descendantCount={view.descendantCount} />
        </div>
      )}

      <Seam />

      {models.map((m) => (
        <CostRow key={m.model} label={m.model}>
          {exactUsd(m.estCostUsd)}
        </CostRow>
      ))}
      {view.rateVsMedian !== null && <CostRow label="Rate">{rateLabel(view.rateVsMedian)}</CostRow>}
      {/* The figure is a LOWER BOUND, and which harnesses made it one. Held at
          the faint step: it qualifies the reading above rather than adding to
          it, and a task whose every session was Claude never draws it. */}
      {view.floor === 'partial' && (
        <CostRow label="Attribution" faint>
          {floorLabel(view.harnesses)}
        </CostRow>
      )}

      {sessions.length > 0 && (
        <>
          <Seam />
          <button
            data-pressable
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            // The inspector's own fold grammar — wholly mono, because a fold
            // summary counts things.
            // Two COLUMNS rather than a glyph inline with the text: the
            // mandated label is longer than a 340px dock can hold on one line,
            // and wrapped inline its second line started under the marker. The
            // marker keeps its own fixed column so the label hangs against
            // itself. `leading-none` becomes `leading-[1.35]` for the same
            // reason — two mono lines set solid touch.
            className="flex w-full gap-1 px-1 py-1.5 text-left font-mono text-[11px] text-text-dim leading-[1.35] hover:text-foreground"
            data-testid="cost-disclosure"
          >
            <span className="flex-none" aria-hidden="true">
              {open ? '⌄' : '›'}
            </span>
            <span className="min-w-0 flex-1">{label}</span>
          </button>
          {open && (
            <>
              {sessions.map((s, i) => (
                <SessionCostRow key={s.sessionId ?? `t${i}`} session={s} />
              ))}
              {/* The sessions the list CANNOT show, said rather than left as a
                  gap between two counts. They ran on this task and carry no
                  figure to sort by — a transcript not harvested yet, or one that
                  no longer exists. Naming them is what keeps the fold's "2 of 6"
                  from reading as a list that lost four rows. */}
              {unpriced > 0 && (
                <div
                  className={cn(DOCK_BODY, 'px-1 py-1.5 text-text-faint')}
                  data-testid="cost-unpriced"
                >
                  {unpriced} more with no figure recorded
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
