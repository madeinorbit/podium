import type { IssueCloseConcern } from '@podium/client-core/viewmodels'
import {
  ISSUE_STATUS_LABELS,
  type IssueCloseReason,
  type IssueWire,
  type SessionMeta,
} from '@podium/model'
import {
  AlertTriangle,
  type AppIcon,
  GitBranch,
  GitCommit,
  MessageCircleQuestion,
  Users,
} from './icons'
import { StyleSheet, Text, View } from 'react-native'
import { issueCloseBlockers } from '../lib/issue-close'
import { alpha } from '../theme/mix'
import { color, font, leading, radius, sans, space } from '../theme/theme'
import { BottomSheet } from './BottomSheet'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'

/**
 * WHAT A CLOSE WOULD COST, ON THE PHONE [POD-1129].
 *
 * The desktop raises an `AlertDialog` before every close. Both phone paths — the
 * task inspector's status sheet and the task page's `selectStatus` — fired
 * `closeIssue` straight through, so marking a task Done from a phone retired
 * pending agent decisions and walked away from uncommitted work in silence.
 *
 * This is that guard in the phone's own grammar rather than a ported dialog: the
 * one shared {@link BottomSheet}, the {@link ActionSheet}'s inset groups and its
 * hairlines, a destructive action, and a Cancel pill in the footer. The FACTS
 * are not restated here — they are {@link issueCloseBlockers} over the shared
 * derivation, which is the whole point: a guard that lists different things
 * depending on which screen you closed from teaches that the list is advisory.
 *
 * TWO THINGS ABOUT THE LAYOUT, both about a thumb that is already moving.
 *
 *  1. The safe action is the BOTTOM-MOST thing on the sheet, in the footer where
 *     every other sheet in this app puts Cancel. The sheet rises from the bottom
 *     edge, so during the entry animation every row is still below its final
 *     resting place — a tap that beats the animation lands on the footer or the
 *     backdrop, never on `Close anyway`.
 *  2. The concerns sit ABOVE the destructive row, so the more there is to lose,
 *     the further that row travels from wherever the previous tap landed. The
 *     interruption is proportional to the cost by construction.
 *
 * The list is derived LIVE from the roster, not snapshotted at the press. An
 * agent that finishes while the sheet is open empties it, and the sheet then
 * says exactly that rather than holding up a stale warning — the same thing the
 * desktop dialog does, and the reason its no-blocker copy exists at all.
 */
