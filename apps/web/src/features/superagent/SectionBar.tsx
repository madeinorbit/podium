import type { JSX, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The engraved column's compact section header (engraved-column.md §2.2) —
 * shared by the Tray (▤) and Super agent (✦) sections. Sections collapse TO
 * this bar, never further, so the bar is always visible and always carries the
 * section's "needs you" signal (count pill / unread dot) while collapsed.
 */
export function SectionBar({
  glyph,
  title,
  scope,
  open,
  onToggle,
  badge,
  actions,
  shadow = false,
  className,
  testId,
}: {
  glyph: string
  title: string
  /** Mono micro-label after the title, e.g. ISSUE SCOPE. */
  scope?: string
  open: boolean
  onToggle: () => void
  /** Attention signal shown in the bar (amber count pill / unread dot). */
  badge?: ReactNode
  /** Quiet trailing controls (stopPropagation is handled here). */
  actions?: ReactNode
  /** The open Super agent bar casts downward — the tray bar never does. */
  shadow?: boolean
  className?: string
  testId?: string
}): JSX.Element {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the chevron button is the accessible toggle; the bar surface is a convenience target
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users toggle via the chevron button
    <div
      data-testid={testId}
      data-open={open}
      className={cn(
        'flex flex-none cursor-pointer select-none items-center gap-2 border-hairline-bar bg-bar px-[13px] py-[5px]',
        shadow && 'shadow-[0_5px_10px_-5px_rgba(0,0,0,.9)]',
        className,
      )}
      onClick={onToggle}
    >
      <span className="flex-none text-[11px] leading-none text-attention" aria-hidden="true">
        {glyph}
      </span>
      <span className="flex-none text-[12px] font-semibold text-text-strong">{title}</span>
      {badge}
      {scope && (
        <span className="truncate font-mono text-[8px] tracking-[.12em] text-text-faint">
          {scope}
        </span>
      )}
      {actions && (
        // biome-ignore lint/a11y/noStaticElementInteractions: shields the real buttons inside from the bar toggle
        // biome-ignore lint/a11y/useKeyWithClickEvents: click-shield only — the buttons inside are keyboardable
        <span
          className="ml-auto flex flex-none items-center gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          {actions}
        </span>
      )}
      <button
        type="button"
        className={cn(
          'flex-none cursor-pointer border-0 bg-transparent p-0 text-[11px] leading-none text-text-dim hover:text-text-strong',
          !actions && 'ml-auto',
        )}
        aria-expanded={open}
        aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
        title={open ? `Collapse ${title}` : `Expand ${title}`}
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
      >
        {open ? '⌄' : '▸'}
      </button>
    </div>
  )
}

/** The amber tray-count pill shown in the collapsed Tray bar (3b variant 1). */
export function CountPill({ count }: { count: number }): JSX.Element | null {
  if (count <= 0) return null
  return (
    <span
      data-testid="tray-count-pill"
      className="flex h-[13px] min-w-[13px] flex-none items-center justify-center rounded-full bg-attention px-[3px] font-mono text-[7.5px] font-bold text-attention-foreground"
    >
      {count}
    </span>
  )
}

/** The 7px amber unread dot shown in the collapsed Super agent bar (3b variant 2). */
export function UnreadDot({ show }: { show: boolean }): JSX.Element | null {
  if (!show) return null
  return (
    <span
      data-testid="super-unread-dot"
      className="size-[7px] flex-none rounded-full bg-attention"
      role="status"
      aria-label="Unread activity"
    />
  )
}
