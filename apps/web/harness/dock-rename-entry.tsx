/**
 * THE TASK PANEL'S NAME, AND RENAMING IT (POD-1618).
 *
 * Filed against a draft: the sidebar row read "Artifact directive provenance"
 * and the panel two columns right read "Draft", because the row substitutes the
 * attached agent's name for the composer's placeholder title and the panel
 * printed the raw field. The panel could not rename the task either — the one
 * surface whose whole job is judging a task and acting on it.
 *
 * jsdom proves both branches; it cannot show that the editor lands where the
 * name was, at the size the name was, which is the part a reviewer has to see.
 * So the shipping `IssueExplorer` is mounted here against the real stylesheet
 * with the explorer harness's stubbed store.
 *
 *   cd apps/web && bunx vite --config vite.explorer-harness.config.ts
 *   bun apps/web/e2e/pod1618-dock-rename-shots.ts <outDir>
 */
import type { SessionMeta } from '@podium/model'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
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

/** The filed case: a vessel the composer minted, whose agent named its SESSION
 *  and never retitled the issue. `title` is the placeholder, verbatim. */
const DRAFT = makeIssue({
  id: 'i-1609',
  seq: 1609,
  displayRef: 'POD-1609',
  title: 'Draft',
  draft: true,
  stage: 'done',
  closedReason: 'done',
  description: '',
  worktreePath: null,
  branch: null,
  memberSessionIds: ['s-1609'],
  activityNotes: '',
  updatedAt: '2026-08-24T22:05:00.000Z',
})

const AGENT = {
  sessionId: 's-1609',
  issueId: 'i-1609',
  agentKind: 'claude-code',
  name: 'Artifact directive provenance',
  title: 'artifact directive provenance',
  cwd: '/r',
  archived: false,
  status: 'hibernated',
  lastActiveAt: '2026-08-24T22:05:00.000Z',
} as unknown as SessionMeta

state.issues = [
  DRAFT,
  makeIssue({ id: 'i-1614', seq: 1614, title: 'Bug: red tests outside the chat view' }),
  makeIssue({ id: 'i-1607', seq: 1607, title: 'WebKit renderer CPU burn' }),
]
state.sessions = [AGENT]

/** Point the explorer at the draft, once — re-pointing every render would undo
 *  whatever the shot script just opened. */
function PointAtDraft(): JSX.Element {
  const { retarget } = useIssueExplorer()
  useEffect(() => {
    retarget('i-1609')
  }, [retarget])
  return <span />
}

/** The dock column as `RightDock` builds it: a 44px head carrying the trail,
 *  then the panel, at the width the operator actually reads it in. */
function Dock(): JSX.Element {
  return (
    <div
      className="flex min-h-0 flex-col border-border border-l bg-background"
      style={{ width: 316, height: '100vh' }}
      data-right-dock-panel="issue"
    >
      <div className="flex h-11 flex-none items-center gap-[9px] border-b border-border px-3.5">
        <IssueExplorerCrumbs />
      </div>
      <IssueExplorer cwd="/r" />
    </div>
  )
}

/** Owns the replica the way `explorer-entry`'s does: the stub store patches
 *  `state.issues` on a rename and wakes its listeners, and this is what turns
 *  that into a re-render of the column. */
function Harness(): JSX.Element {
  const [, bump] = useState(0)
  useEffect(() => {
    const listener = (): void => bump((n) => n + 1)
    state.listeners.add(listener)
    return () => {
      state.listeners.delete(listener)
    }
  }, [])
  return (
    <>
      <PointAtDraft />
      <Dock />
    </>
  )
}

const root = document.getElementById('root')
if (root) {
  root.style.height = '100vh'
  root.style.display = 'flex'
  root.style.justifyContent = 'flex-end'
  createRoot(root).render(
    <ThemeProvider>
      <ConfirmProvider>
        <OperatorFocusProvider missionId={null}>
          <IssueExplorerProvider>
            <Harness />
          </IssueExplorerProvider>
        </OperatorFocusProvider>
      </ConfirmProvider>
    </ThemeProvider>,
  )
}
