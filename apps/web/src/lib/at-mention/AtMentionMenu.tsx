import { FileCode2, FolderGit2, GitBranch, Hash, MessagesSquare } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import type { AtMentionKind, AtOption } from './at-mention'
import type { AtMention } from './useAtMention'

/**
 * THE @-MENTION MENU (POD-412) — the picker's only pixels, drawn once for every
 * composer that mounts `useAtMention`.
 *
 * A popover above the composer, in the app's shipped popover treatment (Chip
 * tier, one hairline, the `--carve-popover-*` lift — DESIGN.md "carved, not
 * floating": at-rest surfaces cast nothing, transient overlays may lift).
 *
 * Three columns, in the order a Linear-style picker is read: an icon that says
 * WHAT KIND without spending a word on it, the identifier you typed toward, and
 * the dim context that tells two similar identifiers apart. The identifier is
 * mono because every one of them is a token — a ref, a filename, a branch — and
 * the detail is not, because titles are prose.
 *
 * The highlight follows the keyboard AND the pointer, and the two share one
 * index: a menu where hovering does not move the selection will insert the row
 * you were not looking at.
 */
const KIND_ICON: Record<AtMentionKind, typeof Hash> = {
  issue: Hash,
  file: FileCode2,
  repo: FolderGit2,
  worktree: GitBranch,
  conversation: MessagesSquare,
}

export function AtMentionMenu({
  mention,
  hint,
  className,
}: {
  mention: AtMention
  /** Optional trailing line — what this composer can reference, in its words. */
  hint?: string
  className?: string
}): JSX.Element | null {
  const listRef = useRef<HTMLDivElement | null>(null)
  const { open, options, activeIndex } = mention

  // Keep the keyboard-selected row in view: the list caps at ~9 rows and the
  // arrow keys walk past that.
  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  if (!open) return null

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Insert a reference"
      data-testid="at-mention-menu"
      className={cn(
        'absolute right-0 bottom-[calc(100%+10px)] left-0 z-30 flex max-h-[268px] max-w-[520px] flex-col overflow-y-auto rounded-md border border-input bg-muted font-sans shadow-[0_-8px_24px_var(--carve-popover-far)]',
        className,
      )}
    >
      {options.map((option, i) => (
        <MenuRow
          key={option.id}
          option={option}
          index={i}
          active={i === activeIndex}
          onHover={mention.setActiveIndex}
          onPick={mention.choose}
        />
      ))}
      {hint !== undefined && (
        <div className="sticky bottom-0 border-t border-border bg-muted px-2.5 pt-1 pb-1.5 text-[10px] text-muted-foreground/70">
          {hint}
        </div>
      )}
    </div>
  )
}

function MenuRow({
  option,
  index,
  active,
  onHover,
  onPick,
}: {
  option: AtOption
  index: number
  active: boolean
  onHover: (index: number) => void
  onPick: (option: AtOption) => void
}): JSX.Element {
  const Icon = KIND_ICON[option.kind]
  return (
    <button
      data-pressable
      data-index={index}
      type="button"
      role="option"
      aria-selected={active}
      // A mouseDOWN inside the menu would blur the textarea before the click
      // lands, and a blurred composer loses the caret the insertion needs.
      onMouseDown={(e) => e.preventDefault()}
      className={cn(
        'flex w-full min-w-0 cursor-pointer items-baseline gap-2 px-2.5 py-[7px] text-left text-xs',
        active ? 'bg-accent text-foreground' : 'text-foreground',
      )}
      onMouseEnter={() => onHover(index)}
      onClick={() => onPick(option)}
    >
      <Icon
        size={12}
        aria-hidden="true"
        className={cn('flex-none translate-y-[1.5px]', active ? 'text-primary' : 'text-text-dim')}
      />
      <span className="max-w-[46%] flex-none overflow-hidden text-ellipsis whitespace-nowrap font-mono font-semibold">
        {option.label}
      </span>
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground/70">
        {option.detail}
      </span>
    </button>
  )
}
