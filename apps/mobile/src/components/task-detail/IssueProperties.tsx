import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import {
  groupRelations,
  ISSUE_STAGE_LABELS,
  type IssueEdge,
  type RelationEntry,
  sessionTitle,
} from '@podium/client-core/values'
import type { PageIssue } from '@podium/client-graph/issue-page'
import {
  IssueType,
  issueStatusMenuEntries,
  issueStatusValueOf,
  type SessionId,
} from '@podium/model'
import { isClosed } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import { type ReactNode, useState } from 'react'
import { Linking, StyleSheet, Text, TextInput, View } from 'react-native'
import { issueObserver as observer } from '../../client/issue-observer'
import type { IssueCommands } from '../../lib/issue-detail'
import { color, font, leading, mono, radius, sans, space } from '../../theme/theme'
import { NativePicker, type NativePickerOption } from '../action-sheet-native'
import { Icon } from '../Icon'
import { ChevronRight, ExternalLink, Plus, X } from '../icons'
import { PressableScale } from '../PressableScale'
import { PriorityGlyph, StageGlyph } from '../StageGlyph'
import { Disclosure, MachineLabel } from './chrome'
import { useDetailLayout } from './detail-type'

/**
 * The properties block [POD-724] — the phone's answer to the desktop's rail.
 *
 * A DISCLOSURE, NOT AN ASIDE AND NOT A SHEET. The desktop keeps a 272px column
 * permanently beside the document; there is no such column here, and the
 * alternative — putting properties behind a modal — would mean every picker
 * inside them is a modal inside a modal, which iOS tolerates and
 * react-native-web does not reliably. Inline and folded, the pickers are ordinary
 * single-level sheets raised by the screen.
 *
 * The ORDER is the desktop's, which POD-591 ranked by the questions an operator
 * actually asks: what state and priority is it in (the bar above the fold),
 * who is working it, where is the branch, what does it touch, the long tail, and
 * provenance. Optional values render only when present; the tail is folded, not
 * padded with empty-value copy.
 *
 * Stage / priority / type are NOT here. Stage and priority live in the
 * always-visible property bar under the title; a non-default type joins them
 * only when it has something to say. Burying the stage picker two taps deep is
 * how a task sits in the wrong lane all afternoon.
 */
