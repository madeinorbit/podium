import { X } from 'lucide-react'
import type { JSX } from 'react'
import { useStoreSelector } from '@/app/store'
import { DeferredMobileHandoffQr } from './DeferredMobileHandoffQr'
import { useHasFirstTask, useMobileHandoffUrl, useMobilePromoDismissed } from './mobile-handoff'

/**
 * THE PROMO CARD on the work column's floor (POD-1320, design 1c).
 *
 * It sits directly above the `new task · search` row — the last thing you pass
 * on the way out — rather than as a row among the work, which would put an
 * invitation in the list of things you are responsible for.
 *
 * APPEARS after the first task exists: this is the one surface that reaches
 * someone who was not looking for the app, which is exactly why it has to be
 * earned instead of shown on an empty shell.
 *
 * DISMISSES FOREVER, in one click, with no second ask. The answer is stored
 * per user (see `useMobilePromoDismissed`), so turning it down once turns it
 * down everywhere; the code stays reachable from the status strip and from
 * Settings → Connected devices, which is where a paired phone is managed anyway.
 */
export function MobilePromoCard(): JSX.Element | null {
  const trpc = useStoreSelector((s) => s.trpc)
  const url = useMobileHandoffUrl(trpc)
  const hasFirstTask = useHasFirstTask()
  const [dismissed, setDismissed] = useMobilePromoDismissed()
  if (!hasFirstTask || dismissed) return null
  return (
    <div className="mobile-promo-card" data-testid="mobile-promo-card">
      <DeferredMobileHandoffQr url={url} size={56} />
      <div className="mobile-promo-copy">
        <span className="mobile-promo-title">Podium in your pocket</span>
        <span className="mobile-promo-line">
          Answer asks and read updates while you are away from the desk.
        </span>
      </div>
      <button
        type="button"
        className="mobile-promo-dismiss"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        title="Dismiss"
        data-testid="mobile-promo-dismiss"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  )
}
