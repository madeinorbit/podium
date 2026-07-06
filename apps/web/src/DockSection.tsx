import { ChevronRight } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useCallback, useState } from 'react'
import { cn } from '@/lib/utils'

const KEY_PREFIX = 'podium.dock.section.'

function readOpen(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + key)
    return raw === null ? fallback : raw === '1'
  } catch {
    return fallback
  }
}

/** Collapsible dock section: micro-label header with a count chip and a
 *  rotating chevron; the body collapses via a grid-rows transition (height
 *  animates without measuring). Open state persists per `storageKey`. */
export function DockSection({
  storageKey,
  title,
  count,
  accent,
  defaultOpen = true,
  children,
}: {
  storageKey: string
  title: string
  count?: number
  /** Optional accent class for the header dot (e.g. a stage color). */
  accent?: string
  defaultOpen?: boolean
  children: ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(() => readOpen(storageKey, defaultOpen))
  const toggle = useCallback(() => {
    setOpen((o) => {
      try {
        localStorage.setItem(KEY_PREFIX + storageKey, o ? '0' : '1')
      } catch {
        /* private mode */
      }
      return !o
    })
  }, [storageKey])

  return (
    <section className="border-b border-border/60">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="group flex w-full items-center gap-1.5 px-3 py-2 text-left hover:bg-accent/40"
      >
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={cn(
            'flex-none text-muted-foreground/70 transition-transform duration-200',
            open && 'rotate-90',
          )}
        />
        {accent && <span className={cn('size-1.5 flex-none rounded-full', accent)} />}
        <span className="text-[11px] font-semibold tracking-[0.1em] text-muted-foreground uppercase group-hover:text-foreground">
          {title}
        </span>
        {count !== undefined && count > 0 && (
          <span className="ml-auto rounded-full bg-muted px-1.5 py-px font-mono text-[10px] tabular-nums text-muted-foreground">
            {count}
          </span>
        )}
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="px-3 pb-3">{children}</div>
        </div>
      </div>
    </section>
  )
}