export const IssueProperties = observer(function IssueProperties({
  issue,
  sessions,
  parent,
  resolveEdge,
  busy,
  commands,
  open,
  onToggle,
  onOpenSession,
  onOpenIssue,
  onPickParent,
  onAddRelation,
}: {
  issue: IssueViewModel
  /** This task's member sessions, resolved against the session world. */
  sessions: SessionView[]
  /** The parent row, when the replica holds it. */
  parent: IssueViewModel | undefined
  /** Shared cross-boundary policy, closed over this replica's exit record. */
  resolveEdge: (id: string | undefined | null) => IssueEdge
  busy: boolean
  commands: IssueCommands
  open: boolean
  onToggle: () => void
  onOpenSession: (id: SessionId) => void
  onOpenIssue: (id: string) => void
  onPickParent: () => void
  onAddRelation: () => void
}) {
  const { size: textSize, accessorySize: size, accessibility } = useDetailLayout()
  const [label, setLabel] = useState('')
  const relations =
    'relationGroups' in issue
      ? (issue as import('@podium/client-graph/issue-page').PageIssue).relationGroups
      : groupRelations(issue)
  // Merge axis only: a shared checkout's `ahead` is not this task's to land.
  const ahead = issue.gitState?.shared ? 0 : (issue.gitState?.ahead ?? 0)

  return (
    <View style={styles.section}>
      <Disclosure label="Details" open={open} onToggle={onToggle} testID="issue-details">
        <Row label="Labels" first>
          <View style={styles.labels}>
            {issue.labels.map((l) => (
              <PressableScale
                key={l}
                accessibilityRole="button"
                accessibilityLabel={`Remove label ${l}`}
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={() => commands.removeLabel(l)}
                style={({ pressed }) => [styles.label, pressed && styles.pressed]}
              >
                <Text style={styles.labelText}>{l}</Text>
                <Icon as={X} size={size(11)} color={color.accentTint} />
              </PressableScale>
            ))}
            <TextInput
              value={label}
              onChangeText={setLabel}
              accessibilityLabel="Add label"
              placeholder="Add label…"
              placeholderTextColor={color.textMicro}
              returnKeyType="done"
              onSubmitEditing={() => {
                commands.addLabel(label)
                setLabel('')
              }}
              style={[
                styles.labelField,
                { minHeight: Math.max(44, textSize(leading(font.body)) + space.lg) },
                accessibility && styles.labelFieldAccessible,
              ]}
            />
          </View>
        </Row>

        <Row label="Parent">
          <PropertyParentReference
            id={issue.parentId}
            parent={parent}
            resolveEdge={resolveEdge}
            onOpenIssue={onOpenIssue}
          />
          <Ghost
            label={parent || issue.parentId ? 'Change parent' : 'Set parent'}
            busy={busy}
            onPress={onPickParent}
          />
          {issue.parentId ? (
            <Ghost label="Clear parent" busy={busy} onPress={() => commands.setParent(null)} />
          ) : null}
        </Row>

        <Row label="Relations">
          {relations.map((group) => (
            <View key={group.section} style={styles.relGroup}>
              <MachineLabel>{group.section}</MachineLabel>
              {group.entries.map((entry) => (
                <PropertyRelationRow
                  key={`${entry.direction}:${entry.type}:${entry.id}`}
                  entry={entry}
                  resolveEdge={resolveEdge}
                  busy={busy}
                  commands={commands}
                  onOpenIssue={onOpenIssue}
                />
              ))}
            </View>
          ))}
          <Ghost label="Add relation" busy={busy} onPress={onAddRelation} icon />
        </Row>

        <Row label="Sessions">
          {sessions.length === 0 ? <Text style={styles.none}>No agent has been here.</Text> : null}
          {sessions.map((session) => (
            <PropertySessionRow
              key={session.sessionId}
              session={session}
              onOpenSession={onOpenSession}
            />
          ))}
          <View style={styles.ghostRow}>
            <Ghost label="Add agent" busy={busy} onPress={commands.addSession} icon />
            <Ghost label="Add shell" busy={busy} onPress={commands.addShell} icon />
          </View>
        </Row>

        {issue.worktreePath ? (
          <Row label="Branch">
            <Text style={styles.mono}>{issue.branch ?? '—'}</Text>
            <View style={styles.ghostRow}>
              {/* THE SIGNAL RULE. The merge button takes the accent only when
                  there is something to land; on every other task both actions are
                  outline and behave identically. A permanently accented primary
                  in a fold spends the one signal on furniture. */}
              <Ghost
                label="FF-only merge"
                busy={busy}
                primary={ahead > 0}
                onPress={() => commands.gitAction('merge')}
              />
              <Ghost
                label={`Rebase on ${issue.parentBranch}`}
                busy={busy}
                onPress={() => commands.gitAction('rebase')}
              />
              <Ghost label="Open PR" busy={busy} onPress={() => commands.gitAction('pr')} />
            </View>
            {issue.prUrl ? <External label="View PR" url={issue.prUrl} /> : null}
          </Row>
        ) : null}

        {issue.dueAt || issue.estimateMin != null || issue.deferUntil ? (
          <Row label="Dates">
            {issue.dueAt ? (
              <Text style={styles.meta}>{`due ${new Date(issue.dueAt).toLocaleDateString()}`}</Text>
            ) : null}
            {issue.estimateMin != null ? (
              <Text style={styles.meta}>{`estimate ${issue.estimateMin}m`}</Text>
            ) : null}
            {issue.deferUntil ? (
              <>
                <Text style={styles.meta}>
                  {`deferred until ${new Date(issue.deferUntil).toLocaleDateString()}`}
                </Text>
                <Ghost label="Undefer" busy={busy} onPress={commands.undefer} />
              </>
            ) : null}
          </Row>
        ) : null}

        {issue.linearUrl || issue.linearIdentifier ? (
          <Row label="Linear">
            {issue.linearUrl ? (
              <External label={issue.linearIdentifier ?? 'Open'} url={issue.linearUrl} />
            ) : (
              <Text style={styles.meta}>{issue.linearIdentifier}</Text>
            )}
          </Row>
        ) : null}

        <Row label="Origin">
          <Text
            style={styles.meta}
          >{`Created by ${issue.intentOrigin === 'agent' ? 'an agent' : 'a person'}`}</Text>
          <Text
            style={styles.meta}
          >{`Written for ${issue.audience === 'agent' ? 'agents only' : 'people'}`}</Text>
          {issue.machineId ? <Text style={styles.meta}>{`Machine ${issue.machineId}`}</Text> : null}
        </Row>
      </Disclosure>
    </View>
  )
})

