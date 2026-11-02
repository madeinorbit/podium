/**
 * FIRST FLIGHTS MOMENT 4, team-forms (POD-2199): the shipping `FlightDeck`
 * inside the shell's wrapper chain (see deck-entry.tsx) and a `TipHost` with a
 * fresh log, so the tip anchors to the real coordinator card and sub-task row.
 */
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import { createRoot } from 'react-dom/client'
import { FlightDeck } from '@/app/FlightDeck'
import { OperatorFocusProvider } from '@/app/operator-focus'
import { DockIssueProvider } from '@/features/issues/dock-issue'
import { TipHost } from '@/features/tips'
import { MemoryTipLog } from '@/features/tips/memory-tip-log'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import '@/index.css'
import '@/styles.css'
import { issue, session, state } from './deck-store-stub'

const params = new URLSearchParams(location.search)
document.documentElement.setAttribute('data-theme', 'podium')
document.documentElement.classList.toggle('dark', params.get('theme') !== 'light')
const ago = (minutes: number): string =>
  new Date(Date.parse('2026-01-01T00:30:00.000Z') - minutes * 60_000).toISOString()
const leadOnly = params.has('lead-only')

state.issues = [
  issue('root', {
    id: 'root',
    displayRef: 'POD-1700',
    title: 'Checkout revamp',
    description: 'Split payment capture from cart mutation, then land fraud checks.',
    stage: 'in_progress',
    type: 'task',
    memberSessionIds: ['coord'],
    coordinatorSessionId: 'coord',
  }),
  issue('t1', {
    parentId: 'root',
    displayRef: 'POD-1701',
    title: 'Payment intents',
    memberSessionIds: leadOnly ? [] : ['w1'],
  }),
  issue('t2', { parentId: 'root', displayRef: 'POD-1702', title: 'Fraud checks' }),
]
state.sessions = [
  session('coord', {
    issueId: 'root',
    displayRef: 'POD-1700-A',
    name: 'Checkout coordinator',
    title: 'Checkout coordinator',
    createdAt: ago(60),
    agentState: { phase: 'working', since: ago(5) },
  }),
  ...(leadOnly
    ? []
    : [
        session('w1', {
          issueId: 't1',
          displayRef: 'POD-1701-A',
          name: 'Intents implementation',
          title: 'Intents implementation',
          createdAt: ago(20),
          // A sub-task that needs the user opens by default, so its row is drawn.
          agentState: {
            phase: 'needs_user',
            since: ago(3),
            need: { kind: 'question', summary: 'Charge idempotency key format?' },
          },
        }),
      ]),
]
state.activity = {}

function Harness() {
  return (
    <TipHost log={new MemoryTipLog()}>
      <div className="desktop-shell">
        <div style={{ height: 'var(--topbar-h)', flex: 'none' }} />
        <div className="desktop-shell-row">
          <div
            className="flex min-h-0 min-w-0 flex-[0_1_auto] overflow-hidden"
            data-flight-deck-shell="open"
            style={{ width: 400 }}
          >
            <div
              className="relative flex min-w-0 max-w-[45vw] flex-[0_1_auto]"
              data-resizable-column="podium:superagent:width"
              style={{ width: 400 }}
            >
              <OperatorFocusProvider missionId="root">
                <ConfirmProvider>
                  <DockIssueProvider>
                    <FlightDeck onCollapse={() => {}} />
                  </DockIssueProvider>
                </ConfirmProvider>
              </OperatorFocusProvider>
            </div>
          </div>
          <div className="min-w-0 flex-1" />
        </div>
        <div style={{ height: 'var(--status-strip-h)', flex: 'none' }} />
      </div>
    </TipHost>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<Harness />)
