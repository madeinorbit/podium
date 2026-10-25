/**
 * THE COLUMN'S HEAD (POD-1469), replacing `spawn-row.tsx`.
 *
 * The sidebar's head used to be `New <Agent> in <Repo>` — a chip that spawned a
 * harness on click, with a chevron inside its own outline holding the agent →
 * repo → machine menu and a `New issue…` entry. Everything that menu could say
 * is now said by the cold-start composer, which asks for the WORK first and the
 * instruments second; see `new-task.ts` for why that ordering is the point. The
 * head keeps the artboard's geometry and its one raised card — it is still the
 * column's single invitation — and spends it on a button that makes no choices.
 *
 * `Add repository` came up from the footer with it. The footer was a 35px strip
 * holding two glyphs and a ⌘K hint: the search glyph duplicated a chord AppShell
 * binds globally, the hint advertised it a second time, and the one control that
 * was NOT reachable any other way sat at the bottom of a scrolling column where
 * a first-run operator with no projects would never look. The strip is gone and
 * the button is up here in words.
 *
 * (POD-2074) `Add repository` has since moved again, to a pinned foot under
 * the list (`AddRepositoryFooter` in `work-folders.tsx`), and the per-project
 * "Start first task" band gave way to each folder header's +.
 */
import { Plus } from 'lucide-react'
import type { JSX } from 'react'
import { modChord } from '@/lib/mod-chord'
import { newTaskChordBound, useNewTask } from './new-task'

/**
 * The one top row: a full-width raised card that opens a blank mission.
 *
 * THE GEOMETRY IS THE ARTBOARD'S, INHERITED WHOLE (POD-1253). 38px of inside on
 * a 1px rim at radius 8 — this box is border-box, so `h-10` — on the same ground
 * the selected row takes (`--chip` in both themes). It is the tallest thing in
 * the column and the only RAISED one, which is what makes it read as an
 * invitation rather than as a search box. `px-[11px]` plus the rim is the mock's
 * 12px inset.
 *
 * NO YELLOW. It is the primary action of this column, and the Signal Rule would
 * license the fill — but the rows underneath spend attention gold on "this one
 * needs you", and a yellow slab permanently lit above them would be the loudest
 * pixel in the column at every moment including the ones where nothing is being
 * asked. The raised card is the invitation; the gold stays the alarm.
 */
export function NewTaskRow(): JSX.Element {
  const { startNewTask } = useNewTask({ bindChord: true })
  // The hint is rendered only where the chord exists (see `newTaskChordBound`).
  // It also replaces the ⌘K the deleted footer used to advertise: the column now
  // states one shortcut, on the control that answers it.
  const chord = newTaskChordBound()
  return (
    <div className="flex flex-none items-center gap-2 px-3 pt-3">
      <button
        data-pressable
        type="button"
        data-testid="new-task-button"
        onClick={() => startNewTask()}
        title="Start a new task"
        className="shell-spawn-chip flex h-10 w-full min-w-0 items-center gap-[9px] rounded-[8px] border border-border-strong bg-chip px-[11px] text-[12.5px] font-medium tracking-[-0.005em] leading-[normal] text-foreground"
      >
        <Plus size={14} aria-hidden="true" className="flex-none text-text-dim" />
        <span className="min-w-0 flex-1 truncate text-left">New task</span>
        {chord && (
          <span
            className="shell-type-micro mono-timer flex-none text-text-faint"
            aria-hidden="true"
            data-testid="new-task-chord"
          >
            {modChord('N')}
          </span>
        )}
      </button>
    </div>
  )
}
