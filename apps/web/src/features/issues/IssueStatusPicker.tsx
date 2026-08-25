import {
  type IssueStatusFields,
  isSystemOwnedIssueStage,
  issueStatusLabel,
  issueStatusMenuEntries,
  issueStatusOf,
  issueStatusValueOf,
} from '@podium/model/browser'
import { Check } from 'lucide-react'
import { Fragment, type JSX } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { StatusGlyph } from './issue-glyphs'

/**
 * THE STATUS GLYPH, MADE INTO A CONTROL (Linear's move).
 *
 * Every list in the shell already draws an issue's status as a glyph — the
 * board list, the sub-task list, the panel's Work rows, the explorer, the
 * flight deck. Until now that glyph was a READOUT: to move a task one lane you
 * opened it, or found the right-click menu's Status submenu. Linear treats the
 * same mark as the door — click it, pick the state, done — without leaving the
 * row you are scanning.
 *
 * WHAT THIS COMPONENT IS AND IS NOT. It is the trigger and the menu, nothing
 * else: it holds no store, runs no mutation, and reports the picked entry up as
 * the model's own encoded value (`stage:review`, `close:duplicate`). The fork
 * between "move the lane" and "close with a reason, through the guard" belongs
 * to the host, because the guard needs the issue's sessions and children — see
 * {@link useIssueStatusApply}, which is that host half, shared by every surface
 * that has the store in hand.
 *
 * IT LIVES INSIDE A ROW BUTTON. Each of those lists is one `<button>` per row,
 * so this trigger cannot be a second native button: it renders as the shell's
 * established `role="button"` span — the shape the list's own disclosure
 * chevron already uses — with `nativeButton={false}`, which is how Base UI is
 * told to supply the keyboard behaviour a real button would have brought. The
 * pointer and key handlers stop propagation, so opening the picker never also
 * opens the task. The glyph is the one part of the row that does something
 * else, and that is the whole feature.
 *
 * THE HIT AREA IS BIGGER THAN THE MARK. A 12px glyph is a 12px target, under
 * half of what a pointer wants. The padding grows the target and its hover wash
 * to ~20px; the matching negative margin gives the space straight back to the
 * layout, so every row's columns land exactly where they did when the glyph was
 * inert.
 */
export function IssueStatusPicker({
  issue,
  size = 12,
  align = 'start',
  className,
  onPick,
}: {
  /** Anything carrying the two fields the status projection reads. */
  issue: IssueStatusFields
  size?: number
  align?: 'start' | 'center' | 'end'
  className?: string
  /** The picked entry's encoded value — parse with `parseIssueStatusValue`. */
  onPick: (value: string) => void
}): JSX.Element {
  const status = issueStatusOf(issue)
  const label = issueStatusLabel(issue)
  // Shipping custody is the service's, not the operator's — the same rule the
  // panel dock states by disabling its status pill. The row still shows its
  // status; it just is not a door, and saying so in the tooltip beats opening a
  // menu that would refuse every pick in it.
  if (isSystemOwnedIssueStage(issue.stage)) {
    return (
      <span
        className={cn('grid flex-none place-items-center', className)}
        title={`${label} · handled by the shipping service`}
      >
        <StatusGlyph status={status} size={size} />
      </span>
    )
  }
  const current = issueStatusValueOf(issue)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        nativeButton={false}
        render={
          // biome-ignore lint/a11y/useSemanticElements: a native button here would nest inside the row's own button (invalid markup) — this is the span-trigger pattern the list's disclosure chevron already uses
          <span
            data-pressable
            role="button"
            tabIndex={0}
            data-testid="issue-status-picker"
            aria-label={`Status: ${label}`}
            title={`${label} — change status`}
            className={cn(
              '-m-[4px] grid flex-none cursor-pointer place-items-center rounded-[5px] p-[4px]',
              'transition-colors hover:bg-hairline-soft',
              'focus-visible:bg-hairline-soft data-popup-open:bg-hairline-soft',
              className,
            )}
            onClick={(event: { stopPropagation: () => void }) => event.stopPropagation()}
            onPointerDown={(event: { stopPropagation: () => void }) => event.stopPropagation()}
            onKeyDown={(event: { key: string; stopPropagation: () => void }) => {
              if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
            }}
          >
            <StatusGlyph status={status} size={size} />
          </span>
        }
      />
      {/* The same list, the same order, the same rules as the dock and the
          right-click menu — `issueStatusMenuEntries()` is the single place that
          decides them (POD-1074). Narrow: the words are short, and a picker
          hanging off a 12px mark should not out-measure the title beside it. */}
      {/* THE MENU STOPS THE CLICK TOO, and this is not belt-and-braces. The
          popup is a React PORTAL: it leaves the row in the DOM but stays the
          row's child in the React tree, and React bubbles synthetic events
          along that tree — so picking `In Progress` would arrive at the row's
          onClick and open the task on top of the change just made. */}
      <DropdownMenuContent
        align={align}
        className="w-[150px]"
        onClick={(event) => event.stopPropagation()}
      >
        {issueStatusMenuEntries().map((entry) => (
          <Fragment key={entry.status}>
            {entry.startsGroup && <DropdownMenuSeparator />}
            <DropdownMenuItem onClick={() => onPick(entry.value)}>
              <StatusGlyph status={entry.status} size={12} decorative />
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              {current === entry.value && (
                <Check className="ml-auto size-3 flex-none text-text-faint" aria-hidden="true" />
              )}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
