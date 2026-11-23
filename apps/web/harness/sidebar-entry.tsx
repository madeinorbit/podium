/** Shipping sidebar with stubbed data. Use ?rows=N and ?mode=light|dark;
 *  ?board=1 draws the issue board beside it; ?fresh=<title> creates an issue
 *  through the real generic create, left queued (the network is off);
 *  ?newtask=1 opens the real New task dialog, whose Create with Start work now
 *  queues an `issue.start` that stays pending here (POD-6421). */
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useCommands } from '@podium/client-core/react'
import { loadRecordDeclarations } from '@podium/client-core/records'
import { setClockWakeSource } from '@podium/mobx-helpers'
import { asUserId } from '@podium/model/browser'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { OperatorFocusProvider } from '@/app/operator-focus'
import { attachWorklistPool, useWorklistPool } from '@/app/store-worklist-pool'
import { ToolbarSlotProvider, ToolbarSlotTarget } from '@/app/ToolbarSlot'
import { TooltipProvider } from '@/components/ui/tooltip'
import { IssuesView } from '@/features/issues/IssuesView'
import { NewIssueDialog } from '@/features/issues/NewIssueDialog'
import { SidebarUnified } from '@/features/worklist/SidebarUnified'
import { ResizableAside } from '@/features/worklist/sidebar-common'
import { browserClockWakeSource } from '@/lib/clock-wake-source'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { createSidebarFixture } from '../test/sidebar-fixture'
import { createSidebarFoldFixture } from '../test/sidebar-fold-fixture'
import '@/index.css'
import '@/styles.css'

const params = new URLSearchParams(location.search)
const fresh = params.get('fresh')
const synthetic = params.has('foldBench')
  ? createSidebarFoldFixture()
  : createSidebarFixture(Number(params.get('rows') ?? 24))
/** The fixture's answers, and an empty answer for any other call the board makes. */
const fallback = (target: unknown, path: string[] = []): unknown =>
  new Proxy(typeof target === 'function' ? target : () => {}, {
    get(fn, key) {
      if (key === 'then') return undefined
      const own = target && typeof target === 'object' ? Reflect.get(target, key) : undefined
      return fallback(own, [...path, String(key)])
    },
    apply(fn, self, args) {
      return typeof target === 'function' ? Reflect.apply(target, self, args) : Promise.resolve([])
    },
  })
const api = (params.get('board') ? fallback(synthetic.api) : synthetic.api) as typeof synthetic.api
setClockWakeSource(browserClockWakeSource)
document.documentElement.dataset.theme = 'podium'
document.documentElement.classList.toggle('dark', (params.get('mode') ?? 'dark') === 'dark')
if (params.get('density'))
  document.documentElement.dataset.density = params.get('density') as string

/** The creating device's queued row before any server answer (POD-6400). */
function FreshTask({ title }: { title: string }) {
  const pool = useWorklistPool()
  const records = useCommands().records
  useEffect(() => {
    if (!pool) return
    let cancelled = false
    // The pool has attached its writer; declarations must load before newId.
    void loadRecordDeclarations().then(() => {
      if (cancelled) return
      return records.create('issueProjection', records.newId('issueProjection'), {
        title,
        repoPath: '/synthetic/project',
      })
    })
    return () => {
      cancelled = true
    }
  }, [pool, records, title])
  return null
}

/** The real dialog, closed by its own Create the way the shell closes it. */
function NewTask() {
  const [open, setOpen] = useState(true)
  return open ? <NewIssueDialog onClose={() => setOpen(false)} /> : null
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StoreProvider
    principal={asClientPrincipal(asUserId('operator'))}
    config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
    api={api}
    createReplicaFn={() => synthetic.replica}
    networkEnabled={false}
    onFatalError={(message) => {
      throw new Error(message)
    }}
    attachRuntime={(owner) => {
      return attachWorklistPool(owner, (error) => {
        throw error
      })
    }}
  >
    <ConfirmProvider>
      {fresh && <FreshTask title={fresh} />}
      <div className="desktop-shell-row" style={{ height: '100dvh' }} data-testid="sidebar-harness">
        <ResizableAside>
          <SidebarUnified />
        </ResizableAside>
        <div data-testid="stage" className="flex min-w-0 flex-1 flex-col bg-card">
          {params.get('board') && (
            <TooltipProvider>
              <OperatorFocusProvider missionId={null}>
                <ToolbarSlotProvider>
                  <ToolbarSlotTarget />
                  <main className="flex min-h-0 flex-1">
                    <IssuesView />
                  </main>
                </ToolbarSlotProvider>
              </OperatorFocusProvider>
            </TooltipProvider>
          )}
        </div>
      </div>
      {params.get('newtask') && (
        <TooltipProvider>
          <NewTask />
        </TooltipProvider>
      )}
    </ConfirmProvider>
  </StoreProvider>,
)