/**
 * The two everyday properties stay visible under the title: stage and priority.
 * A non-default type renders beside them; the ordinary `task` value does not
 * spend a chip merely to repeat what page this is. Assignee is intentionally
 * absent: work is placed on agents in sessions, not on an assignee field.
 *
 * They are OUT of the fold on purpose. The desktop can afford to put stage in a
 * rail because the rail is never closed; here, a stage picker two taps deep is
 * how a finished task sits in `in_progress` all afternoon. Each chip opens a
 * single-level sheet raised by the SCREEN, which is why they take handlers
 * rather than owning the sheets themselves.
 */
export const PropertyBar = observer(function PropertyBar({
  issue,
  onStage,
  onPriority,
  onType,
  onSelect,
  project,
  trailing,
}: {
  issue: IssueViewModel
  onStage: () => void
  onPriority: () => void
  onType: () => void
  /**
   * iOS opens each chip's choices as a native menu anchored to the chip and
   * reports the pick here; elsewhere (and without these) a tap raises the
   * screen's sheet through `onStage`, `onPriority` and `onType`.
   */
  onSelect?: {
    status: (value: string) => void
    priority: (priority: number) => void
    type: (type: IssueType) => void
  }
  /** The repository name, as a plain pill. */
  project?: string
  /** Quiet text after the pills — the task's age. */
  trailing?: ReactNode
}) {
  const { accessorySize: size } = useDetailLayout()
  return (
    <View style={styles.bar}>
      <Chip
        label={isClosed(issue) ? `Closed — ${issue.closedReason}` : ISSUE_STAGE_LABELS[issue.stage]}
        accessibilityLabel={`Stage ${ISSUE_STAGE_LABELS[issue.stage]} — change`}
        onPress={onStage}
        glyph={<StageGlyph stage={issue.stage} size={size(13)} ground={color.surface} />}
        {...(onSelect
          ? {
              picker: {
                label: 'Status',
                options: issueStatusMenuEntries().map((entry) => ({
                  value: entry.value,
                  label: entry.label,
                })),
                selected: issueStatusValueOf(issue),
                onSelect: onSelect.status,
              },
            }
          : {})}
      />
      {project ? (
        <View style={styles.chip}>
          <Text style={styles.chipText}>{project}</Text>
        </View>
      ) : null}
      <Chip
        label={`P${issue.priority}`}
        accessibilityLabel={`Priority P${issue.priority} — change`}
        onPress={onPriority}
        glyph={<PriorityGlyph priority={issue.priority} size={size(13)} />}
        {...(onSelect
          ? {
              picker: {
                label: 'Priority',
                options: PRIORITIES.map((p) => ({ value: String(p), label: `P${p}` })),
                selected: String(issue.priority),
                onSelect: (value: string) => onSelect.priority(Number(value)),
              },
            }
          : {})}
      />
      {issue.type !== 'task' ? (
        <Chip
          label={issue.type}
          accessibilityLabel={`Type ${issue.type} — change`}
          onPress={onType}
          {...(onSelect
            ? {
                picker: {
                  label: 'Type',
                  options: IssueType.options.map((t) => ({ value: t, label: t })),
                  selected: issue.type,
                  onSelect: (value: string) => {
                    const parsed = IssueType.safeParse(value)
                    if (parsed.success) onSelect.type(parsed.data)
                  },
                },
              }
            : {})}
        />
      ) : null}
      {issue.needsHuman ? (
        <View style={[styles.chip, styles.chipNeedsYou]}>
          <Text style={[styles.chipText, styles.chipNeedsYouText]}>needs you</Text>
        </View>
      ) : null}
      {/* Blocked is a STATE, not a property — it has no picker, and it is here
          rather than in the fold because it is the one fact that changes whether
          this task can be worked at all. The board row says it too; a task page
          that only said it two taps down would be quieter than its own row. */}
      {issue.blocked ? (
        <View style={[styles.chip, styles.chipBlocked]}>
          <Text style={[styles.chipText, styles.chipBlockedText]}>blocked</Text>
        </View>
      ) : null}
      {trailing ? <Text style={styles.barTrailing}>{trailing}</Text> : null}
    </View>
  )
})

