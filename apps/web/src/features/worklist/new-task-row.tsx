/**
 * THE COLUMN'S TWO CONTROLS (POD-1469), replacing `spawn-row.tsx`.
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
 * IT SHARES THE FILTER'S LINE, AND THE FILTER IS WHAT GIVES. At the column's
 * 306px default both fit whole. At its 200px minimum they cannot — a spelled-out
 * button is ~115px of the 180px inside the insets — so the button drops to its
 * glyph and the field keeps the room. That direction is not arbitrary: a filter
 * field with a search glyph and no visible placeholder still reads as a filter
 * field, while `Add Reposi…` reads as a bug. The threshold is a CONTAINER query
 * on the column, not a viewport one — this column is resized by hand on a
 * display of any width, and `sm:` knows nothing about that.
 */
import { FolderPlus, Plus } from 'lucide-react'
import type { JSX } from 'react'
import { openAddProject } from '@/app/desktop-menu'
import { cn } from '@/lib/utils'
import { newTaskChordBound, useNewTask } from './new-task'

/**
 * The one top row: a full-width raised card that opens a blank mission.
 *
 * THE GEOMETRY IS THE ARTBOARD'S, INHERITED WHOLE (POD-1253). 38px of inside on
 * a 1px rim at radius 8 — this box is border-box, so `h-10` — on the same ground
 * the selected row takes (`--chip` in both themes). It is the tallest thing in
 * the column and the only RAISED one, which is what makes it read as an
 * invitation rather than as a search box. `px-[11px]` plus the rim is the mock's
 * 12px inset; 10px on the right of the block is exactly enough for the collapse
 * control, which is 18px wide at `translateX(50%)`.
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
    <div className="flex flex-none items-center gap-2 px-[10px] pt-[9px]">
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
            ⌘N
          </span>
        )}
      </button>
    </div>
  )
}

/**
 * `Add repository`, spelled out while there is room for the words.
 *
 * A 30px control, not the filter's 32: the field beside it is the line's
 * subject and this is the utility riding along, so it sits a hair inside the
 * field's height rather than squaring up to it. Chip ground, chip rim — the same
 * raised vocabulary the head above uses, one tier quieter.
 */
export function AddRepositoryButton({ className }: { className?: string }): JSX.Element {
  return (
    <button
      data-pressable
      type="button"
      data-testid="add-repository"
      title="Add repository"
      aria-label="Add repository"
      onClick={openAddProject}
      className={cn(
        'flex h-8 flex-none items-center gap-[6px] rounded-[7px] border border-input bg-chip px-[9px] text-[11.5px] font-medium leading-none text-muted-foreground transition-colors hover:bg-accent hover:text-text-strong focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-strong focus-visible:outline-offset-[-2px]',
        className,
      )}
    >
      <FolderPlus size={13} aria-hidden="true" className="flex-none" />
      {/* The words go first, and only below the column's own 280px — a
          `@container worklist` rule in styles.css, so the width being read is
          the COLUMN's, which is the only width that matters to a control the
          operator drags the edge of. */}
      <span className="worklist-add-repo-label">Add repository</span>
    </button>
  )
}

/**
 * A PROJECT WITH NOTHING IN IT STILL HAS A BAND, AND THE BAND HAS A DOOR
 * (POD-1469).
 *
 * Groups are built from rows, so a repo that has never been worked contributed
 * nothing and vanished from the column entirely: adding a project appeared to do
 * nothing at all, which is the worst possible answer to the one gesture whose
 * whole purpose is to make a project exist. The band is drawn from the project
 * tree now, and this is what stands under it.
 *
 * SUBTLE, AND THAT IS THE SPECIFICATION. It sits where a row's title sits, at
 * the column's 13px inset, in muted ink with the row's own hover wash — it reads
 * as the group's first line rather than as a button parked inside it. The one
 * raised control in this column is the head, and it stays that way.
 *
 * It seeds the composer with THIS project, so the sentence the operator lands on
 * names the repo whose band they clicked.
 */
export function StartFirstTaskRow({ repoPath }: { repoPath: string }): JSX.Element {
  const { startNewTask } = useNewTask()
  return (
    <button
      data-pressable
      type="button"
      data-testid="start-first-task"
      onClick={() => startNewTask(repoPath)}
      title="Start the first task in this project"
      className="flex min-h-[38px] w-full items-center gap-[9px] px-[13px] text-left text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-text-strong focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-strong focus-visible:outline-offset-[-2px]"
    >
      <Plus size={13} aria-hidden="true" className="flex-none text-text-faint" />
      <span className="min-w-0 truncate">Start first task</span>
    </button>
  )
}
