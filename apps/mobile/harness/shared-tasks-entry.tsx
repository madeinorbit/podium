/**
 * BOB ON A SHARED INSTANCE, ON THE PHONE (POD-6297; design §2.2, §4.5).
 *
 * The phone's halves of POD-6294 and POD-6295 with a stubbed three-member
 * roster (the reader is Bob):
 *
 * - the Tasks filter sheet, Assigned to Me by default, its members by name,
 *   with the count and Clear all; the Tasks rows it leaves, where another
 *   member's task names its assignee;
 * - the Work list (the phone's sidebar), personal: Bob's own row, and one of
 *   Alice's he joined, with its owner badge;
 * - Alice's task page as Bob reads it: the assignee by name, the
 *   collaborators, and her sessions as D13 summaries, no control on them.
 *
 *   cd apps/mobile && bunx vite --config vite.shared-tasks-harness.config.ts
 *   node harness/shared-tasks-shots.mjs <outDir>
 */
import type { IssueViewModel } from '@podium/client-core/replica'
import {
  activeFilterCount,
  assigneeFacet,
  type BoardFilter,
  DEFAULT_ISSUES_FILTERS,
  type IssuesAssignedTo,
} from '@podium/client-core/values'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { StyleSheet, Text, View } from 'react-native'
import { AssigneeName } from '../src/components/AssigneeName'
import { TaskFiltersSheet } from '../src/components/TaskFiltersSheet'
import { IssueSharedSection } from '../src/components/task-detail/IssueSharedSection'
import { color, font, mono, sans } from '../src/theme/theme'
import { harnessRoster } from './shared-tasks-roster'

const TASKS = [
  { id: 'i-1', ref: 'POD-6301', title: 'Invite flow copy', assignee: 'mem_alice' },
  { id: 'i-2', ref: 'POD-6302', title: 'Billing export', assignee: 'mem_bob' },
  { id: 'i-3', ref: 'POD-6303', title: 'Release notes', assignee: 'mem_carol' },
]

function Frame({
  label,
  testID,
  children,
}: {
  label: string
  testID: string
  children: React.ReactNode
}) {
  return (
    <View style={styles.frame} testID={testID}>
      <Text style={styles.frameLabel}>{label}</Text>
      {children}
    </View>
  )
}

function TasksPanel() {
  const [filter, setFilter] = useState<BoardFilter>({})
  const [assignedTo, setAssignedTo] = useState<IssuesAssignedTo>(DEFAULT_ISSUES_FILTERS.assignedTo)
  const [showAgentTasks, setShowAgentTasks] = useState(false)
  const assignee = assigneeFacet(assignedTo, {
    shared: harnessRoster.shared,
    viewer: harnessRoster.currentMemberId,
  })
  const rows = TASKS.filter((task) => !assignee || task.assignee === assignee)
  return (
    <>
      <Frame label="Tasks · Filter sheet" testID="panel-filters">
        <TaskFiltersSheet
          visible
          filter={filter}
          ordering="priority"
          showAgentTasks={showAgentTasks}
          assignedTo={assignedTo}
          roster={harnessRoster}
          count={activeFilterCount(filter, { assignedTo, showAgentTasks }, true)}
          onFilter={setFilter}
          onOrdering={() => {}}
          onShowAgentTasks={setShowAgentTasks}
          onAssignedTo={setAssignedTo}
          onReset={() => {
            setFilter({})
            setAssignedTo(DEFAULT_ISSUES_FILTERS.assignedTo)
            setShowAgentTasks(DEFAULT_ISSUES_FILTERS.showAgentTasks)
          }}
          onClose={() => {}}
        />
      </Frame>
      <Frame label="Tasks · rows" testID="panel-tasks">
        {rows.map((task) => (
          <View key={task.id} style={styles.row} testID="task-row">
            <Text style={styles.title}>{task.title}</Text>
            <View style={styles.meta}>
              <Text style={styles.ref}>{task.ref}</Text>
              <AssigneeName assignee={task.assignee} style={styles.ref} />
            </View>
          </View>
        ))}
      </Frame>
    </>
  )
}

function WorkPanel() {
  // The personal set: Bob's own task, and Alice's he joined (owner badge).
  const rows = [
    { id: 'w-1', title: 'Billing export', word: 'Working', ownerBadge: undefined },
    { id: 'w-2', title: 'Invite flow copy', word: 'Waiting', ownerBadge: 'mem_alice' },
  ]
  return (
    <Frame label="Work (sidebar) · personal" testID="panel-work">
      {rows.map((row) => (
        <View key={row.id} style={styles.row} testID="work-row">
          <Text style={styles.title}>{row.title}</Text>
          <View style={styles.meta}>
            <Text style={styles.ref}>{row.word}</Text>
            <AssigneeName assignee={row.ownerBadge} prefix="· " style={styles.ref} />
          </View>
        </View>
      ))}
    </Frame>
  )
}

const ISSUE = {
  id: 'i-1',
  assignee: 'mem_alice',
  owner: 'mem_alice',
  legacyAssignee: null,
} as unknown as IssueViewModel

function TaskPagePanel() {
  return (
    <Frame label="Alice’s task, as Bob reads it" testID="panel-task">
      <Text style={styles.pageTitle}>Invite flow copy</Text>
      <IssueSharedSection issue={ISSUE} roster={harnessRoster} busy={false} onReassign={() => {}} />
    </Frame>
  )
}

function App() {
  return (
    <View style={styles.page}>
      <TasksPanel />
      <WorkPanel />
      <TaskPagePanel />
    </View>
  )
}

const styles = StyleSheet.create({
  page: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, padding: 16, alignItems: 'flex-start' },
  frame: {
    width: 390,
    padding: 12,
    gap: 6,
    backgroundColor: color.bg,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  frameLabel: { ...mono(400), color: color.textFaint, fontSize: font.micro, marginBottom: 4 },
  row: { paddingVertical: 8, gap: 3 },
  title: { ...sans(500), color: color.text, fontSize: font.small },
  meta: { flexDirection: 'row', gap: 8 },
  ref: { ...mono(400), color: color.textDim, fontSize: font.micro },
  pageTitle: { ...sans(600), color: color.text, fontSize: font.body, marginBottom: 6 },
})

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
