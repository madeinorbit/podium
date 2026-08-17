/**
 * THE SHIPPING WORK SIDEBAR, IN A BROWSER, WITH NOTHING BEHIND IT (POD-1253).
 *
 * Renders the real `SidebarUnified` against the real stylesheets inside the
 * column box the shell gives it, so the artboard's numbers can be measured and
 * the fold's motion can be sampled on a still main thread. See
 * `harness/sidebar-store.ts` for why the live instance cannot answer that.
 *
 * Query string: `?rows=N` sizes the list, `?theme=…` picks the palette block.
 */
import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { SidebarUnified } from '@/features/worklist/SidebarUnified'
import '@/index.css'
import '@/styles.css'

const params = new URLSearchParams(location.search)
const theme = params.get('theme') ?? 'superade'
const mode = params.get('mode') ?? 'dark'
const width = Number(params.get('width') ?? 306)

document.documentElement.dataset.theme = theme
document.documentElement.classList.toggle('dark', mode === 'dark')
if (params.get('density'))
  document.documentElement.dataset.density = params.get('density') as string

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

createRoot(document.getElementById('root') as HTMLElement).render(<Harness />)
