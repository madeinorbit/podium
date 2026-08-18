import { groupRelations, ISSUE_STAGE_LABELS, sessionTitle } from '@podium/client-core/viewmodels'
import type { IssueWire, SessionId, SessionMeta } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { ChevronRight, ExternalLink, Plus, X } from 'lucide-react-native'
import { type ReactNode, useState } from 'react'
import { Linking, StyleSheet, Text, TextInput, View } from 'react-native'
import type { IssueCommands } from '../../lib/issue-detail'
import { alpha } from '../../theme/mix'
import { color, font, mono, radius, sans, space } from '../../theme/theme'
import { Icon } from '../Icon'
import { PressableScale } from '../PressableScale'
import { PriorityGlyph, StageGlyph } from '../StageGlyph'
import { Disclosure, MachineLabel } from './chrome'

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
export function IssueProperties({
  issue,
  sessions,
  parent,
  busy,
  commands,
  open,
  onToggle,
  onOpenSession,
  onOpenIssue,
  onPickParent,
  onAddRelation,
}: {
  issue: IssueWire
  /** This task's member sessions, resolved against the session world. */
  sessions: SessionMeta[]
  /** The parent row, when the replica holds it. */
  parent: IssueWire | undefined
  busy: boolean
  commands: IssueCommands
  open: boolean
  onToggle: () => void
  onOpenSession: (id: SessionId) => void
  onOpenIssue: (id: string) => void
  onPickParent: () => void
  onAddRelation: () => void
}) {
  const [label, setLabel] = useState('')
  const relations = groupRelations(issue)
  // Merge axis only: a shared checkout's `ahead` is not this task's to land.
  const ahead = issue.gitState?.shared ? 0 : (issue.gitState?.ahead ?? 0)

  return (
    <View style={styles.section}>
      <Disclosure label="Details" open={open} onToggle={onToggle} testID="issue-details">
        <Row label="Labels">
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
                <Icon as={X} size={11} color={color.accentTint} />
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
              style={styles.labelField}
            />
          </View>
        </Row>

        <Row label="Parent">
          {parent ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={`Open parent ${issueDisplayRef(parent)}`}
              onPress={() => onOpenIssue(parent.id)}
              style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
            >
              <StageGlyph stage={parent.stage} size={13} />
              <Text style={styles.linkRef}>{issueDisplayRef(parent)}</Text>
              <Text style={styles.linkTitle} numberOfLines={1}>
                {parent.title}
              </Text>
              {parent.archived ? <Text style={styles.archived}>ARCHIVED</Text> : null}
              <Icon as={ChevronRight} size={13} color={color.textFaint} />
            </PressableScale>
          ) : issue.parentId ? (
            // The replica does not hold the parent. That is NOT "deleted" — under
            // a scoped feed it may simply not be ours to see — so the id is shown
            // inert and nothing is claimed about it.
            <Text style={styles.inert}>{issue.parentId}</Text>
          ) : (
            <Text style={styles.none}>None</Text>
          )}
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
                <View key={`${entry.direction}:${entry.type}:${entry.id}`} style={styles.relRow}>
                  <PressableScale
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${entry.id}`}
                    onPress={() => onOpenIssue(entry.id)}
                    style={({ pressed }) => [styles.relOpen, pressed && styles.pressed]}
                  >
                    <Text style={styles.inert} numberOfLines={1}>
                      {entry.id}
                    </Text>
                  </PressableScale>
                  <PressableScale
                    accessibilityRole="button"
                    accessibilityLabel={`Remove relation to ${entry.id}`}
                    accessibilityState={{ disabled: busy }}
                    disabled={busy}
                    hitSlop={8}
                    onPress={() => commands.removeRelation(entry)}
                  >
                    <Icon as={X} size={13} color={color.textFaint} />
                  </PressableScale>
                </View>
              ))}
            </View>
          ))}
          <Ghost label="Add relation" busy={busy} onPress={onAddRelation} icon />
        </Row>

        <Row label="Sessions">
          {sessions.length === 0 ? <Text style={styles.none}>No agent has been here.</Text> : null}
          {sessions.map((s) => (
            <PressableScale
              key={s.sessionId}
              accessibilityRole="button"
              accessibilityLabel={`Open ${sessionTitle(s)}`}
              onPress={() => onOpenSession(s.sessionId)}
              style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
            >
              <Text style={styles.linkTitle} numberOfLines={1}>
                {sessionTitle(s)}
              </Text>
              <Text style={styles.meta}>{s.status}</Text>
              <Icon as={ChevronRight} size={13} color={color.textFaint} />
            </PressableScale>
          ))}
          <View style={styles.ghostRow}>
            <Ghost label="Add agent" busy={busy} onPress={commands.addSession} icon />
            <Ghost label="Add shell" busy={busy} onPress={commands.addShell} icon />
          </View>
        </Row>

        {issue.worktreePath ? (
          <Row label="Branch">
            <Text style={styles.mono} numberOfLines={1}>
              {issue.branch ?? '—'}
            </Text>
            <View style={styles.ghostRow}>
              {/* THE SIGNAL RULE. The merge button is Superade Yellow only when
                  there is something to land; on every other task both actions are
                  outline and behave identically. A permanently yellow primary in
                  a fold spends the one signal on furniture. */}
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
          >{`Created by ${issue.origin === 'agent' ? 'an agent' : 'a person'}`}</Text>
          <Text
            style={styles.meta}
          >{`Written for ${issue.audience === 'agent' ? 'agents only' : 'people'}`}</Text>
          {issue.machineId ? <Text style={styles.meta}>{`Machine ${issue.machineId}`}</Text> : null}
        </Row>
      </Disclosure>
    </View>
  )
}

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
export function PropertyBar({
  issue,
  onStage,
  onPriority,
  onType,
}: {
  issue: IssueWire
  onStage: () => void
  onPriority: () => void
  onType: () => void
}) {
  return (
    <View style={styles.bar}>
      <Chip
        label={
          issue.closedReason ? `Closed — ${issue.closedReason}` : ISSUE_STAGE_LABELS[issue.stage]
        }
        accessibilityLabel={`Stage ${ISSUE_STAGE_LABELS[issue.stage]} — change`}
        onPress={onStage}
        glyph={<StageGlyph stage={issue.stage} size={13} ground={color.surface} />}
      />
      <Chip
        label={`P${issue.priority}`}
        accessibilityLabel={`Priority P${issue.priority} — change`}
        onPress={onPriority}
        glyph={<PriorityGlyph priority={issue.priority} size={13} />}
      />
      {issue.type !== 'task' ? (
        <Chip
          label={issue.type}
          accessibilityLabel={`Type ${issue.type} — change`}
          onPress={onType}
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
    </View>
  )
}

function Chip({
  label,
  accessibilityLabel,
  onPress,
  glyph,
}: {
  label: string
  accessibilityLabel: string
  onPress: () => void
  glyph?: ReactNode
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Opens a picker"
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
    >
      {glyph}
      <Text style={styles.chipText} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.caret}>▾</Text>
    </PressableScale>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.row}>
      <MachineLabel>{label}</MachineLabel>
      <View style={styles.rowBody}>{children}</View>
    </View>
  )
}

function Ghost({
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
      {icon ? <Icon as={Plus} size={12} color={primary ? color.onAccent : color.textDim} /> : null}
      <Text style={[styles.ghostText, primary && styles.ghostPrimaryText]}>{label}</Text>
    </PressableScale>
  )
}

function External({ label, url }: { label: string; url: string }) {
  return (
    <PressableScale
      accessibilityRole="link"
      accessibilityLabel={`${label} (opens externally)`}
      onPress={() => void Linking.openURL(url).catch(() => {})}
      style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
    >
      <Text style={styles.link}>{label}</Text>
      <Icon as={ExternalLink} size={12} color={color.info} />
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  section: {
    paddingBottom: space.xl,
  },
  bar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    paddingBottom: space.lg,
  },
  chip: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    maxWidth: '100%',
    paddingHorizontal: space.sm + 2,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  chipPressed: {
    backgroundColor: color.surfacePressed,
  },
  chipNeedsYou: {
    borderColor: color.needsYouBorder,
    backgroundColor: color.needsYouSoft,
  },
  chipText: {
    ...sans(500),
    flexShrink: 1,
    color: color.body,
    fontSize: font.tiny,
  },
  chipNeedsYouText: {
    color: color.needsYouText,
  },
  chipBlocked: {
    borderColor: alpha(color.danger, 0.4),
    backgroundColor: color.dangerSoft,
  },
  chipBlockedText: {
    color: color.danger,
  },
  caret: {
    ...mono(400),
    color: color.textFaint,
    fontSize: 10,
  },
  row: {
    gap: 5,
    paddingVertical: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: alpha(color.hairline, 0.8),
  },
  rowBody: {
    gap: 5,
  },
  labels: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  label: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    backgroundColor: color.accentSoft,
  },
  labelText: {
    ...sans(500),
    color: color.accentTint,
    fontSize: font.micro,
  },
  labelField: {
    ...sans(400),
    minHeight: 34,
    minWidth: 120,
    flexGrow: 1,
    color: color.text,
    fontSize: font.tiny,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.bgSunken,
  },
  linkRow: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.sm,
    marginHorizontal: -space.sm,
    borderRadius: radius.md,
  },
  linkRef: {
    ...mono(400),
    color: color.textFaint,
    fontSize: 10,
  },
  linkTitle: {
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
  link: {
    ...sans(500),
    color: color.info,
    fontSize: font.tiny,
  },
  inert: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.micro,
  },
  none: {
    ...sans(400),
    color: color.textMicro,
    fontSize: font.tiny,
  },
  meta: {
    ...mono(400),
    color: color.textDim,
    fontSize: font.micro,
  },
  mono: {
    ...mono(400),
    color: color.body,
    fontSize: font.micro,
  },
  relGroup: {
    gap: 3,
    paddingBottom: space.xs,
  },
  relRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 34,
    gap: space.sm,
  },
  relOpen: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    minHeight: 34,
  },
  ghostRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  ghost: {
    minHeight: 36,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
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
