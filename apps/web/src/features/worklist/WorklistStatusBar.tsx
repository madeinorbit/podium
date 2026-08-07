/**
 * THE WORKLIST STATUS LINE (POD-516 round 2, left sidebar items 1 and 2).
 *
 * The artifact's segmented `progress()` bar, at the scope of column 1: one
 * reading of everything the list below it is holding. It sits as a SECOND ROW
 * under the shell's 36px datum rather than making the spawn row taller —
 * DESIGN.md §5's rule for a column that needs more room.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT SAYS, AND WHAT IT REFUSES TO SAY
 * ---------------------------------------------------------------------------
 *
 * Restraint is the requirement here, not a caveat, so this line carries exactly
 * three numbers — how much work there is, how much is finished, how much is
 * moving — and hands everything else to the tooltip:
 *
 *   · `12/40 done`  — the fraction answers "how many tasks" and "how many are
 *     done" in five characters, and the meter beside it makes it unmistakable.
 *   · `5 running`   — the live figure, with the spinner beside it.
 *   · the meter     — done / running / blocked, over the waiting trough. The
 *     picture of the four buckets, so the words never have to list them.
 *
 * DELIBERATELY ABSENT — an agent count. The status strip at the bottom of this
 * same window already states how many agents are computing, fleet-wide, with
 * this same spinner, and its own header records why nothing else may: one fact,
 * one place. Two live counters a screen apart read as two facts and invite the
 * operator to reconcile them. What this COLUMN uniquely knows is the shape of
 * its own work, so that is what it says. (The Flight Deck states the selected
 * mission's live and coordinator counts, which is a third, narrower scope
 * again — and it is beside the mission it describes.)
 *
 * DELIBERATELY ABSENT — a needs-you count. It is the most valuable number in
 * the product, and it is already on the rows themselves as the amber pill, six
 * pixels below. An aggregate over a scope that is not exactly the visible pills
 * is the round-1 failure ("a badge that disagreed with the column it
 * summarised") waiting to happen again.
 *
 * ---------------------------------------------------------------------------
 * MOTION FOR ACTIVITY, COLOUR FOR OBLIGATION
 * ---------------------------------------------------------------------------
 *
 * Nothing here is amber. Amber means an agent is asking the operator something,
 * and a progress meter asks nothing — a permanently-lit brand hue in the
 * column's chrome is the exact spend The Signal Rule guards against.
 *
 * The four buckets take four steps of the calm palette instead: done in Accent
 * Blue (the theme's "all good" — Superade has no green), running in the
 * reserved working blue the spinner itself uses, blocked in faint ink, and
 * waiting left as the bare trough. Blue for the two that are fine, grey for the
 * two that are not moving.
 *
 * The only motion is the braille spinner, gated on an agent ACTUALLY computing
 * (see `WorklistStatus.working`) — so when the fleet is idle the line goes
 * completely still, and stillness is information. The segment widths morph once
 * when the numbers change and then stop; reduced motion drops even that.
 */
import type { JSX } from 'react'
import { useMemo } from 'react'
import { useReplicaIssues, useStoreSelector } from '@/app/store'
import { BrailleSpinner } from '@/lib/motion'
import { cn } from '@/lib/utils'
import type { SidebarDerivation } from './derivation'
import { worklistStatus } from './worklist-status'

export function WorklistStatusBar({
  derivation,
}: {
  derivation: SidebarDerivation
}): JSX.Element | null {
  const sessions = useStoreSelector((s) => s.sessions)
  const issues = useReplicaIssues()
  const { pinned, groups } = derivation
  // The rows the column is SHOWING: the pinned lane plus each project group's
  // open rows. Snoozed and closed are tucked away on purpose and stay out.
  const rows = useMemo(
    () => [...pinned, ...groups.flatMap((group) => group.rows)],
    [pinned, groups],
  )
  const status = useMemo(() => worklistStatus(rows, issues, sessions), [rows, issues, sessions])

  // Nothing to summarise — an empty column, or one holding only worktree rows.
  // A meter over zero tasks is chrome pretending to be data, so it falls back
  // to the 9px spacer this row replaced, and the list starts where it always
  // did rather than hugging the section bar's seam.
  if (status.total === 0) return <div className="h-[9px] flex-none" aria-hidden="true" />

  const pct = (n: number): string => `${(n / status.total) * 100}%`
  const detail = [
    `${status.total} ${status.total === 1 ? 'task' : 'tasks'}`,
    `${status.done} done`,
    `${status.run} running`,
    ...(status.block > 0 ? [`${status.block} blocked`] : []),
    `${status.wait} waiting`,
  ].join(' · ')

  return (
    // Rows below sit at the column's 8px side inset; the meter shares it so its
    // ends line up with the ID squares and the fold hairlines.
    <div data-testid="worklist-status" className="flex-none px-2 pt-2 pb-2.5" title={detail}>
      <div className="flex items-center justify-between gap-2 font-mono text-[9px] leading-none tracking-[.02em] tabular-nums">
        <span className="truncate text-text-dim" data-testid="worklist-status-done">
          <span className="text-muted-foreground">{status.done}</span>
          <span className="text-text-faint">/{status.total}</span> done
        </span>
        <span
          data-testid="worklist-status-run"
          data-working={status.working ? 'true' : 'false'}
          className={cn(
            'flex flex-none items-center gap-1',
            status.working ? 'text-live' : 'text-text-dim',
          )}
        >
          {status.working && <BrailleSpinner size={9} className="flex-none" />}
          {status.run} running
        </span>
      </div>
      {/* Data, not decoration (DESIGN.md §5): a 3.5px rounded bar on the
          secondary surface, no border, no label of its own. */}
      <div
        data-testid="worklist-status-meter"
        className="mt-[7px] flex h-[3.5px] overflow-hidden rounded-full bg-secondary"
        aria-hidden="true"
      >
        <span
          data-segment="done"
          className="h-full bg-success transition-[width] duration-300 ease-out motion-reduce:transition-none"
          style={{ width: pct(status.done) }}
        />
        <span
          data-segment="run"
          className="h-full bg-live transition-[width] duration-300 ease-out motion-reduce:transition-none"
          style={{ width: pct(status.run) }}
        />
        <span
          data-segment="block"
          className="h-full bg-text-faint transition-[width] duration-300 ease-out motion-reduce:transition-none"
          style={{ width: pct(status.block) }}
        />
      </div>
    </div>
  )
}