const PRIORITIES = [0, 1, 2, 3, 4] as const

const Chip = observer(function Chip({
  label,
  accessibilityLabel,
  onPress,
  glyph,
  picker,
}: {
  label: string
  accessibilityLabel: string
  onPress: () => void
  glyph?: ReactNode
  /** The choices a native menu offers on iOS; `onPress` stays the fallback. */
  picker?: {
    label: string
    options: readonly NativePickerOption[]
    selected: string
    onSelect: (value: string) => void
  }
}) {
  const chip = (press: (() => void) | undefined) => (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Opens a picker"
      onPress={press}
      style={({ pressed }) => [styles.chipTarget, pressed && styles.chipPressed]}
    >
      <View style={styles.chip}>
        {glyph}
        <Text style={styles.chipText}>{label}</Text>
      </View>
    </PressableScale>
  )
  if (!picker) return chip(onPress)
  return (
    <NativePicker
      label={picker.label}
      style={styles.chipTarget}
      options={picker.options}
      selected={picker.selected}
      onSelect={picker.onSelect}
      onOpenFallback={onPress}
    >
      {chip}
    </NativePicker>
  )
})

const PropertyParentReference = observer(function PropertyParentReference({
  id,
  parent,
  resolveEdge,
  onOpenIssue,
}: {
  id: string | undefined | null
  parent: IssueViewModel | undefined
  resolveEdge: (id: string | undefined | null) => IssueEdge
  onOpenIssue: (id: string) => void
}) {
  const { accessorySize: size, accessibility } = useDetailLayout()
  const edge = resolveEdge(id)
  return edge.render === 'issue' && parent ? (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`Open parent ${issueDisplayRef(parent)}`}
      onPress={() => onOpenIssue(parent.id)}
      style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
    >
      <StageGlyph stage={parent.stage} size={size(13)} />
      <View style={styles.referenceBody}>
        <Text style={styles.linkRef}>{issueDisplayRef(parent)}</Text>
        <Text lineBreakStrategyIOS="standard" style={styles.linkTitle}>
          {'authoredTitle' in parent ? (parent as PageIssue).authoredTitle : parent.title}
        </Text>
      </View>
      {parent.archived ? <Text style={styles.archived}>ARCHIVED</Text> : null}
      {!accessibility ? <Icon as={ChevronRight} size={size(13)} color={color.textFaint} /> : null}
    </PressableScale>
  ) : edge.render === 'opaque' ? (
    <Text style={styles.opaque}>an issue you do not have access to</Text>
  ) : edge.render === 'pending' ? (
    <Text style={styles.inert}>Referenced task is loading</Text>
  ) : (
    <Text style={styles.none}>None</Text>
  )
})
const PropertyRelationRow = observer(function PropertyRelationRow({
  entry,
  resolveEdge,
  busy,
  commands,
  onOpenIssue,
}: {
  entry: RelationEntry
  resolveEdge: (id: string | undefined | null) => IssueEdge
  busy: boolean
  commands: IssueCommands
  onOpenIssue: (id: string) => void
}) {
  const { accessorySize: size } = useDetailLayout()
  const edge = resolveEdge(entry.id)
  if (edge.render === 'hidden') return null
  const target = edge.render === 'issue' ? edge.resolution.value : undefined
  return (
    <View style={styles.relRow}>
      {target ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`Open ${issueDisplayRef(target)} ${'authoredTitle' in target ? (target as PageIssue).authoredTitle : target.title}`}
          onPress={() => onOpenIssue(target.id)}
          style={({ pressed }) => [styles.relOpen, pressed && styles.pressed]}
        >
          <StageGlyph stage={target.stage} size={size(13)} />
          <View style={styles.referenceBody}>
            <Text style={styles.linkRef}>{issueDisplayRef(target)}</Text>
            <Text lineBreakStrategyIOS="standard" style={styles.linkTitle}>
              {'authoredTitle' in target ? (target as PageIssue).authoredTitle : target.title}
            </Text>
          </View>
        </PressableScale>
      ) : (
        <Text style={edge.render === 'opaque' ? styles.opaque : styles.inert}>
          {edge.render === 'opaque'
            ? 'an issue you do not have access to'
            : 'Referenced task is loading'}
        </Text>
      )}
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`Remove ${entry.type} relation`}
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        style={styles.removeRelation}
        onPress={() => commands.removeRelation(entry)}
      >
        <Icon as={X} size={size(13)} color={color.textFaint} />
      </PressableScale>
    </View>
  )
})
const PropertySessionRow = observer(function PropertySessionRow({
  session,
  onOpenSession,
}: {
  session: SessionView
  onOpenSession: (id: SessionId) => void
}) {
  const { accessorySize: size, accessibility } = useDetailLayout()
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`Open ${sessionTitle(session)}`}
      onPress={() => onOpenSession(session.sessionId)}
      style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
    >
      <View style={styles.referenceBody}>
        <Text lineBreakStrategyIOS="standard" style={styles.linkTitle}>
          {sessionTitle(session)}
        </Text>
        <Text style={styles.meta}>{session.status}</Text>
      </View>
      {!accessibility ? <Icon as={ChevronRight} size={size(13)} color={color.textFaint} /> : null}
    </PressableScale>
  )
})

