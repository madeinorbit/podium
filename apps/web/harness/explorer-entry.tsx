/**
 * THE TASK EXPLORER, POINTED AT A TASK IT USED TO REFUSE (POD-1277).
 *
 * The filed shot shows the trail reading `Tasks › POD-1265 · archived` over a
 * panel headed "Conversation workspace" — an intake canvas written for a chat
 * that has not become work yet, printed on a level that names a real task. The
 * explorer offers archived tasks on purpose (its search recovers them by exact
 * ref, its breadcrumb labels them), so a level it pushes has to open.
 *
 * `window.probe.legacy(on)` draws the removed `IntakeDock`, verbatim, for the
 * before frame — the two states are the same dock column, one screenshot apart.
 *
 *   cd apps/web && bunx vite --config vite.explorer-harness.config.ts
 *   bun apps/web/e2e/pod1277-explorer-shots.ts <outDir>
 */
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
import { DOCK_BODY } from '@/features/issues/IssueCompactControls'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { makeIssue } from '@/lib/test-issue'
import { cn } from '@/lib/utils'
import '@/index.css'
import '@/styles.css'
import { state } from './explorer-store'

declare global {
  interface Window {
    probe: {
      /** Draw the removed intake canvas, for the before shot. */
      legacy: (on: boolean) => void
      /** Take the task out of the replica, the way a delete does. */
      vanish: () => void
    }
  }
}

/** The filed case: a done, archived task the explorer is pointed at. */
const ARCHIVED = makeIssue({
  id: 'i-1265',
  seq: 1265,
  displayRef: 'POD-1265',
  title: 'Open in explorer opens the explorer',
  description:
    'A ref card in chat used to move the whole shell when it was clicked — the tab area and the sidebar switched over to the task as well. It now points the task panel and nothing else.',
  stage: 'done',
  archived: true,
  worktreePath: null,
  branch: 'issue/1265-open-in-explorer',
  activityNotes: 'Landed on main; the card points the panel and leaves the shell where it was.',
  notesUpdatedAt: '2026-08-18T09:12:00.000Z',
  updatedAt: '2026-08-18T09:12:00.000Z',
})

const OTHERS = [
  makeIssue({ id: 'i-1275', seq: 1275, title: 'Origin sync on main', stage: 'review' }),
  makeIssue({
    id: 'i-1273',
    seq: 1273,
    title: 'Chat view drops question prompts',
    stage: 'review',
  }),
  makeIssue({
    id: 'i-1271',
    seq: 1271,
    title: 'Clickable status icon picker',
    stage: 'in_progress',
  }),
  makeIssue({ id: 'i-1247', seq: 1247, title: 'Tab selection and deck sorting', stage: 'review' }),
  makeIssue({ id: 'i-1222', seq: 1222, title: 'Agent preset inventory', stage: 'review' }),
]

state.issues = [...OTHERS, ARCHIVED]

/** Points the explorer at the archived task, the way a chat ref card does.
 *  Once only: re-pointing it every render would undo the collapse this harness
 *  exists to photograph. */
function PointAtArchived(): JSX.Element {
  const { retarget } = useIssueExplorer()
  useEffect(() => {
    retarget('i-1265')
  }, [retarget])
  return <span />
}

/**
 * The removed component, copied here VERBATIM so the before frame is the real
 * thing rather than a drawing of it. Nothing else may import this: it is the
 * subject of the fix, kept only to be photographed beside its replacement.
 */
function LegacyIntakeField({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div
      className={cn(
        DOCK_BODY,
        'grid grid-cols-[52px_minmax(0,1fr)] items-center gap-2 border-t border-border/50 py-2.5',
      )}
    >
      <span className="shell-type-micro font-mono text-muted-foreground/80">{label}</span>
      <span className="min-w-0 truncate text-muted-foreground">{value}</span>
    </div>
  )
}

function LegacyIntakeDock(): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="dock-intake">
      <header className="flex-none border-b border-border/60 px-3.5 pt-3 pb-3">
        <div className="flex items-center gap-2 font-mono text-[11px] leading-none text-text-dim">
          <span className="size-1.5 rounded-full bg-muted-foreground/50" aria-hidden="true" />
          <span className="label-mono">Live session</span>
          <span className="label-mono ml-auto">Ready</span>
        </div>
        <h2 className="shell-type-reading mt-1.5 font-semibold text-foreground">
          Conversation workspace
        </h2>
        <p className={cn(DOCK_BODY, 'mt-1.5 text-muted-foreground')}>
          Start in chat. Task details, plan and team will appear here when the agent structures the
          work.
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pt-3 pb-6">
        <section className="mb-3.5">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="shell-type-micro flex-none font-semibold text-muted-foreground">
              Taking shape
            </span>
            <span className="h-px flex-1 bg-border" aria-hidden="true" />
          </div>
          <LegacyIntakeField label="Task" value="Waiting for your first message" />
          <LegacyIntakeField label="Plan" value="The agent will outline the work" />
          <LegacyIntakeField label="Team" value="Agents will appear as they join" />
        </section>
        <p className="shell-type-micro text-text-faint">
          If the conversation stays exploratory, this view stays light. Podium does not force a
          task.
        </p>
      </div>
    </div>
  )
}

/** The dock column as `RightDock` builds it: a 44px head carrying the trail,
 *  then the panel, at the width the operator actually reads it in. */
function Dock({ vanish }: { vanish: () => void }): JSX.Element {
  const [legacy, setLegacy] = useState(false)
  useEffect(() => {
    window.probe = { legacy: setLegacy, vanish }
  }, [vanish])
  return (
    <div
      className="flex min-h-0 flex-col border-border border-l bg-background"
      style={{ width: 316, height: '100vh' }}
      data-right-dock-panel="issue"
    >
      <div className="flex h-11 flex-none items-center gap-[9px] border-b border-border px-3.5">
        <IssueExplorerCrumbs />
      </div>
      {legacy ? <LegacyIntakeDock /> : <IssueExplorer cwd="/r" />}
    </div>
  )
}

/** Owns the replica, so taking the task out of it re-renders the whole column
 *  — the panel reads `useReplicaIssues()` and nothing else would tell it. */
function Harness(): JSX.Element {
  const [, bump] = useState(0)
  const vanish = (): void => {
    state.issues = OTHERS
    bump((n) => n + 1)
  }
  return (
    <>
      <PointAtArchived />
      <Dock vanish={vanish} />
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
