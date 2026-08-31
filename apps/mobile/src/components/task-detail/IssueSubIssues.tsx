import type { IssueWire } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { Plus } from '../icons'
import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import type { IssueCommands } from '../../lib/issue-detail'
import { alpha } from '../../theme/mix'
import { stageColor } from '../../theme/stage'
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
 * The trailing word is derived from the WIRE alone — needs you, blocked,
 * proposed, or a subtree fraction. The desktop additionally ranks "N working"
 * from the child's live sessions; the phone leaves that slot out rather than
 * joining the session world per child row, and the row stays honest about what
 * it does say.
 */
export function IssueSubIssues({
  issue,
  subIssues,
  busy,
  commands,
  onOpen,
}: {
  issue: IssueWire
  subIssues: IssueWire[]
  busy: boolean
  commands: IssueCommands
  onOpen: (id: string) => void
}) {
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')

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
        <SubTaskRow key={child.id} child={child} onOpen={onOpen} muted={finished(child)} />
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
  onOpen,
  muted,
}: {
  child: IssueWire
  onOpen: (id: string) => void
  muted?: boolean
}) {
  const state = child.needsHuman
    ? { text: 'needs you', tint: color.needsYou }
    : child.blocked
      ? { text: 'blocked', tint: color.dangerText }
      : child.stage === 'proposed'
        ? { text: 'proposed', tint: stageColor('proposed') }
        : child.childCount > 0
          ? { text: `${child.childDoneCount}/${child.childCount}`, tint: color.textFaint }
          : null
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${issueDisplayRef(child)} ${child.title}`}
      onPress={() => onOpen(child.id)}
      scaleTo={0.995}
      style={({ pressed }) => [
        styles.row,
        (muted || child.archived) && styles.rowMuted,
        pressed && styles.rowPressed,
      ]}
    >
      <StageGlyph stage={child.stage} size={13} ground={color.bg} />
      <Text style={styles.ref}>{issueDisplayRef(child)}</Text>
      <Text style={styles.title} numberOfLines={1}>
        {child.title}
      </Text>
      {child.archived ? <Text style={styles.archived}>ARCHIVED</Text> : null}
      {state ? <Text style={[styles.state, { color: state.tint }]}>{state.text}</Text> : null}
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  section: {
    paddingBottom: space.xl,
  },
  row: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.sm,
    marginHorizontal: -space.sm,
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
