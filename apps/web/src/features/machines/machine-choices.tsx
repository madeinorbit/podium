/**
 * THE ONE PLACE A MACHINE PICKER LEARNS TO EXPLAIN ITSELF (POD-2700).
 *
 * The bug this work fixes was not a missing filter. It was a screen that
 * offered a machine which could never do the job, and then — once the offer was
 * withdrawn — would have shown an empty dropdown with no words at all. So the
 * hook below returns the option list AND the two pieces of prose that must
 * accompany it: what was excluded from the list, and what to do when nothing
 * qualifies.
 *
 * Every picker in the app calls this instead of filtering `store.machines`
 * itself, because ~20 hand-rolled filters is precisely how one menu comes to
 * offer a machine another refuses.
 *
 * THE DISTINCTION IT ENFORCES, in one sentence: a machine that is merely
 * OFFLINE stays in the list, disabled and labelled, because waiting is real
 * advice; a machine that runs no daemon leaves the list and is counted in a
 * footnote, because there is nothing to wait for.
 */
import {
  type HandoffMachine,
  type MachineActionCopy,
  type MachineChoice,
  type MachineChoiceSummary,
  type MachineEmptyState,
  type MachineRejection,
  type MachineRequirement,
  machineChoiceSummary,
  machineChoices,
  machineEmptyState,
  machineExclusionNote,
} from '@podium/model'
import type { JSX } from 'react'
import { useMemo } from 'react'

/**
 * The least a picker's machine must carry: enough for the predicate, plus a
 * name to say it by. GENERIC rather than pinned to `MachineWire` because
 * several screens narrow the wire to a `Pick<…>` of their own, and forcing them
 * to widen it back would be a type change made to satisfy a helper.
 */
export type ChoosableMachine = HandoffMachine & { name: string }

export interface MachineChoiceView<M extends ChoosableMachine> {
  /** Rows the picker renders, in fleet order. Offline ones carry a rejection. */
  options: MachineChoice<M>[]
  /** Rows that may be SELECTED right now. */
  selectable: M[]
  summary: MachineChoiceSummary<M>
  /** Footnote under the picker, or `undefined` when nothing was excluded. */
  exclusionNote: string | undefined
  /** Rendered instead of a dropdown when nothing qualifies; `null` otherwise. */
  emptyState: MachineEmptyState | null
  /** The id an auto-pick may land on — §3.3: never an ineligible machine. */
  autoPick: string | undefined
}

/**
 * Project the fleet for one requirement.
 *
 * `preferredId` is the caller's existing selection or remembered pin. It is
 * RE-VALIDATED rather than trusted: a persisted `uiState.selectedMachineId`
 * outlives the machine it names, and resurrecting a stale pin is the same
 * failure as auto-picking a dud, just delayed by a page load.
 */
export function useMachineChoices<M extends ChoosableMachine>(
  machines: readonly M[],
  requirement: MachineRequirement,
  copy: MachineActionCopy,
  preferredId?: string,
): MachineChoiceView<M> {
  return useMemo(() => {
    const options = machineChoices(machines, requirement)
    const summary = machineChoiceSummary(options)
    const selectable = summary.eligible
    const preferred = preferredId
      ? selectable.find((machine) => machine.id === preferredId)
      : undefined
    return {
      options: options.filter((choice) => choice.listed),
      selectable,
      summary,
      exclusionNote: machineExclusionNote(summary, copy),
      emptyState: machineEmptyState(summary, copy),
      autoPick: (preferred ?? selectable[0])?.id,
    }
    // PASS A STABLE `copy` AND `requirement` — a module-level constant at every
    // call site today. Both are keyed by identity, so a fresh object literal
    // busts the memo each render. That is a recompute of a pure fold over a
    // handful of machines, not a correctness problem, which is why this is a
    // note rather than a defensive deep-compare.
  }, [machines, requirement, copy, preferredId])
}

/** The label a row carries in a dropdown: the name plus, when refused, why. */
export function machineOptionLabel<M extends ChoosableMachine>(choice: MachineChoice<M>): string {
  const name = choice.machine.name
  switch (choice.rejection) {
    case undefined:
      return name
    case 'offline':
      return `${name} (offline)`
    case 'harness-missing':
      return `${name} (agent not installed)`
    case 'logged-out':
      return `${name} (signed out)`
    case 'unauthorized':
      return `${name} (no access)`
    case 'no-daemon':
      // Should not reach a rendered option — `listed` is false for it — but a
      // label that lies is worse than one that is never seen.
      return `${name} (runs no daemon)`
    case 'current-server':
      return `${name} (already the server)`
    default: {
      const exhaustive: never = choice.rejection satisfies never as never
      return `${name} (${String(exhaustive)})`
    }
  }
}

/** The footnote under a picker. Renders nothing when nothing was excluded. */
export function MachineExclusionNote({ note }: { note: string | undefined }): JSX.Element | null {
  if (!note) return null
  return <p className="text-xs text-muted-foreground/70">{note}</p>
}

/**
 * The empty state — the stuck repo screen, fixed in words.
 *
 * `action` is an optional affordance (a "Pair a machine" button); the sentence
 * still names the remedy without it, so a surface with nowhere to send the user
 * is merely less helpful rather than silent.
 */
export function MachineEmptyStateNotice({
  state,
  action,
  className,
}: {
  state: MachineEmptyState | null
  action?: JSX.Element
  className?: string
}): JSX.Element | null {
  if (!state) return null
  return (
    <div className={className ?? 'flex flex-col gap-1 p-3 text-xs text-muted-foreground/70'}>
      <p className="font-medium text-foreground/80">{state.title}</p>
      {state.detail ? <p>{state.detail}</p> : null}
      {state.remedy ? <p>{state.remedy}</p> : null}
      {action}
    </div>
  )
}

export type { MachineRejection }
