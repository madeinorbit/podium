/**
 * THE DOCK'S START CONTROL, AT DOCK WIDTH (POD-1457).
 *
 * The right dock's task panel could start a task but never say WITH WHAT: its
 * start was one yellow chip in the head strip, and choosing an agent meant
 * leaving the explorer for the full issue page. It now carries the same launch
 * box the page's Sessions block wears.
 *
 * That is a claim about a 316px column — two picker segments and a button
 * sharing a well, at the ink tiers `styles.css` sets — so it is photographed
 * rather than asserted. The same harness at HEAD draws the before frame, since
 * the fixture is in this file and the component is the shipping one.
 *
 *   cd apps/web && bunx vite --config vite.explorer-harness.config.ts
 *   bun apps/web/e2e/pod1457-dock-launch.ts <outDir>
 */
import type { JSX } from 'react'
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { OperatorFocusProvider } from '@/app/operator-focus'
import { ThemeProvider } from '@/app/theme'
import {
  IssueExplorerProvider,
  useIssueExplorer,
} from '@/features/issues/explorer/explorer-context'
import { IssueExplorer, IssueExplorerCrumbs } from '@/features/issues/explorer/IssueExplorer'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { makeIssue } from '@/lib/test-issue'
import '@/index.css'
import '@/styles.css'
import { state } from './explorer-store'

/** A plain task nobody is on: the ordinary start. */
const PLAIN = makeIssue({
  id: 'i-1451',
  seq: 1451,
  displayRef: 'POD-1451',
  title: 'Footer metrics read a stale scan',
  description:
    'The burn figure in the footer keeps the number from the scan that was current when the view mounted, so it disagrees with the deck above it until the tab is reopened.',
  stage: 'backlog',
  repoPath: '/r',
  worktreePath: null,
  branch: null,
  activityNotes: '',
  updatedAt: '2026-08-21T08:40:00.000Z',
})

/** Work an AGENT filed, which is the case that carries the placement fork —
 *  the chevron riding the right edge of Start work. */
const ORIGIN = makeIssue({
  id: 'i-1420',
  seq: 1420,
  displayRef: 'POD-1420',
  title: 'Flight deck spine',
  stage: 'in_progress',
})
const DISCOVERED = makeIssue({
  id: 'i-1456',
  seq: 1456,
  displayRef: 'POD-1456',
  title: 'Deck cards drop their fleet stack',
  description:
    'Found while reworking the spine: a card with more than three sessions renders the stack empty instead of overflowing it.',
  stage: 'proposed',
  startedBySession: 's-agent',
  repoPath: '/r',
  worktreePath: null,
  branch: null,
  activityNotes: '',
  deps: [{ id: 'i-1420', type: 'discovered-from' }],
  updatedAt: '2026-08-21T08:55:00.000Z',
})

/** ONE HOST, WITH AN OPINION. Claude Code is installed and signed in; Codex is
 *  installed but signed out; Cursor is not installed at all. That is what the
 *  agent menu has to draw — a refusal, a condition, and a plain row — and none
 *  of it renders against an empty fleet. */
state.repos = [{ path: '/r', branch: 'main', machineId: 'mine', worktrees: [] }]
state.machines = [
  {
    id: 'mine',
    name: 'mine',
    hostname: 'mine',
    online: true,
    inventory: {
      agents: [
        { kind: 'claude-code', installed: true, login: { state: 'in' } },
        { kind: 'codex', installed: true, login: { state: 'out' } },
        { kind: 'grok', installed: true, login: { state: 'in' } },
        { kind: 'opencode', installed: false, login: { state: 'unknown' } },
        { kind: 'cursor', installed: false, login: { state: 'unknown' } },
      ],
    },
  },
]

/** WORK THAT HAS BEGUN. `Start work` would name the wrong move here, so the
 *  box's foot becomes `+ Session` / `+ Shell` instead (POD-1457). */
const RUNNING = makeIssue({
  id: 'i-1457',
  seq: 1457,
  displayRef: 'POD-1457',
  title: 'Launch box in issue explorer',
  description:
    'The right dock could start a task but never say with what: its start was one chip, and choosing an agent meant leaving the explorer for the full page.',
  stage: 'in_progress',
  repoPath: '/r',
  worktreePath: '/r/.worktrees/issue-1457',
  branch: 'issue/1457-launch-box-in-issue-explorer',
  activityNotes: 'Head reworked around the box; shooting the before/after frames now.',
  notesUpdatedAt: '2026-08-21T10:20:00.000Z',
  updatedAt: '2026-08-21T10:20:00.000Z',
  memberSessionIds: ['s-dock'],
  sessionSummary: { total: 1, byPhase: { working: 1 } },
})

state.sessions = [
  {
    sessionId: 's-dock',
    issueId: 'i-1457',
    agentKind: 'claude-code',
    title: 'Dock launch box',
    cwd: '/r/.worktrees/issue-1457',
    repoPath: '/r',
    archived: false,
    status: 'live',
    lastActiveAt: '2026-08-21T10:20:00.000Z',
  },
]

state.issues = [PLAIN, DISCOVERED, RUNNING, ORIGIN]

function PointAt({ id }: { id: string }): JSX.Element {
  const { retarget } = useIssueExplorer()
  useEffect(() => {
    retarget(id)
  }, [retarget, id])
  return <span />
}

/** The dock column as `RightDock` builds it: a 44px head carrying the trail,
 *  then the panel, at the width the operator actually reads it in. */
function Dock({ id, label }: { id: string; label: string }): JSX.Element {
  return (
    <IssueExplorerProvider>
      <PointAt id={id} />
      <div
        className="flex min-h-0 flex-col border-border border-l bg-background"
        style={{ width: 316, height: '100vh' }}
        data-right-dock-panel="issue"
        data-case={label}
      >
        <div className="flex h-11 flex-none items-center gap-[9px] border-b border-border px-3.5">
          <IssueExplorerCrumbs />
        </div>
        <IssueExplorer cwd="/r" />
      </div>
    </IssueExplorerProvider>
  )
}

const root = document.getElementById('root')
if (root) {
  root.style.height = '100vh'
  root.style.display = 'flex'
  root.style.justifyContent = 'flex-start'
  createRoot(root).render(
    <ThemeProvider>
      <ConfirmProvider>
        <OperatorFocusProvider missionId={null}>
          <Dock id="i-1451" label="plain" />
          <Dock id="i-1456" label="discovered" />
          <Dock id="i-1457" label="running" />
        </OperatorFocusProvider>
      </ConfirmProvider>
    </ThemeProvider>,
  )
}
