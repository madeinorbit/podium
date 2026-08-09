/**
 * ONE BOARD CARD — three slots, in this order, always:
 *
 *   ref · priority · origin ……………………………… fleet · age
 *   title (≤2 lines)
 *   state line (only when there is state; never wraps)
 *
 * Before POD-591 the third slot was a `flex-wrap` bag of up to twelve badge
 * atoms in source order, so a column's cards were all different heights and none
 * of them could be scanned. The ranking now lives in `issueCardStateSlots`
 * (pure, ordered, tested) and this file only draws it; the line is
 * `overflow-hidden` rather than wrapping, so what falls off the end is always
 * the least important thing on the card.
 *
 * THE CARD IS ONE INTERACTIVE ELEMENT. It used to be a native button containing
 * a second `role="button"` span for the assignee menu — invalid nesting the
 * source worked around rather than fixed, and two tab stops where the operator
 * sees one. Assignee changes belong to the context menu and the bulk bar, both
 * of which already carry them.
 *
 * (That sentence says "native button" in prose rather than writing the tag on
 * purpose: `components/ui/interaction-contract.test.ts` greps the source for
 * button tags and cannot tell a comment from an element, so one named in a doc
 * block reads to it as a control with no pressable contract.)
 *
 * THE CARD IS ISSUE-TINTED. `--issue` is scoped per card and every surface on it
 * is a `color-mix` over the panel — DESIGN.md's Tint, Never Fill rule and the
 * board's first use of the product's own colour channel. Hover steps the tint
 * and the hairline; it does NOT paint a yellow border, which is what the board
 * did to every card the mouse crossed and which spends The Signal Rule's one
 * voice on a mouse position.
 */
import type { IssueId, IssueStage, SessionMeta } from '@podium/model'
import { Flag, ShieldAlert } from 'lucide-react'
import type { JSX, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { IssueViewModel } from '@/app/store'
import { IssueFleetSummary } from '@/components/IssueFleetSummary'
import { issueColorHex } from '@/lib/issueColors'
import { BrailleSpinner } from '@/lib/motion'
import { cn } from '@/lib/utils'
import {
  type CardStateSlot,
  cardAge,
  issueCardStateSlots,
  issueIdTitle,
  issueRefLabel,
  STAGE_LABELS,
} from './issue-card'
import { PriorityGlyph, StageGlyph } from './issue-glyphs'
import { isEpic } from './issue-hierarchy'
import type { EpicProgress, IssuesDisplay } from './issues-display'

/** Slot → pixels. One switch, so the rank order in `issue-card.ts` is the only
 *  place the composition is decided. */
function StateSlot({ slot }: { slot: CardStateSlot }): JSX.Element | null {
  switch (slot.kind) {
    case 'deleted':
      return (
        <span className="font-mono text-[9px] text-destructive uppercase tracking-[0.04em]">
          deleted
        </span>
      )
    case 'needs-human':
      return (
        <span className="flex items-center gap-1 text-[10px] text-attention" title="Needs a human">
          <span className="size-[5px] rounded-full bg-attention" aria-hidden="true" />
          needs you
        </span>
      )
    case 'blocked':
      return (
        <span className="flex items-center gap-1 text-[10px] text-destructive" title="Blocked">
          <Flag size={10} aria-hidden="true" />
          blocked
        </span>
      )
    case 'blocking':
      return (
        <span
          className="flex items-center gap-1 text-[10px] text-orange-500"
          title="Blocking other tasks"
        >
          <ShieldAlert size={10} aria-hidden="true" />
          blocking
        </span>
      )
    case 'live':
      return (
        <span
          className="flex items-center gap-1 font-mono text-[9px] text-live tabular-nums"
          title={`${slot.count} agent${slot.count === 1 ? '' : 's'} working`}
          data-testid="epic-live-agents"
        >
          <BrailleSpinner size={9} />
          {slot.count} working
        </span>
      )
    case 'merge':
      return (
        <span
          className="font-mono text-[9px] text-attention tabular-nums"
          title={`${slot.ahead} commit${slot.ahead === 1 ? '' : 's'} ahead of the parent branch`}
        >
          ↑{slot.ahead}
        </span>
      )
    case 'subtree':
      return (
        <span
          className="flex items-center gap-1.5 font-mono text-[9px] text-muted-foreground tabular-nums"
          title={`${slot.done} of ${slot.total} subtasks done`}
        >
          <span className="h-[3px] w-[26px] overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-[var(--issue)] transition-[width] duration-300"
              style={{ width: `${Math.round((slot.done / slot.total) * 100)}%` }}
            />
          </span>
          {slot.done}/{slot.total}
        </span>
      )
    case 'stages':
      return (
        <>
          {slot.counts.map(({ stage, count }) => (
            <span
              key={stage}
              className="inline-flex items-center gap-0.5 font-mono text-[9px] text-muted-foreground tabular-nums"
              title={`${count} ${STAGE_LABELS[stage].toLowerCase()}`}
              data-testid={`stage-chip-${stage}`}
            >
              <StageGlyph stage={stage} size={10} />
              {count}
            </span>
          ))}
        </>
      )
    case 'labels':
      // Colour dots, not word pills. Three named labels used a third of the
      // card; the dots say "this one is tagged like that one" at a glance, and
      // the names are one hover away.
      return (
        <span className="flex items-center gap-[3px]" title={slot.labels.join(' · ')}>
          {slot.labels.map((label) => (
            <span
              key={label}
              className="size-[5px] rounded-[1.5px] bg-flow"
              style={{ backgroundColor: labelDotColor(label) }}
              aria-hidden="true"
            />
          ))}
          {slot.overflow > 0 && (
            <span className="font-mono text-[9px] text-text-faint">+{slot.overflow}</span>
          )}
        </span>
      )
    case 'due':
      return <span className="font-mono text-[9px] text-muted-foreground">{slot.label}</span>
    case 'estimate':
      return (
        <span className="font-mono text-[9px] text-muted-foreground tabular-nums">
          {slot.label}
        </span>
      )
  }
}

/**
 * A stable hue per label name.
 *
 * Labels are free text with no stored colour, so the dot has to derive one. A
 * hash into the issue palette's own hues keeps the board inside the product's
 * colour world and — because it is a pure function of the name — makes the same
 * label the same colour on every card, which is the only property that makes a
 * dot readable at all.
 */
const LABEL_DOT_HUES = ['#f43f5e', '#d946ef', '#8b5cf6', '#3b82f6', '#06b6d4', '#14b8a6', '#84cc16']
function labelDotColor(label: string): string {
  let hash = 0
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) % 100_003
  return LABEL_DOT_HUES[hash % LABEL_DOT_HUES.length] as string
}

