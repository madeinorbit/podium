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
      setMode: (mode: 'full' | 'active' | 'needs-you') => void
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
  /**
   * THE VIEW BAR'S OWN CASE (POD-1245) — a mission shaped like the one an
   * operator filed `Active` against.
   *
   * Every finished task here keeps an agent, because that is what a real
   * mission looks like: agents park, they do not exit. `t1` and `t2` are over
   * and their agents are merely hibernating (nothing to see on `Active`); `t3`
   * is over but an agent is genuinely mid-turn on it (the escape hatch, which
   * must still show); `t4` is live. `t5` is a DONE parent whose child is in
   * review — the path case `Needs you` has to draw without letting the parent
   * look like it is asking too.
   */
  filters: () => {
    state.issues = [
      issue('root', {
        id: 'root',
        displayRef: 'POD-1211',
        title: 'JSON panel reading experience',
        stage: 'planning',
        memberSessionIds: ['s1'],
      }),
      issue('t1', {
        parentId: 'root',
        displayRef: 'POD-1212',
        title: 'Viewer folding and search',
        stage: 'done',
        closedReason: 'done',
        memberSessionIds: ['s2'],
      }),
      issue('t2', {
        parentId: 'root',
        displayRef: 'POD-1213',
        title: 'Payload panel split',
        stage: 'done',
        closedReason: 'cancelled',
        memberSessionIds: ['s3'],
      }),
      issue('t3', {
        parentId: 'root',
        displayRef: 'POD-1214',
        title: 'Reader tier for long payloads',
        stage: 'done',
        closedReason: 'done',
        memberSessionIds: ['s4'],
      }),
      issue('t4', {
        parentId: 'root',
        displayRef: 'POD-1215',
        title: 'Syntax theme tokens',
        memberSessionIds: ['s5'],
      }),
      issue('t5', {
        parentId: 'root',
        displayRef: 'POD-1216',
        title: 'Copy affordances',
        stage: 'done',
        closedReason: 'done',
        memberSessionIds: ['s6', 's7'],
      }),
      issue('t6', {
        parentId: 't5',
        displayRef: 'POD-1217',
        title: 'Copy-as-path menu item',
        stage: 'review',
      }),
    ]
    state.sessions = [
      session('s1', {
        issueId: 'root',
        displayRef: 'POD-1211-A',
        name: 'Spine designer',
        title: 'Spine designer',
        agentState: { phase: 'working', since: '2026-01-01T00:28:00.000Z' },
      }),
      // Parked after finishing — the shape that used to re-admit a done task.
      session('s2', {
        issueId: 't1',
        displayRef: 'POD-1212-A',
        name: 'Folding behaviour',
        title: 'Folding behaviour',
        status: 'hibernated',
      }),
      session('s3', {
        issueId: 't2',
        displayRef: 'POD-1213-A',
        name: 'Panel split probe',
        title: 'Panel split probe',
        status: 'hibernated',
      }),
      // Genuinely mid-turn on a closed task: the escape hatch, still open.
      session('s4', {
        issueId: 't3',
        displayRef: 'POD-1214-A',
        name: 'Reader tier measurements',
        title: 'Reader tier measurements',
        agentState: { phase: 'working', since: '2026-01-01T00:20:00.000Z' },
      }),
      session('s5', {
        issueId: 't4',
        displayRef: 'POD-1215-A',
        name: 'Token sweep',
        title: 'Token sweep',
        agentState: { phase: 'working', since: '2026-01-01T00:25:00.000Z' },
      }),
      session('s6', {
        issueId: 't5',
        displayRef: 'POD-1216-A',
        name: 'Copy affordance pass',
        title: 'Copy affordance pass',
        agentState: { phase: 'working', since: '2026-01-01T00:26:00.000Z' },
      }),
      session('s7', {
        issueId: 't5',
        displayRef: 'POD-1216-B',
        name: 'Menu wording',
        title: 'Menu wording',
        status: 'hibernated',
      }),
    ]
    state.selectedIssueId = 'root'
    state.paneA = null
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
      // The view bar's own state is persisted UI state, so the harness sets it
      // the way the app does rather than reaching into the component.
      setMode: (mode) => {
        state.ui.set('podium.flightDeck.mode', mode === 'full' ? null : mode)
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
