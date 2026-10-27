import type { MotionPhase } from '@podium/client-core/values'
import { ArrowDownToLine, CircleCheck, CircleMinus } from 'lucide-react'
import * as m from 'motion/react-m'
import type {
  JSX,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { UnreadDot, unreadTitleClass } from '@/components/UnreadMark'
import { usePhaseMorph, WorkingMark } from '@/lib/motion'
import { useReducedMotion } from '@/lib/use-reduced-motion'
import { cn } from '@/lib/utils'
import type { RowTone } from './pool-row-data'
import { RowShortcutBadge } from './RowShortcutBadge'
import { EASE_OUT, MOTION_S } from './worklist-motion-tokens'

/** The old identity gutter's width. The calm rows carry no left id column; the
 *  empty-list skeleton still lands its placeholder on this datum. */
export const ID_GUTTER_W = 26

/** The old fixed meta column's width, kept for the empty-list skeleton. */
export const META_COL_W = 56

const TONE_INK: Record<RowTone, string> = {
  needs: 'var(--attention)',
  working: 'var(--foreground)',
  active: 'var(--muted-foreground)',
  idle: 'var(--muted-foreground)',
  settled: 'var(--muted-foreground)',
  done: 'var(--text-dim)',
  closed: 'var(--text-faint)',
  draft: 'var(--text-dim)',
  error: 'var(--destructive)',
}

/** The tuck chip's box, shared by the chip and the meta slot it reserves. */
const TUCK_CHIP_BOX =
  'shell-type-micro flex h-5 items-center gap-1 px-[7px] font-mono leading-none tracking-[0.02em]'

const tuckChipFace = (
  <>
    <ArrowDownToLine
      size={11}
      aria-hidden="true"
      className="text-text-faint transition-[transform,color] duration-150 group-hover/tuck:translate-y-px group-hover/tuck:text-muted-foreground"
    />
    <span>Tuck</span>
  </>
)

/** The 6px status dot, or its glyph stand-in. The working tone is the shared
 *  `WorkingMark`, never a dot of its own (operator decision). */
export function RowStatusMark({ tone }: { tone: RowTone }): JSX.Element {
  if (tone === 'working') return <WorkingMark size={12} className="-mx-[3px] flex-none" />
  if (tone === 'done')
    return (
      <CircleCheck
        size={12}
        aria-hidden="true"
        className="-mx-[3px] flex-none text-text-dim"
        data-testid="row-status-check"
      />
    )
  if (tone === 'closed')
    return (
      <CircleMinus size={12} aria-hidden="true" className="-mx-[3px] flex-none text-text-faint" />
    )
  return (
    <span
      aria-hidden="true"
      className="work-row-dot flex-none"
      data-tone={tone}
      data-testid="row-status-dot"
    />
  )
}

/** Line 2's ink for a tone, exported for the folded rows that share the line. */
export function rowToneInk(tone: RowTone): string {
  return TONE_INK[tone]
}

/**
 * The work row, as the calm design draws it (POD-2074):
 *
 *     Title of the mission                         • 14h
 *     ● Needs review · 7/7                        POD-324
 *
 * Two lines on a rounded, inset surface. Line 1 is the title and one time fact;
 * line 2 is the one status voice, its sub-facts, and the ref at the far end, so
 * every title starts on the same edge. No project tints, no progress rule, no id
 * gutter. The selected row is the only raised white row in the column.
 */
export function WorkRowShell({
  idLabel,
  label,
  statusLine,
  tone,
  phase,
  timeMeta,
  statusTime,
  active,
  unread = false,
  muted = false,
  onSelect,
  onContextMenu,
  onDoubleClick,
  editor,
  marks,
  titleHint,
  testId,
  deemphasized = false,
  domMark,
  statusExtra,
  gitStamp,
  onGripDown,
  onTuck,
  shortcutDigit,
}: {
  /** The full ref (`POD-844`), drawn at the end of line 2. */
  idLabel: string
  label: string
  /** Line 2's status word — the row's one state voice. */
  statusLine: ReactNode
  /** Which of the design's status voices line 2 speaks in. */
  tone: RowTone
  phase: MotionPhase
  /** Line 1's right-hand meta: the live timer or the age. */
  timeMeta?: ReactNode
  /** Line 2's trailing sub-fact after the word (`· 7/7`). */
  statusTime?: ReactNode
  active: boolean
  /** Email-style unread emphasis: semibold title + info dot until opened. */
  unread?: boolean
  /** Done and closed rows sit a step quieter, title included. */
  muted?: boolean
  onSelect: () => void
  /** Right-click the row's select button (opens the issue context menu). */
  onContextMenu?: (e: ReactMouseEvent) => void
  /** Double-click the row's label (issue rename, #170). */
  onDoubleClick?: () => void
  /** When present, replaces the two-line block with an inline-rename input. */
  editor?: ReactNode
  /** Line-2 marks that ride before the status word (unsaved, fleet glyphs). */
  marks?: ReactNode
  /** Native hover tooltip on the row (issue ids, #21). */
  titleHint?: string
  testId: string
  /** Internal decomposition stays visible but subordinate to tracked work. */
  deemphasized?: boolean
  /** Issue id stamped as data-issue-row so lineage flashes can find the row, and
   *  as the First Flights anchor `task-row:<id>`. */
  domMark?: string
  /** Line 2's trailing facts after the sub-info (errors, the spin-off tick). */
  statusExtra?: ReactNode
  /** Line 2's git stamp [POD-98]. */
  gitStamp?: ReactNode
  /** Manual-sort grip (POD-168): a handle fades in on the row's left edge. */
  onGripDown?: (e: ReactPointerEvent) => void
  /** Dismiss a finished row into Closed (POD-293): a quiet chip over the meta. */
  onTuck?: () => void
  /** ⌘-hold row shortcut (POD-790), drawn over the ref while Command is down. */
  shortcutDigit?: number
}): JSX.Element {
  // One-shot transition morphs (§2.6): →waiting flashes the row.
  const morph = usePhaseMorph(phase)
  const reduceMotion = useReducedMotion()
  const ref = (
    <span
      className="work-row-ref relative flex-none font-mono tabular-nums text-text-faint"
      data-testid="row-id-number"
    >
      {idLabel}
      {shortcutDigit !== undefined && <RowShortcutBadge digit={shortcutDigit} size={18} />}
    </span>
  )
  return (
    <div className="min-w-0 px-2 py-px" data-testid={testId}>
      <div
        className={cn(
          'shell-work-row phase-surface group/row relative flex min-w-0 items-center',
          !active && 'hover:bg-[var(--work-row-hover)]',
          morph === 'waiting' && 'morph-row-flash',
          deemphasized && !active && 'opacity-70',
        )}
        data-phase={phase}
        data-selected={active ? 'true' : 'false'}
        {...(domMark
          ? { 'data-issue-row': domMark, 'data-tip-anchor': `task-row:${domMark}` }
          : {})}
      >
        {onGripDown && (
          // Manual-sort grip (POD-168): the row's left inset, visible on hover.
          <span
            className="shell-type-micro absolute inset-y-0 left-1 z-[1] flex w-2.5 cursor-grab select-none items-center justify-center text-transparent transition-colors duration-150 group-hover/row:text-text-faint"
            style={{ touchAction: 'none' }}
            data-testid="row-grip"
            aria-hidden="true"
            onPointerDown={onGripDown}
          >
            ⠿
          </span>
        )}
        {editor ? (
          // Inline rename (#170): the input replaces the two-line block in place.
          <div className="flex min-h-[35px] min-w-0 flex-1 items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center">{editor}</div>
            {ref}
          </div>
        ) : (
          <button
            data-pressable
            type="button"
            className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1 text-left leading-[normal]"
            title={titleHint}
            onClick={onSelect}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
          >
            <span className="flex w-full min-w-0 items-center gap-2">
              <span
                className={cn(
                  'shell-work-row-title min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap',
                  unreadTitleClass(unread, active),
                  active && !unread && 'font-semibold',
                  muted && !unread && !active && 'text-text-dim',
                )}
              >
                {label}
              </span>
              {unread && (
                <>
                  <UnreadDot />
                  <span className="sr-only">unread</span>
                </>
              )}
              <span
                className={cn(
                  'work-row-meta flex flex-none justify-end text-right font-mono tabular-nums text-text-faint',
                  onTuck && 'invisible',
                )}
                data-testid="row-meta-column"
              >
                {/* A tuckable row reserves the chip's own width (not its
                    height), so the chip drawn over this slot never covers the
                    unread dot. */}
                {onTuck ? (
                  <span aria-hidden="true" className={cn(TUCK_CHIP_BOX, 'h-0 overflow-hidden')}>
                    {tuckChipFace}
                  </span>
                ) : (
                  timeMeta
                )}
              </span>
            </span>
            <span
              className="shell-work-row-status flex w-full min-w-0 items-center gap-[7px]"
              data-testid="row-lifecycle-status"
              data-phase={phase}
              data-tone={tone}
            >
              {marks}
              <RowStatusMark tone={tone} />
              <span className="flex min-w-0 flex-1 items-center gap-[5px] overflow-hidden whitespace-nowrap">
                <span
                  data-testid="row-status-phrase"
                  className={cn(
                    // The word outranks every trailing fact: it never yields
                    // its width to them.
                    'max-w-full flex-none overflow-hidden text-ellipsis',
                    tone === 'needs' || tone === 'error'
                      ? 'font-semibold'
                      : tone === 'working'
                        ? 'font-medium'
                        : 'font-normal',
                  )}
                  style={{ color: TONE_INK[tone] }}
                >
                  {statusLine}
                </span>
                {statusTime && (
                  <span className="flex flex-none items-center text-text-faint">{statusTime}</span>
                )}
                {(gitStamp || statusExtra) && (
                  <span className="work-row-facts min-w-0 flex-1 overflow-hidden text-ellipsis text-text-faint">
                    {gitStamp}
                    {statusExtra}
                  </span>
                )}
              </span>
              {ref}
            </span>
          </button>
        )}
        {/* Tuck-away (POD-293): a finished task holds its place until this is
            pressed. It takes over line 1's meta, drawn over the button because a
            button cannot nest. No bronze: nothing is being asked. */}
        {onTuck && (
          <m.button
            data-pressable
            type="button"
            data-testid="tuck-away"
            initial={reduceMotion ? false : { opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={
              reduceMotion ? { duration: 0 } : { duration: MOTION_S.enter, ease: EASE_OUT }
            }
            className={cn(
              TUCK_CHIP_BOX,
              'group/tuck absolute right-[10px] rounded-[6px] text-text-dim shadow-[inset_0_0_0_1px_var(--border-strong)] transition-colors hover:bg-accent hover:text-text-strong',
            )}
            style={{ top: 'calc(var(--work-row-pad) - 2px)' }}
            title="Tuck this finished task into Closed — it stays reachable there (click to reopen, or start an agent to pick it back up). Nothing is killed or closed."
            aria-label={`Tuck ${label} into Closed`}
            onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
              event.stopPropagation()
              onTuck()
            }}
          >
            {tuckChipFace}
          </m.button>
        )}
      </div>
    </div>
  )
}
