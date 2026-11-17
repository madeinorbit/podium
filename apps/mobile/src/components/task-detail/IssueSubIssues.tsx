import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { confirmedWorkingAgentCountsByIssue, taskStateWord } from '@podium/client-core/values'
import type { PageIssue } from '@podium/client-graph/issue-page'
import { sidebarIssueProgress } from '@podium/client-graph/worklist/sidebar'
import { isFinished } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import { type ComponentProps, useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { issueObserver as observer } from '../../client/issue-observer'
import { useIssueOpening } from '../../client/issue-opening'
import { useMobilePool } from '../../client/mobile-pool'
import type { IssueCommands } from '../../lib/issue-detail'
import { color, font, radius, sans, space } from '../../theme/theme'
import { Icon } from '../Icon'
import { ChevronRight, Plus } from '../icons'
import { PressableScale } from '../PressableScale'
import { StageGlyph } from '../StageGlyph'
import { SectionHeading } from './chrome'

/** FullDeck.buckets reads this same shared execution progress. */
function useSubTaskCount(issue?: IssueViewModel) {
  const pool = useMobilePool()
  if (!pool || !issue?.childCount) return undefined
  const progress = sidebarIssueProgress(pool.issueObject(issue.id))
  if (typeof progress === 'symbol') throw progress
  return `${progress.done}/${progress.total}`
}

export const IssueSubIssuesSection = observer(function IssueSubIssuesSection(
  props: ComponentProps<typeof IssueSubIssues>,
) {
  const count = useSubTaskCount(props.issue)
  return (
    <View testID="issue-subtasks-section">
      <SectionHeading label="Sub-tasks" count={count} />
      <IssueSubIssues {...props} headless />
    </View>
  )
})

/**
 * The sub-task list [POD-724], kept flat in the shared slice order with an
 * inline add row. Finished children stay in place and step down one ink rung;
 * the status glyph already says why.
 *
 * WHERE THE CHILDREN COME FROM. The list is `subIssuesOf` from the shared issues
 * slice, read once by the screen — not a `.filter(i => i.parentId === id)` here.
 * The slice's version is the one that keeps ARCHIVED children visible (POD-133),
 * and re-deriving or reordering it locally is how that decision silently gets
 * lost on one surface.
 *
 * PARTIAL WORLD. This counts and lists what the replica HOLDS. A child the
 * principal cannot see is not listed and is not hinted at either — a count is an
 * existence fact, and the policy on those is settled the same way here as on the
 * desktop: say nothing rather than leak a number.
 *
 * The trailing word uses the same ranked selector as desktop cards. Confirmed
 * computing sessions are joined by issue membership before the selector ranks
 * them against needs-human, blocking, merge and subtree state.
 */
export const IssueSubIssues = observer(function IssueSubIssues({
  issue,
  subIssues: suppliedChildren,
  busy,
  commands,
  sessions,
  now,
  onOpen,
  onStatus,
  headless = false,
}: {
  issue: IssueViewModel
  /** Inside a fold whose header already names it. */
  headless?: boolean
  subIssues?: IssueViewModel[]
  busy: boolean
  commands: IssueCommands
  sessions?: readonly SessionView[]
  now?: number
  onOpen: (id: string) => void
  onStatus: (issue: IssueViewModel) => void
}) {
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const count = useSubTaskCount(headless ? undefined : issue)
  const views = useIssueOpening()
  const rows = suppliedChildren ?? (views ? views.row(issue.id).children : [])
  if (typeof rows === 'symbol') throw rows
  const subIssues = rows ?? []
  const legacyWorkers =
    suppliedChildren && sessions
      ? confirmedWorkingAgentCountsByIssue(suppliedChildren, sessions, now ?? Date.now())
      : undefined
  const create = () => {
    const next = title.trim()
    if (!next || busy) return
    commands.createSubIssue(next)
    setTitle('')
  }

  return (
    <View style={headless ? undefined : styles.section} testID="sub-issues">
      {headless ? null : <SectionHeading label="Sub-tasks" count={count} />}
      <View style={styles.card} testID="sub-issues-card">
        {subIssues.map((child, index) => (
          <SubTaskRow
            key={child.id}
            child={child}
            first={index === 0}
            workingAgents={legacyWorkers?.get(child.id) ?? 0}
            onOpen={onOpen}
            onStatus={onStatus}
            muted={isFinished(child)}
          />
        ))}
        {subIssues.length === 0 ? <Text style={styles.empty}>No sub-tasks yet.</Text> : null}

        {adding ? (
          <View style={styles.addRow}>
            <TextInput
              value={title}
              onChangeText={setTitle}
              accessibilityLabel="Sub-task title"
              placeholder="Sub-task title…"
              placeholderTextColor={color.textMicro}
              autoFocus
              returnKeyType="done"
              // Guard double-submit here rather than disabling the field, so rapid
              // entry keeps flowing across creates.
              onSubmitEditing={create}
              style={styles.field}
            />
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Add sub-task"
              accessibilityState={{ disabled: busy || title.trim().length === 0 }}
              disabled={busy || title.trim().length === 0}
              onPress={create}
              style={({ pressed }) => [
                styles.addBtn,
                (busy || title.trim().length === 0) && styles.muted,
                pressed && styles.muted,
              ]}
            >
              <Text style={styles.addBtnText}>Add</Text>
            </PressableScale>
          </View>
        ) : (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Add a sub-task"
            onPress={() => setAdding(true)}
            style={({ pressed }) => [styles.addChip, pressed && styles.rowPressed]}
          >
            <Icon as={Plus} size={14} color={color.textDim} />
            <Text style={styles.addChipText}>Add sub-task</Text>
          </PressableScale>
        )}
      </View>
    </View>
  )
})

/** One sub-task, in the board row's grammar: stage glyph, ref, title, state. */
const SubTaskRow = observer(function SubTaskRow({
  child,
  workingAgents,
  first,
  onOpen,
  onStatus,
  muted,
}: {
  child: IssueViewModel
  workingAgents: number
  first: boolean
  onOpen: (id: string) => void
  onStatus: (issue: IssueViewModel) => void
  muted?: boolean
}) {
  const count =
    'confirmedWorkingAgents' in child ? (child as PageIssue).confirmedWorkingAgents : workingAgents
  const state = taskStateWord(child, count)
  const stateTint =
    state?.tone === 'attention'
      ? color.needsYouText
      : state?.tone === 'alert'
        ? color.dangerText
        : state?.tone === 'live'
          ? color.workingText
          : color.textFaint
  return (
    <View style={[styles.row, (muted || child.archived) && styles.rowMuted]}>
      {first ? null : <View style={styles.separator} />}
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`Change status for ${issueDisplayRef(child)}`}
        accessibilityHint="Opens the status picker"
        onPress={() => onStatus(child)}
        hitSlop={4}
        style={({ pressed }) => [styles.statusButton, pressed && styles.rowPressed]}
      >
        <StageGlyph stage={child.stage} size={18} ground={color.groupedCard} />
      </PressableScale>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`${issueDisplayRef(child)} ${'authoredTitle' in child ? (child as PageIssue).authoredTitle : child.title}`}
        onPress={() => onOpen(child.id)}
        scaleTo={0.995}
        style={({ pressed }) => [styles.rowBody, pressed && styles.rowPressed]}
      >
        <View style={styles.main}>
          <Text style={styles.title}>
            {'authoredTitle' in child ? (child as PageIssue).authoredTitle : child.title}
          </Text>
          <View style={styles.meta}>
            <Text style={styles.ref}>{issueDisplayRef(child)}</Text>
            {child.archived ? <Text style={styles.archived}>Archived</Text> : null}
            {state ? <Text style={[styles.state, { color: stateTint }]}>{state.text}</Text> : null}
          </View>
        </View>
        <Icon as={ChevronRight} size={14} color={color.textFaint} />
      </PressableScale>
    </View>
  )
})