export function IssueCard({
  issue,
  sessions,
  badges,
  stageCounts,
  progress,
  focused,
  selected,
  dragging,
  now,
  onOpen,
  onApprove,
  onToggleSelect,
  onContextMenu,
  onDragStart,
}: {
  issue: IssueViewModel
  /** This issue's member sessions, resolved by the board — the fleet stack. */
  sessions: SessionMeta[]
  badges: IssuesDisplay['badges']
  stageCounts?: { stage: IssueStage; count: number }[]
  progress?: EpicProgress | null
  focused: boolean
  selected: boolean
  /** This card is the one being dragged — it stays in place as a ghost. */
  dragging: boolean
  now: number
  onOpen: (id: IssueId) => void
  /** Proposed-column approve; absent on every other stage. */
  onApprove?: (id: IssueId) => void
  onToggleSelect: (id: IssueId) => void
  onContextMenu: (id: IssueId, event: ReactMouseEvent) => void
  onDragStart: (event: ReactPointerEvent, issue: IssueViewModel) => void
}): JSX.Element {
  const slots = issueCardStateSlots(issue, { badges, stageCounts, progress })
  const hex = issueColorHex(issue.color)
  const epic = isEpic(issue)
  return (
    <div
      className={cn(
        'issue-scope group/card relative',
        dragging && 'pointer-events-none opacity-30 saturate-50',
      )}
      style={hex ? ({ '--issue': hex } as React.CSSProperties) : undefined}
      data-issue-colored={hex ? 'true' : 'false'}
      onPointerDown={(event) => onDragStart(event, issue)}
    >
      <button
        data-pressable
        type="button"
        data-issue-id={issue.id}
        className={cn(
          // A card is dragged, not read: `select-none` stops a drag that starts
          // on the title from painting a text selection across the column.
          'flex w-full select-none flex-col gap-2 rounded-[9px] px-3.5 py-3 text-left',
          'issue-mix-6 issue-base-card issue-hairline-24 border',
          'transition-[background-color,border-color] duration-150 ease-out',
          'hover:issue-mix-11 hover:issue-hairline-42',
          selected && 'issue-mix-20 issue-hairline-55',
          focused && 'ring-2 ring-[var(--issue)]/60',
        )}
        title={issueIdTitle(issue)}
        onClick={(event) => (event.shiftKey ? onToggleSelect(issue.id) : onOpen(issue.id))}
        onContextMenu={(event) => onContextMenu(issue.id, event)}
      >
        <div className="flex h-[16px] items-center gap-2">
          <span
            className={cn(
              'font-mono text-[10px] text-[var(--issue-dim)] tabular-nums transition-opacity',
              'group-hover/card:opacity-0',
              selected && 'opacity-0',
            )}
          >
            {issueRefLabel(issue)}
          </span>
          <PriorityGlyph priority={issue.priority} size={12} />
          {epic && (
            <span
              className="font-mono text-[9px] text-[var(--issue-muted)] uppercase tracking-[0.08em]"
              title="Epic"
            >
              epic
            </span>
          )}
          {/* Type rides the IDENTITY row, not the state line — see the rank
              note in issue-card.ts. `task` is the default and every card would
              carry it, so only a departure from it is worth the ink. */}
          {badges.type && !epic && issue.type !== 'task' && (
            <span className="font-mono text-[9px] text-text-faint uppercase tracking-[0.08em]">
              {issue.type}
            </span>
          )}
          {issue.origin === 'agent' && (
            <span
              className="font-mono text-[9.5px] text-text-faint"
              role="img"
              title="Created by an agent"
              aria-label="Created by an agent"
            >
              ◇
            </span>
          )}
          <span className="ml-auto flex items-center gap-2">
            {badges.sessions && sessions.length > 0 && (
              <IssueFleetSummary sessions={sessions} unread={issue.unread === true} size={18} />
            )}
            <span className="font-mono text-[9.5px] text-text-faint tabular-nums">
              {cardAge(issue.updatedAt, now)}
            </span>
          </span>
        </div>

        <div className="line-clamp-2 min-w-0 break-words font-medium text-[13.5px] text-[var(--issue-bright)] leading-[1.4]">
          {issue.title}
        </div>

        {slots.length > 0 && (
          <div className="flex h-[15px] items-center gap-2.5 overflow-hidden whitespace-nowrap">
            {slots.map((slot) => (
              <StateSlot key={slot.kind} slot={slot} />
            ))}
          </div>
        )}
      </button>

      {/* Selection lives where the ref was: the checkbox fades in on hover in
          the same 12px, so the row never reflows and the affordance is finally
          visible (shift-click and `x` were the only ways to find it before). */}
      <button
        data-pressable
        type="button"
        aria-label={
          selected ? `Deselect ${issueRefLabel(issue)}` : `Select ${issueRefLabel(issue)}`
        }
        aria-pressed={selected}
        className={cn(
          'absolute top-[14px] left-[14px] size-3 rounded-[3px] border transition-opacity',
          'opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100',
          selected
            ? 'border-transparent bg-[var(--issue)] opacity-100'
            : 'border-border-strong bg-background hover:border-muted-foreground',
        )}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          onToggleSelect(issue.id)
        }}
      >
        {selected && (
          <svg viewBox="0 0 12 12" className="size-full text-background" aria-hidden="true">
            <path
              d="M3 6.2 5 8.2 9 3.9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>

      {/* Proposals keep their one decision, but it OVERLAYS the card's corner
          instead of adding a row beneath it: 140 proposals × a permanent
          three-button bar was 420 controls in one column, and a hover row that
          changes the card's height reflows everything below it. Everything else
          — approve & start, archive, the rest — is on the context menu and the
          bulk bar, which act on a selection instead of one card at a time. */}
      {onApprove && (
        <div
          className="pointer-events-none absolute right-[9px] bottom-[9px] flex translate-y-0.5 items-center gap-1 pl-6 opacity-0 transition-[opacity,transform] duration-150 ease-out group-hover/card:pointer-events-auto group-hover/card:translate-y-0 group-hover/card:opacity-100 focus-within:pointer-events-auto focus-within:translate-y-0 focus-within:opacity-100"
          style={{
            background:
              'linear-gradient(90deg, transparent, color-mix(in srgb, var(--issue) calc(11 * var(--issue-tint-scale, 1%)), var(--card)) 24px)',
          }}
          data-testid="proposal-actions"
        >
          <button
            data-pressable
            type="button"
            className="h-[24px] rounded-[5px] bg-primary px-2.5 font-medium text-[11px] text-primary-foreground transition-opacity hover:opacity-80"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onApprove(issue.id)
            }}
          >
            Approve
          </button>
        </div>
      )}
    </div>
  )
}
