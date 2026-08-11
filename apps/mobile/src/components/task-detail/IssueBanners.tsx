import { ISSUE_STAGE_LABELS } from '@podium/client-core/viewmodels'
import type { IssueWire } from '@podium/model'
import { StyleSheet, Text, View } from 'react-native'
import type { IssueCommands } from '../../lib/issue-detail'
import { alpha } from '../../theme/mix'
import { color, font, leading, radius, sans, space } from '../../theme/theme'
import { PressableScale } from '../PressableScale'

/**
 * The banners above the task title [POD-724]: deleted, superseded / duplicate-of,
 * and a suggested stage move. The needs-human ask is NOT here — the phone already
 * has `IssueQuestionCard` for it, which quotes the agent's actual question and can
 * answer it inline, and the page renders that immediately below this stack so the
 * desktop's banner order is preserved.
 *
 * CROSS-BOUNDARY EDGES. The superseded-by / duplicate-of banner points at ANOTHER
 * task, which under the scoped feed may be one this principal cannot see. The
 * desktop resolves that through the issues slice's `resolveIssueEdge` so a
 * not-visible row is never rendered as a removed one. The phone holds no such
 * resolver, so it renders the RAW REF and nothing else — no title, no
 * click-through, no claim about whether the target exists. An id shown inert is
 * the one reading that is true whichever of the two cases it is; inventing "this
 * issue was deleted" from a `.find()` miss is exactly the defect that policy
 * exists to prevent.
 */
export function IssueBanners({
  issue,
  busy,
  commands,
  onRestored,
}: {
  issue: IssueWire
  busy: boolean
  commands: IssueCommands
  onRestored: () => void
}) {
  const lifecycle = issue.supersededBy || issue.duplicateOf
  if (!issue.deletedAt && !lifecycle && !issue.suggestedStage) return null
  return (
    <View style={styles.stack}>
      {issue.deletedAt ? (
        <View style={[styles.banner, styles.danger]}>
          <Text style={styles.body}>
            This task and its sessions were deleted. Restoring it returns the sessions as exited
            records; their running processes were stopped.
          </Text>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Restore task"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={() => commands.restoreIssue(onRestored)}
            style={({ pressed }) => [styles.action, busy && styles.muted, pressed && styles.muted]}
          >
            <Text style={styles.actionText}>Restore task</Text>
          </PressableScale>
        </View>
      ) : null}

      {lifecycle ? (
        <View style={styles.banner}>
          {issue.supersededBy ? (
            <Text style={styles.body}>
              Superseded by <Text style={styles.ref}>{issue.supersededBy}</Text>
            </Text>
          ) : null}
          {issue.duplicateOf ? (
            <Text style={styles.body}>
              Duplicate of <Text style={styles.ref}>{issue.duplicateOf}</Text>
            </Text>
          ) : null}
        </View>
      ) : null}

      {issue.suggestedStage ? (
        <View style={[styles.banner, styles.suggestion]}>
          <Text style={styles.body}>
            Move to <Text style={styles.strong}>{ISSUE_STAGE_LABELS[issue.suggestedStage]}</Text>?
            {issue.suggestedReason ? ` ${issue.suggestedReason}` : ''}
          </Text>
          <View style={styles.row}>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={`Approve move to ${ISSUE_STAGE_LABELS[issue.suggestedStage]}`}
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={commands.applySuggestion}
              style={({ pressed }) => [
                styles.action,
                styles.primary,
                busy && styles.muted,
                pressed && styles.muted,
              ]}
            >
              <Text style={[styles.actionText, styles.primaryText]}>Approve</Text>
            </PressableScale>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Dismiss the suggested move"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={commands.dismissSuggestion}
              style={({ pressed }) => [
                styles.action,
                busy && styles.muted,
                pressed && styles.muted,
              ]}
            >
              <Text style={styles.actionText}>Dismiss</Text>
            </PressableScale>
          </View>
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  stack: {
    gap: space.sm,
    paddingBottom: space.md,
  },
  banner: {
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  danger: {
    borderColor: alpha(color.danger, 0.4),
    backgroundColor: color.dangerSoft,
  },
  suggestion: {
    borderColor: color.accentBorder,
    backgroundColor: color.accentSoft,
  },
  body: {
    ...sans(400),
    color: color.body,
    fontSize: font.small,
    lineHeight: leading(font.small, 'prose'),
  },
  strong: {
    ...sans(600),
    color: color.text,
  },
  ref: {
    color: color.textDim,
  },
  row: {
    flexDirection: 'row',
    gap: space.sm,
  },
  action: {
    minHeight: 40,
    justifyContent: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    backgroundColor: color.elevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  primary: {
    backgroundColor: color.accent,
    borderColor: color.accent,
  },
  muted: {
    opacity: 0.55,
  },
  actionText: {
    ...sans(600),
    color: color.body,
    fontSize: font.small,
  },
  primaryText: {
    color: color.onAccent,
  },
})
