/**
 * THE FLIGHT DECK, REAL, IN A BROWSER AT EVERY WIDTH (POD-1226).
 *
 * The deck's open defects are all geometric — a rail that has to read as ONE
 * line from the mission header down to the last agent row, and four columns that
 * have to stay columns while the operator drags the column across its whole
 * 300–620px range. Neither can be measured where there is no layout, so this
 * mounts the shipping `FlightDeck` inside the shell's REAL wrapper chain
 * (`.desktop-shell` › `.desktop-shell-row` › the shell's width box › the
 * `ResizableColumn` root) against the real `styles.css`.
 *
 * Reproducing that chain is not decoration: the deck's own container queries key
 * off the used inline size of its rows, so a hand-rolled wrapper measures a
 * different ladder than the one that ships.
 */
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { FlightDeck } from '@/app/FlightDeck'
import { OperatorFocusProvider } from '@/app/operator-focus'
import { setHoveredSession } from '@/app/session-hover'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import '@/index.css'
import '@/styles.css'
import { issue, session, state } from './deck-store-stub'

declare global {
  interface Window {
    deck: {
      setWidth: (px: number) => void
      /** Swap the fixture; `bump` re-renders against the new one. */
      setMission: (name: keyof typeof MISSIONS) => void
      setIssueColor: (hex: string | null) => void
      point: (sessionId: string | null) => void
    }
  }
}

/**
 * The screenshot the operator filed (POD-1226): a planning mission whose one
 * agent is asking. That row carries every mark the gutter can hold at once —
 * the branch rail, the elbow, the selection tick and the attention rule — which
 * is exactly why it was the row that showed the collision.
 */
const MISSIONS = {
  /** The filed case, verbatim. */
  asking: () => {
    state.issues = [
      issue('root', {
        id: 'root',
        displayRef: 'POD-1211',
        title: 'JSON panel reading experience',
        stage: 'planning',
        memberSessionIds: ['s1'],
      }),
    ]
    state.sessions = [
      session('s1', {
        issueId: 'root',
        displayRef: 'POD-1211-A',
        name: 'JSON panel UX direction',
        title: 'JSON panel UX direction',
        agentState: { phase: 'needs_user', since: '2026-01-01T00:00:00.000Z' },
      }),
    ]
    state.selectedIssueId = 'root'
    state.paneA = 's1'
  },
  /** The same mission with a full roster: a coordinator (coloured rail, filled
   *  row), a task lead, a spawned peer, a working agent, and sub-tasks — every
   *  cell of the four-column row occupied at once. */
  roster: () => {
    state.issues = [
      issue('root', {
        id: 'root',
        displayRef: 'POD-1211',
        title: 'JSON panel reading experience',
        stage: 'planning',
        memberSessionIds: ['s1', 's2'],
        coordinatorSessionId: 's1',
      }),
      issue('t1', {
        parentId: 'root',
        displayRef: 'POD-1212',
        title: 'Viewer folding and search',
        memberSessionIds: ['s3'],
        coordinatorSessionId: 's3',
      }),
      issue('t2', {
        parentId: 'root',
        displayRef: 'POD-1213',
        title: 'Reader tier for long payloads',
        memberSessionIds: ['s4', 's5'],
      }),
      issue('t3', { parentId: 't2', displayRef: 'POD-1214', title: 'Nested probe' }),
      issue('p1', {
        parentId: 'root',
        displayRef: 'POD-1215',
        stage: 'proposed',
        title: 'Split the payload panel',
      }),
    ]
    state.sessions = [
      session('s1', {
        issueId: 'root',
        displayRef: 'POD-1211-A',
        name: 'Spine designer',
        title: 'Spine designer',
        agentState: {
          phase: 'working',
          since: '2026-01-01T00:28:00.000Z',
          workingMsTotal: 900_000,
        },
      }),
      session('s2', {
        issueId: 'root',
        displayRef: 'POD-1211-B',
        name: 'JSON panel UX direction',
        title: 'JSON panel UX direction',
        agentState: { phase: 'needs_user', since: '2026-01-01T00:00:00.000Z' },
      }),
      session('s3', {
        issueId: 't1',
        displayRef: 'POD-1212-A',
        name: 'Folding behaviour',
        title: 'Folding behaviour',
      }),
      session('s4', {
        issueId: 't2',
        displayRef: 'POD-1213-A',
        name: 'Reader tier measurements',
        title: 'Reader tier measurements',
        spawnedBy: 'session:s1',
      }),
      session('s5', {
        issueId: 't2',
        displayRef: 'POD-1213-B',
        name: 'Long payload sweep',
        title: 'Long payload sweep',
      }),
    ]
    state.selectedIssueId = 'root'
    state.paneA = 's2'
  },
} as const

function Harness(): JSX.Element {
  const [width, setWidth] = useState(366)
  const [mission, setMission] = useState<keyof typeof MISSIONS>('asking')
  const [color, setColor] = useState<string | null>(null)
  const [, bump] = useState(0)

  MISSIONS[mission]()

  useEffect(() => {
    window.deck = {
      setWidth: (px) => setWidth(px),
      setMission: (name) => {
        setMission(name)
        bump((v) => v + 1)
      },
      setIssueColor: (hex) => setColor(hex),
      // `setHoveredSession(null)` IS the clear; `clearHoveredSession` is the
      // guarded form a row uses on pointer-out and needs its own id.
      point: (id) => setHoveredSession(id as never),
    }
  }, [])

  return (
    <div
      className="desktop-shell issue-scope"
      data-issue-colored={color ? 'true' : 'false'}
      style={{ '--issue': color ?? 'var(--flow)' } as never}
    >
      {/* The shell spends its top bar and status strip before the row gets any
          height; a harness without them hands the deck a taller pane than
          production and every vertical number comes out optimistic. */}
      <div style={{ height: 'var(--topbar-h)', flex: 'none' }} />
      <div className="desktop-shell-row">
        <div
          className="flex min-h-0 min-w-0 flex-[0_1_auto] overflow-hidden"
          data-flight-deck-shell="open"
          style={{ width }}
        >
          <div
            className="relative flex max-w-[45vw] min-w-0 flex-[0_1_auto]"
            data-resizable-column="podium:superagent:width"
            style={{ width }}
          >
            <OperatorFocusProvider missionId="root">
              <ConfirmProvider>
                <FlightDeck onCollapse={() => {}} />
              </ConfirmProvider>
            </OperatorFocusProvider>
          </div>
        </div>
        <div className="min-w-0 flex-1" />
      </div>
      <div style={{ height: 'var(--status-strip-h)', flex: 'none' }} />
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<Harness />)