export function IssueCloseSheet({
  issue,
  sessions,
  reason,
  busy = false,
  onConfirm,
  onClose,
}: {
  issue: IssueWire
  /** The whole roster; membership is resolved by {@link issueCloseBlockers}. */
  sessions: readonly SessionMeta[]
  /** The ending being recorded, or `null` when the sheet is down. */
  reason: IssueCloseReason | null
  busy?: boolean
  onConfirm: (reason: IssueCloseReason) => void
  onClose: () => void
}) {
  const concerns = issueCloseBlockers(issue, sessions)

  return (
    <BottomSheet
      visible={reason !== null}
      onClose={onClose}
      mode="fit"
      scrollable={concerns.length > 3}
      contentStyle={styles.content}
      testID="issue-close-sheet"
      head={
        <View style={styles.titles}>
          <View style={styles.warn}>
            <Icon as={AlertTriangle} size={15} color={color.needsYouText} />
          </View>
          <Text style={styles.title} numberOfLines={2}>
            {/* The ending is named only when it is NOT the ordinary one:
                "Close this task?" already means done, and spelling that out
                would make the common path read like a special case. */}
            {concerns.length > 0
              ? 'This task still needs attention'
              : reason && reason !== 'done'
                ? `Close this task as ${ISSUE_STATUS_LABELS[reason].toLowerCase()}?`
                : 'Close this task?'}
          </Text>
          <Text style={styles.subtitle}>
            {concerns.length > 0
              ? 'Closing is still available, but it should be an explicit decision.'
              : 'Nothing unresolved is left on it.'}
          </Text>
        </View>
      }
      footerRule={false}
      footer={
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Keep open"
          disabled={busy}
          onPress={onClose}
          style={({ pressed }) => [styles.cancel, pressed && styles.rowPressed]}
        >
          <Text style={styles.cancelText}>Keep open</Text>
        </PressableScale>
      }
    >
      {concerns.length > 0 ? (
        <View style={styles.group} testID="issue-close-concerns">
          {concerns.map((concern, i) => (
            <View key={concern.key} style={[styles.concern, i > 0 && styles.divider]}>
              <View style={styles.icon}>
                <Icon as={CONCERN_ICONS[concern.icon]} size={15} color={color.needsYouText} />
              </View>
              <View style={styles.concernText}>
                <Text style={styles.label}>{concern.label}</Text>
                <Text style={styles.detail}>{concern.detail}</Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.group}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={confirmLabel(reason, concerns.length > 0, false)}
          disabled={busy || reason === null}
          scaleTo={0.99}
          // Dismiss FIRST, then close. The store's close is optimistic and
          // outboxed (POD-781) — the row reaches the closed fold on the press —
          // so holding the sheet up on a `Closing…` state would be a spinner
          // over something that has already happened. `busy` still gates the
          // button, for a host whose page is mid-mutation when the guard opens.
          onPress={() => {
            if (!reason) return
            onClose()
            onConfirm(reason)
          }}
          style={({ pressed }) => [
            styles.row,
            busy && styles.rowDisabled,
            pressed && styles.rowPressed,
          ]}
        >
          <Text style={[styles.label, styles.destructive]}>
            {confirmLabel(reason, concerns.length > 0, busy)}
          </Text>
        </PressableScale>
      </View>
    </BottomSheet>
  )
}

/** The derivation names an icon; each surface maps it to its own set. These are
 *  the desktop's four, translated to the platform symbol set. */
const CONCERN_ICONS: Record<IssueCloseConcern['icon'], AppIcon> = {
  attention: MessageCircleQuestion,
  sessions: Users,
  children: GitBranch,
  git: GitCommit,
}

/** The button says which ENDING is being recorded, not just "close" — the status
 *  sheet offers three of them and this is the last place to catch a mispick.
 *  `done` keeps the plain wording so the common path stays a plain sentence.
 *  Word for word the desktop's, so the two guards cannot drift apart in tone. */
function confirmLabel(reason: IssueCloseReason | null, blocked: boolean, busy: boolean): string {
  if (busy) return 'Closing…'
  if (reason && reason !== 'done') return `Close as ${ISSUE_STATUS_LABELS[reason].toLowerCase()}`
  return blocked ? 'Close anyway' : 'Close task'
}

const styles = StyleSheet.create({
  titles: {
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    gap: 3,
  },
  warn: {
    width: 28,
    height: 28,
    marginBottom: 3,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.needsYouBg,
  },
  title: {
    ...sans(600),
    color: color.body,
    fontSize: font.small,
    textAlign: 'center',
  },
  subtitle: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny),
    textAlign: 'center',
  },
  content: {
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
    gap: space.sm,
  },
  group: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    overflow: 'hidden',
  },
  divider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: alpha(color.hairline, 0.8),
  },
  // Not a `row`: a concern is read, not pressed, so it takes no minimum tap
  // height and no press state. Nothing in this group is a target.
  concern: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingVertical: 11,
    paddingHorizontal: space.lg - 2,
  },
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    paddingHorizontal: space.lg - 2,
  },
  rowPressed: {
    backgroundColor: color.surfacePressed,
  },
  rowDisabled: {
    opacity: 0.38,
  },
  icon: {
    width: 26,
    paddingTop: 1,
    alignItems: 'center',
  },
  concernText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  label: {
    ...sans(500),
    color: color.text,
    fontSize: font.small,
  },
  detail: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny),
  },
  destructive: {
    ...sans(600),
    color: color.danger,
  },
  cancel: {
    paddingVertical: 15,
    marginHorizontal: space.md,
    marginTop: space.sm,
    alignItems: 'center',
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  cancelText: {
    ...sans(600),
    color: color.textDim,
    fontSize: font.body,
  },
})
