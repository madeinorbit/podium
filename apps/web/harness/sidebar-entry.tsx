/**
 * THE SHIPPING WORK SIDEBAR, IN A BROWSER, WITH NOTHING BEHIND IT (POD-1253).
 *
 * Renders the real `SidebarUnified` against the real stylesheets inside the
 * column box the shell gives it, so the artboard's numbers can be measured and
 * the fold's motion can be sampled on a still main thread. See
 * `harness/sidebar-store.ts` for why the live instance cannot answer that.
 *
 * Query string: `?rows=N` sizes the list, `?mode=…` picks light or dark,
 * and `?rail=1` renders the COLLAPSED column instead — the 58px aside with its
 * ⟩ header band, exactly as `AppShell` builds it, because the rail's spacing is
 * only readable against the column's real width and its real chrome ends.
 */
import { ChevronRight } from 'lucide-react'
import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { SidebarRail } from '@/features/worklist/SidebarRail'
import { SidebarUnified } from '@/features/worklist/SidebarUnified'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import '@/index.css'
import '@/styles.css'

const params = new URLSearchParams(location.search)
const mode = params.get('mode') ?? 'dark'
const width = Number(params.get('width') ?? 306)

document.documentElement.dataset.theme = 'podium'
document.documentElement.classList.toggle('dark', mode === 'dark')
if (params.get('density'))
  document.documentElement.dataset.density = params.get('density') as string

/** The collapsed aside, reproduced from `AppShell`: same class, same header
 *  band, same child. Anything less and the 58px column is a guess. */
function RailHarness(): JSX.Element {
  return (
    <div style={{ height: '100dvh', display: 'flex', background: 'var(--background)' }}>
      <aside className="collapsed-sidebar" aria-label="Collapsed work sidebar">
        <button type="button" className="collapsed-sidebar-expand" aria-label="Expand sidebar">
          <ChevronRight size={15} aria-hidden="true" />
        </button>
        <SidebarRail />
      </aside>
    </div>
  )
}

function Harness(): JSX.Element {
  return (
    // The column's own box, as `ResizableAside` gives it: a fixed-width flex
    // column on the sidebar ground, full window height. Reproducing the box
    // matters — a hand-rolled wrapper lets the scroller grow past the window and
    // every height number becomes optimistic.
    <div
      data-testid="sidebar-harness"
      style={{
        width,
        height: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: 'var(--sidebar)',
        borderRight: '1px solid var(--hairline-bar)',
      }}
    >
      <SidebarUnified />
    </div>
  )
}

// The row's right-click menu raises the app-wide confirm for Archive and
// Delete (POD-1077) and throws without its provider, which `AppShell` supplies
// in the real tree. The harness is only honest about the menu if it has one.
createRoot(document.getElementById('root') as HTMLElement).render(
  <ConfirmProvider>{params.get('rail') ? <RailHarness /> : <Harness />}</ConfirmProvider>,
)
