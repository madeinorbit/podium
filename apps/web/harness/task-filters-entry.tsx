/**
 * THE TASKS FILTERS, IN A BROWSER (POD-6294, MU-09).
 *
 * The Tasks toolbar's Filter and Display menus with a stubbed three-member
 * roster (the viewer is Bob), plus the assignee avatars a list row draws from
 * the roster's names. (The list itself reads the pool, so it is not mounted
 * here.) State is local: `window.probe` records what was picked.
 *
 *   cd apps/web && bunx vite --config vite.harness.config.ts
 *   bun harness/task-filters-shots.ts <outDir>
 */
import {
  activeFilterCount,
  DEFAULT_ISSUES_FILTERS,
  type IssuesAssignedTo,
} from '@podium/client-core/values'
import type { MemberRoster } from '@podium/client-graph/member-roster'
import type { JSX } from 'react'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from '@/app/theme'
import { DisplayMenu, FilterMenu } from '@/features/issues/IssuesFilters'
import { AssigneeAvatar } from '@/features/issues/issue-glyphs'
import { DEFAULT_DISPLAY } from '@/features/issues/issues-display'
import { memberDisplayName } from '@/lib/member-roster'
import '@/index.css'
import '@/styles.css'

declare global {
  interface Window {
    probe: { assignedTo: string[]; agentTasks: boolean[] }
  }
}
const probe: Window['probe'] = { assignedTo: [], agentTasks: [] }
window.probe = probe

const MEMBERS = [
  { id: 'mem_alice', displayName: 'Alice Martin' },
  { id: 'mem_bob', displayName: 'Bob Keller' },
  { id: 'mem_carol', displayName: 'Carol Diaz' },
]
const roster = {
  shared: true,
  currentMemberId: 'mem_bob',
  members: MEMBERS,
  nameOf: (id: string | null | undefined) => MEMBERS.find((m) => m.id === id)?.displayName,
} as unknown as MemberRoster

const TASKS = [
  { title: 'Shared roster in the Tasks view', assignee: 'mem_bob' },
  { title: 'Invite flow copy', assignee: 'mem_alice' },
  { title: 'Quota ledger', assignee: 'mem_carol' },
]

function Harness(): JSX.Element {
  const [assignedTo, setAssignedTo] = useState<IssuesAssignedTo>('me')
  const [showAgentTasks, setShowAgentTasks] = useState(false)
  const count = activeFilterCount({}, { assignedTo, showAgentTasks }, true)
  return (
    <ThemeProvider>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="topbar-tools flex flex-none items-center justify-end gap-2 border-hairline-bar border-b bg-bar px-4 py-1.5">
          <FilterMenu
            filter={{}}
            onChange={() => {}}
            assignedTo={assignedTo}
            onAssignedTo={(value) => {
              probe.assignedTo.push(value)
              setAssignedTo(value)
            }}
            showAgentTasks={showAgentTasks}
            onShowAgentTasks={(value) => {
              probe.agentTasks.push(value)
              setShowAgentTasks(value)
            }}
            roster={roster}
            count={count}
            onReset={() => {
              setAssignedTo(DEFAULT_ISSUES_FILTERS.assignedTo)
              setShowAgentTasks(DEFAULT_ISSUES_FILTERS.showAgentTasks)
            }}
          />
          <DisplayMenu display={DEFAULT_DISPLAY} onChange={() => {}} showLayout />
        </div>
        <ul className="flex flex-col gap-1 p-4 text-[13px]">
          {TASKS.map((task) => (
            <li key={task.title} className="flex items-center justify-between gap-3">
              <span>{task.title}</span>
              <AssigneeAvatar
                assignee={task.assignee}
                name={memberDisplayName(roster, task.assignee)}
              />
            </li>
          ))}
        </ul>
      </div>
    </ThemeProvider>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<Harness />)
