/**
 * THE SHIPPING WORK SIDEBAR, IN A BROWSER, WITH NOTHING BEHIND IT (POD-1253).
 *
 * Renders the real `SidebarUnified` against the real stylesheets inside the
 * column box the shell gives it, so the artboard's numbers can be measured and
 * the fold's motion can be sampled on a still main thread. See
 * `harness/sidebar-store.ts` for why the live instance cannot answer that.
 *
 * Query string: `?rows=N` sizes the list, `?mode=…` picks light or dark,
 * `?rail=1` renders the COLLAPSED column instead — the 58px aside with its
 * ⟩ header band, exactly as `AppShell` builds it, because the rail's spacing is
 * only readable against the column's real width and its real chrome ends — and
 * `?fold=1` puts the two of them either side of the REAL fold (POD-1584), so
 * the gesture between them can be watched and sampled. That mode drives
 * `useColumnFold`, the same hook the shell drives, and renders the same
 * `CollapsedSidebar` and the same dissolving ghost (POD-1658) — the fold's
 * worst frame is the SWAP at its end, so a harness that hand-rolled either side
 * of it would be measuring the one thing it is here to check.
 */
import { ChevronLeft } from 'lucide-react'
import type { JSX } from 'react'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CollapsedSidebar } from '@/features/worklist/CollapsedSidebar'
import { SidebarUnified } from '@/features/worklist/SidebarUnified'
import {
  ResizableAside,
  SIDEBAR_RAIL_WIDTH,
  SIDEBAR_WIDTH_DEFAULT,
} from '@/features/worklist/sidebar-common'
import { useColumnFold } from '@/features/worklist/use-column-fold'
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
      <CollapsedSidebar />
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
      // `worklist-column` is the aside's own class (`SIDEBAR_ASIDE_CLASS`), and
      // it carries the container query `Add repository` reads. Without it the
      // harness measures a column that declares no container and the button
      // never gives up its words — which is the exact thing being verified.
      className="worklist-column"
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

/** THE FOLD, end to end: the shell's persistent wrapper, its two branches and
 *  the real hook between them. The stage beside it is a stand-in for the rest
 *  of the window — the fold is only honest if something is there to be pushed. */
function FoldHarness(): JSX.Element {
  const [collapsed, setCollapsed] = useState(params.get('folded') === '1')
  const fold = useColumnFold({
    foldedWidth: SIDEBAR_RAIL_WIDTH,
    openWidth: () => width || SIDEBAR_WIDTH_DEFAULT,
    onFold: setCollapsed,
  })
  return (
    <div className="desktop-shell-row" style={{ height: '100dvh' }}>
      <div
        data-testid="sidebar-shell"
        ref={fold.ref}
        className="sidebar-shell"
        data-sidebar-shell={collapsed ? 'folded' : 'open'}
        data-sidebar-folding={fold.folding ? 'true' : undefined}
        style={{ width: fold.width ?? undefined }}
      >
        {collapsed && !fold.folding ? (
          <CollapsedSidebar onExpand={() => fold.fold(false)} />
        ) : (
          <div className="relative z-10 flex min-w-0 flex-[0_1_auto]">
            <ResizableAside>
              <SidebarUnified />
            </ResizableAside>
            <button
              type="button"
              className="sidebar-collapse-control"
              aria-label="Collapse sidebar"
              onClick={() => fold.fold(true)}
            >
              <ChevronLeft size={12} aria-hidden="true" />
            </button>
          </div>
        )}
        {fold.folding && (
          <div ref={fold.ghostRef} className="sidebar-fold-ghost" aria-hidden="true">
            <div ref={fold.ghostContentRef} className="sidebar-fold-ghost-inner">
              <CollapsedSidebar />
            </div>
          </div>
        )}
      </div>
      <div
        data-testid="stage"
        style={{
          flex: 1,
          minWidth: 0,
          background: 'var(--card)',
          borderLeft: '1px solid var(--border)',
        }}
      />
    </div>
  )
}

const surface = params.get('fold') ? (
  <FoldHarness />
) : params.get('rail') ? (
  <RailHarness />
) : (
  <Harness />
)

// The row's right-click menu raises the app-wide confirm for Archive and
// Delete (POD-1077) and throws without its provider, which `AppShell` supplies
// in the real tree. The harness is only honest about the menu if it has one.
createRoot(document.getElementById('root') as HTMLElement).render(
  <ConfirmProvider>{surface}</ConfirmProvider>,
)