const Row = observer(function Row({
  label,
  children,
  first = false,
}: {
  label: string
  children: ReactNode
  first?: boolean
}) {
  return (
    <View style={[styles.row, first && styles.firstRow]}>
      <MachineLabel>{label}</MachineLabel>
      <View style={styles.rowBody}>{children}</View>
    </View>
  )
})

const Ghost = observer(function Ghost({
  label,
  busy,
  onPress,
  icon,
  primary,
}: {
  label: string
  busy: boolean
  onPress: () => void
  icon?: boolean
  primary?: boolean
}) {
  const { accessorySize: size } = useDetailLayout()
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.ghost,
        primary && styles.ghostPrimary,
        (busy || pressed) && styles.pressed,
      ]}
    >
      {icon ? (
        <Icon as={Plus} size={size(12)} color={primary ? color.onAccent : color.textDim} />
      ) : null}
      <Text style={[styles.ghostText, primary && styles.ghostPrimaryText]}>{label}</Text>
    </PressableScale>
  )
})

const External = observer(function External({ label, url }: { label: string; url: string }) {
  const { accessorySize: size } = useDetailLayout()
  return (
    <PressableScale
      accessibilityRole="link"
      accessibilityLabel={`${label} (opens externally)`}
      onPress={() => void Linking.openURL(url).catch(() => {})}
      style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
    >
      <Text style={styles.link}>{label}</Text>
      <Icon as={ExternalLink} size={size(12)} color={color.info} />
    </PressableScale>
  )
})

