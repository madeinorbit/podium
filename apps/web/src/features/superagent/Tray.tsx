import type { IssueWire } from '@podium/protocol'
import type { JSX, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { BrailleSpinner } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { deriveTrayItems, workingSessionCount } from './derive-tray'
import { itemKey, type TrayActions, TrayCard } from './TrayCard'

/** Card keys this app session has already shown. A card runs its arrival
 *  choreography exactly once — when its key first APPEARS while the tray is
 *  live — never again on collapse/expand remounts or scroll. Module-level so
 *  the memory survives Tray unmounts; `primed` keeps the very first render
 *  (a full page load) from replaying every existing card's arrival. */
const seen = new Set<string>()
let primed = false

/** Insertion unfold (§2.3-v3): grid-template-rows 0fr→1fr — NEVER animate
 *  height (measure-at-auto snaps; see the repo's height-transition trap). */
function ArrivalWrap({ arrive, children }: { arrive: boolean; children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(!arrive)
  useEffect(() => {
    if (!arrive) return
    // Double rAF: the 0fr state must paint once before 1fr lands, or the
    // transition never runs.
    let inner: number | null = null
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setOpen(true))
    })
    return () => {
      cancelAnimationFrame(outer)
      if (inner !== null) cancelAnimationFrame(inner)
    }
  }, [arrive])
  return (
    <div className={cn('tray-ins', open && 'tray-ins-open')}>
      <div>{children}</div>
    </div>
  )
}

/**
 * The GLOBAL Tray (engraved-column.md §2.3-v3 + §5): every live offer and
 * question across all tasks, always — no issue scoping. Newest-first; the
 * selected issue only adds the colour ring on its cards. Working, status and
 * finished/done rows never render here [POD-198] — the tray is attention
 * only, cleanup lives on the board/sidebar. When nothing waits, one quiet
 * line with a machine-wide count of agents still working replaces all cards.
 * Total stillness after a card lands IS the "needs you" signal.
 */
export function Tray({
  issues,
  selectedIssueId,
  actions,
  maxHeight,
  dismissedOffers,
}: {
  issues: IssueWire[]
  /** Ring-only (§5): never narrows or re-sorts the tray. */
  selectedIssueId: string | null
  actions: TrayActions
  /** Set by the tray/chat split handle; null = a default viewport-relative
   *  cap applies instead (the tray must never push the rest of the column
   *  off screen [POD-198]). */
  maxHeight: number | null
  /** Offer cards optimistically consumed by a click (derive-tray offerKey). */
  dismissedOffers?: ReadonlySet<string>
}): JSX.Element {
  // Coarse "ago" stamps tick on a slow clock — the tray is deliberately still.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const items = deriveTrayItems(issues, dismissedOffers)
  // Arrival bookkeeping runs during render so `arrived` is true on the card's
  // FIRST paint (an effect would be a frame late and the morphs would miss).
  // Marking keys as seen is idempotent, so StrictMode double-renders agree.
  const arriving = new Set<string>()
  for (const item of items) {
    const key = itemKey(item)
    if (!seen.has(key)) {
      if (primed) arriving.add(key)
      seen.add(key)
    }
  }
  primed = true

  if (items.length === 0) {
    const working = workingSessionCount(issues)
    return (
      <div
        data-testid="tray-empty"
        className="flex flex-none items-center justify-center gap-[9px] px-3 pt-4 pb-[17px]"
      >
        <span className="text-[12px] text-[#3f3f4a]" aria-hidden="true">
          ✓
        </span>
        <span className="text-[11px] text-text-dim">Nothing waiting on you — anywhere</span>
        {working > 0 && (
          <span className="flex items-center gap-1.5 font-mono text-[9px] text-live">
            <BrailleSpinner size={9} className="min-w-2" />
            {working} agent{working === 1 ? '' : 's'} working
          </span>
        )}
      </div>
    )
  }

  return (
    <div
      data-testid="tray-cards"
      className={cn(
        'flex flex-none flex-col gap-1.5 overflow-y-auto px-3 pt-2 pb-2.5',
        // No split-handle height → a static viewport-relative cap [POD-198]:
        // the card stack scrolls internally instead of pushing the chat and
        // section bars off screen. A CSS max-height, never animated (the
        // repo's height-transition trap); ArrivalWrap's grid-rows unfold
        // works unchanged inside the scroll container.
        maxHeight === null && 'max-h-[42vh]',
      )}
      style={maxHeight !== null ? { maxHeight } : undefined}
    >
      {items.map((item) => {
        const key = itemKey(item)
        const arrive = arriving.has(key)
        return (
          <ArrivalWrap key={key} arrive={arrive}>
            <TrayCard
              item={item}
              issues={issues}
              actions={actions}
              now={now}
              selected={selectedIssueId !== null && item.issue.id === selectedIssueId}
              arrived={arrive}
            />
          </ArrivalWrap>
        )
      })}
    </div>
  )
}
