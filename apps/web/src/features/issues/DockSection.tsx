import { ChevronRight } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useCallback, useState } from 'react'
import type { UiState } from '@/app/replica'
import { useStoreSelector } from '@/app/store'
import { cn } from '@/lib/utils'

// ui-state key family for per-section open state; the legacy localStorage keys
// of the same names migrate in once (replica LEGACY_UI_PREFIXES).
const KEY_PREFIX = 'podium.dock.section.'

function readOpen(ui: UiState, key: string, fallback: boolean): boolean {
  const raw = ui.get(KEY_PREFIX + key)
  return raw === null ? fallback : raw === '1'
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
  const ui = useStoreSelector((s) => s.uiState)
  const [open, setOpen] = useState(() => readOpen(ui, storageKey, defaultOpen))
  const toggle = useCallback(() => {
    setOpen((o) => {
      ui.set(KEY_PREFIX + storageKey, o ? '0' : '1')
      return !o
    })
  }, [ui, storageKey])

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
