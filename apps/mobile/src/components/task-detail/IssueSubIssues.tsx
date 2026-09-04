import { confirmedWorkingAgentCountsByIssue, taskStateWord } from '@podium/client-core/viewmodels'
import type { IssueWire, SessionMeta } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { Plus } from '../icons'
import { useMemo, useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import type { IssueCommands } from '../../lib/issue-detail'
import { alpha } from '../../theme/mix'
import { color, font, mono, radius, sans, space } from '../../theme/theme'
import { Icon } from '../Icon'
import { PressableScale } from '../PressableScale'
import { StageGlyph } from '../StageGlyph'
import { SectionHeading } from './chrome'

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
export function IssueSubIssues({
  issue,
  subIssues,
  busy,
  commands,
  sessions,
  now,
  onOpen,
  onStatus,
}: {
  issue: IssueWire
  subIssues: IssueWire[]
  busy: boolean
  commands: IssueCommands
  sessions: readonly SessionMeta[]
  now: number
  onOpen: (id: string) => void
  onStatus: (issue: IssueWire) => void
}) {
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const workingByIssue = useMemo(
    () => confirmedWorkingAgentCountsByIssue(subIssues, sessions, now),
    [now, sessions, subIssues],
  )

  const finished = (c: IssueWire) => c.stage === 'done' || c.closedReason != null

  const create = () => {
    const next = title.trim()
    if (!next || busy) return
    commands.createSubIssue(next)
    setTitle('')
  }

  return (
    <View style={styles.section} testID="sub-issues">
      <SectionHeading
        label="Sub-tasks"
        count={issue.childCount > 0 ? `${issue.childDoneCount}/${issue.childCount}` : undefined}
      />
      {subIssues.map((child) => (
        <SubTaskRow
          key={child.id}
          child={child}
          workingAgents={workingByIssue.get(child.id) ?? 0}
          onOpen={onOpen}
          onStatus={onStatus}
          muted={finished(child)}
        />
      ))}
      {subIssues.length === 0 ? (
        <Text style={styles.empty}>No sub-tasks. Break the work down as it becomes clear.</Text>
      ) : null}

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
  )
}

/** One sub-task, in the board row's grammar: stage glyph, ref, title, state. */
function SubTaskRow({
  child,
  workingAgents,
  onOpen,
  onStatus,
  muted,
}: {
  child: IssueWire
  workingAgents: number
  onOpen: (id: string) => void
  onStatus: (issue: IssueWire) => void
  muted?: boolean
}) {
  const state = taskStateWord(child, workingAgents)
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
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`Change status for ${issueDisplayRef(child)}`}
        accessibilityHint="Opens the status picker"
        onPress={() => onStatus(child)}
        hitSlop={4}
        style={({ pressed }) => [styles.statusButton, pressed && styles.rowPressed]}
      >
        <StageGlyph stage={child.stage} size={14} ground={color.bg} />
      </PressableScale>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`${issueDisplayRef(child)} ${child.title}`}
        onPress={() => onOpen(child.id)}
        scaleTo={0.995}
        style={({ pressed }) => [styles.rowBody, pressed && styles.rowPressed]}
      >
        <Text style={styles.ref}>{issueDisplayRef(child)}</Text>
        <Text style={styles.title} numberOfLines={1}>
          {child.title}
        </Text>
        {child.archived ? <Text style={styles.archived}>ARCHIVED</Text> : null}
        {state ? <Text style={[styles.state, { color: stateTint }]}>{state.text}</Text> : null}
      </PressableScale>
    </View>
  )
}

const styles = StyleSheet.create({
  section: {
    paddingBottom: space.xl,
  },
  row: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: -space.sm,
    borderRadius: radius.md,
  },
  statusButton: {
    width: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
  },
  rowBody: {
    minHeight: 44,
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingRight: space.sm,
    borderRadius: radius.md,
  },
  rowMuted: {
    opacity: 0.62,
  },
  rowPressed: {
    backgroundColor: alpha(color.surface, 0.8),
  },
  ref: {
    ...mono(400),
    width: 58,
    color: color.textFaint,
    fontSize: 10,
  },
  title: {
    ...sans(400),
    flex: 1,
    minWidth: 0,
    color: color.body,
    fontSize: font.tiny,
  },
  archived: {
    ...mono(500),
    color: color.textMicro,
    fontSize: 9,
    letterSpacing: 0.5,
  },
  state: {
    ...mono(400),
    fontSize: 9.5,
  },
  empty: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.tiny,
    paddingVertical: space.xs,
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.sm,
  },
  field: {
    ...sans(400),
    flex: 1,
    minHeight: 40,
    color: color.text,
    fontSize: font.small,
    backgroundColor: color.bgSunken,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    paddingHorizontal: space.md,
  },
  addBtn: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    backgroundColor: color.elevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  muted: {
    opacity: 0.5,
  },
  addBtnText: {
    ...sans(600),
    color: color.body,
    fontSize: font.small,
  },
  addChip: {
    minHeight: 40,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: space.xs,
    paddingHorizontal: space.sm,
    marginLeft: -space.sm,
    borderRadius: radius.md,
  },
  addChipText: {
    ...sans(500),
    color: color.textDim,
    fontSize: font.tiny,
  },
})
