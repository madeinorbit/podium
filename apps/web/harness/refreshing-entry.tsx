/** Shipping web and phone layouts; only the authority and platform services are stubbed. */
import { createRoot } from 'react-dom/client'
import { FlightDeck } from '@/app/FlightDeck'
import { OperatorFocusProvider } from '@/app/operator-focus'
import { ToolbarSlotProvider, ToolbarSlotTarget } from '@/app/ToolbarSlot'
import { TooltipProvider } from '@/components/ui/tooltip'
import { DockIssueProvider } from '@/features/issues/dock-issue'
import { IssuesView } from '@/features/issues/IssuesView'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { IssuesScreen } from '../../mobile/src/screens/IssuesScreen'
import { MissionDetailsScreen } from '../../mobile/src/screens/MissionDetailsScreen'
import { initialize } from './refreshing-state'
import '@/index.css'
import '@/styles.css'
import './refreshing.css'

const query = new URLSearchParams(location.search)
const phone = query.get('platform') === 'phone'
const board = query.get('screen') === 'board'
document.documentElement.classList.add('dark')
document.documentElement.dataset.theme = 'podium'
document.body.style.margin = '0'

void initialize()
  .then(() =>
    createRoot(document.getElementById('root')!).render(
      <TooltipProvider>
        <ConfirmProvider>
          <OperatorFocusProvider missionId="root">
            <DockIssueProvider>
              <ToolbarSlotProvider>
                <div
                  className={phone ? undefined : 'desktop-shell'}
                  data-refreshing-layout
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    height: '100vh',
                    width: '100vw',
                    overflow: 'hidden',
                    background: 'var(--background)',
                  }}
                >
                  {!phone && board ? (
                    <div style={{ padding: 12 }}>
                      <ToolbarSlotTarget />
                    </div>
                  ) : null}
                  {phone ? (
                    board ? (
                      <IssuesScreen />
                    ) : (
                      <MissionDetailsScreen />
                    )
                  ) : board ? (
                    <IssuesView />
                  ) : (
                    <FlightDeck onCollapse={() => {}} />
                  )}
                </div>
              </ToolbarSlotProvider>
            </DockIssueProvider>
          </OperatorFocusProvider>
        </ConfirmProvider>
      </TooltipProvider>,
    ),
  )
  .catch(console.error)
