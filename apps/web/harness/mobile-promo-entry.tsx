/**
 * THE TWO MOBILE-HANDOFF SURFACES, REAL, IN A BROWSER (POD-1320).
 *
 * Both ship as store-reading components, so the harness swaps `@/app/store` for
 * a stub (see `vite.mobile-promo.config.ts`) and renders everything else — the
 * real popover, the real QR, the real `styles.css` — inside a status strip and
 * a sidebar column of the shipping widths. The surrounding shell is deliberately
 * thin: it is here to place the two surfaces, not to be reviewed.
 */
import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MobileHandoffChip } from '@/features/mobile-handoff/MobileHandoffChip'
import { MobilePromoCard } from '@/features/mobile-handoff/MobilePromoCard'
import '@/index.css'
import '@/styles.css'

function Shell(): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: 720,
        height: 420,
        overflow: 'hidden',
        border: '1px solid var(--border)',
        borderRadius: 12,
        background: 'var(--background)',
        color: 'var(--text)',
      }}
    >
      <div style={{ display: 'flex', flex: '1 1 auto', minHeight: 0 }}>
        <div
          style={{
            display: 'flex',
            flex: '0 0 260px',
            flexDirection: 'column',
            borderRight: '1px solid var(--border)',
          }}
        >
          <div style={{ flex: '1 1 auto' }} />
          <MobilePromoCard />
          <div
            className="flex h-[35px] flex-none items-center border-hairline-bar border-t bg-muted px-[13px] font-mono text-[10px] text-text-faint"
            style={{ gap: 14 }}
          >
            <span>new task</span>
            <span>search</span>
          </div>
        </div>
        <div style={{ flex: '1 1 auto' }} />
      </div>
      <footer className="status-strip">
        <span className="status-strip-live">15 agents working</span>
        <span className="status-strip-seam" aria-hidden="true" />
        <span>POD-710 Editor-style task workspaces</span>
        <span className="status-strip-spacer" aria-hidden="true" />
        <MobileHandoffChip />
      </footer>
    </div>
  )
}

// The theme lives on <html> (`[data-theme="podium"].dark`), so the probe sets
// it there between shots rather than the page nesting two themed subtrees —
// nesting resolves half the tokens from the outer appearance and lies about dark.
document.documentElement.dataset.theme = 'podium'
document.documentElement.dataset.density = 'balanced'
createRoot(document.getElementById('root') as HTMLElement).render(
  // The shell mounts one of these at its root, and the QR plate's tooltip takes
  // its delay from it — without it the harness would hover on a timing the
  // product never uses.
  <TooltipProvider>
    <div style={{ display: 'flex', padding: 28, background: 'var(--background)' }}>
      <Shell />
    </div>
  </TooltipProvider>,
)
