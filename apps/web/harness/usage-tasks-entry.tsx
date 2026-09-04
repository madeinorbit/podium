/**
 * WHERE IT WENT — BY TASK, REAL, IN A BROWSER (POD-1861).
 *
 * The section is a pure function of its feed, so no store stub is needed: this
 * renders the shipping component against the shipping `styles.css`. What it is
 * here to check is the part unit tests cannot see — that the five readings hold
 * ONE right edge with the table's cost column under them, that the divided group
 * reads as an instrument rather than five loose numbers now that nothing in it
 * takes the masthead's 24px step, and that both themes come out of the same
 * declarations.
 *
 * The WHOLE sheet, with this section in its place between the providers and the
 * trace, is harness/usage-sheet-entry.tsx — that is where the sheet's one right
 * edge across every region is checked. This page is the section's own states.
 */

import { taskCostRows } from '@podium/client-core/viewmodels'
import type { TaskCostRowWire } from '@podium/model'
import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { UsageTasks } from '@/features/usage/UsageTasks'
import type { TaskCostsFeed } from '@/features/usage/useTaskCosts'
import { TASK_ROWS } from './usage-tasks-fixture'
import '@/index.css'
import '@/styles.css'

const ROWS: TaskCostRowWire[] = TASK_ROWS

const feedOf = (wire: TaskCostRowWire[]): TaskCostsFeed => {
  const priced = taskCostRows(wire)
  return {
    rows: priced.rows,
    cohort: priced.cohort,
    waiting: false,
    failed: false,
    retry: () => {},
  }
}

const FULL = feedOf(ROWS)
const EMPTY = feedOf([])
const COLD: TaskCostsFeed = {
  rows: null,
  cohort: null,
  waiting: false,
  failed: false,
  retry: () => {},
}

function Panel({
  title,
  theme,
  children,
}: {
  title: string
  theme: 'dark' | 'paper'
  children: JSX.Element
}): JSX.Element {
  return (
    // Paper is not a class: `index.css` keys the light palette on
    // `[data-theme="podium"]` and the dark one on `[data-theme="podium"].dark`,
    // so re-stamping the attribute WITHOUT `dark` on a subtree gives that subtree
    // the light token set. Same declarations, other theme — which is the point.
    <section
      {...(theme === 'paper' ? { 'data-theme': 'podium' } : {})}
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <h2
        style={{
          margin: 0,
          font: '500 11px var(--font-mono)',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--text-dim)',
        }}
      >
        {title}
      </h2>
      <div
        className="usage-body"
        style={{
          padding: '18px 20px',
          border: '1px solid var(--border-strong)',
          borderRadius: 10,
          background: 'var(--card)',
          color: 'var(--foreground)',
        }}
      >
        {children}
      </div>
    </section>
  )
}

function Shell(): JSX.Element {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(680px, 1fr))',
        gap: 28,
        padding: 28,
        background: 'var(--background)',
        minHeight: '100vh',
      }}
    >
      <Panel title="Ranked by cost · Dark Ink" theme="dark">
        <UsageTasks feed={FULL} cold={false} />
      </Panel>
      <Panel title="Ranked by cost · Paper" theme="paper">
        <UsageTasks feed={FULL} cold={false} />
      </Panel>
      <Panel title="Cold — the cost read in flight" theme="dark">
        <UsageTasks feed={COLD} cold />
      </Panel>
      <Panel title="Loaded, no task has a figure yet" theme="dark">
        <UsageTasks feed={EMPTY} cold={false} />
      </Panel>
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<Shell />)
