/** Shipping sidebar with stubbed data. Use ?rows=N and ?mode=light|dark. */
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import { setClockWakeSource } from '@podium/mobx-helpers'
import { asUserId } from '@podium/model/browser'
import { createRoot } from 'react-dom/client'
import { attachWorklistPool } from '@/app/store-worklist-pool'
import { SidebarUnified } from '@/features/worklist/SidebarUnified'
import { ResizableAside } from '@/features/worklist/sidebar-common'
import { browserClockWakeSource } from '@/lib/clock-wake-source'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { createSidebarFixture } from '../test/sidebar-fixture'
import '@/index.css'
import '@/styles.css'

const params = new URLSearchParams(location.search)
const synthetic = createSidebarFixture(Number(params.get('rows') ?? 24))
setClockWakeSource(browserClockWakeSource)
document.documentElement.dataset.theme = 'podium'
document.documentElement.classList.toggle('dark', (params.get('mode') ?? 'dark') === 'dark')
if (params.get('density'))
  document.documentElement.dataset.density = params.get('density') as string

createRoot(document.getElementById('root') as HTMLElement).render(
  <StoreProvider
    principal={asClientPrincipal(asUserId('operator'))}
    config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
    api={synthetic.api}
    createReplicaFn={() => synthetic.replica}
    networkEnabled={false}
    onFatalError={(message) => {
      throw new Error(message)
    }}
    attachRuntime={(owner) => {
      void owner.access.refreshRepos()
      return attachWorklistPool(owner, (error) => {
        throw error
      })
    }}
  >
    <ConfirmProvider>
      <div className="desktop-shell-row" style={{ height: '100dvh' }} data-testid="sidebar-harness">
        <ResizableAside>
          <SidebarUnified />
        </ResizableAside>
        <div data-testid="stage" className="min-w-0 flex-1 bg-card" />
      </div>
    </ConfirmProvider>
  </StoreProvider>,
)
