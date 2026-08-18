/**
 * THE ROW'S STATUS PICKER, IN A BROWSER (POD-1271).
 *
 * The change is pointer routing, and jsdom can only say that a handler ran.
 * What has to hold is that the glyph inside a row button opens its own menu and
 * the row does NOT open the task underneath it — plus that the menu is a menu
 * anyone would want to use, which is a question about `styles.css` and about
 * where the popup lands, neither of which exists in a unit test.
 *
 * `IssueListView` is presentational, so this harness needs no store stub: the
 * rows are fixtures and the pick is recorded on `window.probe` instead of being
 * applied. `probe.opens` counts what the ROW's own click would have done — an
 * open that never happens is the whole affordance.
 *
 *   cd apps/web && bunx vite --config vite.harness.config.ts
 *   bun apps/web/e2e/pod1271-status-picker-shots.ts <outDir>
 */
import type { IssueId } from '@podium/model/browser'
import type { JSX } from 'react'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from '@/app/theme'
import { IssueListView } from '@/features/issues/IssueListView'
import type { IssueRow } from '@/features/issues/issue-hierarchy'
import { DEFAULT_DISPLAY } from '@/features/issues/issues-display'
import { makeIssue } from '@/lib/test-issue'
import '@/index.css'
import '@/styles.css'

declare global {
  interface Window {
    probe: {
      /** Encoded menu values picked, in order. */
      picks: string[]
      /** Ids the ROW would have opened — must stay empty while picking. */
      opens: string[]
    }
  }
}

const probe: Window['probe'] = { picks: [], opens: [] }
window.probe = probe

const row = (over: Parameters<typeof makeIssue>[0], extra: Partial<IssueRow> = {}): IssueRow => ({
  issue: makeIssue(over),
  depth: 0,
  childCount: 0,
  expanded: false,
  ...extra,
})

const GROUPS: { stage: 'backlog' | 'in_progress' | 'review'; rows: IssueRow[] }[] = [
  {
    stage: 'in_progress',
    rows: [
      row({ id: 'i-1271', seq: 1271, title: 'Clickable status icon picker', priority: 1 }),
      row(
        { id: 'i-1244', seq: 1244, title: 'Sidebar folds keep their scroll', priority: 2 },
        { childCount: 2, expanded: true },
      ),
      row(
        { id: 'i-1245', seq: 1245, title: 'Context rows stop shouting', stage: 'review' },
        { depth: 1 },
      ),
      row(
        {
          id: 'i-1246',
          seq: 1246,
          title: 'The fold remembers what it hid',
          stage: 'done',
          closedReason: 'done',
        },
        { depth: 1 },
      ),
    ],
  },
  {
    stage: 'backlog',
    rows: [
      row({
        id: 'i-1250',
        seq: 1250,
        title: 'Retire the second status vocabulary',
        stage: 'backlog',
      }),
      row({
        id: 'i-1251',
        seq: 1251,
        title: 'A cancelled task is not a green tick',
        stage: 'backlog',
        priority: 3,
      }),
    ],
  },
]

function Harness(): JSX.Element {
  const [expanded, setExpanded] = useState(true)
  return (
    <ThemeProvider>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="flex h-(--section-bar-h) flex-none items-center border-hairline-bar border-b bg-bar px-4 font-mono text-[11px] text-text-dim">
          POD-1271 · status picker
        </div>
        <IssueListView
          groups={GROUPS.map((group) =>
            group.stage === 'in_progress' && !expanded
              ? { ...group, rows: group.rows.filter((r) => r.depth === 0) }
              : group,
          )}
          display={{ ...DEFAULT_DISPLAY, layout: 'list' }}
          onOpen={(id) => probe.opens.push(id)}
          onCreateIn={() => {}}
          focusId={null}
          selected={[]}
          onToggleSelect={() => {}}
          onToggleExpand={() => setExpanded((v) => !v)}
          onContextMenu={(_id: IssueId, event) => event.preventDefault()}
          onStatusPick={(id, value) => {
            probe.picks.push(value)
            document.title = `${id} → ${value}`
          }}
        />
      </div>
    </ThemeProvider>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<Harness />)