const styles = StyleSheet.create({
  section: {},
  card: {
    borderRadius: radius.card,
    borderCurve: 'continuous',
    overflow: 'hidden',
    backgroundColor: color.groupedCard,
  },
  row: { minHeight: 44, flexDirection: 'row', alignItems: 'stretch' },
  separator: {
    position: 'absolute',
    top: 0,
    left: 44,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.hairline,
  },
  statusButton: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  rowBody: {
    minHeight: 44,
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingRight: space.md,
    paddingVertical: space.md,
  },
  main: { flex: 1, minWidth: 0, gap: space.xs },
  meta: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  rowMuted: { opacity: 0.72 },
  rowPressed: { backgroundColor: color.surfacePressed },
  ref: { ...sans(400), color: color.textDim, fontSize: font.tiny },
  title: { ...sans(400), color: color.text, fontSize: font.body },
  archived: { ...sans(400), color: color.textDim, fontSize: font.tiny },
  state: { ...sans(400), fontSize: font.tiny },
  empty: { ...sans(400), color: color.textDim, fontSize: font.small, padding: space.md },
  addRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
    padding: space.md,
  },
  field: {
    ...sans(400),
    flexGrow: 1,
    minWidth: 120,
    minHeight: 44,
    color: color.text,
    fontSize: font.body,
    backgroundColor: color.bgSunken,
    borderRadius: radius.control,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  addBtn: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.control,
    backgroundColor: color.tertiaryFill,
  },
  muted: { opacity: 0.5 },
  addBtnText: { ...sans(600), color: color.accentTint, fontSize: font.body },
  addChip: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  addChipText: { ...sans(400), color: color.accentTint, fontSize: font.body, flexShrink: 1 },
})
