/** Shipping sidebar with stubbed data. Use ?rows=N and ?mode=light|dark. */
import { createRoot } from 'react-dom/client'
import { SidebarUnified } from '@/features/worklist/SidebarUnified'
import { ResizableAside } from '@/features/worklist/sidebar-common'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import '@/index.css'
import '@/styles.css'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = 'podium'
document.documentElement.classList.toggle('dark', (params.get('mode') ?? 'dark') === 'dark')
if (params.get('density'))
  document.documentElement.dataset.density = params.get('density') as string

createRoot(document.getElementById('root') as HTMLElement).render(
  <ConfirmProvider>
    <div className="desktop-shell-row" style={{ height: '100dvh' }} data-testid="sidebar-harness">
      <ResizableAside>
        <SidebarUnified />
      </ResizableAside>
      <div data-testid="stage" className="min-w-0 flex-1 bg-card" />
    </div>
  </ConfirmProvider>,
)