const styles = StyleSheet.create({
  section: {
    paddingBottom: 0,
  },
  // The board's header pills: 24pt fills on the control radius, no outline.
  bar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
  },
  barTrailing: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
  },
  chipTarget: {
    minHeight: 44,
    justifyContent: 'center',
    maxWidth: '100%',
    borderRadius: radius.control,
  },
  chip: {
    minHeight: 28,
    paddingVertical: space.xs,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    maxWidth: '100%',
    paddingHorizontal: space.sm,
    borderRadius: radius.control,
    backgroundColor: color.tertiaryFill,
  },
  chipPressed: {
    backgroundColor: color.surfacePressed,
  },
  chipNeedsYou: {
    backgroundColor: color.needsYouSoft,
  },
  chipText: {
    ...sans(400),
    flexShrink: 1,
    color: color.body,
    fontSize: font.small,
  },
  chipNeedsYouText: {
    color: color.needsYouText,
  },
  chipBlocked: {
    backgroundColor: color.dangerSoft,
  },
  chipBlockedText: {
    color: color.dangerText,
  },
  row: {
    gap: space.sm,
    paddingVertical: space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  firstRow: { borderTopWidth: 0, paddingTop: space.xs },
  rowBody: {
    gap: space.sm,
  },
  labels: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
  },
  label: {
    minHeight: 44,
    paddingVertical: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.sm,
    borderRadius: radius.control,
    backgroundColor: color.accentSoft,
  },
  labelText: {
    ...sans(500),
    flexShrink: 1,
    color: color.accentTint,
    fontSize: font.tiny,
  },
  labelField: {
    ...sans(400),
    lineHeight: leading(font.body),
    minHeight: 44,
    paddingVertical: space.sm,
    minWidth: 120,
    flexGrow: 1,
    color: color.text,
    fontSize: font.body,
    paddingHorizontal: space.sm,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.bgSunken,
  },
  labelFieldAccessible: { flexBasis: '100%', width: '100%' },
  linkRow: {
    minHeight: 44,
    paddingVertical: space.sm,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: space.sm,
    marginHorizontal: -space.sm,
    borderRadius: radius.control,
  },
  linkRef: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.tiny,
  },
  linkTitle: {
    ...sans(400),
    color: color.body,
    fontSize: font.small,
  },
  archived: {
    ...mono(500),
    color: color.textMicro,
    fontSize: font.tiny,
    letterSpacing: 0.5,
  },
  link: {
    ...sans(500),
    color: color.info,
    fontSize: font.tiny,
  },
  inert: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.tiny,
  },
  opaque: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.tiny,
    fontStyle: 'italic',
  },
  none: {
    ...sans(400),
    color: color.textMicro,
    fontSize: font.tiny,
  },
  meta: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
  },
  mono: {
    ...mono(400),
    color: color.body,
    fontSize: font.tiny,
  },
  removeRelation: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  referenceBody: { flex: 1, minWidth: 0, gap: space.xs },
  relGroup: {
    gap: space.xs,
    paddingBottom: space.xs,
  },
  relRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    paddingVertical: space.sm,
    gap: space.sm,
  },
  relOpen: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    gap: space.sm,
    justifyContent: 'flex-start',
    alignItems: 'flex-start',
    minHeight: 44,
    paddingVertical: space.sm,
  },
  ghostRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  ghost: {
    maxWidth: '100%',
    minHeight: 44,
    paddingVertical: space.sm,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  ghostPrimary: {
    backgroundColor: color.accent,
    borderColor: color.accent,
  },
  ghostText: {
    ...sans(500),
    flexShrink: 1,
    color: color.textDim,
    fontSize: font.tiny,
  },
  ghostPrimaryText: {
    ...sans(600),
    color: color.onAccent,
  },
  pressed: {
    opacity: 0.6,
  },
})
