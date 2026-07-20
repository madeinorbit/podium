import type { IssueWire } from '@podium/protocol'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { BrailleSpinner } from '@/lib/motion'
import { deriveTrayItems, workingSessionCount } from './derive-tray'
import { itemKey, type TrayActions, TrayCard } from './TrayCard'

/**
 * The Tray (engraved-column.md §2.3–§2.4): ONLY items that need a human —
 * review cards with action rows, question cards with answer chips. Working and
 * status rows never render here; when nothing waits, one quiet line with a live
 * count of agents still working replaces all cards. Total stillness after a
 * card lands IS the "needs you" signal.
 */
export function Tray({
  issues,
  selectedIssueId,
  actions,
  maxHeight,
  dismissedOffers,
}: {
  issues: IssueWire[]
  selectedIssueId: string | null
  actions: TrayActions
  /** Set by the tray/chat split handle; null = size to content. */
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

  const items = deriveTrayItems(issues, selectedIssueId, dismissedOffers)
  if (items.length === 0) {
    const working = workingSessionCount(issues, selectedIssueId)
    return (
      <div
        data-testid="tray-empty"
        className="flex flex-none items-center justify-center gap-[9px] px-3 pt-4 pb-[17px]"
      >
        <span className="text-[12px] text-[#3f3f4a]" aria-hidden="true">
          ✓
        </span>
        <span className="text-[11px] text-text-dim">Nothing waiting on you</span>
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
      className="flex flex-none flex-col gap-1.5 overflow-y-auto px-3 pt-2 pb-2.5"
      style={maxHeight !== null ? { maxHeight } : undefined}
    >
      {items.map((item) => (
        <TrayCard key={itemKey(item)} item={item} issues={issues} actions={actions} now={now} />
      ))}
    </div>
  )
}
