import type { JSX } from 'react'
import { cn } from '@/lib/utils'

/**
 * The unread cue that is NOT an agent tile.
 *
 * Fleet tiles stack and grow a `×N` for bigger tasks, so a blue dot on the
 * last glyph cannot mean "this session has something new". The mark lives
 * next to the title — one place, every surface — and the title itself goes
 * semibold. `reserve` keeps unread and read titles aligned.
 */
export function UnreadDot({
  className,
  reserve = false,
}: {
  className?: string
  /** Keep the 6px slot even when hidden so a click does not shift the title. */
  reserve?: boolean
}): JSX.Element {
  return (
    <span
      className={cn(
        'size-[6px] flex-none rounded-full',
        reserve ? 'invisible' : 'bg-info',
        className,
      )}
      data-testid={reserve ? undefined : 'row-unread-dot'}
      aria-hidden="true"
    />
  )
}

/** Semibold + info dot. Put the children (the title) between the optional
 *  leading slot and the trailing extras. */
export function unreadTitleClass(unread: boolean, selected: boolean): string {
  if (selected) return 'font-semibold text-text-strong'
  return unread ? 'font-semibold text-text-strong' : 'text-foreground'
}
